'use strict';

/* Verifies live mode degrades gracefully when the Finnhub key is invalid. */
const os = require('os');
const path = require('path');
const { Store } = require('../lib/store');
const { Market } = require('../lib/market');

(async () => {
  const store = new Store(path.join(os.tmpdir(), `pc-fakekey-${Date.now()}`));
  store.saveSettings({ apiKey: 'fake_key_1234567890' });
  const market = new Market(store);

  console.log('resolveMode with key:', market.resolveMode());
  console.log('status:', JSON.stringify(market.getStatus()));

  const test = await market.testConnection('fake_key_1234567890');
  console.log('testConnection:', JSON.stringify(test));
  if (test.ok) throw new Error('bad key must not pass the test');

  const candles = await market.loadCandles('AAPL', '1D');
  console.log('candles with bad key:', candles.source, candles.bars.length);
  if (candles.source !== 'Yahoo Finance') throw new Error('expected Yahoo fallback for candles');

  const quotes = await market.getQuotes(['AAPL', 'NVDA']);
  console.log('quotes with bad key:', JSON.stringify(quotes));
  if (!quotes.AAPL || !quotes.NVDA) throw new Error('expected Yahoo fallback for quotes');

  console.log('FAKEKEY OK');
  process.exit(0);
})().catch((err) => {
  console.error('FAKEKEY FAILED:', err.message);
  process.exit(1);
});
