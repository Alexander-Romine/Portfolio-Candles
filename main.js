'use strict';

const { app, BrowserWindow, ipcMain, shell, Menu, Tray, nativeImage, screen } = require('electron');
const { execFile } = require('child_process');

// Must run before requestSingleInstanceLock() so isolated test profiles
// (PC_USER_DATA) get their own lock and can run beside the installed app.
if (process.env.PC_USER_DATA) app.setPath('userData', process.env.PC_USER_DATA);
const path = require('path');
const fs = require('fs');
const { Store } = require('./lib/store');
const { Market } = require('./lib/market');

let win = null;
let widget = null;
let tray = null;
let store = null;
let market = null;
let quitting = false;
let trayTimer = null;
let winStateTimer = null;
let widgetPosTimer = null;
let preFsBounds = null;   // normal bounds captured right before entering fullscreen
let fsCheckTimer = null;  // pending "did the fullscreen exit restore the window?" check
let fsActive = false;     // our source of truth for "window is fullscreen" (native flag unreliable)
let fsGen = 0;            // toggles generation — guards rapid enter/exit races

const gotLock = app.requestSingleInstanceLock();
if (!gotLock) {
  app.quit();
} else {
  app.on('second-instance', () => showWindow());
}

function broadcast(channel, payload) {
  for (const w of [win, widget]) {
    if (w && !w.isDestroyed()) w.webContents.send(channel, payload);
  }
}

/* ---------------- window state (remember size/position) ---------------- */

function winStatePath() {
  return path.join(app.getPath('userData'), 'window-state.json');
}

function readJson(file) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return null;
  }
}

function writeJson(file, value) {
  try {
    fs.writeFileSync(file, JSON.stringify(value), 'utf8');
  } catch (err) {
    console.warn('[winstate]', err.message);
  }
}

function persistWindowState(immediate = false) {
  if (winStateTimer) {
    clearTimeout(winStateTimer);
    winStateTimer = null;
  }
  const write = () => {
    if (!win || win.isDestroyed()) return;
    if (fsActive || win.isFullScreen()) return; // never save fullscreen dimensions as the normal bounds
    if (fsCheckTimer) return;                   // fullscreen exit still settling — its bounds aren't the normal ones
    const prev = readJson(winStatePath()) || {};
    const state = { ...prev };
    state.maximized = win.isMaximized();
    if (!win.isMaximized()) Object.assign(state, win.getBounds());
    writeJson(winStatePath(), state);
  };
  if (immediate) write();
  else winStateTimer = setTimeout(write, 400);
}

function restoredBounds() {
  const st = readJson(winStatePath()) || {};
  const wa = screen.getPrimaryDisplay().workArea;
  const bounds = {
    width: Math.min(Math.max(st.width || 1340, 760), wa.width),
    height: Math.min(Math.max(st.height || 860, 520), wa.height)
  };
  if (Number.isFinite(st.x) && Number.isFinite(st.y)) {
    // only reuse the position if its top-left corner is on a visible display
    const visible = screen.getAllDisplays().some((d) => {
      const a = d.workArea;
      return st.x >= a.x - 20 && st.x <= a.x + a.width - 20 && st.y >= a.y - 20 && st.y <= a.y + a.height - 20;
    });
    if (visible) {
      bounds.x = st.x;
      bounds.y = st.y;
    }
  }
  bounds.maximized = st.maximized === true;
  return bounds;
}

/* ---------------- desktop widget ---------------- */

const WIDGET_W = 238;

function widgetHeight(state) {
  const wa = screen.getPrimaryDisplay().workArea;
  const n = Math.max(state.positions.length, 1);
  return Math.max(150, Math.min(wa.height - 90, 96 + n * 30));
}

/* Content-driven height: after creation the widget measures its real
   content and reports it via 'widget:height'; we clamp it to the screen
   and resize. Growth is downward (top-left anchored). */
let widgetNaturalH = 0;

