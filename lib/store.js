'use strict';

const fs = require('fs');
const path = require('path');

const SETTINGS_DEFAULTS = {
  apiKey: '',
  mode: 'auto', // 'auto' = live when an API key is present, otherwise delayed; 'demo' = simulated
  quotePollSeconds: 30,
  startWithWindows: false
};

const SAMPLE_POSITIONS = [
  { symbol: 'AAPL', quantity: 25, avgCost: 172.4 },
  { symbol: 'MSFT', quantity: 12, avgCost: 415.6 },
  { symbol: 'NVDA', quantity: 40, avgCost: 118.2 },
  { symbol: 'TSLA', quantity: 10, avgCost: 244.8 },
  { symbol: 'VOO', quantity: 15, avgCost: 512.35 }
];

function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

function makeId() {
  return `pf_${Date.now().toString(36)}${Math.random().toString(36).slice(2, 7)}`;
}

function normalizePosition(p) {
  if (!p || typeof p !== 'object') return null;
  const symbol = String(p.symbol || '').trim().toUpperCase().replace(/\s+/g, '');
  const quantity = Number(p.quantity);
  const avgCost = Number(p.avgCost);
  if (!symbol || symbol.length > 12) return null;
  if (!Number.isFinite(quantity) || quantity <= 0) return null;
  if (!Number.isFinite(avgCost) || avgCost < 0) return null;
  const clean = { symbol, quantity, avgCost: Math.round(avgCost * 10000) / 10000 };
  if (p.amountMode === true) clean.amountMode = true;
  return clean;
}

function normalizeName(name, taken = []) {
  const clean = String(name || '').replace(/\s+/g, ' ').trim().slice(0, 40);
  if (!clean) throw new Error('Enter a portfolio name (1–40 characters).');
  const clash = taken.some((n) => n.toLowerCase() === clean.toLowerCase());
  if (clash) throw new Error(`A portfolio named “${clean}” already exists.`);
  return clean;
}

class Store {
  constructor(dir) {
    this.dir = dir;
    fs.mkdirSync(dir, { recursive: true });
    this.settingsPath = path.join(dir, 'settings.json');
    this.portfolioPath = path.join(dir, 'portfolio.json');
    this.settings = this.#readSettings();
    this.doc = this.#readPortfolioDoc();
    this.#writeFile(this.settingsPath, this.settings);
    this.#writeFile(this.portfolioPath, this.doc);
  }

  /* ---------- low level ---------- */

