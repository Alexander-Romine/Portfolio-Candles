'use strict';

const { EventEmitter } = require('events');
const WebSocket = require('ws');

const ET_TZ = 'America/New_York';
const UA_HEADERS = {
  'User-Agent':
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
  Accept: 'application/json,text/plain,*/*'
};

// Approximate prices used only to seed the simulated (demo) mode before any network data arrives.
const DEMO_SEEDS = {
  AAPL: 268, MSFT: 495, NVDA: 190, TSLA: 425, AMZN: 238, GOOGL: 330, META: 745,
  BRKB: 505, 'BRK.B': 505, JPM: 298, V: 352, KO: 72, DIS: 120, AMD: 172,
  NFLX: 1240, INTC: 38, MU: 235, QQQ: 605, SPY: 675, VOO: 640, DIA: 505, IWM: 250,
  ORCL: 320, CRM: 340, ADBE: 520, PEP: 155, WMT: 112, XOM: 128, BA: 235, UBER: 98,
  COIN: 380, PLTR: 175, SOFI: 32, NIO: 6.5, RIVN: 14, PYPL: 88, SBUX: 98, F: 12.5, GM: 62
};

// Typical per-tick volatility for the simulator, keyed by symbol with a sensible default.
const DEMO_VOL = {
  TSLA: 0.0016, NVDA: 0.0015, AMD: 0.0015, COIN: 0.0022, PLTR: 0.0018, NFLX: 0.0013,
  META: 0.0011, AMZN: 0.001, GOOGL: 0.001, AAPL: 0.0009, MSFT: 0.0009, INTC: 0.0014,
  MU: 0.0016, SPY: 0.0004, VOO: 0.0004, QQQ: 0.0005, DIA: 0.00035, KO: 0.0005, JPM: 0.0008
};

const TIMEFRAMES = {
  '1D': { kind: 'intraday', resMin: 5, finnhub: { res: '5', spanHours: 34 }, yahoo: { interval: '5m', range: '1d' } },
  '5D': { kind: 'intraday', resMin: 30, finnhub: { res: '30', spanHours: 24 * 8 }, yahoo: { interval: '30m', range: '5d' } },
  '1M': { kind: 'intraday', resMin: 60, finnhub: { res: '60', spanHours: 24 * 32 }, yahoo: { interval: '1h', range: '1mo' } },
  '6M': { kind: 'daily', spanDays: 200, finnhub: { res: 'D' }, yahoo: { interval: '1d', range: '6mo' } },
  '1Y': { kind: 'daily', spanDays: 380, finnhub: { res: 'D' }, yahoo: { interval: '1d', range: '1y' } },
  '5Y': { kind: 'daily', spanDays: 366 * 5 + 30, finnhub: { res: 'D' }, yahoo: { interval: '1d', range: '5y' } }
};

const etFormatters = {};
function etFmt(opts) {
  const key = JSON.stringify(opts);
  if (!etFormatters[key]) etFormatters[key] = new Intl.DateTimeFormat('en-US', { timeZone: ET_TZ, ...opts });
  return etFormatters[key];
}

function etParts(ms) {
  const parts = etFmt({
    year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false
  }).formatToParts(new Date(ms));
  const get = (type) => Number(parts.find((p) => p.type === type)?.value);
  let hour = get('hour');
  if (hour === 24) hour = 0; // some ICU versions render midnight as 24
  return { year: get('year'), month: get('month'), day: get('day'), hour, minute: get('minute'), second: get('second') };
}

function etDateString(ms) {
  const p = etParts(ms);
  return `${p.year}-${String(p.month).padStart(2, '0')}-${String(p.day).padStart(2, '0')}`;
}

function dayOfWeek(ms) {
  return etFmt({ weekday: 'short' }).format(new Date(ms));
}

async function getJson(url, timeoutMs = 12000) {
  const res = await fetch(url, {
    headers: UA_HEADERS,
    signal: AbortSignal.timeout(timeoutMs)
  });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return res.json();
}