function applyWidgetHeight() {
  if (!widget || widget.isDestroyed()) return;
  const bounds = widget.getBounds();
  const wa = screen.getDisplayMatching(bounds).workArea;
  const maxH = Math.max(160, wa.y + wa.height - bounds.y - 10);
  const h = Math.max(140, Math.min(widgetNaturalH || 150, maxH));
  const curH = widget.getSize()[1];
  if (Math.abs(curH - h) > 1) {
    console.log(`[widget] resizing: current=${curH} -> want=${h} (natural=${widgetNaturalH}, max=${maxH})`);
    // resizable:false makes Windows clamp every resize back to the current
    // size (WM_GETMINMAXINFO) — lift it for the programmatic resize only
    widget.setResizable(true);
    widget.setSize(WIDGET_W, h);
    widget.setPosition(bounds.x, bounds.y); // setSize can drift on transparent windows
    widget.setResizable(false);
    buryWidget(); // setResizable can re-raise the window; re-bury it
    console.log(`[widget] after setSize: ${widget.getSize()[1]}`);
  } else {
    console.log(`[widget] height ok: ${curH} (natural=${widgetNaturalH}, max=${maxH})`);
  }
}

function persistWidgetPos() {
  if (!widget || widget.isDestroyed()) return;
  if (widgetPosTimer) clearTimeout(widgetPosTimer);
  widgetPosTimer = setTimeout(() => {
    widgetPosTimer = null;
    if (!widget || widget.isDestroyed()) return;
    const [wx, wy] = widget.getPosition();
    writeJson(winStatePath(), { ...(readJson(winStatePath()) || {}), widgetX: wx, widgetY: wy });
    applyWidgetHeight(); // re-clamp after a drag (e.g. toward the screen bottom)
  }, 400);
}

function createWidget() {
  if (widget && !widget.isDestroyed()) {
    widget.show();
    return;
  }
  const st = readJson(winStatePath()) || {};
  const wa = screen.getPrimaryDisplay().workArea;
  let x = Number.isFinite(st.widgetX) ? st.widgetX : wa.x + wa.width - WIDGET_W - 14;
  let y = Number.isFinite(st.widgetY) ? st.widgetY : wa.y + 14;
  x = Math.min(Math.max(x, wa.x + 4), wa.x + wa.width - WIDGET_W - 4);
  y = Math.min(Math.max(y, wa.y + 4), wa.y + wa.height - 80);
  widgetNaturalH = 0; // fresh widget: wait for the renderer's real measurement

  const state = store.getPortfolioState();
  widget = new BrowserWindow({
    width: WIDGET_W,
    height: widgetHeight(state),
    x,
    y,
    frame: false,
    transparent: true,
    resizable: false,
    movable: true,
    alwaysOnTop: false, // background app: never above other windows
    focusable: false, // clicks never activate/raise it
    skipTaskbar: true,
    show: false,
    title: 'Widget',
    webPreferences: {
      preload: path.join(__dirname, 'preload-widget.js'),
      contextIsolation: true,
      nodeIntegration: false,
      spellcheck: false
    }
  });
  widget.loadFile(path.join(__dirname, 'renderer', 'widget.html'));
  widget.once('ready-to-show', () => {
    if (widget && !widget.isDestroyed()) {
      widget.show();
      buryWidget();
    }
  });
  widget.on('show', () => buryWidget());
  widget.on('moved', () => persistWidgetPos());
  widget.on('closed', () => {
    widget = null;
    broadcast('widget:changed', { enabled: false });
    scheduleTrayUpdate(0);
  });
  store.saveSettings({ widgetEnabled: true });
  broadcast('widget:changed', { enabled: true });
  scheduleTrayUpdate(0);
  console.log('[widget] created');
}

function destroyWidget() {
  console.log('[widget] destroy requested');
  store.saveSettings({ widgetEnabled: false });
  if (widget && !widget.isDestroyed()) widget.close();
  broadcast('widget:changed', { enabled: false });
  scheduleTrayUpdate(0);
}

// execFile needs a REAL file on disk, so the helper is unpacked from the
// asar in packaged builds (build.asarUnpack mirrors this path).
const SEND_BEHIND = path
  .join(__dirname, 'assets', 'send-behind.exe')
  .replace('app.asar', 'app.asar.unpacked');

const WIN_FRAME = path
  .join(__dirname, 'assets', 'win-frame.exe')
  .replace('app.asar', 'app.asar.unpacked');

