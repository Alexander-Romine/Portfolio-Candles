'use strict';

/* Repairs %APPDATA%\Portfolio Candles\portfolio.json after a destructive test run:
   recreates the default "My Portfolio" with the 5 sample positions and removes
   the leftover "Glass Test" portfolio. */
const path = require('path');
const { Store } = require('../lib/store');

const dir = path.join(process.env.APPDATA, 'Portfolio Candles');
const store = new Store(dir);

let before = store.getPortfolioState();
console.log('before:', JSON.stringify(before.list));

const glass = before.list.find((p) => p.name === 'Glass Test');
if (!before.list.some((p) => p.name === 'My Portfolio')) {
  store.createPortfolio('My Portfolio');
  const samples = [
    { symbol: 'AAPL', quantity: 25, avgCost: 172.4 },
    { symbol: 'MSFT', quantity: 12, avgCost: 415.6 },
    { symbol: 'NVDA', quantity: 40, avgCost: 118.2 },
    { symbol: 'TSLA', quantity: 10, avgCost: 244.8 },
    { symbol: 'VOO', quantity: 15, avgCost: 512.35 }
  ];
  for (const p of samples) store.savePosition(p);
}
if (glass) store.deletePortfolio(glass.id);

const after = store.getPortfolioState();
console.log('after:', JSON.stringify(after.list), 'active:', after.list.find((p) => p.id === after.activeId).name);
console.log('REPAIR OK');
