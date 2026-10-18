import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import core from '../core.js';

const now = Date.now();
assert.equal(core.priceRisk(1100, 1000, now).manual, false);
assert.equal(core.priceRisk(1101, 1000, now).manual, true);
assert.equal(core.priceRisk(900, 1000, now).manual, false);
assert.equal(core.priceRisk(1000, null, now).reason, 'unknown');
assert.equal(core.priceRisk(1000, 1000, now - 600001).manual, true);
assert.equal(core.priceRisk(1000, 1000, now + 5000).manual, true);
const sets = [{id: 'a', pool: [1, 2, 3], cards: 2, grades: [{letter: 'D', threshold: 30}, {letter: 'S', threshold: 70}]}, {id: 'b', pool: [2, 3, 4], cards: 2, grades: [{letter: 'D', threshold: 30}]}];
assert.deepEqual(core.syncQueue(sets, {2: now}, [1]), [3, 4]);
assert.deepEqual(core.syncQueue(sets, {2: now}, [1], true), [1, 2, 3, 4]);
assert.deepEqual(core.syncQueue(sets, {2: now - core.SYNC_TTL}, [1]), [2, 3, 4]);
assert.equal(core.setOverview(sets[0], [], {}, {}).coverage, 'unknown');
assert.equal(core.setOverview(sets[0], [1], {1: 20}, {}).coverage, 'partial');
const saved = core.setOverview(sets[0], [1, 2], {1: 20, 2: 25}, {3: now});
assert.equal(saved.current, 'D'); assert.equal(saved.stale, false); assert.equal(saved.next.letter, 'S');

const source = fs.readFileSync(new URL('../ea-panel.js', import.meta.url), 'utf8');
const tail = "if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', mount, {once: true}); else mount();";
function harness({price = 1200, quote = 1000, accept = false, stopOnSearch = false, clubFailure = false} = {}) {
  const calls = [], prompts = [], storage = {}, runtimeCalls = [];
  const context = {window: {addEventListener() {}}, document: {getElementById() { return null; }}, GalleryCore: core,
    setTimeout(callback) { callback(); return 1; }, clearTimeout() {},
    confirm(message) { prompts.push(message); return accept; },
    chrome: {runtime: {sendMessage(message, callback) { runtimeCalls.push(message); callback({ok: true, prices: quote ? Object.fromEntries(message.ids.map(id => [id, quote])) : {}, at: Date.now()}); }}, storage: {local: {async get() { return storage; }, async set(value) { Object.assign(storage, structuredClone(value)); }}}},
  };
  vm.runInNewContext(source.replace(tail, `globalThis.api = {findAndBuy, syncSets, runOperation, catalogBatch, state: () => ({checkedAt, collected: [...collected]}), setCollected(ids) { for (const id of ids) { collected.add(id); scores[id] = 100; } }, setup(handler) { bridge = handler; ready = true; persona = 'test'; }, stop() { stopRequested = true; }};`), context);
  context.api.setup(async (method, args) => {
    calls.push({method, args});
    if (method === 'unassigned') return {items: []};
    if (method === 'search') { if (stopOnSearch) context.api.stop(); return {found: true, price, handle: 'lot'}; }
    if (method === 'buy') return {price, defId: 1, item: null};
    if (method === 'sync') return {items: args.ids.map(defId => ({defId, collected: defId === 1, score: 20, name: 'Card ' + defId}))};
    if (method === 'club') { if (clubFailure) throw Error('Club offline'); return {counts: {}, items: []}; }
    throw Error(method);
  });
  return {api: context.api, calls, prompts, storage, runtimeCalls};
}
const options = {defId: 1, name: 'Player', ceiling: 2000, purchaseMode: 'auto', status: {}, platform: 'ps5'};
const rejected = harness();
assert.equal((await rejected.api.findAndBuy(options)).state, 'skipped');
assert.match(rejected.prompts[0], /ПЕРЕПЛАТА БОЛЕЕ 10%/);
assert.equal(rejected.calls.some(c => c.method === 'buy'), false);
const allowed = harness({accept: true});
assert.equal((await allowed.api.findAndBuy(options)).state, 'bought');
assert.equal(allowed.prompts.length, 1);
assert.ok(allowed.storage['fcghCollected.test'].includes(1));
const exact = harness({price: 1100});
assert.equal((await exact.api.findAndBuy(options)).state, 'bought');
assert.equal(exact.prompts.length, 0);
const unknown = harness({quote: null});
assert.equal((await unknown.api.findAndBuy(options)).state, 'skipped');
assert.match(unknown.prompts[0], /Нет свежего/);
const stopped = harness({stopOnSearch: true});
assert.equal((await stopped.api.findAndBuy(options)).state, 'stopped');
assert.equal(stopped.calls.some(c => c.method === 'buy'), false);
const syncing = harness();
await syncing.api.syncSets(sets, {});
assert.deepEqual(syncing.calls.filter(c => c.method === 'sync').flatMap(c => Array.from(c.args.ids)), [1, 2, 3, 4]);
syncing.calls.length = 0;
await syncing.api.syncSets(sets, {});
assert.equal(syncing.calls.length, 0, 'Resume skips all fresh/shared cards');
const failed = harness({clubFailure: true});
await assert.rejects(failed.api.syncSets(sets, {}), /Club offline/);
assert.ok(failed.storage['fcghCollected.test'].includes(1), 'Positive ownership survives club failure');
assert.equal(Object.keys(failed.api.state().checkedAt).length, 0, 'Incomplete batch remains retryable');
let release;
const pending = syncing.api.runOperation(() => new Promise(resolve => { release = resolve; }));
let concurrent = false;
await syncing.api.runOperation(() => { concurrent = true; });
assert.equal(concurrent, false, 'Concurrent UI operations are blocked');
release(); await pending;
const complete = harness(); complete.api.setCollected([1, 2]);
await complete.api.syncSets([sets[0]], {});
assert.equal(complete.calls.length, 0, 'A permanently completed maximum tier needs no requests');
const large = harness();
const allPrices = await large.api.catalogBatch('fcgh.prices', Array.from({length: 21002}, (_, index) => index + 1), 'pc');
assert.equal(Object.keys(allPrices.prices).length, 21002, 'Large pools are not truncated');
assert.deepEqual(large.runtimeCalls.map(c => c.ids.length), [8000, 8000, 5002]);
const rising = harness({price: 1150, quote: 1200});
assert.equal((await rising.api.findAndBuy({...options, reference: 1000, referenceAt: Date.now()})).state, 'skipped', 'Rising reference cannot silently permit overpayment');
console.log('V2 regressions passed: 10% boundary, automatic/manual purchases, missing prices, stop, sync deduplication/resume/failure, operation lock.');