class Market extends EventEmitter {
  constructor(store) {
    super();
    this.store = store;
    this.quotes = new Map(); // symbol -> {price, prevClose, change, changePct, time, source}
    this.ticks = new Map(); // symbol -> ms of last received tick
    this.seeds = new Map(); // symbol -> {price, prevClose}
    this.profileCache = new Map(); // symbol -> {name, logo, at}
    this.mode = 'demo'; // resolved mode: 'live' | 'delayed' | 'demo'
    this.wsState = 'off'; // 'off' | 'connecting' | 'connected' | 'reconnecting'
    this.subscribed = new Set();
    this.started = false;
    this._ws = null;
    this._wsBackoff = 2000;
    this._reconnectTimer = null;
    this._pollTimer = null;
    this._demoTimer = null;
    this._pendingTrades = new Map();
    this._flushTimer = null;
    this.stopped = false;
  }

  // ---------- configuration ----------

  get settings() {
    return this.store.getSettings();
  }

  get apiKey() {
    return this.settings.apiKey || '';
  }

  resolveMode() {
    const s = this.settings;
    if (s.mode === 'demo') return 'demo';
    return this.apiKey ? 'live' : 'delayed';
  }

  getStatus() {
    return {
      mode: this.mode,
      ws: this.wsState,
      hasKey: Boolean(this.apiKey),
      configuredMode: this.settings.mode
    };
  }

