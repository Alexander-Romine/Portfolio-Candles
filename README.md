# Portfolio Candles

A desktop app that shows your portfolio in live candlestick charts — TradingView-style
candles, real prices, and a running total of what your holdings are worth.

![app](screenshot.png)

## What you get

- **Candlestick chart** with volume bars, crosshair OHLC readout, and mouse-wheel zoom / drag-to-pan
- **Timeframes:** 1D (5-min bars) · 5D (30-min) · 1M (hourly) · 6M / 1Y / 5Y (daily)
- **Live updates** — the forming candle moves with every new quote, prices update in place
- **Portfolio sidebar** — value, day change, overall gain/loss, per-position P/L %
- **Add positions your way** — by **shares + avg cost**, or just by **the dollar amount you own** (e.g. "$5,000 of AAPL", priced at the current market price)
- **In-app portfolio editor** — add / edit / remove positions, saved automatically
- **Multiple portfolios** — create, rename, switch, and delete them in the sidebar; each keeps its own positions and selected chart
- **Remembers your window** — size, position, and maximized state persist across restarts; shrink it as small as 760×520
- **Native window controls** — real Windows minimize / maximize / close buttons in the title bar (the acrylic glass look is kept); the window snaps and resizes like any normal app
- **Fullscreen** — press **F11** to fill the screen; **Esc** leaves again. Your normal window size and position always survive a fullscreen session. The widget stays a background panel — fullscreen applies to the main window only
- **Desktop widget** — a slim, frameless, ultra-transparent glass panel docked to the right edge of your desktop showing your portfolio value and every position's price/change. It behaves like a background app: always **behind every other window** (never in your way, wallpaper shows through it), and clicking it doesn't bring it forward. It **grows downward to fit every position** (capped at the screen, with scrolling if you have a mountain of them). Click a row to open the full chart; drag its header to reposition; ✕ removes it. Toggle with the **Widget** button or the tray menu
- **Glass theme** — ultra-transparent frosted-acrylic on Windows 11: whisper-thin panels with strong blur so the blurred desktop glows through everywhere; soft text halos keep everything readable over any wallpaper
- **Lives in the tray** — closing (✕) hides to the tray instead of quitting; the tray menu lists your portfolios **with their current value**, so one click checks a portfolio. Left-click the tray icon to show/hide the window
- **Start with Windows** (optional, in Settings) — launches quietly into the tray at sign-in
- **Three data modes** (Settings → Data mode):

| Mode | When | What you see |
|---|---|---|
| **Live** | Automatic + an API key is set | True real-time US trade prints from Finnhub's WebSocket |
| **Delayed** | Automatic, no key yet | Real prices polled from Yahoo Finance every 30 s |
| **Simulated demo** | Chosen explicitly | Fake ticks for trying the app; chart history stays real |

Even with a bad or missing key the app keeps working — quotes fall back to Yahoo so
prices never freeze.

## Install

Download from the [Releases page](../../releases):

- **`Portfolio Candles Setup <version>.exe`** — one-click installer. It installs just
  for your user account (no admin needed), adds Desktop and Start Menu shortcuts, and
  can be uninstalled from Windows Settings > Apps.

> Windows SmartScreen may show "Windows protected your PC" on first run because the
> app isn't code-signed. Click **More info → Run anyway**.

Data lives in `%APPDATA%\Portfolio Candles\` (`portfolio.json` + `settings.json` +
`window-state.json`).

## Portfolios

The picker at the top of the sidebar controls which portfolio is shown:

- **+** creates a new (empty) portfolio and switches to it
- **✎** renames the current one · **×** deletes it (the last portfolio can't be deleted)
- Switching is instant — positions, totals, chart symbol, and the tray menu follow along
- In the tray menu every portfolio shows its **live value**; click one to open the app on it

## Feed it your portfolio

1. Click **+ Add position**
2. Pick how you track it under **Track by**:
   - **Shares** — enter share count + average cost per share (full P/L history)
   - **Amount ($)** — enter just the dollar amount you own (e.g. `5000`); it's priced
     at the current market price. Day change and totals still update live; overall
     gain/loss starts at 0% since no cost history is entered
3. Save — it persists across restarts. Hover a row for edit (✎) and remove (×).
   Editing an amount position reopens it in amount mode with the dollar figure.

Want to bulk-import? Edit `%APPDATA%\Portfolio Candles\portfolio.json` directly:

```json
{
  "version": 2,
  "activeId": "pf_main",
  "portfolios": [
    {
      "id": "pf_main",
      "name": "Long term",
      "positions": [
        { "symbol": "AAPL", "quantity": 25, "avgCost": 172.4 },
        { "symbol": "NVDA", "quantity": 40, "avgCost": 118.2, "amountMode": true }
      ]
    }
  ]
}
```

`amountMode: true` marks a position you entered by dollar amount (shares/avgCost
are derived from the price at entry). The file is rewritten on every change, so
edits stick once saved from the app. The old single-list format (v1) is migrated
automatically on first launch.

## Enable true live data (free, ~1 min)

1. Sign up at [finnhub.io/register](https://finnhub.io/register) — no credit card
2. Copy your API key
3. In the app: **Settings → paste key → Test connection → Save**
4. The status pill switches from `DELAYED · 30s` to `LIVE · FINNHUB`

Free tier = 60 requests/min and real-time US equities. The app polls politely and
only fills gaps the WebSocket doesn't cover.

## Build from source

Requires [Node.js](https://nodejs.org) 18+.

```powershell
npm install          # once (Electron needs approval of its install script, see below)
npm start            # launch the app
npm run dist         # build the installer into dist/
```

> **Note (npm ≥ 11):** npm blocks Electron's post-install script by default. If
> `node_modules/electron/dist/electron.exe` is missing after install, run:
> `npm install-scripts approve electron; node node_modules/electron/install.js`

### Dev & test scripts

| Command | Purpose |
|---|---|
| `node scripts/smoke.js` | Headless test of quotes/candles/profiles in all modes |
| `node scripts/store-test.js` | Portfolio CRUD + v1→v2 data migration (isolated temp dirs) |
| `node scripts/ui-test.js` | Drives the app over CDP in an isolated profile (`PC_USER_DATA`): timeframes, symbol switch, modals, portfolio create/switch/delete, start-with-Windows toggle, **amount-mode add/edit/remove**, **widget open/click-to-open/close**, **fullscreen enter/exit via F11 and Esc (with bounds restore)**, **native maximize/restore**, demo ticks. Prints `NO JS ERRORS`, screenshots → `%TEMP%\pc-ui` |
| `node scripts/widget-diag.js` | Inspects a running widget window over CDP (rows, value, JS errors) |
| `powershell -File scripts/winstate-verify.ps1 -Exe <electron.exe> -Dir .` | Proves window size/position persistence: resize → hard-kill → relaunch → compare |
| `powershell -File scripts/zorder-verify.ps1 -Exe <electron.exe> -Dir .` | Proves the widget sits below all apps, above the desktop layer, not topmost, and still receives clicks |
| `powershell -File scripts/widget-size-verify.ps1 -Exe <electron.exe> -Dir . [-Screenshots]` | Proves the widget's content-driven height: grows for 12 positions, clamps at the screen bottom |
| `PC_CDP_PORT=9224 node scripts/widget-probe.js` | CDP probe of a running widget: api surface, measured content height, console errors |
| `node scripts/repair-data.js` | Rebuilds the default portfolio in `%APPDATA%\Portfolio Candles` |
| `powershell -File scripts/make-icon.ps1` | Regenerates `assets/icon.ico` |
| `PC_SCREENSHOT=%TEMP%\x.png PC_SCREENSHOT_EXIT=1 npx electron .` | Self-capture of the window (dev) |
| `npm run pack` | Unpacked build (no installer) |
| `npm run dist` | NSIS installer → `dist\` |

## Layout

```
main.js            Electron main: acrylic window, tray + portfolio menu, close-to-tray,
                   window-state persistence, desktop widget window, IPC