/* A transparent window is created WITHOUT WS_THICKFRAME, which leaves the
   native maximize/restore, drag-resize and Aero Snap inert. Electron exposes
   no style-bit API, so a tiny bundled helper ORs WS_THICKFRAME back in by
   PID (it finds the main Chrome_WidgetWin_1 window itself). Safe to call a
   moment after the window is created; never activates or moves the window. */
function restoreFrameStyles() {
  if (!win || win.isDestroyed() || process.platform !== 'win32') return;
  if (!fs.existsSync(WIN_FRAME)) return;
  try {
    execFile(WIN_FRAME, [String(process.pid)], { windowsHide: true }, (err) => {
      if (err) console.warn('[window] win-frame failed:', err.message);
    });
  } catch (err) {
    console.warn('[window] win-frame error:', err.message);
  }
}

/* Push the widget into the desktop's z-band: above the wallpaper layer
   (Progman/WorkerW) but below every application window. Uses the tiny
   bundled helper because Electron has no "send to back" API. */
function buryWidget() {
  if (!widget || widget.isDestroyed() || process.platform !== 'win32') return;
  if (!fs.existsSync(SEND_BEHIND)) return;
  try {
    const hwnd = widget.getNativeWindowHandle().readBigUInt64LE(0).toString();
    execFile(SEND_BEHIND, [hwnd], { windowsHide: true }, (err) => {
      if (err) console.warn('[widget] send-behind failed:', err.message);
    });
  } catch (err) {
    console.warn('[widget] send-behind error:', err.message);
  }
}

/* ---------------- fullscreen (via the native maximize button) ----------------
   The titlebar's maximize button IS the fullscreen button: "maximize" puts
   the window into a real, screen-covering fullscreen (setFullScreen) and
   "restore" brings it back to its normal bounds. The native maximize/restore
   state is persisted like a normal window, so a restart remembers it.
   The Fullscreen topbar button, F11, and Esc stay as shortcuts into the
   same maximize/restore path.
   (The isFullScreen() flag on this build is unreliable, so fsActive is the
   source of truth and scheduleFsRestore force-restores the normal bounds
   if an exit leaves the window stuck at screen size. */
function captureFsBounds() {
  if (!win || win.isDestroyed() || win.isMaximized()) return; // maximized: Windows restores that state itself
  const b = win.getBounds();
  const d = screen.getDisplayMatching(b);
  if (b.width >= d.bounds.width && b.height >= d.bounds.height) return; // already fullscreen-sized
  preFsBounds = b;
}

function enterFullscreen() {
  if (!win || win.isDestroyed()) return;
  fsGen++;
  captureFsBounds();
  fsActive = true;
  win.webContents.send('window:fullscreen', { fullscreen: true });
  win.setFullScreen(true);
}

function exitFullscreen() {
  if (!win || win.isDestroyed()) return;
  fsGen++;
  win.setFullScreen(false); // a real exit on platforms that honor it
  scheduleFsRestore();      // guaranteed: restore bounds, broadcast, persist
}

function scheduleFsRestore() {
  if (fsCheckTimer) clearTimeout(fsCheckTimer);
  const gen = fsGen;
  fsCheckTimer = setTimeout(() => {
    fsCheckTimer = null;
    if (gen !== fsGen) return; // superseded by a newer toggle
    if (!win || win.isDestroyed() || win.isFullScreen()) return;
    const b = win.getBounds();
    const d = screen.getDisplayMatching(b);
    if (b.width >= d.bounds.width && b.height >= d.bounds.height && preFsBounds) win.setBounds(preFsBounds);
    preFsBounds = null;
    if (fsActive) {
      fsActive = false;
      win.webContents.send('window:fullscreen', { fullscreen: false });
    }
    persistWindowState();
  }, 800);
}

/* ---------------- window ---------------- */