  #emitStatus() {
    this.emit('status', this.getStatus());
  }

  // ---------- lifecycle ----------

  async start() {
    this.stopped = false;
    this.started = true;
    this.setPortfolio(this.store.getPortfolio());
    this.applySettings();
  }

  stop() {
    this.stopped = true;
    this.#teardownEngines();
  }

  applySettings() {
    this.mode = this.resolveMode();
    this.#teardownEngines();
    this.#startEngines();
    this.#emitStatus();
  }

  #teardownEngines() {
    if (this._pollTimer) { clearInterval(this._pollTimer); this._pollTimer = null; }
    if (this._demoTimer) { clearInterval(this._demoTimer); this._demoTimer = null; }
    if (this._reconnectTimer) { clearTimeout(this._reconnectTimer); this._reconnectTimer = null; }
    if (this._flushTimer) { clearTimeout(this._flushTimer); this._flushTimer = null; }
    this.#closeWs();
  }

  #startEngines() {
    if (this.stopped) return;
    if (this.mode === 'live') {
      this.#connectWs();
      this._pollTimer = setInterval(() => this.#pollLiveGaps().catch(() => {}), 60000);
      this.#pollLiveGaps().catch(() => {});
    } else if (this.mode === 'delayed') {
      this.wsState = 'off';
      this.#pollDelayed().catch(() => {});
      this._pollTimer = setInterval(() => this.#pollDelayed().catch(() => {}), Math.max(15, this.settings.quotePollSeconds) * 1000);
    } else {
      this.wsState = 'off';
      this.#startDemo();
    }
  }

  setPortfolio(portfolio) {
    const symbols = new Set(portfolio.map((p) => p.symbol));
    for (const p of portfolio) this.subscribed.add(p.symbol);
    if (this.mode === 'live' && this._ws && this._ws.readyState === WebSocket.OPEN) {
      // resubscribe: subscribe everything we track, unsubscribe nothing (cheap & safe)
      for (const s of this.subscribed) this.#wsSend({ type: 'subscribe', symbol: s });
    }
    if (symbols.size) this.#warmSeeds([...symbols]);
  }

  watch(symbol) {
    const sym = String(symbol || '').trim().toUpperCase();
    if (!sym || this.subscribed.has(sym)) return;
    this.subscribed.add(sym);
    if (this.mode === 'live' && this._ws && this._ws.readyState === WebSocket.OPEN) {
      this.#wsSend({ type: 'subscribe', symbol: sym });
    }
  }

  // ---------- Finnhub websocket (live mode) ----------

  #connectWs() {
    const key = this.apiKey;
    if (!key || this.stopped) {
      this.wsState = 'off';
      this.#emitStatus();
      return;
    }
    this.#closeWs();
    this.wsState = this._reconnectTimer ? 'reconnecting' : 'connecting';
    this.#emitStatus();

    let ws;
    try {
      ws = new WebSocket(`wss://ws.finnhub.io?token=${encodeURIComponent(key)}`);
    } catch (err) {
      console.warn('[market] ws create failed:', err.message);
      this.#scheduleReconnect();
      return;
    }
    this._ws = ws;

    ws.on('open', () => {
      if (this._ws !== ws) return;
      this.wsState = 'connected';
      this._wsBackoff = 2000;
      for (const s of this.subscribed) this.#wsSend({ type: 'subscribe', symbol: s }, ws);
      this.#emitStatus();
      this.#pollLiveGaps().catch(() => {});
    });

    ws.on('message', (raw) => {
      if (this._ws !== ws) return;
      let msg;
      try { msg = JSON.parse(raw.toString()); } catch { return; }
      if (msg.type !== 'trade' || !Array.isArray(msg.data)) return;
      const now = Date.now();
      for (const t of msg.data) {
        if (!t || typeof t.s !== 'string' || typeof t.p !== 'number') continue;
        this._pendingTrades.set(t.s, { symbol: t.s, price: t.p, volume: t.v || 0, time: t.t || now });
      }
      if (!this._flushTimer) this._flushTimer = setTimeout(() => this.#flushTrades(), 200);
    });

    ws.on('close', () => {
      if (this._ws !== ws) return;
      this._ws = null;
      if (this.stopped || this.mode !== 'live') return;
      this.wsState = 'reconnecting';
      this.#emitStatus();
      this.#scheduleReconnect();
    });

    ws.on('error', (err) => {
      console.warn('[market] ws error:', err.message);
      try { ws.close(); } catch { /* ignore */ }
    });
  }

  #scheduleReconnect() {
    if (this._reconnectTimer || this.stopped) return;
    const delay = this._wsBackoff;
    this._wsBackoff = Math.min(60000, Math.round(this._wsBackoff * 1.8));
    this._reconnectTimer = setTimeout(() => {
      this._reconnectTimer = null;
      if (this.mode === 'live' && !this.stopped) this.#connectWs();
    }, delay);
  }

  #closeWs() {
    if (this._ws) {
      const ws = this._ws;
      this._ws = null;
      try { ws.removeAllListeners(); ws.close(); } catch { /* ignore */ }
    }
    this.wsState = 'off';
  }

  #wsSend(payload, ws) {
    const target = ws || this._ws;
    if (target && target.readyState === WebSocket.OPEN) {
      try { target.send(JSON.stringify(payload)); } catch { /* ignore */ }
    }
  }

  #flushTrades() {
    this._flushTimer = null;
    if (!this._pendingTrades.size) return;
    const batch = [...this._pendingTrades.values()];
    this._pendingTrades.clear();
    for (const trade of batch) this.#emitQuote(trade, 'finnhub');
  }

  // ---------- quote polling ----------

  async #pollLiveGaps() {
    if (this.mode !== 'live' || this.stopped) return;
    const symbols = [...this.subscribed];
    const now = Date.now();
    const stale = symbols.filter((s) => now - (this.ticks.get(s) || 0) > 90000);
    for (const symbol of stale) {
      try {
        const q = await this.#finnhubQuote(symbol);
        this.#emitQuote(q, 'finnhub');
      } catch (err) {
        // Bad key, rate limit, or gap in WS prints — keep prices moving via Yahoo.
        try {
          const q = await this.#yahooQuote(symbol);
          this.#emitQuote(q, 'yahoo');
        } catch { /* next poll will retry */ }
        if (err.message && /HTTP (401|403)/.test(err.message)) this.#emitStatus();
      }
      await new Promise((r) => setTimeout(r, 120));
    }
  }

  async #pollDelayed() {
    if (this.mode !== 'delayed' || this.stopped) return;
    const symbols = [...this.subscribed];
    const results = await Promise.allSettled(symbols.map((s) => this.#yahooQuote(s)));
    results.forEach((r, i) => {
      if (r.status === 'fulfilled' && r.value) this.#emitQuote(r.value, 'yahoo');
    });
  }

  async #warmSeeds(symbols) {
    const missing = (symbols || []).filter((s) => {
      const seed = this.seeds.get(s);
      return !seed || !Number.isFinite(seed.prevClose);
    });
    if (!missing.length) return;
    const results = await Promise.allSettled(missing.map((s) => this.#yahooQuote(s)));
    results.forEach((r, i) => {
      const sym = missing[i];
      if (r.status === 'fulfilled' && r.value) {
        this.seeds.set(sym, { price: r.value.price, prevClose: r.value.prevClose });
      } else if (DEMO_SEEDS[sym] != null) {
        this.seeds.set(sym, { price: DEMO_SEEDS[sym], prevClose: DEMO_SEEDS[sym] });
      }
    });
  }

  // ---------- demo (simulated) engine ----------

  #startDemo() {
    // Real prices (and previous-close for the change column) come from the network;
    // hard-coded fallbacks only apply if that fetch fails.
    this.#warmSeeds([...this.subscribed]).catch(() => {});

    let tickCount = 0;
    const run = () => {
      if (this.stopped || this.mode !== 'demo') return;
      tickCount++;
      for (const symbol of this.subscribed) {
        const seed = this.seeds.get(symbol);
        if (!seed) continue;
        const vol = DEMO_VOL[symbol] ?? 0.0011;
        const gauss = (Math.random() + Math.random() + Math.random() - 1.5) / 1.5;
        const drift = Math.sin(tickCount / 60) * vol * 0.15;
        const price = Math.max(0.01, seed.price * (1 + gauss * vol + drift));
        seed.price = price;
        this.#emitQuote({ symbol, price, prevClose: seed.prevClose, time: Date.now() }, 'demo');
      }
    };
    run();
    this._demoTimer = setInterval(run, 1000);
    this.wsState = 'off';
    this.#emitStatus();
  }

  // ---------- quote plumbing ----------

  #emitQuote(q, source) {
    if (!q || typeof q.symbol !== 'string' || !Number.isFinite(q.price)) return;
    const symbol = q.symbol;
    const prevClose = Number.isFinite(q.prevClose) && q.prevClose > 0 ? q.prevClose : this.quotes.get(symbol)?.prevClose || q.price;
    const change = q.price - prevClose;
    const changePct = prevClose > 0 ? (change / prevClose) * 100 : 0;
    const record = {
      symbol,
      price: q.price,
      prevClose,
      change,
      changePct,
      time: q.time || Date.now(),
      volume: q.volume || 0,
      source
    };
    this.quotes.set(symbol, record);
    this.ticks.set(symbol, Date.now());
    this.emit('quote', record);
  }

  async getQuotes(symbols) {
    const out = {};
    const missing = [];
    for (const symbol of symbols || []) {
      const cached = this.quotes.get(symbol);
      if (cached && Date.now() - cached.time < 15000) out[symbol] = cached;
      else missing.push(symbol);
    }
    await Promise.allSettled(
      missing.map(async (symbol) => {
        try {
          const q = this.mode === 'live'
            ? await this.#finnhubQuote(symbol).catch(() => this.#yahooQuote(symbol))
            : await this.#yahooQuote(symbol);
          if (q) {
            this.#emitQuote(q, this.mode === 'live' ? 'finnhub' : 'yahoo');
            out[symbol] = this.quotes.get(symbol);
          }
        } catch { /* leave unavailable */ }
      })
    );
    return out;
  }

  async #finnhubQuote(symbol) {
    const key = this.apiKey;
    if (!key) throw new Error('no api key');
    const j = await getJson(`https://finnhub.io/api/v1/stock/quote?symbol=${encodeURIComponent(symbol)}&token=${encodeURIComponent(key)}`);
    if (!j || !Number.isFinite(j.c) || j.c <= 0) throw new Error('invalid quote');
    return { symbol, price: j.c, prevClose: Number.isFinite(j.pc) && j.pc > 0 ? j.pc : j.c, time: j.t ? j.t * 1000 : Date.now() };
  }

  async #yahooQuote(symbol) {
    const j = await getJson(
      `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(symbol)}?interval=1d&range=1d&includePrePost=false`
    );
    const r = j?.chart?.result?.[0];
    const meta = r?.meta;
    const price = meta?.regularMarketPrice;
    if (!Number.isFinite(price)) throw new Error('invalid quote');
    const prevClose = meta.chartPreviousClose ?? meta.previousClose ?? price;
    return { symbol, price, prevClose, time: meta.regularMarketTime ? meta.regularMarketTime * 1000 : Date.now() };
  }

  // ---------- candle history ----------

  async loadCandles(symbol, timeframe) {
    const sym = String(symbol || '').trim().toUpperCase();
    const tf = TIMEFRAMES[timeframe] ? timeframe : '1D';
    const cfg = TIMEFRAMES[tf];
    const attempts = [];

    if (this.mode === 'live' && this.apiKey) {
      try {
        const bars = await this.#finnhubCandles(sym, cfg);
        if (bars.length) return { symbol: sym, timeframe: tf, bars, source: 'Finnhub', kind: cfg.kind };
        attempts.push('Finnhub returned no data');
      } catch (err) {
        attempts.push(`Finnhub: ${err.message}`);
      }
    }

    try {
      const res = await this.#yahooCandles(sym, cfg);
      if (res.bars.length) {
        if (res.meta && Number.isFinite(res.meta.price)) {
          // Only remember the price here. Never prevClose: on longer ranges Yahoo's
          // chartPreviousClose is the close from a year ago, not yesterday.
          const seed = this.seeds.get(sym) || {};
          this.seeds.set(sym, {
            price: res.meta.price,
            prevClose: Number.isFinite(seed.prevClose) ? seed.prevClose : undefined
          });
        }
        return { symbol: sym, timeframe: tf, bars: res.bars, source: 'Yahoo Finance', kind: cfg.kind };
      }
      attempts.push('Yahoo returned no data');
    } catch (err) {
      attempts.push(`Yahoo: ${err.message}`);
    }

    // Last resort so the chart always has something to draw.
    return { symbol: sym, timeframe: tf, bars: this.#syntheticCandles(sym, cfg), source: 'Simulated', kind: cfg.kind, warnings: attempts };
  }

  async #finnhubCandles(symbol, cfg) {
    const key = this.apiKey;
    if (!key) throw new Error('no api key');
    const to = Math.floor(Date.now() / 1000);
    const from = cfg.kind === 'daily' ? to - cfg.spanDays * 86400 : to - cfg.spanHours * 3600;
    const j = await getJson(
      `https://finnhub.io/api/v1/stock/candle?symbol=${encodeURIComponent(symbol)}&resolution=${cfg.finnhub.res}&from=${from}&to=${to}&token=${encodeURIComponent(key)}`
    );
    if (j.s !== 'ok' || !Array.isArray(j.c) || !j.c.length) throw new Error(j.s || 'unavailable');
    const map = new Map();
    for (let i = 0; i < j.c.length; i++) {
      const t = j.t[i];
      if (!Number.isFinite(t)) continue;
      const time = cfg.kind === 'daily' ? etDateString(t * 1000) : t;
      map.set(time, {
        time,
        open: round4(j.o[i]), high: round4(j.h[i]), low: round4(j.l[i]), close: round4(j.c[i]),
        volume: j.v?.[i] || 0
      });
    }
    return [...map.values()].sort((a, b) => (a.time > b.time ? 1 : -1));
  }

  async #yahooCandles(symbol, cfg) {
    const j = await getJson(
      `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(symbol)}` +
        `?interval=${cfg.yahoo.interval}&range=${cfg.yahoo.range}&includePrePost=false&events=div%2Csplits`
    );
    const r = j?.chart?.result?.[0];
    if (!r || !Array.isArray(r.timestamp)) throw new Error('no data');
    const quote = r.indicators?.quote?.[0] || {};
    const map = new Map();
    for (let i = 0; i < r.timestamp.length; i++) {
      const o = quote.open?.[i], h = quote.high?.[i], l = quote.low?.[i], c = quote.close?.[i];
      if (o == null || h == null || l == null || c == null) continue;
      const t = r.timestamp[i];
      const time = cfg.kind === 'daily' ? etDateString(t * 1000) : t;
      map.set(time, { time, open: round4(o), high: round4(h), low: round4(l), close: round4(c), volume: quote.volume?.[i] || 0 });
    }
    const bars = [...map.values()].sort((a, b) => (a.time > b.time ? 1 : -1));
    // Yahoo sometimes appends a flat "last price" stub (O=H=L=C, no volume) stamped at
    // the current second instead of a real bar boundary — drop it so live updates land
    // on the real forming candle.
    while (bars.length) {
      const last = bars[bars.length - 1];
      const flat = last.open === last.high && last.high === last.low && last.low === last.close;
      if (flat && !last.volume) bars.pop();
      else break;
    }
    const meta = r.meta || {};
    return {
      bars,
      meta: {
        price: meta.regularMarketPrice,
        prevClose: meta.chartPreviousClose ?? meta.previousClose
      }
    };
  }

  #syntheticCandles(symbol, cfg) {
    const seed = this.seeds.get(symbol) || this.quotes.get(symbol);
    const base = seed?.price || DEMO_SEEDS[symbol] || 100;
    const n = cfg.kind === 'daily' ? 130 : 110;
    const vol = cfg.kind === 'daily' ? 0.018 : Math.max(0.0008, (DEMO_VOL[symbol] ?? 0.0011) * 3.2);
    const bars = [];
    let price = base * (1 - vol * n * 0.08);
    const now = Date.now();

    for (let i = 0; i < n; i++) {
      const open = price;
      const shock = (Math.random() + Math.random() + Math.random() - 1.5) / 1.5;
      const close = Math.max(0.01, open * (1 + shock * vol));
      const high = Math.max(open, close) * (1 + Math.random() * vol * 0.4);
      const low = Math.min(open, close) * (1 - Math.random() * vol * 0.4);
      let time;
      if (cfg.kind === 'daily') {
        // walk backwards over weekdays from today
        const d = new Date(now);
        d.setHours(0, 0, 0, 0);
        let remaining = n - 1 - i;
        d.setDate(d.getDate() - remaining);
        while (['Sat', 'Sun'].includes(dayOfWeek(d.getTime()))) d.setDate(d.getDate() - 1);
        time = etDateString(d.getTime());
      } else {
        const slot = n - 1 - i;
        time = Math.floor(now / (cfg.resMin * 60)) * (cfg.resMin * 60) - slot * cfg.resMin * 60;
      }
      bars.push({
        time,
        open: round4(open), high: round4(high), low: round4(low), close: round4(close),
        volume: Math.round(50000 + Math.random() * 800000)
      });
      price = close;
    }
    // ensure strictly ascending, unique times
    const seen = new Set();
    return bars
      .filter((b) => (seen.has(b.time) ? false : (seen.add(b.time), true)))
      .sort((a, b) => (a.time > b.time ? 1 : -1));
  }

  // ---------- company profiles ----------

  async getProfile(symbol) {
    const sym = String(symbol || '').trim().toUpperCase();
    if (!sym) return null;
    const cached = this.profileCache.get(sym);
    if (cached && Date.now() - cached.at < 24 * 3600 * 1000) return cached.data;

    let data = null;
    if (this.apiKey) {
      try {
        const j = await getJson(
          `https://finnhub.io/api/v1/stock/profile2?symbol=${encodeURIComponent(sym)}&token=${encodeURIComponent(this.apiKey)}`
        );
        if (j && j.name) data = { name: j.name, logo: j.logo || null, exchange: j.exchange || '' };
      } catch { /* fall through */ }
    }
    if (!data) {
      try {
        const j = await getJson(`https://query1.finance.yahoo.com/v1/finance/search?q=${encodeURIComponent(sym)}&quotesCount=1&newsCount=0`);
        const hit = (j?.quotes || []).find((q) => q.symbol === sym) || (j?.quotes || [])[0];
        const name = hit && (hit.shortname || hit.shortName || hit.longname || hit.longName);
        if (name) data = { name, logo: null, exchange: hit.exchDisp || '' };
      } catch { /* fall through */ }
    }
    if (data) this.profileCache.set(sym, { data, at: Date.now() });
    return data;
  }

  async testConnection(apiKey) {
    const key = ((apiKey ?? this.apiKey) || '').trim();
    if (!key) return { ok: false, message: 'No API key entered.' };
    try {
      const j = await getJson(`https://finnhub.io/api/v1/stock/quote?symbol=AAPL&token=${encodeURIComponent(key)}`, 10000);
      if (!j || !Number.isFinite(j.c) || j.c <= 0) return { ok: false, message: 'Key accepted but no quote data returned.' };
      return { ok: true, message: `Connected — AAPL quote $${j.c.toFixed(2)}` };
    } catch (err) {
      if (/HTTP 401|HTTP 403/.test(err.message)) return { ok: false, message: 'Key rejected (401/403). Check it at finnhub.io.' };
      return { ok: false, message: `Connection failed: ${err.message}` };
    }
  }
}

function round4(n) {
  const v = Number(n);
  if (!Number.isFinite(v)) return 0;
  return Math.round(v * 10000) / 10000;
}

module.exports = { Market, TIMEFRAMES };
