import fs from 'node:fs';
import vm from 'node:vm';

const source = fs.readFileSync(new URL('../page-bridge.js', import.meta.url), 'utf8');
const listeners = [];
const responses = new Map();
const rows = Array.from({length: 100}, (_, index) => ({
  definitionId: index + 1,
  resourceId: index + 1,
  isCollected: index === 99,
  gradingScore: 20
}));
const factory = {createItem(raw) { return {definitionId: raw.definitionId, getName: () => `Card ${raw.definitionId}`}; }};
const observable = data => ({observe(scope, callback) { queueMicrotask(() => callback(this, {success: true, data})); }, unobserve() {}});
const window = {
  factories: {Item: factory}, SearchType: {PLAYER: 'player'},
  services: {
    Item: {
      searchConceptItems(criteria) {
        const page = rows.slice(criteria.offset, criteria.offset + Math.min(criteria.count, 91)).map(raw => factory.createItem(raw));
        return observable({items: page});
      }
    }
  },
  addEventListener(type, listener) { if (type === 'message') listeners.push(listener); },
  postMessage(message) {
    if (message.direction === 'response') responses.get(message.id)?.(message);
    for (const listener of listeners) listener({source: window, data: message});
  }
};
const context = {window, setInterval: () => 1, clearInterval() {}, setTimeout, queueMicrotask, console};
vm.runInNewContext(source, context, {filename: 'page-bridge.js'});

const result = await new Promise((resolve, reject) => {
  const id = 'pagination-smoke';
  responses.set(id, message => message.ok ? resolve(message.result) : reject(new Error(message.error)));
  window.postMessage({channel: 'fcgh-v1', direction: 'request', id, method: 'sync', args: {ids: rows.map(row => row.definitionId)}});
});
if (result.rows !== 100 || result.pages !== 2 || result.complete !== true) throw new Error(`Pagination failed: ${JSON.stringify(result)}`);
if (result.items.find(row => row.defId === 100)?.collected !== true) throw new Error('Collected card on page 2 was not detected');
console.log('Bridge pagination smoke test passed: 100 cards, 2 pages, last card collected.');
