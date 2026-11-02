'use strict';

/* Headless smoke test for the market-data layer (no Electron needed). */
const os = require('os');
const path = require('path');
const { Store } = require('../lib/store');
const { Market } = require('../lib/market');

(async () => {
  const store = new Store(path.join(os.tmpdir(), `pc-smoke-${Date.now()}`));
  const market = new Market(store);

  market.on('quote', (q) => console.log('QUOTE', q.symbol, q.price.toFixed(2), `${q.changePct.toFixed(2)}%`, q.source));
  market.on('status', (s) => console.log('STATUS', JSON.stringify(s)));

  console.log('--- phase 1: delayed mode (no API key) ---');
  await market.start();

  const candles = await market.loadCandles('AAPL', '1D');
  console.log('CANDLES 1D:', candles.source, candles.bars.length, JSON.stringify(candles.bars[candles.bars.length - 1]));

  const daily = await market.loadCandles('MSFT', '1Y');
  console.log('CANDLES 1Y:', daily.source, daily.bars.length, JSON.stringify(daily.bars[daily.bars.length - 1]));

  const quotes = await market.getQuotes(['AAPL', 'NVDA']);
  console.log('QUOTES:', JSON.stringify(quotes));

  const profile = await market.getProfile('AAPL');
  console.log('PROFILE:', JSON.stringify(profile));

  const test = await market.testConnection('');
  console.log('TEST (empty key):', JSON.stringify(test));

  console.log('--- phase 2: demo mode (simulated ticks) ---');
  store.saveSettings({ mode: 'demo' });
  market.applySettings();
  await new Promise((r) => setTimeout(r, 2500));

  market.stop();
  console.log('SMOKE OK');
  process.exit(0);
})().catch((err) => {
  console.error('SMOKE FAILED:', err);
  process.exit(1);
});
