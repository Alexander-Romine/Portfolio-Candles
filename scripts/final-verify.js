'use strict';

/* Final verification against the INSTALLED build over CDP:
   - real user data loaded (positions present)
   - no JS errors on the main page
   - enable the widget, verify it renders, count its JS errors too
   Leaves the widget ON so the user sees it right away. */

const WebSocket = require('ws');
const http = require('http');

function getJson(url) {
  return new Promise((resolve, reject) => {
    http.get(url, (r) => {
      let d = '';
      r.on('data', (c) => (d += c));
      r.on('end', () => resolve(JSON.parse(d)));
    }).on('error', reject);
  });
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function connect(url) {
  const ws = new WebSocket(url, { perMessageDeflate: false });
  await new Promise((res, rej) => {
    ws.once('open', res);
    ws.once('error', rej);
  });
  let id = 0;
  const pend = new Map();
  const errors = [];
  ws.on('message', (raw) => {
    const m = JSON.parse(raw.toString());
    if (m.method === 'Runtime.exceptionThrown') {
      errors.push(m.params.exceptionDetails.exception?.description || m.params.exceptionDetails.text);
    }
    if (m.id && pend.has(m.id)) {
      const p = pend.get(m.id);
      pend.delete(m.id);
      m.error ? p.reject(new Error(m.error.message)) : p.resolve(m.result);
    }
  });
  const send = (method, params = {}) =>
    new Promise((resolve, reject) => {
      const i = ++id;
      pend.set(i, { resolve, reject });
      ws.send(JSON.stringify({ id: i, method, params }));
    });
  const ev = async (expression) => {
    const r = await send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true });
    if (r.exceptionDetails) return 'EXC: ' + (r.exceptionDetails.exception?.description || r.exceptionDetails.text);
    return r.result?.value;
  };
  await send('Runtime.enable');
  return { ws, send, ev, errors };
}

(async () => {
  let version = null;
  for (let i = 0; i < 40 && !version; i++) {
    try {
      version = await getJson('http://127.0.0.1:9223/json/version');
    } catch {
      /* not up yet */
    }
    if (!version) await sleep(500);
  }
  if (!version) throw new Error('CDP endpoint never came up');
  const list = await getJson('http://127.0.0.1:9223/json');
  const page = list.find((t) => t.type === 'page' && /Portfolio Candles/.test(t.title));
  if (!page) throw new Error('main page not found');

  const main = await connect(page.webSocketDebuggerUrl);
  await sleep(2500); // let quotes/candles settle

  const info = (await main.ev(`(() => {
    const rows = document.querySelectorAll('.position');
    return {
      portfolio: document.querySelector('#portfolioSelect') ? document.querySelector('#portfolioSelect').selectedOptions[0]?.textContent : null,
      rows: rows.length,
      symbols: [...rows].map(r => r.dataset.sym),
      total: (document.getElementById('totalValue') || {}).textContent,
      pill: (document.getElementById('statusPill') || {}).textContent
    };
  })()`)) || {};
  console.log('MAIN:', JSON.stringify(info));

  if (typeof info.rows !== 'number' || !info.portfolio) {
    throw new Error('main window did not render the portfolio state');
  }

  // enable the desktop widget
  await main.ev(`document.getElementById('btnWidget').click(); void 0`);
  let widgetPage = null;
  for (let i = 0; i < 15 && !widgetPage; i++) {
    try {
      const l = await getJson('http://127.0.0.1:9223/json');
      widgetPage = l.find((t) => t.type === 'page' && t.title === 'Widget');
    } catch {
      /* retry */
    }
    if (!widgetPage) await sleep(400);
  }
  if (!widgetPage) throw new Error('widget never appeared');

  const wg = await connect(widgetPage.webSocketDebuggerUrl);
  await sleep(2500);
  const winfo = (await wg.ev(`(() => ({
    rows: document.querySelectorAll('.wg__row').length,
    name: document.getElementById('wgName').textContent,
    value: document.getElementById('wgValue').textContent,
    chg: document.getElementById('wgChg').textContent,
    firstRow: document.querySelector('.wg__row') ? document.querySelector('.wg__row').textContent : null,
    emptyHint: document.querySelector('.wg__empty') ? document.querySelector('.wg__empty').textContent : null
  }))()`)) || {};
  console.log('WIDGET:', JSON.stringify(winfo));
  console.log('MAIN JS ERRORS:', main.errors.length, main.errors.slice(0, 3));
  console.log('WIDGET JS ERRORS:', wg.errors.length, wg.errors.slice(0, 3));

  const ok =
    winfo.rows === info.rows &&
    winfo.name === info.portfolio &&
    main.errors.length === 0 &&
    wg.errors.length === 0;
  console.log(ok ? 'INSTALLED BUILD OK' : 'INSTALLED BUILD HAS ISSUES');
  main.ws.close();
  wg.ws.close();
  process.exit(ok ? 0 : 1);
})().catch((e) => {
  console.error('FINAL VERIFY FAILED:', e.message);
  process.exit(1);
});