function createWindow() {
  // No menu bar — the app is a single self-contained surface.
  // (DevTools remain reachable by launching with --remote-debugging-port.)
  Menu.setApplicationMenu(null);

  // Native window controls (minimize / maximize / close) are drawn by
  // Windows in the top-right corner; F11/Esc still give a true fullscreen.
  // On Windows the window stays a transparent acrylic pane, so the glass
  // theme keeps working underneath the native controls.
  const rb = restoredBounds();

  // The titlebar is hidden but Windows still draws the real minimize /
  // maximize / close buttons in the top-right corner (over the app's own
  // topbar) via titleBarStyle:'hidden' + titleBarOverlay, and the acrylic
  // glass keeps working because the window stays transparent.
  // NOTE: a transparent window is created WITHOUT WS_THICKFRAME (style
  // 0x14030000), so maximize/restore, drag-resize and Aero Snap are inert
  // until we OR the thickframe bit back in with the bundled win-frame
  // helper below (Electron's setResizable/setMaximizable only add
  // WS_MAXIMIZEBOX, not WS_THICKFRAME). F11/Esc still give a true fullscreen.
  win = new BrowserWindow({
    width: rb.width,
    height: rb.height,
    ...(rb.x !== undefined ? { x: rb.x, y: rb.y } : {}),
    minWidth: 760,
    minHeight: 520,
    show: false,
    title: 'Portfolio Candles',
    icon: path.join(__dirname, 'assets', 'icon.ico'),
    titleBarStyle: 'hidden',
    titleBarOverlay: { color: '#141a29', symbolColor: '#c9d2e4', height: 40 },
    ...(process.platform === 'win32'
      ? { transparent: true, backgroundMaterial: 'acrylic', backgroundColor: '#00000000' }
      : { backgroundColor: '#0b0e14' }),
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      spellcheck: false
    }
  });

  // Belt-and-suspenders: make sure the window stays resizable and maximizable
  // (the native overlay buttons drive both).
  win.setResizable(true);
  win.setMaximizable(true);

  win.loadFile(path.join(__dirname, 'renderer', 'index.html'));
  win.once('ready-to-show', () => {
    win.show();
    // OR in WS_THICKFRAME (async), then honor a restored maximized state.
    restoreFrameStyles();
    setTimeout(() => {
      if (rb.maximized && win && !win.isDestroyed()) win.maximize();
    }, 250);
  });

  win.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:\/\//i.test(url)) shell.openExternal(url);
    return { action: 'deny' };
  });

  // Right-click editing menu (no menu bar, so provide it contextually).
  win.webContents.on('context-menu', (event, params) => {
    const items = [];
    if (params.isEditable) {
      items.push(
        { role: 'undo' },
        { role: 'redo' },
        { type: 'separator' },
        { role: 'cut' },
        { role: 'copy' },
        { role: 'paste' },
        { type: 'separator' },
        { role: 'selectAll' }
      );
    } else if (params.selectionText) {
      items.push({ role: 'copy' });
    }
    if (items.length) {
      Menu.buildFromTemplate(items).popup({ window: win, x: params.x, y: params.y });
    }
  });

  // Closing hides to the tray so the app can sit quietly in the background.
  win.on('close', (e) => {
    if (!quitting) {
      e.preventDefault();
      win.hide();
    }
  });

  win.on('resize', () => persistWindowState());
  win.on('move', () => persistWindowState());
  win.on('close', () => persistWindowState(true));

  // Native maximize/restore (the standard titlebar button) behaves like any
  // Windows app: maximize fills the work area, restore brings back the saved
  // bounds — and the state is persisted so a restart returns to it.
  // (F11 still gives a true, screen-covering fullscreen via enterFullscreen.)
  win.on('maximize', () => persistWindowState(true));
  win.on('unmaximize', () => persistWindowState(true));

  win.on('closed', () => {
    win = null;
  });
}

function showWindow() {
  if (!win || win.isDestroyed()) {
    createWindow();
    return;
  }
  if (win.isMinimized()) win.restore();
  win.show();
  win.focus();
}

function toggleWindow() {
  if (!win || win.isDestroyed()) {
    createWindow();
  } else if (win.isVisible() && win.isFocused()) {
    win.hide();
  } else {
    showWindow();
  }
}

/* ---------------- tray ---------------- */

function money(n) {
  return '$' + Math.round(n).toLocaleString('en-US');
}