preload.js         contextBridge API (renderer never touches Node or the key)
preload-widget.js  contextBridge API for the widget window (read-only + open/close)
lib/store.js       settings.json + portfolio.json (atomic writes, self-healing)
lib/market.js      Finnhub WS + REST, Yahoo fallback, demo engine, candle loading
renderer/index.html  app shell
renderer/chart.js  Lightweight Charts wrapper, NY-session candle bucketing
renderer/app.js    UI: sidebar, header, modals, live quote routing
renderer/widget.html / widget.css / widget.js   desktop widget panel
scripts/SendBehind.cs  source of the z-order helper (compiled with the in-box
                   .NET csc.exe → assets/send-behind.exe, unpacked from the
                   asar at build time — used to bury the widget behind apps)
scripts/WinFrame.cs  source of the frame-style helper (compiled the same way →
                   assets/win-frame.exe, unpacked at build time — restores
                   WS_THICKFRAME on the acrylic window so native maximize,
                   snap, and drag-resize work)
```

## Desktop widget

The **Widget** button (top bar) or tray menu → **Desktop widget** pins a slim
glass panel to the right edge of your desktop:

- Shows the active portfolio's name, total value, day change, and every position
  with price + change % (green/red)
- **Click a row** → the full app opens on that symbol's chart · **Open app** or
  double-click the header → just opens the app
- **Drag the header** to move it — the position is remembered
- **It grows downward** to fit every position: the panel measures its own
  content and the window expands (or shrinks) to match — anchored at the top,
  so dragging it near the screen bottom clamps it to the work area instead of
  letting it hang off-screen (the list scrolls there)
- **✕** removes it; the setting persists, so it returns on next launch if left on
- It's a **background app**: the window is non-focusable and is pushed, via a tiny
  bundled Win32 helper (`assets/send-behind.exe`), into the z-band just above the
  desktop wallpaper layer — so every application window stays above it and it
  never pops in front of your work. Clicks on it don't raise it either; if the
  wallpaper itself covers that band, it hides behind the wallpaper rather than
  jumping forward

## Notes & limits

- Candles come from Yahoo Finance (and Finnhub when a key is set); quotes are
  Finnhub (live) or Yahoo (delayed). No broker connection — you enter positions yourself.
- Live ticks only fold into candles during regular hours (09:30–16:00 ET); outside
  that, prices still update in the header and sidebar.
- Historical data for non-US listings depends on Yahoo having the symbol (most
  major exchanges are covered).

## Troubleshooting

- **The window vanished** — ✕ hides to the tray instead of quitting. Left-click the tray
  icon (or the desktop shortcut) to reopen it; right-click the tray icon →
  **Quit Portfolio Candles** to exit fully.
- **The window came back at the wrong size** — size/position are saved on resize/move
  (and on quit); a hard kill (task manager) can lose the last change. Just resize it
  again — it sticks from then on.
- **The widget is stuck on screen** — click its ✕, or tray menu → **Desktop widget**
  (uncheck). It never starts with Windows unless the app itself does.
- **Pill shows `RECONNECTING…`** — Finnhub's socket dropped; it retries with backoff
  and quotes fall back to Yahoo meanwhile.
- **A symbol shows no chart** — check the ticker (Yahoo symbology, e.g. `BRK-B`,
  `MSFT`), then try a longer timeframe.
- **Reset everything** — quit the app and delete `%APPDATA%\Portfolio Candles\`.
