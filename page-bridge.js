(() => {
  if (window.__FCGH_PAGE_BRIDGE__) return;
  window.__FCGH_PAGE_BRIDGE__ = true;
  const CHANNEL = 'fcgh-v1';
  const BRIDGE_VERSION = '1.5.0';
  const marks = new Map(), lots = new Map(), items = new Map();
  let sequence = 0, installed = false, lastSbcFill = null;
  const positive = value => Number.isSafeInteger(Number(value)) && Number(value) > 0 ? Number(value) : null;
  const itemDefId = item => positive(item?.definitionId ?? item?.resourceId);
  const booleanValue = value => value === true || value === 1 || value === 'true' ? true : value === false || value === 0 || value === 'false' ? false : null;
  const galleryFlag = value => {
    if (!value || typeof value !== 'object') return null;
    for (const read of [
      () => value.isCollected,
      () => value.collected,
      () => value.isGalleryCollected,
      () => value.galleryCollected,
      () => value.gallery?.isCollected,
      () => value.getIsCollected?.(),
      () => value.isCollected?.()
    ]) {
      try { const result = booleanValue(read()); if (result !== null) return result; } catch {}
    }
    return null;
  };
  const galleryScore = value => {
    if (!value || typeof value !== 'object') return null;
    for (const read of [() => value.gradingScore, () => value.galleryScore, () => value.itemScore, () => value.gallery?.gradingScore, () => value.getGradingScore?.()]) {
      try { const result = Number(read()); if (Number.isFinite(result) && result >= 0) return result; } catch {}
    }
    return null;
  };
  const remember = (raw, entity = null) => {
    if (!raw || typeof raw !== 'object') return;
    const defId = positive(raw.resourceId ?? raw.definitionId ?? raw.itemData?.resourceId ?? raw.itemData?.definitionId) || itemDefId(entity);
    if (!defId) return;
    const collected = galleryFlag(raw) ?? galleryFlag(raw.itemData) ?? galleryFlag(entity);
    const score = galleryScore(raw) ?? galleryScore(raw.itemData) ?? galleryScore(entity);
    if (collected === null && score === null) return;
    const old = marks.get(defId) || {};
    // Gallery ownership is permanent: once true, a later stale response must not revert it.
    const rememberedCollected = old.collected === true || collected === true ? true : collected ?? old.collected ?? null;
    marks.set(defId, {collected: rememberedCollected, score: score ?? old.score ?? null, seq: ++sequence});
  };
  function installCapture() {
    if (installed) return true;
    let factory;
    try { factory = window.factories?.Item; } catch { return false; }
    if (!factory) return false;
    let owner = factory;
    while (owner && owner !== Object.prototype && !Object.prototype.hasOwnProperty.call(owner, 'createItem')) owner = Object.getPrototypeOf(owner);
    if (!owner || typeof owner.createItem !== 'function') return false;
    const original = owner.createItem;
    owner.createItem = function(raw) {
      const result = original.apply(this, arguments);
      try { remember(raw, result); } catch {}
      return result;
    };
    installed = true;
    return true;
  }
  const captureTimer = setInterval(() => { if (installCapture()) clearInterval(captureTimer); }, 200);
  installCapture();

  function observable(value, label) {
    return new Promise((resolve, reject) => {
      if (!value || typeof value.observe !== 'function') return reject(new Error(`${label}: EAObservable недоступен`));
      const scope = {};
      value.observe(scope, (sender, response) => {
        try { (sender || value).unobserve?.(scope); } catch {}
        if (!response || response.success !== true) {
          const status = response?.error?.code ?? response?.status ?? 'unknown';
          return reject(new Error(`${label}: EA отказала (${status})`));
        }
        resolve(response.data === undefined ? response.response : response.data);
      });
    });
  }
  function criteria(values) {
    let current;
    try { current = window.services?.User?.getUser?.()?.marketSearchCriteria; } catch {}
    const dto = typeof current?.constructor === 'function' ? new current.constructor() : {};
    for (const [key, value] of Object.entries(values)) try { dto[key] = value; } catch {}
    return dto;
  }
  const service = () => {
    const item = window.services?.Item;
    if (!item) throw new Error('EA Web App ещё не загрузился');
    return item;
  };
  const auction = lot => { try { return lot?.getAuctionData?.() || null; } catch { return null; } };
  const lotPrice = lot => positive(auction(lot)?.buyNowPrice);
  const nameOf = item => {
    for (const read of [() => item?.getName?.(), () => item?.name, () => item?.commonName, () => item?.lastName]) {
      try { const value = read(); if (typeof value === 'string' && value.trim()) return value.trim(); } catch {}
    }
    return null;
  };
  const balance = () => {
    try {
      const list = window.services?.User?.getUser?.()?.getCurrencies?.();
      return list?.find(row => row?.type === (window.GameCurrency?.COINS ?? 'COINS'))?.amount ?? null;
    } catch { return null; }
  };
  async function sync(ids) {
    installCapture();
    const list = [...new Set((ids || []).map(Number).filter(id => Number.isSafeInteger(id) && id > 0))].slice(0, 1000);
    if (!list.length) return {rows: 0, pages: 0, complete: true, items: []};
    const wanted = new Set(list), found = new Map();
    let offset = 0, pages = 0;
    // FC 27 currently returns Gallery/concept results in pages of at most 91.
    // Continue until every requested definitionId was seen or EA returns an empty page.
    while (pages < 10 && found.size < wanted.size) {
      const data = await observable(service().searchConceptItems(criteria({type: window.SearchType?.PLAYER ?? 'player', count: 91, offset, defId: list})), `Проверка Gallery, страница ${pages + 1}`);
      const entities = Array.isArray(data?.items) ? data.items : [];
      pages++;
      if (!entities.length) break;
      for (const entity of entities) {
        try { remember(entity, entity); } catch {}
        const defId = itemDefId(entity);
        if (defId && wanted.has(defId)) found.set(defId, entity);
      }
      offset += entities.length;
      if (found.size < wanted.size) await new Promise(resolve => setTimeout(resolve, 300));
    }
    return {rows: found.size, pages, complete: found.size === wanted.size, items: [...found.entries()].map(([defId, entity]) => {
      const mark = marks.get(defId);
      return {defId, collected: mark?.collected ?? galleryFlag(entity), score: mark?.score ?? galleryScore(entity), name: nameOf(entity)};
    })};
  }
  async function search(defId, maxBuy, excludedTradeIdsArg) {
    const id = positive(defId), cap = positive(maxBuy) || 15_000_000;
    if (!id) throw new Error('Некорректный definitionId');
    const excluded = new Set((Array.isArray(excludedTradeIdsArg) ? excludedTradeIdsArg : []).map(String));
    service().clearTransferMarketCache?.();
    const data = await observable(service().searchTransferMarket(criteria({type: window.SearchType?.PLAYER ?? 'player', count: 20, offset: 0, defId: [id], maxBuy: cap}), 1), 'Поиск рынка');
    const found = (Array.isArray(data?.items) ? data.items : []).filter(lot => itemDefId(lot) === id && lotPrice(lot) && lotPrice(lot) <= cap && !excluded.has(String(auction(lot)?.tradeId))).sort((a, b) => lotPrice(a) - lotPrice(b));
    if (!found.length) return {found: false};
    const lot = found[0], handle = `lot-${Date.now()}-${Math.random()}`;
    lots.set(handle, lot);
    return {found: true, handle, price: lotPrice(lot), defId: id, name: nameOf(lot), tradeId: auction(lot)?.tradeId ?? null};
  }
  async function club(ids) {
    const wanted = [...new Set((ids || []).map(Number).filter(id => Number.isSafeInteger(id) && id > 0))].slice(0, 100);
    if (!wanted.length) return {items: [], counts: {}};
    const query = criteria({type: window.SearchType?.PLAYER ?? 'player', count: 100, offset: 0, defId: wanted});
    const operation = typeof service().searchClubItems === 'function' ? service().searchClubItems(query) : window.services?.Club?.search?.(query);
    if (!operation) throw new Error('EA не предоставила поиск по клубу в этой версии Web App');
    const data = await observable(operation, 'Поиск игроков в клубе');
    const found = Array.isArray(data?.items) ? data.items : [];
    const counts = {}, rows = [];
    for (const item of found) {
      const defId = itemDefId(item); if (!wanted.includes(defId)) continue;
      counts[defId] = (counts[defId] || 0) + 1;
      const handle = `club-${Date.now()}-${Math.random()}`; items.set(handle, item);
      rows.push({handle, defId, id: positive(item?.id), name: nameOf(item), untradeable: item?.untradeable === true || item?.isUntradeable === true});
    }
    return {items: rows, counts};
  }
  function currentSbcChallenge() {
    let app = null;
    try { app = window._appMain || window.getAppMain?.(); } catch {}
    const root = app?._rootViewController || app?.getRootViewController?.();
    if (!root) return null;
    const queue = [{node: root, depth: 0}], seen = new Set();
    const links = ['currentController', 'leftController', 'rightController', '_childViewControllers', 'childViewControllers', 'presentedViewController', '_presentedViewController', '_navigationController', 'navigationController'];
    while (queue.length) {
      const {node, depth} = queue.shift();
      if (!node || typeof node !== 'object' || seen.has(node)) continue;
      seen.add(node);
      const challenge = node._challenge || node.challenge;
      if (challenge?.squad?.getPlayers) return challenge;
      if (depth >= 8) continue;
      for (const key of links) {
        let value; try { value = node[key]; } catch { continue; }
        if (Array.isArray(value)) for (const child of value) queue.push({node: child, depth: depth + 1});
        else if (value && typeof value === 'object') queue.push({node: value, depth: depth + 1});
      }
    }
    return null;
  }
  function positionPoint(position, fallbackIndex, total) {
    const id = Number(position?.id);
    const points = {
      0:[.50,1.00], 2:[.90,.72], 3:[.90,.78], 4:[.66,.78], 5:[.50,.78], 6:[.34,.78], 7:[.10,.78], 8:[.10,.72],
      9:[.66,.61], 10:[.50,.61], 11:[.34,.61], 12:[.90,.50], 13:[.66,.49], 14:[.50,.49], 15:[.34,.49], 16:[.10,.50],
      17:[.66,.34], 18:[.50,.34], 19:[.34,.34], 20:[.66,.20], 21:[.50,.20], 22:[.34,.20], 23:[.90,.17], 24:[.66,.15], 25:[.50,.14], 26:[.34,.15], 27:[.10,.17]
    };
    const point = points[id] || [.5, total > 1 ? 1 - fallbackIndex / (total - 1) : .5];
    return {x: point[0], y: point[1], id, name: position?.name || position?.typeName || `позиция ${fallbackIndex + 1}`};
  }
  function bestPositionAssignment(cards, openSlots) {
    const targets = openSlots.map((entry, index) => positionPoint(entry.slot.position, index, openSlots.length));
    const sources = cards.map((card, index) => ({
      x: Number.isFinite(Number(card.fieldX)) ? Number(card.fieldX) : .5,
      y: Number.isFinite(Number(card.fieldY)) ? Number(card.fieldY) : (cards.length > 1 ? index / (cards.length - 1) : .5)
    }));
    const memo = new Map();
    function solve(at, mask) {
      if (at === cards.length) return {cost: 0, choices: []};
      const key = `${at}:${mask}`; if (memo.has(key)) return memo.get(key);
      let best = {cost: Infinity, choices: []};
      for (let target = 0; target < targets.length; target++) {
        if (mask & (1 << target)) continue;
        const dx = sources[at].x - targets[target].x, dy = sources[at].y - targets[target].y;
        const rest = solve(at + 1, mask | (1 << target));
        const cost = dx * dx + 1.7 * dy * dy + rest.cost;
        if (cost < best.cost) best = {cost, choices: [target, ...rest.choices]};
      }
      memo.set(key, best); return best;
    }
    return solve(0, 0).choices.map((target, cardIndex) => ({card: cards[cardIndex], ...openSlots[target], target: targets[target]}));
  }
  function sbcState(challenge) {
    const squad = challenge?.squad;
    const read = (object, method) => { try { return typeof object?.[method] === 'function' ? object[method]() : null; } catch { return null; } };
    return {challengeId: challenge?.id ?? null, challengeName: challenge?.name || null, rating: read(squad, 'getRating'), chemistry: read(squad, 'getChemistry'), meetsRequirements: read(challenge, 'meetsRequirements'), canSubmit: read(challenge, 'canSubmit')};
  }
  async function fillSbc(cards) {
    if (!Array.isArray(cards) || cards.length !== 11) throw new Error('Для расстановки нужен импортированный состав из 11 карт');
    const challenge = currentSbcChallenge();
    if (!challenge) throw new Error('Открой нужное испытание ИПК и экран с пустым полем');
    const squad = challenge.squad, slots = squad.getPlayers?.();
    if (!Array.isArray(slots) || typeof squad.removeAllItems !== 'function' || typeof squad.setPlayers !== 'function') throw new Error('EA изменила модель состава — расстановка недоступна');
    if (typeof window.services?.SBC?.saveChallenge !== 'function') throw new Error('Сервис сохранения ИПК ещё не загрузился');
    const openSlots = slots.map((slot, index) => ({slot, index})).filter(({slot}) => {
      if (!slot?.position) return false;
      const type = slot.requirement?.playerType;
      try { if (slot.isBrick?.() || slot.isCustomBrick?.()) return false; } catch {}
      return !type || type === 'DEFAULT';
    });
    if (openSlots.length !== cards.length) throw new Error(`В открытом ИПК доступно ${openSlots.length} ячеек, а в сборке FUTBIN ${cards.length} игроков`);
    const clubResult = await club(cards.map(card => card.defId));
    const byDef = new Map();
    for (const row of clubResult.items || []) {
      const entity = items.get(row.handle); if (!entity) continue;
      if (!byDef.has(row.defId)) byDef.set(row.defId, []);
      byDef.get(row.defId).push(entity);
    }
    const missing = cards.filter(card => !(byDef.get(Number(card.defId)) || []).length);
    if (missing.length) throw new Error(`В клубе не найдены: ${missing.map(card => card.name).join(', ')}. Нажми «Проверить клуб».`);
    const assignment = bestPositionAssignment(cards, openSlots);
    const original = slots.map(slot => { try { return slot.getItem?.(); } catch { return null; } });
    const EmptyItem = window.UTItemEntity;
    if (typeof EmptyItem !== 'function') throw new Error('EA не предоставила модель пустой карточки');
    const planned = slots.map((slot, index) => openSlots.some(open => open.index === index) ? new EmptyItem() : original[index]);
    const placements = [];
    for (const entry of assignment) {
      const pool = byDef.get(Number(entry.card.defId)) || [], entity = pool.shift();
      if (!entity) throw new Error(`Карточка ${entry.card.name} больше не найдена в клубе`);
      planned[entry.index] = entity;
      placements.push({name: entry.card.name, position: entry.target.name, slotIndex: entry.index});
    }
    lastSbcFill = {challenge, original};
    try {
      squad.removeAllItems(); squad.setPlayers(planned, true);
      await observable(window.services.SBC.saveChallenge(challenge), 'Сохранение состава ИПК');
      try { challenge.onDataChange?.notify?.({squad}); } catch {}
    } catch (error) {
      try { squad.removeAllItems(); squad.setPlayers(original, true); } catch {}
      lastSbcFill = null; throw error;
    }
    return {...sbcState(challenge), placements};
  }
  async function undoSbcFill() {
    if (!lastSbcFill?.challenge || !Array.isArray(lastSbcFill.original)) throw new Error('Нет расстановки, которую можно отменить');
    const {challenge, original} = lastSbcFill, squad = challenge.squad;
    squad.removeAllItems(); squad.setPlayers(original, true);
    await observable(window.services.SBC.saveChallenge(challenge), 'Отмена расстановки ИПК');
    try { challenge.onDataChange?.notify?.({squad}); } catch {}
    lastSbcFill = null; return sbcState(challenge);
  }
  async function readUnassigned(defId = null) {
    const data = await observable(service().requestUnassignedItems(), 'Непринятые предметы');
    return (Array.isArray(data?.items) ? data.items : []).filter(item => defId === null || itemDefId(item) === Number(defId)).map(item => {
      const handle = `item-${Date.now()}-${Math.random()}`;
      items.set(handle, item);
      return {handle, id: positive(item?.id), defId: itemDefId(item), name: nameOf(item)};
    });
  }
  async function buy(handle, ceiling) {
    const lot = lots.get(handle);
    if (!lot) throw new Error('Лот устарел — повтори поиск');
    const price = lotPrice(lot);
    if (!price || price > Number(ceiling)) throw new Error('Цена лота выше лимита');
    await observable(service().bid(lot, price), 'Покупка');
    lots.delete(handle);
    let bought = [];
    for (let attempt = 0; attempt < 4 && !bought.length; attempt++) {
      await new Promise(resolve => setTimeout(resolve, 500 + attempt * 300));
      bought = await readUnassigned(itemDefId(lot));
    }
    return {price, defId: itemDefId(lot), item: bought[0] || null};
  }
  function previousPrice(value) {
    const p = Number(value), step = p < 1000 ? 50 : p < 10_000 ? 100 : p < 50_000 ? 250 : p < 100_000 ? 500 : 1000;
    return Math.max(150, Math.floor((p - 1) / step) * step);
  }
  async function list(handle, reference, discount) {
    const item = items.get(handle);
    if (!item) throw new Error('Предмет PURCHASED не найден');
    const pct = Math.max(0, Math.min(20, Number(discount) || 0));
    const buyNow = Math.max(200, previousPrice(Math.floor(Number(reference) * (1 - pct / 100)) + 1));
    const startingBid = previousPrice(buyNow);
    await observable(service().list(item, startingBid, buyNow, 3600), 'Выставление лота');
    items.delete(handle);
    return {startingBid, buyNow, net: Math.floor(buyNow * .95)};
  }
  async function quicksell(handle) {
    const item = items.get(handle);
    if (!item) throw new Error('Предмет PURCHASED не найден');
    const discardValue = positive(item?.discardValue ?? item?.getDiscardValue?.()) || 0;
    await observable(service().discard([item]), 'Быстрая продажа');
    items.delete(handle);
    return {discardValue};
  }
  async function move(handle, destination) {
    const item = items.get(handle);
    if (!item) throw new Error('Предмет PURCHASED не найден');
    const pile = destination === 'transfer' ? (window.ItemPile?.TRANSFER ?? 5) : (window.ItemPile?.CLUB ?? 7);
    await observable(service().move([item], pile), 'Перемещение предмета');
    items.delete(handle);
    return {destination};
  }
  async function run(method, args) {
    if (method === 'status') {
      let persona = null;
      try { persona = String(window.services?.User?.getUser?.()?.getSelectedPersona?.()?.id ?? '') || null; } catch {}
      return {ready: Boolean(window.services?.Item), capture: installed, coins: balance(), marks: marks.size, persona, bridgeVersion: BRIDGE_VERSION};
    }
    if (method === 'sync') return sync(args.ids);
    if (method === 'club') return club(args.ids);
    if (method === 'sbcfill') return fillSbc(args.cards);
    if (method === 'sbcundo') return undoSbcFill();
    if (method === 'search') return search(args.defId, args.maxBuy, args.excludeTradeIds);
    if (method === 'buy') return buy(args.handle, args.ceiling);
    if (method === 'list') return list(args.handle, args.reference, args.discount);
    if (method === 'quicksell') return quicksell(args.handle);
    if (method === 'move') return move(args.handle, args.destination);
    if (method === 'unassigned') return {items: await readUnassigned(args.defId ?? null)};
    throw new Error('Неизвестная команда моста');
  }
  window.addEventListener('message', event => {
    const message = event.data;
    if (event.source !== window || message?.channel !== CHANNEL || message?.direction !== 'request') return;
    Promise.resolve().then(() => run(message.method, message.args || {})).then(
      result => window.postMessage({channel: CHANNEL, direction: 'response', id: message.id, ok: true, result}, '*'),
      error => window.postMessage({channel: CHANNEL, direction: 'response', id: message.id, ok: false, error: String(error?.message || error)}, '*')
    );
  });
  window.postMessage({channel: CHANNEL, direction: 'ready'}, '*');
})();