function portfolioValue(positions) {
  if (!market || !positions.length) return null;
  let total = 0;
  let any = false;
  for (const p of positions) {
    const q = market.quotes.get(p.symbol);
    if (q) {
      total += q.price * p.quantity;
      any = true;
    } else {
      total += p.avgCost * p.quantity;
    }
  }
  return any ? total : null;
}

function updateTrayMenu() {
  if (!tray || tray.isDestroyed?.()) return;
  const doc = store.getPortfolioState();
  const active = doc.list.find((p) => p.id === doc.activeId);

  const items = doc.list.map((entry) => {
    const value = portfolioValue(store.getPositions(entry.id));
    const label = value == null ? entry.name : `${entry.name}   ${money(value)}`;
    return {
      label,
      type: 'radio',
      checked: entry.id === doc.activeId,
      click: () => selectPortfolio(entry.id)
    };
  });

  const menu = Menu.buildFromTemplate([
    { label: win && win.isVisible() ? 'Hide window' : 'Show window', click: toggleWindow },
    {
      label: 'Desktop widget',
      type: 'checkbox',
      checked: Boolean(widget && !widget.isDestroyed()),
      click: () => {
        console.log('[widget] toggle from tray menu');
        if (widget && !widget.isDestroyed()) destroyWidget();
        else createWidget();
      }
    },
    { type: 'separator' },
    ...(items.length ? items : [{ label: 'No portfolios', enabled: false }]),
    { type: 'separator' },
    { label: 'Quit Portfolio Candles', click: () => app.quit() }
  ]);
  tray.setContextMenu(menu);

  const activeValue = portfolioValue(store.getPositions(doc.activeId));
  tray.setToolTip(
    active
      ? `Portfolio Candles — ${active.name}${activeValue != null ? ` · ${money(activeValue)}` : ''}`
      : 'Portfolio Candles'
  );
}

function scheduleTrayUpdate(delay = 8000) {
  if (trayTimer) return;
  trayTimer = setTimeout(() => {
    trayTimer = null;
    updateTrayMenu();
  }, delay);
}

function createTray() {
  try {
    const img = nativeImage.createFromPath(path.join(__dirname, 'assets', 'icon.png'));
    tray = new Tray(img.isEmpty() ? nativeImage.createEmpty() : img.resize({ width: 16, height: 16 }));
    tray.setToolTip('Portfolio Candles');
    tray.on('click', () => toggleWindow());
    tray.on('double-click', () => showWindow());
    updateTrayMenu();
    console.log('[tray] created');
  } catch (err) {
    console.error('[tray] failed:', err);
  }
}

function selectPortfolio(id) {
  try {
    if (id !== store.getPortfolioState().activeId) {
      syncPortfolio(store.setActivePortfolio(id));
    }
    showWindow();
  } catch (err) {
    console.error('[portfolio] select failed:', err);
  }
}

/* ---------------- portfolio plumbing ---------------- */

function syncPortfolio(state) {
  market.setPortfolio(state.positions);
  broadcast('portfolio:changed', state);
  if (widget && !widget.isDestroyed()) applyWidgetHeight();
  updateTrayMenu();
  return state;
}

function applyAutoLaunch() {
  try {
    const enabled = Boolean(store.getSettings().startWithWindows);
    app.setLoginItemSettings({ openAtLogin: enabled, path: process.execPath, name: 'Portfolio Candles' });
  } catch (err) {
    console.warn('[autolaunch]', err.message);
  }
}

/* ---------------- ipc ---------------- */

