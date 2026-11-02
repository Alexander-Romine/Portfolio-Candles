'use strict';

/* Timeframe metadata: main process returns `kind`, chart needs bucket size. */
const TF = {
  '1D': { intraday: true, resMin: 5 },
  '5D': { intraday: true, resMin: 30 },
  '1M': { intraday: true, resMin: 60 },
  '6M': { intraday: false, resMin: 1440 },
  '1Y': { intraday: false, resMin: 1440 },
  '5Y': { intraday: false, resMin: 1440 }
};

const state = {
  portfolios: [], // [{id, name, count}]
  activeId: null,
  portfolio: [], // positions of the active portfolio
  quotes: new Map(),
  profiles: new Map(),
  settings: null,
  status: null,
  selected: null,
  tf: '1D',
  editing: null,
  pfMode: 'create',
  posMode: 'shares',
  candleSource: '—'
};

const rowEls = new Map();
const $ = (id) => document.getElementById(id);
let selectToken = 0;
let rafId = 0;
let toastTimer = null;

/* ---------------- formatting ---------------- */

const isNum = (n) => typeof n === 'number' && Number.isFinite(n);

function fmtPrice(n) {
  if (!isNum(n)) return '—';
  if (Math.abs(n) < 1) return n.toFixed(4);
  return n.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

function fmtMoney(n) {
  if (!isNum(n)) return '—';
  return (n < 0 ? '-$' : '$') + Math.abs(n).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

function signedMoney(n) {
  if (!isNum(n)) return '—';
  return (n >= 0 ? '+$' : '-$') + Math.abs(n).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

function fmtPct(n) {
  if (!isNum(n)) return '—';
  return (n >= 0 ? '+' : '') + n.toFixed(2) + '%';
}

function fmtQty(n) {
  return Number.isInteger(n) ? String(n) : String(Number(n.toFixed(4)));
}

function fmtVol(n) {
  if (!isNum(n) || n <= 0) return '0';
  if (n >= 1e9) return (n / 1e9).toFixed(2) + 'B';
  if (n >= 1e6) return (n / 1e6).toFixed(2) + 'M';
  if (n >= 1e3) return (n / 1e3).toFixed(1) + 'K';
  return String(Math.round(n));
}

const clsFor = (n) => (isNum(n) ? (n > 0.00001 ? 'up' : n < -0.00001 ? 'down' : 'flat') : 'flat');

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

function cleanError(err) {
  const msg = err?.message || String(err);
  return msg.replace(/^Error invoking remote method '[^']+': (Error: )?/, '');
}

const sourceLabel = (src) =>
  src === 'finnhub' ? 'Finnhub live' : src === 'yahoo' ? 'Yahoo Finance' : src === 'demo' ? 'simulated' : src || '';

/* ---------------- boot ---------------- */

async function init() {
  ChartPane.create($('chart'));
  ChartPane.onHover(renderLegend);
  bindEvents();

  api.onQuote(onQuote);
  api.onStatus(applyStatus);
  api.onPortfolioChanged(applyPortfolioState);
  api.onWidgetChanged((s) => $('btnWidget').classList.toggle('is-on', Boolean(s.enabled)));
  api.onOpenSymbol((sym) => {
    if (state.portfolio.some((p) => p.symbol === sym)) selectSymbol(sym);
    else if (state.portfolio[0]) selectSymbol(state.portfolio[0].symbol);
  });
  api.getWidget().then((s) => $('btnWidget').classList.toggle('is-on', Boolean(s.enabled)));

  // fullscreen state (F11 / Esc) — tracked for keyboard handling; the
  // native titlebar maximize button drives the same window state
  const syncFullscreen = (s) => {
    state.fullscreen = Boolean(s.fullscreen);
  };
  api.onFullscreenChanged(syncFullscreen);
  api.getWindowFullscreen().then(syncFullscreen).catch(() => {});

  const [portfolioState, settings, status] = await Promise.all([
    api.getPortfolios(),
    api.getSettings(),
    api.getStatus()
  ]);
  state.settings = settings;
  if (TF[localStorage.getItem('pc.tf')]) state.tf = localStorage.getItem('pc.tf');
  syncTfButtons();
  applyStatus(status);

  applyPortfolioState(portfolioState);
  loadInitialQuotes();
  startClock();
}

/* ---------------- portfolios ---------------- */

function applyPortfolioState(s) {
  if (!s || !Array.isArray(s.list)) return;
  const activeChanged = s.activeId !== state.activeId;

  state.portfolios = s.list;
  state.activeId = s.activeId;
  state.portfolio = s.positions;

  populateSwitcher();
  const n = s.positions.length;
  $('pfCount').textContent = `${n} position${n === 1 ? '' : 's'}`;
  $('btnDeletePf').disabled = s.list.length <= 1;
  $('btnRenamePf').disabled = false;

  buildRows();
  refreshTotals();
  loadInitialQuotes();

  if (activeChanged) {
    const stored =
      localStorage.getItem('pc.symbol.' + s.activeId) || localStorage.getItem('pc.symbol');
    const pick = stored && s.positions.some((p) => p.symbol === stored)
      ? stored
      : s.positions[0]?.symbol;
    if (pick) selectSymbol(pick);
    else clearChart();
    return;
  }

  if (state.selected && !s.positions.some((p) => p.symbol === state.selected)) {
    // the selected symbol was removed from this portfolio
    if (s.positions[0]) selectSymbol(s.positions[0].symbol);
    else clearChart();
    return;
  }

  if (!state.selected && s.positions.length) {
    selectSymbol(s.positions[0].symbol);
    return;
  }

  for (const [sym, row] of rowEls) row.el.classList.toggle('is-active', sym === state.selected);
}

function populateSwitcher() {
  const sel = $('portfolioSelect');
  sel.innerHTML = '';
  for (const p of state.portfolios) {
    const opt = document.createElement('option');
    opt.value = p.id;
    opt.textContent = p.name;
    sel.appendChild(opt);
  }
  if (state.activeId) sel.value = state.activeId;
}

function openPfModal(mode) {
  state.pfMode = mode;
  const active = state.portfolios.find((p) => p.id === state.activeId);
  $('pfTitle').textContent = mode === 'rename' ? 'Rename portfolio' : 'New portfolio';
  $('btnSavePf').textContent = mode === 'rename' ? 'Save' : 'Create';
  $('pfName').value = mode === 'rename' && active ? active.name : '';
  $('pfError').hidden = true;
  showModal('pfModal');
}

async function savePf() {
  const errEl = $('pfError');
  errEl.hidden = true;
  try {
    if (state.pfMode === 'rename') {
      await api.renamePortfolio(state.activeId, $('pfName').value);
      toast('Portfolio renamed');
    } else {
      const name = $('pfName').value;
      await api.createPortfolio(name);
      toast(`Portfolio “${name.trim()}” created`);
    }
    hideModal('pfModal');
  } catch (err) {
    errEl.textContent = cleanError(err);
    errEl.hidden = false;
  }
}

async function deleteActivePf() {
  const active = state.portfolios.find((p) => p.id === state.activeId);
  if (!active) return;
  if (state.portfolios.length <= 1) {
    toast('You need at least one portfolio.', true);
    return;
  }
  const ok = window.confirm(
    `Delete “${active.name}” and its ${active.count} position${active.count === 1 ? '' : 's'}? This cannot be undone.`
  );
  if (!ok) return;
  try {
    await api.deletePortfolio(active.id);
    toast('Portfolio deleted');
  } catch (err) {
    toast(cleanError(err), true);
  }
}

function loadInitialQuotes() {
  const symbols = state.portfolio.map((p) => p.symbol);
  if (!symbols.length) return;
  api
    .getQuotes(symbols)
    .then((map) => {
      if (map) Object.values(map).forEach((q) => q && onQuote(q));
    })
    .catch(() => {});
}

/* ---------------- live quotes ---------------- */

function onQuote(q) {
  if (!q || !q.symbol) return;
  state.quotes.set(q.symbol, q);
  scheduleRefresh();
  if (q.symbol === state.selected) {
    updateQuoteHeader(q);
    ChartPane.applyQuote(q);
    $('lastUpdate').textContent = `${ET.clockStr(q.time)} · ${sourceLabel(q.source)}`;
  }
}

function scheduleRefresh() {
  if (rafId) return;
  rafId = requestAnimationFrame(() => {
    rafId = 0;
    refreshRows();
    refreshTotals();
  });
}

/* ---------------- sidebar ---------------- */

function buildRows() {
  const list = $('positionsList');
  list.innerHTML = '';
  rowEls.clear();

  for (const p of state.portfolio) {
    const el = document.createElement('div');
    el.className = 'position' + (p.symbol === state.selected ? ' is-active' : '');
    el.dataset.sym = p.symbol;
    el.innerHTML = `
      <div class="position__sym"><b>${escapeHtml(p.symbol)}</b><small data-f="name">—</small></div>
      <div class="num"><span data-f="last">—</span><small data-f="shares">—</small></div>
      <div class="num" data-f="chg">—</div>
      <div class="num"><span data-f="value">—</span><small data-f="pl">—</small></div>
      <div class="position__actions">
        <button class="minibtn" data-edit="${escapeHtml(p.symbol)}" title="Edit position" type="button">&#x270E;</button>
        <button class="minibtn minibtn--del" data-del="${escapeHtml(p.symbol)}" title="Remove position" type="button">&times;</button>
      </div>`;
    list.appendChild(el);

    const grab = (f) => el.querySelector(`[data-f="${f}"]`);
    rowEls.set(p.symbol, {
      el,
      name: grab('name'),
      last: grab('last'),
      shares: grab('shares'),
      chg: grab('chg'),
      value: grab('value'),
      pl: grab('pl')
    });
    loadProfile(p.symbol);
  }

  $('emptyPortfolio').hidden = state.portfolio.length > 0;
  refreshRows();
}

function refreshRows() {
  for (const [sym, row] of rowEls) {
    const p = state.portfolio.find((x) => x.symbol === sym);
    if (!p) continue;
    const q = state.quotes.get(sym);
    row.shares.textContent = p.amountMode === true ? 'amount' : `${fmtQty(p.quantity)} sh`;

    if (!q) {
      row.last.textContent = '—';
      row.chg.textContent = '—';
      row.chg.className = 'num';
      row.value.textContent = '—';
      row.pl.textContent = '';
      continue;
    }
    row.last.textContent = fmtPrice(q.price);
    row.chg.textContent = fmtPct(q.changePct);
    row.chg.className = 'num ' + clsFor(q.changePct);
    row.value.textContent = fmtMoney(q.price * p.quantity);
    const plPct = p.avgCost > 0 ? ((q.price - p.avgCost) / p.avgCost) * 100 : 0;
    row.pl.textContent = fmtPct(plPct);
    row.pl.className = clsFor(plPct);
  }
}

function refreshTotals() {
  const set = (id, text, cls) => {
    const el = $(id);
    el.textContent = text;
    if (cls !== undefined) el.className = cls;
  };

  if (!state.portfolio.length) {
    set('totalValue', '—');
    set('dayChange', '—', '');
    set('totalPl', '—', '');
    set('invested', '—');
    return;
  }

  let value = 0;
  let cost = 0;
  let day = 0;
  let anyQuote = false;

  for (const p of state.portfolio) {
    const q = state.quotes.get(p.symbol);
    cost += p.avgCost * p.quantity;
    if (q) {
      anyQuote = true;
      value += q.price * p.quantity;
      day += q.change * p.quantity;
    } else {
      value += p.avgCost * p.quantity;
    }
  }

  set('totalValue', anyQuote ? fmtMoney(value) : '—');
  const prev = value - day;
  const dayPct = prev > 0 ? (day / prev) * 100 : 0;
  set('dayChange', anyQuote ? `${signedMoney(day)} (${fmtPct(dayPct)})` : '—', clsFor(day));
  const pl = value - cost;
  const plPct = cost > 0 ? (pl / cost) * 100 : 0;
  set('totalPl', anyQuote ? `${signedMoney(pl)} (${fmtPct(plPct)})` : '—', clsFor(pl));
  set('invested', fmtMoney(cost));
}

function loadProfile(sym) {
  if (state.profiles.has(sym)) {
    applyProfile(sym);
    return;
  }
  api
    .getProfile(sym)
    .then((prof) => {
      if (prof && prof.name) {
        state.profiles.set(sym, prof.name);
        applyProfile(sym);
      }
    })
    .catch(() => {});
}

function applyProfile(sym) {
  const name = state.profiles.get(sym);
  if (!name) return;
  const row = rowEls.get(sym);
  if (row) row.name.textContent = name;
  if (state.selected === sym) $('chartName').textContent = name;
}

/* ---------------- chart pane ---------------- */

async function selectSymbol(sym) {
  if (!sym) {
    await clearChart();
    return;
  }
  state.selected = sym;
  if (state.activeId) localStorage.setItem('pc.symbol.' + state.activeId, sym);
  api.watchSymbol(sym);
  for (const [s, row] of rowEls) row.el.classList.toggle('is-active', s === sym);

  $('chartSymbol').textContent = sym;
  $('chartName').textContent = state.profiles.get(sym) || '…';
  updateQuoteHeader(state.quotes.get(sym));
  ChartPane.setSymbol(sym);
  $('dataSource').textContent = 'Loading history…';
  $('lastUpdate').textContent = '';

  const token = ++selectToken;
  try {
    const res = await api.getCandles(sym, state.tf);
    if (token !== selectToken || state.selected !== sym) return;
    state.candleSource = res.source;
    ChartPane.setBars(res.bars, { kind: res.kind, resMin: TF[state.tf].resMin });
    renderDataSource();
    if (res.warnings && res.warnings.length) {
      $('lastUpdate').textContent = `Fallback history used (${res.source})`;
    }
  } catch (err) {
    if (token !== selectToken) return;
    toast(`Could not load chart: ${cleanError(err)}`, true);
    $('dataSource').textContent = 'History unavailable';
  }
}

async function clearChart() {
  selectToken++;
  state.selected = null;
  localStorage.removeItem('pc.symbol.' + (state.activeId || ''));
  localStorage.removeItem('pc.symbol');
  for (const row of rowEls.values()) row.el.classList.remove('is-active');
  $('chartSymbol').textContent = '—';
  $('chartName').textContent = 'Select a position';
  updateQuoteHeader(null);
  ChartPane.setSymbol(null);
  $('dataSource').textContent = '—';
  $('lastUpdate').textContent = 'Add a position to begin';
  $('ohlcLegend').innerHTML = '';
}

function syncTfButtons() {
  document.querySelectorAll('.tf__btn').forEach((b) => b.classList.toggle('is-active', b.dataset.tf === state.tf));
}

function updateQuoteHeader(q) {
  const price = $('chartPrice');
  const change = $('chartChange');
  if (!q) {
    price.textContent = '—';
    price.className = 'quote__price';
    change.textContent = '—';
    change.className = 'quote__change';
    return;
  }
  price.textContent = fmtPrice(q.price);
  price.className = 'quote__price ' + clsFor(q.changePct);
  change.textContent = `${signedMoney(q.change)} (${fmtPct(q.changePct)})`;
  change.className = 'quote__change ' + clsFor(q.changePct);
}

function renderLegend(bar) {
  const el = $('ohlcLegend');
  if (!bar) {
    el.innerHTML = '';
    return;
  }
  const cells = [
    ['O', fmtPrice(bar.open)],
    ['H', fmtPrice(bar.high)],
    ['L', fmtPrice(bar.low)],
    ['C', fmtPrice(bar.close)],
    ['Vol', fmtVol(bar.volume)]
  ];
  const closeCls = bar.close >= bar.open ? 'up' : 'down';
  el.innerHTML = cells
    .map(([k, v], i) => `<span><b>${k}</b><span class="${i === 4 ? closeCls : ''}">${v}</span></span>`)
    .join('');
}

/* ---------------- status / clock ---------------- */

function applyStatus(s) {
  if (!s) return;
  state.status = s;
  const pill = $('statusPill');
  const txt = $('statusText');
  let cls = 'pill--pending';
  let label = 'CONNECTING';

  if (s.mode === 'demo') {
    cls = 'pill--demo';
    label = 'SIMULATED DEMO';
  } else if (s.mode === 'live') {
    if (s.ws === 'connected') {
      cls = 'pill--live';
      label = 'LIVE · FINNHUB';
    } else if (s.ws === 'reconnecting') {
      cls = 'pill--warn';
      label = 'RECONNECTING…';
    } else {
      cls = 'pill--pending';
      label = 'LIVE · CONNECTING';
    }
  } else if (s.mode === 'delayed') {
    cls = 'pill--delayed';
    label = `DELAYED · ${state.settings?.quotePollSeconds || 30}s`;
  }

  pill.className = 'pill ' + cls;
  pill.title =
    s.mode === 'live'
      ? 'Real-time trade prints from Finnhub'
      : s.mode === 'demo'
        ? 'Simulated prices — no live data'
        : 'Real prices, refreshed on a timer (no API key)';
  txt.textContent = label;
  renderDataSource();
}

function renderDataSource() {
  const mode = state.status?.mode;
  const quoteSrc = mode === 'live' ? 'Finnhub real-time' : mode === 'demo' ? 'simulated ticks' : 'delayed quotes';
  const el = $('dataSource');
  if (!state.selected) return;
  el.textContent = `Quotes: ${quoteSrc} · History: ${state.candleSource}`;
}

function startClock() {
  const tick = () => {
    const now = Date.now();
    const open = ET.isOpen(now);
    const el = $('sessionClock');
    el.textContent = `${open ? 'Market open' : 'Market closed'} · ${ET.clockStr(now)}`;
    el.className = 'topbar__clock' + (open ? ' up' : '');
  };
  tick();
  setInterval(tick, 1000);
}

/* ---------------- modals & toast ---------------- */

function showModal(id) {
  $(id).hidden = false;
  const input = $(id).querySelector('input:not([type="radio"]):not(:disabled)');
  setTimeout(() => input && input.focus(), 40);
}

function hideModal(id) {
  $(id).hidden = true;
}

function openModalOpen() {
  return Array.from(document.querySelectorAll('.overlay')).some((o) => !o.hidden);
}

function toast(message, isError = false) {
  const el = $('toast');
  el.textContent = message;
  el.className = 'toast' + (isError ? ' err' : '');
  el.hidden = false;
  if (toastTimer) clearTimeout(toastTimer);
  toastTimer = setTimeout(() => {
    el.hidden = true;
  }, 3600);
}

function openSettings() {
  const s = state.settings || {};
  $('apiKey').value = s.apiKey || '';
  $('pollSeconds').value = s.quotePollSeconds || 30;
  document.querySelectorAll('input[name="mode"]').forEach((r) => {
    r.checked = r.value === (s.mode || 'auto');
  });
  $('apiKey').type = 'password';
  $('btnToggleKey').textContent = 'Show';
  $('startWin').checked = Boolean(s.startWithWindows);
  $('testResult').textContent = ' ';
  $('testResult').className = 'hint';
  showModal('settingsModal');
}

async function saveSettings() {
  const btn = $('btnSaveSettings');
  btn.disabled = true;
  try {
    const patch = {
      apiKey: $('apiKey').value.trim(),
      mode: document.querySelector('input[name="mode"]:checked')?.value || 'auto',
      quotePollSeconds: Number($('pollSeconds').value) || 30,
      startWithWindows: $('startWin').checked
    };
    state.settings = await api.saveSettings(patch);
    applyStatus(await api.getStatus());
    hideModal('settingsModal');
    toast(state.settings.mode === 'demo' || !state.settings.apiKey ? 'Settings saved' : 'Settings saved — live data enabled');
  } catch (err) {
    toast(cleanError(err), true);
  } finally {
    btn.disabled = false;
  }
}

async function testConnection() {
  const btn = $('btnTest');
  const out = $('testResult');
  btn.disabled = true;
  out.className = 'hint';
  out.textContent = 'Testing…';
  try {
    const res = await api.testConnection($('apiKey').value.trim());
    out.textContent = res.message;
    out.className = 'hint ' + (res.ok ? 'ok' : 'err');
  } catch (err) {
    out.textContent = cleanError(err);
    out.className = 'hint err';
  } finally {
    btn.disabled = false;
  }
}

function openPosition(existing) {
  state.editing = existing ? existing.symbol : null;
  $('posTitle').textContent = existing ? 'Edit position' : 'Add position';
  $('posSymbol').value = existing ? existing.symbol : '';
  $('posSymbol').disabled = Boolean(existing);
  const isAmount = Boolean(existing && existing.amountMode === true);
  setPosMode(isAmount ? 'amount' : 'shares');
  $('posAmount').value = '';
  if (existing && isAmount) {
    $('posAmount').value = (existing.quantity * existing.avgCost).toFixed(2);
    $('posQty').value = '';
    $('posCost').value = '';
  } else {
    $('posQty').value = existing ? existing.quantity : '';
    $('posCost').value = existing ? existing.avgCost : '';
  }
  $('posError').hidden = true;
  $('btnDeletePos').hidden = !existing;
  showModal('positionModal');
}

function setPosMode(mode) {
  state.posMode = mode;
  document.querySelectorAll('#posMode .tf__btn').forEach((b) => {
    b.classList.toggle('is-active', b.dataset.mode === mode);
  });
  $('posSharesGroup').hidden = mode !== 'shares';
  $('posAmountGroup').hidden = mode !== 'amount';
}

async function savePosition() {
  const errEl = $('posError');
  errEl.hidden = true;
  try {
    const symbol = $('posSymbol').value.trim().toUpperCase();
    let pos;
    if (state.posMode === 'amount') {
      const amount = Number($('posAmount').value);
      if (!symbol) throw new Error('Enter a valid ticker symbol.');
      if (!Number.isFinite(amount) || amount <= 0) throw new Error('Amount must be greater than $0.');
      const quotes = await api.getQuotes([symbol]);
      const q = quotes && quotes[symbol];
      if (!q || !Number.isFinite(q.price) || q.price <= 0) {
        throw new Error(
          `No current price for ${symbol} — check the symbol or try again in a few seconds.`
        );
      }
      pos = { symbol, quantity: amount / q.price, avgCost: q.price, amountMode: true };
    } else {
      pos = { symbol, quantity: $('posQty').value, avgCost: $('posCost').value };
    }
    await api.savePosition(pos);
    hideModal('positionModal');
    toast(state.editing ? 'Position updated' : 'Position added');
  } catch (err) {
    errEl.textContent = cleanError(err);
    errEl.hidden = false;
  }
}

async function deletePosition(symbol) {
  if (!window.confirm(`Remove ${symbol} from your portfolio?`)) return;
  try {
    await api.deletePosition(symbol);
    hideModal('positionModal');
    toast(`${symbol} removed`);
  } catch (err) {
    toast(cleanError(err), true);
  }
}

/* ---------------- events ---------------- */

function bindEvents() {
  $('btnSettings').addEventListener('click', openSettings);
  $('btnAdd').addEventListener('click', () => openPosition(null));
  $('btnSaveSettings').addEventListener('click', saveSettings);
  $('btnTest').addEventListener('click', testConnection);
  $('btnSavePos').addEventListener('click', savePosition);
  $('btnDeletePos').addEventListener('click', () => state.editing && deletePosition(state.editing));

  // portfolios
  $('portfolioSelect').addEventListener('change', (e) => {
    const id = e.target.value;
    if (id && id !== state.activeId) {
      api.setActivePortfolio(id).catch((err) => toast(cleanError(err), true));
    }
  });
  $('btnNewPf').addEventListener('click', () => openPfModal('create'));
  $('btnRenamePf').addEventListener('click', () => openPfModal('rename'));
  $('btnDeletePf').addEventListener('click', deleteActivePf);
  $('btnSavePf').addEventListener('click', savePf);
  $('pfName').addEventListener('keydown', (e) => {
    if (e.key === 'Enter') savePf();
  });

  // position tracking mode (shares vs amount)
  document.querySelectorAll('#posMode .tf__btn').forEach((b) => {
    b.addEventListener('click', () => setPosMode(b.dataset.mode));
  });

  // desktop widget
  $('btnWidget').addEventListener('click', async () => {
    try {
      const cur = await api.getWidget();
      const res = await api.setWidget(!cur.enabled);
      $('btnWidget').classList.toggle('is-on', Boolean(res.enabled));
    } catch (err) {
      toast(cleanError(err), true);
    }
  });

  $('btnToggleKey').addEventListener('click', () => {
    const input = $('apiKey');
    const show = input.type === 'password';
    input.type = show ? 'text' : 'password';
    $('btnToggleKey').textContent = show ? 'Hide' : 'Show';
  });

  $('tfButtons').addEventListener('click', (e) => {
    const btn = e.target.closest('.tf__btn');
    if (!btn || !TF[btn.dataset.tf]) return;
    state.tf = btn.dataset.tf;
    localStorage.setItem('pc.tf', state.tf);
    syncTfButtons();
    if (state.selected) selectSymbol(state.selected);
  });

  $('positionsList').addEventListener('click', (e) => {
    const action = e.target.closest('[data-edit], [data-del]');
    if (action) {
      const symbol = action.dataset.edit || action.dataset.del;
      const pos = state.portfolio.find((p) => p.symbol === symbol);
      if (action.dataset.edit) openPosition(pos);
      else deletePosition(symbol);
      return;
    }
    const row = e.target.closest('.position');
    if (row?.dataset.sym) selectSymbol(row.dataset.sym);
  });

  document.querySelectorAll('[data-close]').forEach((btn) => {
    btn.addEventListener('click', () => {
      const overlay = btn.closest('.overlay');
      if (overlay) hideModal(overlay.id);
    });
  });

  document.querySelectorAll('.overlay').forEach((overlay) => {
    overlay.addEventListener('mousedown', (e) => {
      if (e.target === overlay) hideModal(overlay.id);
    });
  });

  document.addEventListener('keydown', (e) => {
    if (e.key === 'F11') {
      e.preventDefault();
      api.toggleFullscreen();
      return;
    }
    if (e.key === 'Escape' && openModalOpen()) {
      document.querySelectorAll('.overlay').forEach((o) => (o.hidden = true));
      return;
    }
    if (e.key === 'Escape' && state.fullscreen && !openModalOpen()) {
      // leave fullscreen when there is no modal to close (and no field to bail out of)
      const tag = document.activeElement ? document.activeElement.tagName : '';
      if (tag !== 'INPUT' && tag !== 'TEXTAREA' && tag !== 'SELECT') api.setFullscreen(false);
      return;
    }
    if (e.key === 'Enter' && !openModalOpen() && document.activeElement === document.body && state.selected) {
      selectSymbol(state.selected); // refresh chart
    }
  });
}

document.addEventListener('DOMContentLoaded', () => {
  init().catch((err) => {
    console.error(err);
    toast(`Startup error: ${cleanError(err)}`, true);
  });
});
