'use strict';

/* Desktop widget: compact, always-on-top view of the active portfolio.
   Clicking a row opens the full app on that symbol's chart. */

/* NB: contextBridge exposes window.api as a NON-CONFIGURABLE global, so a
   top-level `const api = ...` throws "Identifier 'api' has already been
   declared" and the whole script dies. Reference the bare global `api`
   directly instead — exactly what app.js does in the main window. */
const $ = (id) => document.getElementById(id);

const state = {
  list: [],
  activeId: null,
  positions: [],
  quotes: new Map()
};

async function init() {
  api.onQuote((quote) => {
    state.quotes.set(quote.symbol, quote);
    render();
  });
  api.onPortfolioChanged(applyState);

  $('wgClose').addEventListener('click', () => api.close());
  $('wgOpen').addEventListener('click', () => api.open());
  $('wgHead').addEventListener('dblclick', () => api.open());

  applyState(await api.getState());
}

function applyState(s) {
  if (!s || !Array.isArray(s.positions)) return;
  state.list = s.list || [];
  state.activeId = s.activeId;
  state.positions = s.positions;

  render();
  api.getQuotes(s.positions.map((p) => p.symbol)).then((quotes) => {
    if (quotes) {
      for (const key of Object.keys(quotes)) state.quotes.set(key, quotes[key]);
    }
    render();
  });
}

function quoteOf(symbol) {
  return state.quotes.get(symbol);
}

function render() {
  renderHeader();
  renderRows();
  scheduleHeightSync();
}

/* ---------- window height: content-driven ----------

   The widget window grows downward to fit every row. The renderer measures
   the real content height and reports it; main.js clamps it to the screen
   and resizes the window (growth anchored at the top-left, so the dragged
   position stays put). If the screen clamp cuts content off, the rows
   area scrolls instead. */

let lastNatural = 0;
let heightRaf = 0;

function syncHeight() {
  const wg = document.querySelector('.wg');
  const rows = $('wgRows');
  rows.style.maxHeight = ''; // natural state first
  wg.style.minHeight = '0px'; // measure content, not the current window
  const natural = Math.ceil(wg.scrollHeight);
  wg.style.minHeight = '';
  if (natural > 0 && natural !== lastNatural) {
    lastNatural = natural;
    api.setHeight(natural);
  }
}

function fitRows() {
  const wg = document.querySelector('.wg');
  const rows = $('wgRows');
  rows.style.maxHeight = '';
  wg.style.minHeight = '0px';
  const chrome = wg.scrollHeight - rows.scrollHeight; // head + foot + padding
  wg.style.minHeight = '';
  const avail = window.innerHeight - chrome;
  if (rows.scrollHeight > avail) {
    rows.style.maxHeight = Math.max(40, Math.floor(avail)) + 'px';
  }
}

function scheduleHeightSync() {
  if (heightRaf) return; // coalesce quote bursts
  heightRaf = requestAnimationFrame(() => {
    heightRaf = 0;
    syncHeight();
  });
}

window.addEventListener('resize', fitRows);

function renderHeader() {
  const active = state.list.find((p) => p.id === state.activeId);
  $('wgName').textContent = active ? active.name : 'Portfolio';

  let value = 0;
  let day = 0;
  let prevTotal = 0;
  for (const p of state.positions) {
    const q = quoteOf(p.symbol);
    const price = q ? q.price : p.avgCost;
    value += price * p.quantity;
    if (q && q.prevClose > 0) {
      day += (q.price - q.prevClose) * p.quantity;
      prevTotal += q.prevClose * p.quantity;
    }
  }

  $('wgValue').textContent =
    '$' + Math.round(value).toLocaleString('en-US');

  const pct = prevTotal > 0 ? (day / prevTotal) * 100 : 0;
  const chg = $('wgChg');
  const sign = day >= 0 ? '+' : '−';
  chg.textContent = `${sign}$${Math.abs(Math.round(day)).toLocaleString('en-US')} (${sign}${Math.abs(pct).toFixed(2)}%)`;
  chg.className = 'wg__chg ' + (day > 0 ? 'up' : day < 0 ? 'down' : 'flat');
}

function renderRows() {
  const wrap = $('wgRows');
  wrap.innerHTML = '';

  if (!state.positions.length) {
    const empty = document.createElement('div');
    empty.className = 'wg__empty';
    empty.textContent = 'No positions yet — add one in the app.';
    wrap.appendChild(empty);
    return;
  }

  for (const p of state.positions) {
    const q = quoteOf(p.symbol);
    const price = q ? q.price : p.avgCost;
    const pct = q && q.prevClose > 0 ? ((q.price - q.prevClose) / q.prevClose) * 100 : 0;

    const row = document.createElement('div');
    row.className = 'wg__row';
    row.title = `Open ${p.symbol} chart`;

    const sym = document.createElement('span');
    sym.className = 'wg__sym';
    sym.textContent = p.symbol;

    const px = document.createElement('span');
    px.className = 'wg__px';
    px.textContent = '$' + price.toFixed(2);

    const chg = document.createElement('span');
    chg.className = 'wg__pct ' + (pct > 0 ? 'up' : pct < 0 ? 'down' : 'flat');
    chg.textContent = `${pct >= 0 ? '+' : '−'}${Math.abs(pct).toFixed(2)}%`;

    row.append(sym, px, chg);
    row.addEventListener('click', () => api.open(p.symbol));
    wrap.appendChild(row);
  }
}

init().catch((err) => console.error('[widget] init failed:', err));