function registerIpc() {
  ipcMain.handle('portfolios:get', () => store.getPortfolioState());

  ipcMain.handle('portfolios:create', (_event, name) => syncPortfolio(store.createPortfolio(name)));

  ipcMain.handle('portfolios:rename', (_event, { id, name }) =>
    syncPortfolio(store.renamePortfolio(id, name))
  );

  ipcMain.handle('portfolios:delete', (_event, id) => syncPortfolio(store.deletePortfolio(id)));

  ipcMain.handle('portfolios:setActive', (_event, id) => syncPortfolio(store.setActivePortfolio(id)));

  ipcMain.handle('portfolio:save', (_event, pos) => syncPortfolio(store.savePosition(pos)));

  ipcMain.handle('portfolio:delete', (_event, symbol) => syncPortfolio(store.deletePosition(symbol)));

  ipcMain.handle('settings:get', () => store.getSettings());

  ipcMain.handle('settings:save', (_event, patch) => {
    const settings = store.saveSettings(patch || {});
    market.applySettings();
    applyAutoLaunch();
    broadcast('settings:changed', settings);
    return settings;
  });

  ipcMain.handle('settings:test', (_event, apiKey) => market.testConnection(apiKey));

  ipcMain.handle('market:status', () => market.getStatus());

  ipcMain.handle('candles:get', (_event, { symbol, timeframe }) =>
    market.loadCandles(symbol, timeframe)
  );

  ipcMain.handle('quotes:get', (_event, symbols) => market.getQuotes(symbols || []));

  ipcMain.handle('profile:get', (_event, symbol) => market.getProfile(symbol));

  ipcMain.on('watch:symbol', (_event, symbol) => market.watch(symbol));

  ipcMain.handle('widget:get', () => ({ enabled: Boolean(widget && !widget.isDestroyed()) }));

  ipcMain.on('window:fullscreen-toggle', () => {
    if (!win || win.isDestroyed()) return;
    if (fsActive || win.isFullScreen()) exitFullscreen();
    else enterFullscreen();
  });

  ipcMain.on('window:fullscreen-set', (_event, enabled) => {
    if (!win || win.isDestroyed()) return;
    if (enabled) {
      if (!fsActive && !win.isFullScreen()) enterFullscreen();
    } else if (fsActive || win.isFullScreen()) {
      exitFullscreen();
    }
  });

  ipcMain.handle('window:fullscreen-get', () => Boolean(win && !win.isDestroyed() && (fsActive || win.isFullScreen())));

  ipcMain.handle('widget:set', (_event, enabled) => {
    console.log(`[widget] set from renderer: ${enabled}`);
    if (enabled) createWidget();
    else destroyWidget();
    return { enabled: Boolean(widget && !widget.isDestroyed()) };
  });

  ipcMain.on('widget:height', (_event, height) => {
    const n = Math.round(Number(height));
    if (!Number.isFinite(n) || n <= 0) return;
    widgetNaturalH = n;
    console.log(`[widget] natural height reported: ${n}px`);
    applyWidgetHeight();
  });

  ipcMain.on('widget:open', (_event, symbol) => {
    showWindow();
    if (typeof symbol === 'string' && symbol) broadcast('app:open-symbol', symbol);
  });

  ipcMain.on('widget:close', () => {
    console.log('[widget] close from widget renderer');
    destroyWidget();
  });
}

/* ---------------- lifecycle ---------------- */

// Test hook: run against an isolated data directory (never touches real data).
app.whenReady().then(() => {
  store = new Store(app.getPath('userData'));
  market = new Market(store);

  market.on('quote', (quote) => {
    broadcast('market:quote', quote);
    scheduleTrayUpdate();
  });
  market.on('status', (status) => {
    broadcast('market:status', status);
    scheduleTrayUpdate(2000);
  });

  registerIpc();
  createWindow();
  createTray();
  applyAutoLaunch();
  if (store.getSettings().widgetEnabled) createWidget();
  market.start().catch((err) => console.error('[market] start failed:', err));

  // Dev helper: PC_SCREENSHOT=path.png captures the window (and exits when
  // PC_SCREENSHOT_EXIT=1). Used for automated visual checks.
  if (process.env.PC_SCREENSHOT) {
    const target = process.env.PC_SCREENSHOT;
    const delay = Number(process.env.PC_SCREENSHOT_DELAY || 16000);
    setTimeout(async () => {
      try {
        const image = await win.webContents.capturePage();
        fs.writeFileSync(target, image.toPNG());
        console.log('[capture] saved', target);
      } catch (err) {
        console.error('[capture] failed:', err);
      }
      if (process.env.PC_SCREENSHOT_EXIT) app.quit();
    }, delay);
  }

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on('before-quit', () => {
  quitting = true;
  persistWindowState(true);
  if (trayTimer) clearTimeout(trayTimer);
  if (market) market.stop();
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});
