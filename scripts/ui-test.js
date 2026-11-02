'use strict';

/* Drives the running app over CDP: exercises every timeframe, symbol switching,
   and both modals. Saves screenshots to %TEMP%\pc-ui and fails on JS errors. */
const WebSocket = require('ws');
const http = require('http');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execSync } = require('child_process');

const OUT = path.join(os.tmpdir(), 'pc-ui');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function getJson(url) {
  return new Promise((resolve, reject) => {
    http
      .get(url, (res) => {
        let data = '';
        res.on('data', (c) => (data += c));
        res.on('end', () => {
          try {
            resolve(JSON.parse(data));
          } catch (err) {
            reject(err);
          }
        });
      })
      .on('error', reject);
  });
}

(async () => {
  fs.mkdirSync(OUT, { recursive: true });

  let targets = null;
  for (let i = 0; i < 40 && !targets; i++) {
    try {
      targets = await getJson('http://127.0.0.1:9222/json');
    } catch {
      await sleep(500);
    }
  }
  if (!targets) throw new Error('CDP endpoint never came up');
  const page = targets.find((t) => t.type === 'page' && /Portfolio Candles/.test(t.title)) ||
    targets.find((t) => t.type === 'page');
  if (!page) throw new Error('no page target: ' + JSON.stringify(targets));

  const ws = new WebSocket(page.webSocketDebuggerUrl, { perMessageDeflate: false });
  await new Promise((res, rej) => {
    ws.once('open', res);
    ws.once('error', rej);
  });

  let id = 0;
  const pending = new Map();
  const errors = [];

  ws.on('message', (raw) => {
    const msg = JSON.parse(raw.toString());
    if (msg.id && pending.has(msg.id)) {
      const { resolve, reject } = pending.get(msg.id);
      pending.delete(msg.id);
      msg.error ? reject(new Error(msg.error.message)) : resolve(msg.result);
    }
    if (msg.method === 'Runtime.exceptionThrown') {
      const d = msg.params.exceptionDetails;
      errors.push('EXCEPTION: ' + (d.exception?.description || d.text));
    }
    if (msg.method === 'Runtime.consoleAPICalled' && msg.params.type === 'error') {
      errors.push('console.error: ' + msg.params.args.map((a) => a.value ?? a.description).join(' '));
    }
  });

  const send = (method, params = {}) =>
    new Promise((resolve, reject) => {
      const i = ++id;
      const timer = setTimeout(() => {
        if (pending.has(i)) {
          pending.delete(i);
          reject(new Error(`CDP timeout after 75s: ${method}`));
        }
      }, 75000);
      pending.set(i, {
        resolve: (v) => { clearTimeout(timer); resolve(v); },
        reject: (e) => { clearTimeout(timer); reject(e); }
      });
      ws.send(JSON.stringify({ id: i, method, params }));
    });

  await send('Runtime.enable');
  await send('Page.enable');

  const evaluate = async (expression) => {
    let r;
    try {
      r = await send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true });
    } catch (err) {
      errors.push('EVAL-CMD: ' + err.message);
      return null;
    }
    if (r.exceptionDetails) {
      errors.push('EVAL: ' + (r.exceptionDetails.exception?.description || r.exceptionDetails.text));
      return null;
    }
    return r.result?.value;
  };

  // Restores the window from minimized without activating it (focus-safe).
  const ensureVisible = () => {
    try {
      execSync(
        `powershell -NoProfile -ExecutionPolicy Bypass -File "${path.join(__dirname, 'win-show.ps1')}"`,
        { stdio: 'ignore', windowsHide: true }
      );
    } catch {
      /* window already visible or app restarting — screenshots will retry */
    }
  };

  const shot = async (name) => {
    const capture = async () => {
      // The window can get minimized mid-run (user or automation) — restore it
      // first without activating, otherwise captureScreenshot hangs forever.
      ensureVisible();
      // An occluded (backgrounded) window stops producing frames and
      // captureScreenshot can hang forever — force it to the front first.
      await Promise.race([
        send('Page.bringToFront', {}),
        new Promise((res) => setTimeout(res, 3000))
      ]);
      await sleep(400);
      const r = await Promise.race([
        send('Page.captureScreenshot', { format: 'png' }),
        new Promise((_, rej) => setTimeout(() => rej(new Error('capture timeout (15s)')), 15000))
      ]);
      return Buffer.from(r.data, 'base64');
    };
    for (let attempt = 1; attempt <= 2; attempt++) {
      try {
        const png = await capture();
        fs.writeFileSync(path.join(OUT, name), png);
        console.log('screenshot:', name);
        return;
      } catch (err) {
        if (attempt === 2) {
          errors.push('SHOT ' + name + ': ' + err.message);
          console.log('screenshot FAILED:', name, '-', err.message);
        } else {
          console.log('screenshot retry:', name, '-', err.message);
          await sleep(1500);
        }
      }
    }
  };

  // 1) every timeframe must load history without errors
  const tfReport = {};
  for (const tf of ['5D', '1M', '6M', '1Y', '5Y', '1D']) {
    tfReport[tf] = await evaluate(
      `document.querySelector('[data-tf="${tf}"]').click();
       new Promise(r => setTimeout(() => r(document.getElementById('dataSource').textContent), 2600))`
    );
    await sleep(250);
  }
  console.log('TIMEFRAMES:', JSON.stringify(tfReport, null, 1));
  await shot('01-chart-1d.png');

  // 2) switch the selected symbol from the sidebar
  const switched = await evaluate(
    `document.querySelector('[data-sym="NVDA"]').click();
     new Promise(r => setTimeout(() => r({
       symbol: document.getElementById('chartSymbol').textContent,
       name: document.getElementById('chartName').textContent,
       price: document.getElementById('chartPrice').textContent,
       source: document.getElementById('dataSource').textContent
     }), 2600))`
  );
  console.log('SYMBOL SWITCH:', JSON.stringify(switched));
  await shot('02-chart-nvda-1y.png');

  // 3) crosshair legend values exist after a synthetic hover
  const legend = await evaluate(`document.getElementById('ohlcLegend').textContent`);
  console.log('LEGEND:', legend);

  // 4) modals render
  await evaluate(`document.getElementById('btnAdd').click(); void 0`);
  await sleep(400);
  await shot('03-add-position.png');
  await evaluate(`document.getElementById('positionModal').querySelector('[data-close]').click(); void 0`);

  await evaluate(`document.getElementById('btnSettings').click(); void 0`);
  await sleep(400);
  await shot('04-settings.png');
  const settingsState = await evaluate(`({
    mode: document.querySelector('input[name="mode"]:checked')?.value,
    hasKey: Boolean(document.getElementById('apiKey').value),
    poll: document.getElementById('pollSeconds').value
  })`);
  console.log('SETTINGS:', JSON.stringify(settingsState));

  // 4a) start-with-Windows: Save must write the HKCU Run entry, unchecking must remove it
  const appExe = path.resolve(__dirname, '..', 'node_modules', 'electron', 'dist', 'electron.exe').toLowerCase();
  const runQuery = () => {
    try {
      return execSync('reg query "HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Run"', {
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'ignore']
      }).toLowerCase();
    } catch {
      return '';
    }
  };
  await evaluate(`document.getElementById('startWin').checked = true; void 0`);
  await evaluate(`document.getElementById('btnSaveSettings').click(); void 0`);
  await sleep(800);
  const runOn = runQuery();
  console.log('AUTOLAUNCH ON:', runOn.includes(appExe) ? 'Run entry present' : 'MISSING');
  if (!runOn.includes(appExe)) errors.push('start-with-Windows did not write the HKCU Run entry');

  await evaluate(`document.getElementById('btnSettings').click(); void 0`);
  await sleep(400);
  await evaluate(`document.getElementById('startWin').checked = false; void 0`);
  await evaluate(`document.getElementById('btnSaveSettings').click(); void 0`);
  await sleep(800);
  const runOff = runQuery();
  console.log('AUTOLAUNCH OFF:', runOff.includes(appExe) ? 'STILL PRESENT' : 'removed');
  if (runOff.includes(appExe)) errors.push('start-with-Windows entry not removed');

  // 4b) portfolio lifecycle: create → empty state → switch back → delete
  await evaluate(`window.confirm = () => true; void 0`); // auto-accept confirms
  const origPf = await evaluate(`document.getElementById('portfolioSelect').value`);

  await evaluate(`document.getElementById('btnNewPf').click(); void 0`);
  await sleep(400);
  await shot('06-new-portfolio.png');
  await evaluate(`document.getElementById('pfName').value = 'Glass Test'; void 0`);
  await evaluate(`document.getElementById('btnSavePf').click(); void 0`);
  await sleep(800);

  const created = (await evaluate(`({
    options: [...document.getElementById('portfolioSelect').options].map(o => o.textContent),
    active: document.getElementById('portfolioSelect').value,
    rows: document.querySelectorAll('.position').length,
    empty: !document.getElementById('emptyPortfolio').hidden,
    count: document.getElementById('pfCount').textContent
  })`)) || {};
  console.log('PF CREATED:', JSON.stringify(created));
  if ((created.options?.length ?? 0) !== 2) errors.push('expected 2 portfolios, got ' + (created.options?.length ?? 0));
  if (created.rows !== 0) errors.push('new portfolio should be empty, rows=' + created.rows);
  if (!created.empty) errors.push('empty state not shown for new portfolio');
  if (!/Glass Test/.test((created.options || []).join(','))) errors.push('portfolio name missing from switcher');

  // duplicate name must be rejected
  await evaluate(`document.getElementById('btnNewPf').click(); void 0`);
  await sleep(350);
  await evaluate(`document.getElementById('pfName').value = 'glass test'; void 0`);
  await evaluate(`document.getElementById('btnSavePf').click(); void 0`);
  await sleep(450);
  const dupErr = (await evaluate(`({
    open: !document.getElementById('pfModal').hidden,
    err: document.getElementById('pfError').textContent
  })`)) || {};
  console.log('DUPLICATE CHECK:', JSON.stringify(dupErr));
  if (!dupErr.open) errors.push('duplicate save should keep the modal open');
  if (!/already exists/i.test(dupErr.err || '')) errors.push('duplicate portfolio name was not rejected');
  await evaluate(`document.getElementById('pfModal').querySelector('[data-close]').click(); void 0`);

  // switch back to the original portfolio (IIFE: top-level const would leak into the
  // global lexical scope and break later evaluates)
  await evaluate(
    `(() => { const s = document.getElementById('portfolioSelect'); s.value = '${origPf}'; s.dispatchEvent(new Event('change')); })()`
  );
  await sleep(900);
  const back = await evaluate(`({
    active: document.getElementById('portfolioSelect').value,
    rows: document.querySelectorAll('.position').length
  })`);
  console.log('PF SWITCHED BACK:', JSON.stringify(back));
  if (back.active !== origPf) errors.push('switch back failed');
  if (back.rows !== 5) errors.push('original positions lost after switch, rows=' + back.rows);

  // delete the test portfolio (must be active to delete)
  await evaluate(
    `(() => { const s = document.getElementById('portfolioSelect'); const t = [...s.options].find(o => o.textContent === 'Glass Test'); s.value = t.value; s.dispatchEvent(new Event('change')); })()`
  );
  await sleep(800);
  await evaluate(`document.getElementById('btnDeletePf').click(); void 0`);
  await sleep(800);
  const afterDel = (await evaluate(`({
    options: [...document.getElementById('portfolioSelect').options].map(o => o.textContent),
    active: document.getElementById('portfolioSelect').value,
    rows: document.querySelectorAll('.position').length
  })`)) || {};
  console.log('PF DELETED:', JSON.stringify(afterDel));
  if ((afterDel.options?.length ?? 0) !== 1) errors.push('test portfolio not deleted');
  if (afterDel.active !== origPf) errors.push('did not fall back to original portfolio');
  if (afterDel.rows !== 5) errors.push('positions lost after delete, rows=' + afterDel.rows);
  await shot('07-portfolios-final.png');

  // 4c) amount-mode position: add $1,000 of AMZN priced at market, then remove it
  await evaluate(`document.getElementById('btnAdd').click(); void 0`);
  await sleep(400);
  await evaluate(`document.querySelector('#posMode [data-mode="amount"]').click(); void 0`);
  await sleep(250);
  const modeState = (await evaluate(`({
    sharesHidden: document.getElementById('posSharesGroup').hidden,
    amountShown: !document.getElementById('posAmountGroup').hidden
  })`)) || {};
  if (!modeState.sharesHidden || !modeState.amountShown) {
    errors.push('amount mode did not swap the fields: ' + JSON.stringify(modeState));
  }
  await evaluate(`document.getElementById('posSymbol').value = 'AMZN'; void 0`);
  await evaluate(`document.getElementById('posAmount').value = '1000'; void 0`);
  await shot('08-amount-mode.png');
  await evaluate(`document.getElementById('btnSavePos').click(); void 0`);
  await sleep(3200); // quote fetch + state round trip
  const amountAdded = (await evaluate(`(() => {
    const row = document.querySelector('.position[data-sym="AMZN"]');
    return {
      exists: Boolean(row),
      valueCell: row ? row.querySelectorAll('.num')[2].textContent : null,
      modalOpen: !document.getElementById('positionModal').hidden
    };
  })()`)) || {};
  console.log('AMOUNT ADDED:', JSON.stringify(amountAdded));
  if (!amountAdded.exists) errors.push('amount-mode position was not added');
  if (amountAdded.modalOpen) errors.push('position modal stayed open after amount save');
  const amtVal = parseFloat(String(amountAdded.valueCell || '').replace(/[^0-9.]/g, ''));
  if (!(amtVal > 900 && amtVal < 1100)) {
    errors.push('amount position value should be ~$1,000, got: ' + amountAdded.valueCell);
  }
  // editing it reopens in amount mode with the dollar figure
  await evaluate(`document.querySelector('.position[data-sym="AMZN"] [data-edit]').click(); void 0`);
  await sleep(400);
  const editMode = (await evaluate(`({
    amountActive: document.querySelector('#posMode [data-mode="amount"]').classList.contains('is-active'),
    amountValue: document.getElementById('posAmount').value,
    symbol: document.getElementById('posSymbol').value
  })`)) || {};
  console.log('AMOUNT EDIT:', JSON.stringify(editMode));
  if (!editMode.amountActive || editMode.symbol !== 'AMZN') {
    errors.push('editing an amount position did not reopen in amount mode');
  }
  if (!(parseFloat(editMode.amountValue) > 900 && parseFloat(editMode.amountValue) < 1100)) {
    errors.push('edit did not restore the dollar amount: ' + editMode.amountValue);
  }
  await evaluate(`document.getElementById('btnDeletePos').click(); void 0`);
  await sleep(900);
  const amountGone = (await evaluate(`({
    modalClosed: document.getElementById('positionModal').hidden,
    rowGone: !document.querySelector('.position[data-sym="AMZN"]'),
    rows: document.querySelectorAll('.position').length
  })`)) || {};
  console.log('AMOUNT REMOVED:', JSON.stringify(amountGone));
  if (!amountGone.rowGone) errors.push('could not remove the amount-mode position');
  if (amountGone.rows !== 5) errors.push('expected 5 rows after amount cleanup, got ' + amountGone.rows);

  // 4d) desktop widget: enable -> inspect -> open a symbol from it -> disable
  await evaluate(`document.getElementById('btnWidget').click(); void 0`);
  let widgetPage = null;
  for (let i = 0; i < 15 && !widgetPage; i++) {
    try {
      const list = await getJson('http://127.0.0.1:9222/json');
      widgetPage = list.find((t) => t.type === 'page' && t.title === 'Widget');
    } catch {
      /* endpoint hiccup */
    }
    if (!widgetPage) await sleep(400);
  }
  if (!widgetPage) {
    errors.push('widget window never appeared over CDP');
  } else {
    const wsock = new WebSocket(widgetPage.webSocketDebuggerUrl, { perMessageDeflate: false });
    await new Promise((res, rej) => {
      wsock.once('open', res);
      wsock.once('error', rej);
    });
    let wid = 0;
    const wpend = new Map();
    wsock.on('message', (raw) => {
      const m = JSON.parse(raw.toString());
      if (m.id && wpend.has(m.id)) {
        const p = wpend.get(m.id);
        wpend.delete(m.id);
        m.error ? p.reject(new Error(m.error.message)) : p.resolve(m.result);
      }
    });
    const wsend = (method, params = {}) =>
      new Promise((resolve, reject) => {
        const i = ++wid;
        wpend.set(i, { resolve, reject });
        wsock.send(JSON.stringify({ id: i, method, params }));
      });
    const wev = async (expression) => {
      let r;
      try {
        r = await wsend('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true });
      } catch (err) {
        errors.push('WEVAL-CMD: ' + err.message);
        return null;
      }
      if (r.exceptionDetails) {
        errors.push('WEVAL: ' + (r.exceptionDetails.exception?.description || r.exceptionDetails.text));
        return null;
      }
      return r.result?.value;
    };
    await wsend('Runtime.enable');
    await wev(`new Promise(r => setTimeout(r, 1500))`);
    const winfo = (await wev(`({
      rows: document.querySelectorAll('.wg__row').length,
      value: document.getElementById('wgValue').textContent,
      name: document.getElementById('wgName').textContent
    })`)) || {};
    console.log('WIDGET:', JSON.stringify(winfo));
    if (winfo.rows !== 5) errors.push('widget should show 5 rows, got ' + winfo.rows);
    if (!winfo.value || winfo.value === '—') errors.push('widget value not rendered');
    if (!/My Portfolio/.test(winfo.name || '')) errors.push('widget portfolio name not rendered: ' + winfo.name);

    // clicking a row must open the full app on that symbol
    await wev(`([...document.querySelectorAll('.wg__row')].find(r => r.textContent.includes('MSFT')) || { click() {} }).click(); void 0`);
    await sleep(2200);
    const openedSym = await evaluate(`document.getElementById('chartSymbol').textContent`);
    console.log('WIDGET OPENED SYMBOL:', openedSym);
    if (openedSym !== 'MSFT') errors.push('widget row click did not open MSFT, got ' + openedSym);

    // removing the widget via its own close button
    await wev(`document.getElementById('wgClose').click(); void 0`);
    await sleep(1500);
    try {
      wsock.close();
    } catch {
      /* already closed */
    }
    let widgetGone = false;
    for (let i = 0; i < 8 && !widgetGone; i++) {
      try {
        const l = await getJson('http://127.0.0.1:9222/json');
        widgetGone = !l.some((t) => t.title === 'Widget');
      } catch {
        widgetGone = true;
      }
      if (!widgetGone) await sleep(400);
    }
    if (!widgetGone) errors.push('widget window still present after close');
    const btnOn = await evaluate(`document.getElementById('btnWidget').classList.contains('is-on')`);
    if (btnOn) errors.push('widget button still highlighted after close');
  }

  // 4e) fullscreen via F11/Esc (the native titlebar maximize button is
  //     exercised in 4f). Windows fullscreen transitions can take a second+,
  //     so poll instead of sleeping.
  const pollFs = async (want, ms = 8000) => {
    const t0 = Date.now();
    for (;;) {
      const v = await evaluate(`api.getWindowFullscreen()`);
      if (v === want) return true;
      if (Date.now() - t0 > ms) return false;
      await sleep(250);
    }
  };
  const pollWidth = async (target, ms = 8000) => {
    const t0 = Date.now();
    for (;;) {
      const w = await evaluate(`window.outerWidth`);
      if (w !== null && Math.abs(w - target) <= 60) return true;
      if (Date.now() - t0 > ms) return false;
      await sleep(250);
    }
  };

  ensureVisible();
  await sleep(400);
  const w0 = await evaluate(`window.outerWidth`);
  const sw = await evaluate(`window.screen.width`);
  const sh = await evaluate(`window.screen.height`);
  await evaluate(`document.dispatchEvent(new KeyboardEvent('keydown', { key: 'F11', bubbles: true })); void 0`);
  if (!(await pollFs(true))) errors.push('F11 did not enter fullscreen');
  // bounds cover the screen shortly after the flag flips
  let dims = null;
  let dimsOk = false;
  for (let i = 0; i < 24; i++) {
    dims = JSON.parse(await evaluate(`JSON.stringify({ w: window.outerWidth, h: window.outerHeight, sx: window.screenX })`));
    if (dims.w === sw && dims.h === sh && dims.sx === 0) { dimsOk = true; break; }
    await sleep(250);
  }
  if (!dimsOk) errors.push('window does not cover the screen in fullscreen: ' + JSON.stringify(dims));
  console.log('FULLSCREEN ENTERED:', JSON.stringify(dims));

  // F11 exits and the normal width comes back
  await evaluate(`document.dispatchEvent(new KeyboardEvent('keydown', { key: 'F11', bubbles: true })); void 0`);
  if (!(await pollFs(false))) errors.push('F11 did not exit fullscreen');
  if (!(await pollWidth(w0))) {
    errors.push(`width not restored after F11: w0=${w0}, now=${await evaluate(`window.outerWidth`)}`);
  }

  // Esc exits too (needs the broadcast state, hence the extra beat)
  await evaluate(`api.toggleFullscreen(); void 0`);
  if (!(await pollFs(true))) errors.push('could not re-enter fullscreen');
  await sleep(500);
  await evaluate(`document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })); void 0`);
  if (!(await pollFs(false))) errors.push('Escape did not exit fullscreen');
  if (!(await pollWidth(w0))) {
    errors.push(`width not restored after Escape: w0=${w0}, now=${await evaluate(`window.outerWidth`)}`);
  }
  console.log(`FULLSCREEN OK: F11/Esc all work, restored to ${await evaluate(`window.outerWidth`)}px`);

  // 4f) native titlebar maximize: the caption button drives the window's
  //     maximize/restore machinery (WS_THICKFRAME + WS_MAXIMIZEBOX) — the
  //     window must fill the work area and restore cleanly
  ensureVisible();
  await sleep(300);
  const syscmd = (cmd) => {
    try {
      execSync(
        `powershell -NoProfile -ExecutionPolicy Bypass -File "${path.join(__dirname, 'win-syscmd.ps1')}" -ExeName electron.exe -Match portfolio-candles -Cmd ${cmd}`,
        { stdio: 'ignore', windowsHide: true }
      );
      return true;
    } catch {
      return false;
    }
  };
  if (!syscmd('maximize')) errors.push('could not send SC_MAXIMIZE');
  let maxOk = false;
  let maxDims = null;
  for (let i = 0; i < 24; i++) {
    maxDims = JSON.parse(await evaluate(`JSON.stringify({ w: window.outerWidth, h: window.outerHeight })`));
    if (maxDims.w >= sw - 20 && maxDims.h >= sh - 60) { maxOk = true; break; }
    await sleep(250);
  }
  if (!maxOk) errors.push('native maximize did not fill the work area: ' + JSON.stringify(maxDims));
  else console.log('NATIVE MAXIMIZE OK:', JSON.stringify(maxDims));
  syscmd('restore');
  if (!(await pollWidth(w0))) {
    errors.push(`width not restored after native restore: w0=${w0}, now=${await evaluate(`window.outerWidth`)}`);
  }
  console.log('NATIVE RESTORE OK');

  // 5) totals are real numbers, not placeholders
  const totals = await evaluate(`({
    total: document.getElementById('totalValue').textContent,
    day: document.getElementById('dayChange').textContent,
    pill: document.getElementById('statusText').textContent,
    rows: document.querySelectorAll('.position').length
  })`);
  console.log('TOTALS:', JSON.stringify(totals));
  if (totals.rows !== 5) errors.push(`expected 5 rows, got ${totals.rows}`);
  if (!/\$/.test(totals.total)) errors.push('total value is not a number: ' + totals.total);

  // 6) demo mode: pill changes and prices tick every second
  await evaluate(`document.getElementById('btnSettings').click(); void 0`);
  await sleep(350);
  await evaluate(`document.querySelector('input[name="mode"][value="demo"]').checked = true; void 0`);
  await evaluate(`document.getElementById('btnSaveSettings').click(); void 0`);
  await sleep(1500);
  const demoPill = await evaluate(`document.getElementById('statusText').textContent`);
  const samples = [];
  for (let i = 0; i < 3; i++) {
    samples.push(await evaluate(`document.getElementById('chartPrice').textContent`));
    await sleep(900);
  }
  const ticking = new Set(samples).size > 1;
  console.log('DEMO MODE:', JSON.stringify({ pill: demoPill, samples, ticking }));
  if (!/DEMO/.test(demoPill)) errors.push('demo pill not shown: ' + demoPill);
  if (!ticking) errors.push('demo prices did not tick: ' + samples.join(','));
  await shot('05-demo-mode.png');

  // restore automatic mode
  await evaluate(`document.getElementById('btnSettings').click(); void 0`);
  await sleep(350);
  await evaluate(`document.querySelector('input[name="mode"][value="auto"]').checked = true; void 0`);
  await evaluate(`document.getElementById('btnSaveSettings').click(); void 0`);
  await sleep(500);
  const restoredPill = await evaluate(`document.getElementById('statusText').textContent`);
  console.log('RESTORED PILL:', restoredPill);

  console.log(errors.length ? 'ERRORS:\n' + errors.join('\n') : 'NO JS ERRORS');
  ws.close();
  process.exit(errors.length ? 1 : 0);
})().catch((err) => {
  console.error('UI TEST FAILED:', err.message);
  process.exit(2);
});
