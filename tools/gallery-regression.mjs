import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import core from '../core.js';

const input = {pool: [1, 2, 3, 4, 5], slots: 2, target: 50, collected: [1], scores: {1: 20, 2: 30, 3: 35, 4: 10, 5: 40}, prices: {2: 200, 3: 250, 4: 150, 5: 900}, maxPrice: 500, budget: 500};
const plan = {...core.galleryPlan(input), planning: input};
assert.deepEqual(plan.missing.map(c => c.id), [2]);
assert.deepEqual(core.galleryAlternatives(plan, input, 2).map(c => c.id), [3]);
assert.equal(core.galleryPlan({...input, collected: [1, 2]}).missing.length, 0, 'Sold but collected cards must remain free');
const progress = core.galleryProgress({...input, grades: [{letter: 'D', threshold: 40}, {letter: 'C', threshold: 60}], collected: [1, 2, 4]});
assert.equal(progress.score, 50);
assert.equal(progress.current, 'D');
assert.equal(progress.next.letter, 'C');
assert.equal(core.galleryProgress({...input, grades: [{letter: 'D', threshold: 10}]}).current, null, 'All slots are required');

// Exercise the actual panel purchase loop with a stale plan, including a new session.
const panel = fs.readFileSync(new URL('../ea-panel.js', import.meta.url), 'utf8');
function element() { return {append() {}, prepend() {}, querySelector() { return null; }, classList: {add() {}}}; }
async function runPurchase({held = [], receipt = null} = {}) {
  const saved = { 'fcghCollected.test': held }, calls = [];
  const context = {
    window: {addEventListener() {}}, document: {getElementById() { return null; }, createElement: element},
    chrome: {runtime: {sendMessage(message, callback) { callback({ok: true, prices: {2: 200}, at: Date.now()}); }}, storage: {local: {async get() { return saved; }, async set(value) { Object.assign(saved, value); }}}},
    GalleryCore: core, confirm: () => true, setTimeout, clearTimeout,
  };
  vm.runInNewContext(panel.replace("if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', mount, {once: true}); else mount();", `
    globalThis.testSetup = (plan, handler) => {
      persona = 'test'; currentPlan = plan;
      sets = [{id: 'test', pool: [1, 2], cards: 2, grades: [{letter: 'D', threshold: 50}]}];
      scores[1] = 20; scores[2] = 30;
      bridge = handler;
    };
    globalThis.testExecute = execute;
  `), context);
  context.testSetup({...plan, meta: {setId: 'test', letter: 'D', platform: 'ps5', priceAt: Date.now()}, planning: input}, async (method) => {
    calls.push(method);
    if (method === 'sync') return {items: [{defId: 2, collected: false}]};
    if (method === 'club') return {counts: {}};
    if (method === 'unassigned') return {items: []};
    if (method === 'search') return {found: true, price: 200, handle: 'lot'};
    if (method === 'buy') return receipt;
    throw Error(`Unexpected call: ${method}`);
  });
  const control = value => ({value});
  let error;
  try { await context.testExecute({maxPrice: control(500), budget: control(500), after: control('club'), discount: control(5), purchaseMode: control('confirm')}, {}, element(), {}, {}); }
  catch (caught) { error = caught; }
  return {saved, calls, error};
}
const repeat = await runPurchase({held: [2]});
assert.equal(repeat.error, undefined);
assert.deepEqual(repeat.calls, [], 'History must skip purchase before any market request');
const delayed = await runPurchase({receipt: {price: 200, defId: 2, item: null}});
assert.match(delayed.error?.message || '', /сохранена в истории/);
assert.ok(delayed.saved['fcghCollected.test'].includes(2), 'Save confirmed purchase before checking inventory');
const afterReload = await runPurchase({held: delayed.saved['fcghCollected.test']});
assert.deepEqual(afterReload.calls, [], 'A reload must not buy the delayed card again');
console.log('Gallery regression tests passed: persistent ownership, stale plans, delayed items, alternatives and tiers.');
