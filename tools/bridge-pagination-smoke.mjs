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

// A successful bid followed by inventory error 461 must stay a successful bid.
let bids = 0;
window.services.Item.searchTransferMarket = () => observable({items: [{definitionId: 123, getAuctionData: () => ({buyNowPrice: 200, tradeId: 456})}]});
window.services.Item.bid = () => { bids++; return observable({}); };
window.services.Item.requestUnassignedItems = () => ({observe(scope, callback) { queueMicrotask(() => callback(this, {success: false, error: {code: 461}})); }, unobserve() {}});
let nextId = 0;
const call = (method, args) => new Promise((resolve, reject) => {
  const id = `purchase-${++nextId}`;
  responses.set(id, message => message.ok ? resolve(message.result) : reject(new Error(message.error)));
  window.postMessage({channel: 'fcgh-v1', direction: 'request', id, method, args});
});
const lot = await call('search', {defId: 123, maxBuy: 500});
const receipt = await call('buy', {handle: lot.handle, ceiling: 500});
if (receipt.price !== 200 || receipt.item !== null || bids !== 1) throw Error('Successful bid was lost after inventory error');
console.log('Bridge purchase smoke test passed: inventory error preserves successful receipt.');

const marketCaps = [];
window.services.Item.searchTransferMarket = criteria => {
  marketCaps.push(criteria.maxBuy);
  const price = criteria.maxBuy >= 1000 ? 1000 : criteria.maxBuy >= 700 ? 700 : null;
  return observable({items: price ? [{definitionId: 222, getAuctionData: () => ({buyNowPrice: price, tradeId: price})}] : []});
};
const cheaper = await call('search', {defId: 222, maxBuy: 2000});
if (cheaper.price !== 700 || marketCaps.length !== 3) throw Error('Did not search below the first market result');
const clubOffsets = [];
window.services.Item.searchClubItems = criteria => {
  clubOffsets.push(criteria.offset);
  return observable({items: criteria.offset === 0 ? [{id: 11, definitionId: 333}] : criteria.offset === 1 ? [{id: 12, definitionId: 444}] : []});
};
const club = await call('club', {ids: [333, 444, 555]});
if (club.counts[444] !== 1 || clubOffsets.join(',') !== '0,1,2') throw Error('Club pagination lost a card or stopped before exhaustion');
window.services.Item.searchClubItems = () => observable({items: [{id: 11, definitionId: 333}]});
const partial = await call('club', {ids: [333, 555]});
if (partial.complete !== false || partial.reason !== 'repeated-page' || partial.counts[333] !== 1) throw Error('Partial club result lost ownership or claimed completeness');
const pageNumbers = [];
window.services.Item.searchClubItems = (criteria, page) => { pageNumbers.push(page); return observable({items: page === 1 ? [{id: 11, definitionId: 333}] : page === 2 ? [{id: 12, definitionId: 444}] : []}); };
const paged = await call('club', {ids: [333, 444, 555]});
if (!paged.complete || paged.counts[444] !== 1 || pageNumbers.join(',') !== '1,2,3') throw Error('Separate page argument was not advanced');
console.log('Bridge V2 tests passed: lower-price probes, full club pagination and repeated-page protection.');
