'use strict';

/* Verifies v1 → v2 portfolio migration and the portfolio CRUD API. */
const os = require('os');
const fs = require('fs');
const path = require('path');
const { Store } = require('../lib/store');

function freshDir(tag) {
  const dir = path.join(os.tmpdir(), `pc-store-${tag}-${Date.now()}`);
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

function assert(cond, msg) {
  if (!cond) throw new Error('ASSERT: ' + msg);
}

// Case 1: legacy v1 array
{
  const dir = freshDir('v1');
  fs.writeFileSync(
    path.join(dir, 'portfolio.json'),
    JSON.stringify([
      { symbol: 'AAPL', quantity: 25, avgCost: 172.4 },
      { symbol: 'NVDA', quantity: 40, avgCost: 118.2 }
    ])
  );
  const store = new Store(dir);
  const s = store.getPortfolioState();
  assert(s.list.length === 1, 'legacy array becomes one portfolio');
  assert(s.positions.length === 2, 'legacy positions kept');
  assert(s.positions[0].symbol === 'AAPL', 'legacy symbols kept');
  assert(s.activeId === s.list[0].id, 'legacy active id set');
  console.log('case 1 (v1 array migration): OK ->', JSON.stringify(s.list));
}

// Case 2: legacy corrupted object-of-numeric-keys
{
  const dir = freshDir('v1bad');
  fs.writeFileSync(
    path.join(dir, 'portfolio.json'),
    JSON.stringify({ 0: { symbol: 'TSLA', quantity: 10, avgCost: 244.8 } })
  );
  const store = new Store(dir);
  const s = store.getPortfolioState();
  assert(s.positions.length === 1 && s.positions[0].symbol === 'TSLA', 'healed positions');
  console.log('case 2 (corrupted file heal): OK');
}

// Case 3: portfolio CRUD
{
  const dir = freshDir('crud');
  const store = new Store(dir);

  const created = store.createPortfolio(' Long Term  Ideas ');
  assert(created.list.length === 2, 'second portfolio created');
  assert(created.list[1].name === 'Long Term Ideas', 'name normalized: ' + created.list[1].name);
  assert(created.activeId === created.list[1].id, 'create switches to new portfolio');
  assert(created.positions.length === 0, 'new portfolio starts empty');

  let threw = false;
  try { store.createPortfolio('long term ideas'); } catch { threw = true; }
  assert(threw, 'duplicate names rejected (case-insensitive)');

  store.savePosition({ symbol: ' ko ', quantity: '10.5', avgCost: '71.25' });
  const withKo = store.getPortfolioState();
  assert(withKo.positions[0].symbol === 'KO', 'symbol trimmed/uppercased');
  assert(withKo.positions[0].quantity === 10.5, 'quantity coerced to number');
  assert(withKo.list.find((p) => p.id === withKo.activeId).count === 1, 'count updated');

  const back = store.setActivePortfolio(withKo.list[0].id);
  assert(back.activeId === back.list[0].id, 'switch back');
  assert(back.positions.length === 5, 'default sample positions intact after switch');

  const renamed = store.renamePortfolio(back.activeId, 'Core Holdings');
  assert(renamed.list[0].name === 'Core Holdings', 'rename works');

  // deleting the inactive portfolio is fine
  let afterDel = store.deletePortfolio(renamed.list[1].id);
  assert(afterDel.list.length === 1, 'inactive portfolio deleted');

  threw = false;
  try { store.deletePortfolio(afterDel.activeId); } catch (e) { threw = /at least one/i.test(e.message); }
  assert(threw, 'last portfolio cannot be deleted');

  // persistence across reload
  const reloaded = new Store(dir);
  const s2 = reloaded.getPortfolioState();
  assert(s2.list[0].name === 'Core Holdings', 'state persisted');
  assert(s2.positions.some((p) => p.symbol === 'KO') === false, 'KO was in the deleted portfolio');
  console.log('case 3 (CRUD + persistence): OK ->', JSON.stringify(s2.list));
}

// Case 4: amount-mode positions keep (and can clear) their flag
{
  const dir = freshDir('amount');
  const store = new Store(dir);
  store.savePosition({ symbol: 'AMZN', quantity: 2, avgCost: 200, amountMode: true });
  store.savePosition({ symbol: 'AAPL', quantity: 3, avgCost: 100 });
  const pos = store.getPortfolio();
  assert(pos.find((p) => p.symbol === 'AMZN').amountMode === true, 'amount flag kept on save');
  assert(!pos.find((p) => p.symbol === 'AAPL').amountMode, 'shares position has no flag');
  const re = new Store(dir).getPortfolio();
  assert(re.find((p) => p.symbol === 'AMZN').amountMode === true, 'amount flag persisted');

  // re-saving the same symbol in shares mode must clear the flag
  store.savePosition({ symbol: 'AMZN', quantity: 5, avgCost: 190 });
  assert(!store.getPortfolio().find((p) => p.symbol === 'AMZN').amountMode, 'shares re-save clears amount flag');

  // re-saving in amount mode sets it again
  store.savePosition({ symbol: 'AMZN', quantity: 6, avgCost: 195, amountMode: true });
  assert(store.getPortfolio().find((p) => p.symbol === 'AMZN').amountMode === true, 'amount re-save restores flag');
  console.log('case 4 (amount mode): OK');
}

console.log('STORE OK');
