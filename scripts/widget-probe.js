'use strict';

/* CDP probe for the widget window: reports the preload api surface, the
   real content height the way syncHeight measures it, any console errors,
   and optionally fires a manual api.setHeight() to prove the main-process
   side works. Port via PC_CDP_PORT (default 9224). */

const WebSocket = require('ws');
const http = require('http');

const PORT = process.env.PC_CDP_PORT || '9224';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function getJson(url) {
  return new Promise((resolve, reject) => {
    http
      .get(url, (r) => {
        let d = '';
        r.on('data', (c) => (d += c));
        r.on('end', () => resolve(JSON.parse(d)));
      })
      .on('error', reject);
  });
}

(async () => {
  let list = null;
  for (let i = 0; i < 30 && !list; i++) {
    try {
      list = await getJson(`http://127.0.0.1:${PORT}/json`);
    } catch {
      await sleep(400);
    }
  }
  if (!list) throw new Error('CDP endpoint never came up');
  const target = list.find((t) => t.type === 'page' && t.title === 'Widget');
  if (!target) throw new Error('Widget target not found');

  const ws = new WebSocket(target.webSocketDebuggerUrl, { perMessageDeflate: false });
  await new Promise((res, rej) => {
    ws.once('open', res);
    ws.once('error', rej);
  });

  let id = 0;
  const pend = new Map();
  const events = [];
  ws.on('message', (raw) => {
    const msg = JSON.parse(raw);
    if (msg.id && pend.has(msg.id)) {
      const { resolve, reject } = pend.get(msg.id);
      pend.delete(msg.id);
      if (msg.error) reject(new Error(msg.error.message));
      else resolve(msg.result);
      return;
    }
    if (msg.method === 'Runtime.exceptionThrown') {
      const d = msg.params.exceptionDetails;
      events.push(`EXCEPTION: ${d.text} ${d.exception ? d.exception.description || '' : ''}`);
    }
    if (msg.method === 'Runtime.consoleAPICalled' && msg.params.type === 'error') {
      events.push(
        'console.error: ' + msg.params.args.map((a) => a.value || a.description || '').join(' ')
      );
    }
  });

  function send(method, params = {}) {
    const mid = ++id;
    return new Promise((resolve, reject) => {
      pend.set(mid, { resolve, reject });
      ws.send(JSON.stringify({ id: mid, method, params }));
    });
  }
  async function evalJs(expression) {
    const r = await send('Runtime.evaluate', { expression, returnByValue: true });
    if (r.exceptionDetails) throw new Error('eval failed: ' + JSON.stringify(r.exceptionDetails));
    return r.result.value;
  }

  await send('Runtime.enable');

  console.log('api.setHeight:', await evalJs('typeof api.setHeight'));
  console.log(
    'content:',
    await evalJs(`(function () {
      var wg = document.querySelector('.wg');
      var rows = document.getElementById('wgRows');
      rows.style.maxHeight = '';
      wg.style.minHeight = '0px';
      var natural = wg.scrollHeight;
      var chrome = natural - rows.scrollHeight;
      wg.style.minHeight = '';
      return JSON.stringify({ natural: natural, chrome: chrome, rows: rows.scrollHeight, innerH: window.innerHeight });
    })()`)
  );
  console.log(
    'rows in DOM:',
    await evalJs("document.querySelectorAll('#wgRows .wg__row').length")
  );

  // fire a manual height report: if main applies it, the window becomes 400 tall
  console.log('manual setHeight(400):', await evalJs('api.setHeight(400), "sent"'));

  await sleep(1200);
  if (events.length) console.log('EVENTS:\n  ' + events.join('\n  '));
  else console.log('no console errors');

  ws.close();
  process.exit(0);
})().catch((err) => {
  console.error('PROBE FAILED:', err.message);
  process.exit(1);
});
