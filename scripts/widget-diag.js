'use strict';

/* Diagnoses the widget page: does it load, does its JS run, do quotes render? */
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
  await new Promise((res, rej) => { ws.once('open', res); ws.once('error', rej); });
  let id = 0;
  const pend = new Map();
  ws.on('message', (raw) => {
    const m = JSON.parse(raw.toString());
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
  return { ws, send, ev };
}

(async () => {
  let targets = await getJson('http://127.0.0.1:9222/json');
  const main = targets.find((t) => t.type === 'page' && /Portfolio Candles/.test(t.title));
  const mconn = await connect(main.webSocketDebuggerUrl);
  await mconn.ev(`document.getElementById('btnWidget').click(); void 0`);
  mconn.ws.close();
  await sleep(3500);

  targets = await getJson('http://127.0.0.1:9222/json');
  console.log('PAGE TARGETS:', JSON.stringify(targets.filter((t) => t.type === 'page').map((t) => ({ title: t.title, url: t.url.slice(0, 70) }))));
  const wg = targets.find((t) => t.type === 'page' && t.title === 'Widget');
  if (!wg) {
    console.log('NO WIDGET TARGET');
    process.exit(1);
  }
  const wconn = await connect(wg.webSocketDebuggerUrl);
  console.log('readyState:', await wconn.ev('document.readyState'));
  console.log('typeof api:', await wconn.ev('typeof window.api'));
  console.log('api keys:', await wconn.ev('JSON.stringify(Object.keys(window.api || {}))'));
  console.log('script srcs:', await wconn.ev('JSON.stringify([...document.scripts].map(s => s.src))'));
  console.log('body start:', await wconn.ev('document.body ? document.body.innerHTML.slice(0, 200) : "NO BODY"'));
  console.log('rows:', await wconn.ev('document.querySelectorAll(".wg__row").length'));
  console.log('value:', await wconn.ev('document.getElementById("wgValue") ? document.getElementById("wgValue").textContent : "NO ELEM"'));
  // reload while capturing exceptions + console errors
  const errs = [];
  wconn.ws.on('message', (raw) => {
    const m = JSON.parse(raw.toString());
    if (m.method === 'Runtime.exceptionThrown') {
      errs.push('EXC: ' + (m.params.exceptionDetails.exception?.description || m.params.exceptionDetails.text));
    }
    if (m.method === 'Runtime.consoleAPICalled' && m.params.type === 'error') {
      errs.push('console.error: ' + m.params.args.map((a) => a.value ?? a.description).join(' '));
    }
  });
  await wconn.send('Page.enable');
  await wconn.send('Page.reload');
  await sleep(3000);
  console.log('ERRORS ON RELOAD:', JSON.stringify(errs, null, 1));
  console.log('rows after reload:', await wconn.ev('document.querySelectorAll(".wg__row").length'));
  console.log('value after reload:', await wconn.ev('document.getElementById("wgValue").textContent'));
  console.log('can close:', await wconn.ev(`(() => { document.getElementById('wgClose').click(); return 'clicked'; })()`));
  await sleep(1500);
  targets = await getJson('http://127.0.0.1:9222/json');
  console.log('after close, widget target present:', targets.some((t) => t.title === 'Widget'));
  wconn.ws.close();
  process.exit(0);
})().catch((e) => {
  console.error('DIAG FAILED', e);
  process.exit(1);
});