  #readFile(file) {
    try {
      return JSON.parse(fs.readFileSync(file, 'utf8'));
    } catch (err) {
      if (err.code !== 'ENOENT') console.warn(`[store] could not read ${path.basename(file)}:`, err.message);
      return null;
    }
  }

  #writeFile(file, value) {
    try {
      const tmp = `${file}.tmp`;
      fs.writeFileSync(tmp, JSON.stringify(value, null, 2), 'utf8');
      try {
        fs.renameSync(tmp, file);
      } catch {
        fs.copyFileSync(tmp, file);
        fs.rmSync(tmp, { force: true });
      }
    } catch (err) {
      console.warn(`[store] could not write ${path.basename(file)}:`, err.message);
    }
  }

  #readSettings() {
    const raw = this.#readFile(this.settingsPath);
    if (raw && typeof raw === 'object' && !Array.isArray(raw)) {
      return { ...clone(SETTINGS_DEFAULTS), ...raw };
    }
    return clone(SETTINGS_DEFAULTS);
  }

  /* ---------- portfolio document (multi-portfolio v2) ---------- */

  #readPortfolioDoc() {
    const raw = this.#readFile(this.portfolioPath);

    // v1: a bare array of positions (or an object with numeric keys from the old bug)
    if (Array.isArray(raw)) return this.#docFromLegacy(raw);
    if (raw && typeof raw === 'object' && !Array.isArray(raw.portfolios)) {
      const asArray = Object.values(raw);
      if (asArray.some((p) => p && typeof p === 'object' && p.symbol)) {
        return this.#docFromLegacy(asArray);
      }
    }

    // v2: { version, activeId, portfolios: [...] }
    if (raw && Array.isArray(raw.portfolios)) {
      const portfolios = [];
      for (const p of raw.portfolios) {
        if (!p || typeof p !== 'object') continue;
        const positions = Array.isArray(p.positions)
          ? p.positions.map(normalizePosition).filter(Boolean)
          : [];
        portfolios.push({
          id: typeof p.id === 'string' && p.id ? p.id : makeId(),
          name: typeof p.name === 'string' && p.name.trim() ? p.name.trim().slice(0, 40) : 'Portfolio',
          positions
        });
      }
      if (portfolios.length) {
        // unique names + a valid active id
        const seen = new Set();
        for (const p of portfolios) {
          let name = p.name;
          while (seen.has(name.toLowerCase())) name = `${name} 2`;
          seen.add(name.toLowerCase());
          p.name = name;
        }
        const activeId = portfolios.some((p) => p.id === raw.activeId)
          ? raw.activeId
          : portfolios[0].id;
        return { version: 2, activeId, portfolios };
      }
    }

    return this.#docFromLegacy(clone(SAMPLE_POSITIONS));
  }

  #docFromLegacy(positions) {
    const clean = positions.map(normalizePosition).filter(Boolean);
    const id = makeId();
    return {
      version: 2,
      activeId: id,
      portfolios: [{ id, name: 'My Portfolio', positions: clean }]
    };
  }

  #active() {
    return this.doc.portfolios.find((p) => p.id === this.doc.activeId) || this.doc.portfolios[0];
  }

  #writeDoc() {
    this.#writeFile(this.portfolioPath, this.doc);
  }

  /* ---------- settings ---------- */

  getSettings() {
    return clone(this.settings);
  }

  saveSettings(patch) {
    const next = { ...this.settings };
    if (typeof patch.apiKey === 'string') next.apiKey = patch.apiKey.trim();
    if (patch.mode === 'auto' || patch.mode === 'demo') next.mode = patch.mode;
    const poll = Number(patch.quotePollSeconds);
    if (Number.isFinite(poll)) next.quotePollSeconds = Math.min(300, Math.max(15, Math.round(poll)));
    if (typeof patch.startWithWindows === 'boolean') next.startWithWindows = patch.startWithWindows;
    if (typeof patch.widgetEnabled === 'boolean') next.widgetEnabled = patch.widgetEnabled;
    this.settings = next;
    this.#writeFile(this.settingsPath, this.settings);
    return this.getSettings();
  }

  /* ---------- portfolios ---------- */

  getPortfolioState() {
    return {
      list: this.doc.portfolios.map((p) => ({ id: p.id, name: p.name, count: p.positions.length })),
      activeId: this.doc.activeId,
      positions: clone(this.#active().positions)
    };
  }

  /** Active portfolio's positions — used by the market engine. */
  getPortfolio() {
    return clone(this.#active().positions);
  }

  /** Positions of any portfolio by id (used by the tray menu). */
  getPositions(id) {
    const pf = this.doc.portfolios.find((p) => p.id === id);
    return pf ? clone(pf.positions) : [];
  }

  createPortfolio(name) {
    const clean = normalizeName(name, this.doc.portfolios.map((p) => p.name));
    const pf = { id: makeId(), name: clean, positions: [] };
    this.doc.portfolios.push(pf);
    this.doc.activeId = pf.id;
    this.#writeDoc();
    return this.getPortfolioState();
  }

  renamePortfolio(id, name) {
    const pf = this.doc.portfolios.find((p) => p.id === id);
    if (!pf) throw new Error('Portfolio not found.');
    const others = this.doc.portfolios.filter((p) => p.id !== id).map((p) => p.name);
    pf.name = normalizeName(name, others);
    this.#writeDoc();
    return this.getPortfolioState();
  }

  deletePortfolio(id) {
    if (this.doc.portfolios.length <= 1) {
      throw new Error('You need at least one portfolio — create another one first.');
    }
    const exists = this.doc.portfolios.some((p) => p.id === id);
    if (!exists) throw new Error('Portfolio not found.');
    this.doc.portfolios = this.doc.portfolios.filter((p) => p.id !== id);
    if (this.doc.activeId === id) this.doc.activeId = this.doc.portfolios[0].id;
    this.#writeDoc();
    return this.getPortfolioState();
  }

  setActivePortfolio(id) {
    if (!this.doc.portfolios.some((p) => p.id === id)) throw new Error('Portfolio not found.');
    this.doc.activeId = id;
    this.#writeDoc();
    return this.getPortfolioState();
  }

  /* ---------- positions (active portfolio) ---------- */

  savePosition(pos) {
    const clean = normalizePosition(pos);
    if (!clean) {
      const symbol = String(pos?.symbol || '').trim();
      if (!symbol) throw new Error('Enter a valid ticker symbol.');
      if (!Number.isFinite(Number(pos?.quantity)) || Number(pos?.quantity) <= 0) {
        throw new Error('Shares must be greater than 0.');
      }
      throw new Error('Average cost must be 0 or more.');
    }
    const positions = this.#active().positions;
    const existing = positions.findIndex((p) => p.symbol === clean.symbol);
    if (existing >= 0) {
      const merged = { ...positions[existing], ...clean };
      // switching back to shares mode must clear the flag
      if (clean.amountMode !== true) delete merged.amountMode;
      positions[existing] = merged;
    } else positions.push(clean);
    this.#writeDoc();
    return this.getPortfolioState();
  }

  deletePosition(symbol) {
    const sym = String(symbol || '').trim().toUpperCase();
    const active = this.#active();
    active.positions = active.positions.filter((p) => p.symbol !== sym);
    this.#writeDoc();
    return this.getPortfolioState();
  }
}

module.exports = { Store, DEFAULT_SETTINGS: SETTINGS_DEFAULTS, DEFAULT_PORTFOLIO: SAMPLE_POSITIONS };
