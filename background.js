const GAME = 27;
const FUTGG_MANIFEST = `https://r2.fut.gg/${GAME}/manifest.json`;
const OWN_DATA_ROOT = 'https://raw.githubusercontent.com/sergunchik218/FC-Gallery_SBC-Assistant/main';
const DATA_TTL = 7 * 24 * 60 * 60_000;
const WEEK_MINUTES = 7 * 24 * 60;
const FUTBIN_LOAD_TIMEOUT = 60_000;
const FUTBIN_POLL_INTERVAL = 750;
const FUTBIN_SCORE_URL = `https://www.futbin.com/${GAME}/squad-building-challenges/cheapest-item-score`;
const FUTBIN_SCORE_TTL = 10 * 60_000;
let catalogMemo = null;
const priceMemo = new Map();
const futbinScoreMemo = new Map();
let cardsMemo = null;
let dataBundleMemo = null;

async function json(url) {
  const response = await fetch(url, {cache: 'no-cache'});
  if (!response.ok) throw new Error(`HTTP ${response.status}: ${url}`);
  return response.json();
}

function validCatalog(data) {
  return data?.schema === 1 && data?.game === 'fc27' && Array.isArray(data.categories);
}

function validCards(data) {
  return Array.isArray(data?.fields) && data.fields.includes('eaId') && Array.isArray(data?.cards);
}

async function localDataBundle() {
  const [catalogResponse, cardsResponse] = await Promise.all([
    fetch(chrome.runtime.getURL('gallery-catalog-27.json'), {cache: 'no-cache'}),
    fetch(chrome.runtime.getURL('cards-27.json'), {cache: 'no-cache'})
  ]);
  if (!catalogResponse.ok || !cardsResponse.ok) throw new Error('Не удалось открыть встроенную базу Gallery FC 27');
  const [catalog, cards] = await Promise.all([catalogResponse.json(), cardsResponse.json()]);
  if (!validCatalog(catalog) || !validCards(cards)) throw new Error('Повреждена встроенная база Gallery FC 27');
  return {at: 0, source: 'built-in', catalog, cards};
}

async function dataBundle(force = false) {
  if (dataBundleMemo && !force) return dataBundleMemo;
  const stored = await chrome.storage.local.get('fcghDataBundle27');
  const cached = stored.fcghDataBundle27;
  if (!force && cached?.at && Date.now() - cached.at < DATA_TTL && validCatalog(cached.catalog) && validCards(cached.cards)) return (dataBundleMemo = cached);
  try {
    const [catalog, cards] = await Promise.all([
      json(`${OWN_DATA_ROOT}/gallery-catalog-27.json`),
      json(`${OWN_DATA_ROOT}/cards-27.json`)
    ]);
    if (!validCatalog(catalog) || !validCards(cards)) throw new Error('Неизвестный формат обновления Gallery');
    const bundle = {at: Date.now(), source: 'github', catalog, cards};
    await chrome.storage.local.set({fcghDataBundle27: bundle});
    return (dataBundleMemo = bundle);
  } catch (error) {
    if (validCatalog(cached?.catalog) && validCards(cached?.cards)) return (dataBundleMemo = cached);
    return (dataBundleMemo = await localDataBundle());
  }
}

async function updateOwnedData() {
  dataBundleMemo = null;
  const bundle = await dataBundle(true);
  catalogMemo = expandDynamicPools(bundle.catalog, bundle.cards);
  cardsMemo = null;
  const sets = catalogMemo.categories.reduce((sum, category) => sum + (category.sets?.length || 0), 0);
  return {source: bundle.source, at: bundle.at || Date.now(), version: bundle.catalog.version ?? null, categories: bundle.catalog.categories.length, sets, cards: bundle.cards.cards.length};
}

chrome.runtime.onInstalled.addListener(() => {
  chrome.alarms.create('fcgh-weekly-data-update', {delayInMinutes: WEEK_MINUTES, periodInMinutes: WEEK_MINUTES});
});

chrome.runtime.onStartup.addListener(async () => {
  const alarm = await chrome.alarms.get('fcgh-weekly-data-update');
  if (!alarm) chrome.alarms.create('fcgh-weekly-data-update', {delayInMinutes: WEEK_MINUTES, periodInMinutes: WEEK_MINUTES});
});

chrome.alarms.onAlarm.addListener(alarm => {
  if (alarm.name === 'fcgh-weekly-data-update') updateOwnedData().catch(() => {});
});

function expandDynamicPools(catalog, cards) {
  const at = Object.fromEntries(cards.fields.map((name, index) => [name, index]));
  const common = cards.cards.filter(row => Number(row[at.rarityEaId]) === 0).map(row => Number(row[at.eaId])).filter(Number.isSafeInteger);
  for (const category of catalog.categories) for (const set of category.sets || []) {
    if ((!Array.isArray(set.pool) || !set.pool.length) && set.rule?.anyCommon === true) set.pool = common;
  }
  return catalog;
}

async function galleryCatalog(force = false) {
  if (catalogMemo && !force) return catalogMemo;
  const bundle = await dataBundle(force);
  catalogMemo = expandDynamicPools(bundle.catalog, bundle.cards);
  return catalogMemo;
}

function blobUrl(manifest, name) {
  const version = manifest?._version;
  const hash = manifest?.[name];
  if (!Number.isSafeInteger(version) || typeof hash !== 'string') return null;
  return `https://r2.fut.gg/${GAME}/${name}.v${version}.${hash}.json`;
}

async function priceBook(platform = 'ps5', force = false) {
  if (!['ps5', 'pc'].includes(platform)) throw new Error('Платформа должна быть ps5 или pc');
  const live = priceMemo.get(platform);
  if (live && !force && Date.now() - live.at < 60_000) return live;
  const manifest = await json(FUTGG_MANIFEST);
  const full = blobUrl(manifest, `player-prices-${platform}`);
  let index, prices;
  if (full) {
    prices = await json(full);
    index = prices;
  } else {
    const indexUrl = blobUrl(manifest, 'player-prices-index');
    const pricesUrl = blobUrl(manifest, `player-prices-${platform}-dyn`);
    if (!indexUrl || !pricesUrl) throw new Error('FUT.GG manifest не содержит цены');
    [index, prices] = await Promise.all([json(indexUrl), json(pricesUrl)]);
  }
  if (!Number.isSafeInteger(index?.id0) || !Array.isArray(index?.d) || !Array.isArray(prices?.p)) throw new Error('Неизвестный формат цен FUT.GG');
  const map = new Map();
  let id = index.id0;
  map.set(id, Number(prices.p[0]) || null);
  for (let i = 0; i < index.d.length; i++) {
    id += index.d[i];
    map.set(id, Number(prices.p[i + 1]) || null);
  }
  const book = {at: Date.now(), version: manifest._version, map};
  priceMemo.set(platform, book);
  return book;
}

async function baseCards() {
  if (cardsMemo) return cardsMemo;
  const raw = (await dataBundle()).cards;
  const positions = Object.fromEntries(raw.fields.map((name, index) => [name, index]));
  const index = new Map();
  for (const row of raw.cards) index.set(Number(row[positions.eaId]), row);
  cardsMemo = {positions, index};
  return cardsMemo;
}

async function parseFutbinTab(url) {
  let parsed;
  try { parsed = new URL(url); } catch { throw new Error('Вставь полную ссылку FUTBIN'); }
  if (parsed.protocol !== 'https:' || parsed.hostname !== 'www.futbin.com' || !/^\/27\/squad\/\d+/i.test(parsed.pathname)) {
    throw new Error('Нужна ссылка вида https://www.futbin.com/27/squad/.../sbc');
  }
  const tab = await chrome.tabs.create({url: parsed.href, active: false});
  try {
    const deadline = Date.now() + FUTBIN_LOAD_TIMEOUT;
    let lastError = null;
    while (Date.now() < deadline) {
      await new Promise(resolve => setTimeout(resolve, FUTBIN_POLL_INTERVAL));
      const currentTab = await chrome.tabs.get(tab.id).catch(() => null);
      if (!currentTab || currentTab.status !== 'complete') continue;
      const answer = await chrome.tabs.sendMessage(tab.id, {type: 'fcgh.futbin.parse'}).catch(() => null);
      if (answer?.ok && answer.data?.cards?.length === 11) return answer.data;
      if (answer && !answer.ok) lastError = answer.error || 'FUTBIN ещё не отдал состав';
    }
    const detail = lastError ? ` Последний ответ: ${lastError}.` : '';
    throw new Error(`FUTBIN не загрузил все 11 карточек за 60 секунд.${detail} Открой ссылку вручную один раз и повтори импорт.`);
  } finally {
    if (Number.isSafeInteger(tab?.id)) chrome.tabs.remove(tab.id).catch(() => {});
  }
}

async function futbinScoreBook(platform = 'ps5', force = false) {
  if (!['ps5', 'pc'].includes(platform)) throw new Error('Платформа должна быть ps5 или pc');
  const cached = futbinScoreMemo.get(platform);
  if (cached && !force && Date.now() - cached.readAt < FUTBIN_SCORE_TTL) return cached;
  const tab = await chrome.tabs.create({url: FUTBIN_SCORE_URL, active: false});
  try {
    const deadline = Date.now() + FUTBIN_LOAD_TIMEOUT;
    let lastError = null;
    while (Date.now() < deadline) {
      await new Promise(resolve => setTimeout(resolve, FUTBIN_POLL_INTERVAL));
      const currentTab = await chrome.tabs.get(tab.id).catch(() => null);
      if (!currentTab || currentTab.status !== 'complete') continue;
      const answer = await chrome.tabs.sendMessage(tab.id, {type: 'fcgh.futbin.score.parse', platform}).catch(() => null);
      if (answer?.ok && answer.data?.rows?.length) {
        const book = {...answer.data, readAt: Date.now()};
        futbinScoreMemo.set(platform, book);
        return book;
      }
      if (answer && !answer.ok) lastError = answer.error;
    }
    throw new Error(lastError || 'FUTBIN не загрузил таблицу Item Score за 60 секунд');
  } finally {
    if (Number.isSafeInteger(tab?.id)) chrome.tabs.remove(tab.id).catch(() => {});
  }
}

async function resolveFutbinCards(solution) {
  const book = await baseCards(), at = book.positions;
  const byBase = new Map();
  for (const row of book.index.values()) {
    const base = Number(row[at.basePlayerEaId] || row[at.eaId]);
    if (!byBase.has(base)) byBase.set(base, []);
    byBase.get(base).push(row);
  }
  const cards = solution.cards.map(card => {
    let exact = (byBase.get(Number(card.baseEaId)) || []).filter(row => Number(row[at.overall]) === Number(card.rating));
    if (Number.isSafeInteger(Number(card.raritySquadId))) {
      const rarityExact = exact.filter(row => Number(row[at.raritySquadId]) === Number(card.raritySquadId));
      if (rarityExact.length) exact = rarityExact;
    }
    for (const [cardKey, field] of [['clubEaId', 'clubEaId'], ['leagueEaId', 'leagueEaId'], ['nationEaId', 'nationEaId']]) {
      if (!Number.isSafeInteger(Number(card[cardKey]))) continue;
      const narrowed = exact.filter(row => Number(row[at[field]]) === Number(card[cardKey]));
      if (narrowed.length) exact = narrowed;
    }
    const ids = [...new Set(exact.map(row => Number(row[at.eaId])).filter(Number.isSafeInteger))];
    return {...card, defId: ids.length === 1 ? ids[0] : null, candidates: ids};
  });
  const unresolved = cards.filter(card => !card.defId);
  if (unresolved.length) {
    const list = unresolved.map(card => `${card.name} (${card.rating}): найдено версий ${card.candidates.length}`).join(', ');
    throw new Error(`Не удалось однозначно определить карты: ${list}`);
  }
  const duplicate = cards.find((card, index) => cards.findIndex(other => other.defId === card.defId) !== index);
  if (duplicate) throw new Error(`Решение FUTBIN содержит повтор ${duplicate.name}. Выбери другую сборку: EA может не принять одинаковые карты.`);
  return {...solution, cards};
}

chrome.runtime.onMessage.addListener((message, _sender, respond) => {
  (async () => {
    if (message?.type === 'fcgh.catalog') return {ok: true, data: await galleryCatalog(message.force === true)};
    if (message?.type === 'fcgh.data.update') return {ok: true, data: await updateOwnedData()};
    if (message?.type === 'fcgh.data.status') {
      const stored = await chrome.storage.local.get('fcghDataBundle27');
      const bundle = stored.fcghDataBundle27;
      return {ok: true, data: {at: bundle?.at || null, source: bundle?.source || 'built-in', version: bundle?.catalog?.version ?? null}};
    }
    if (message?.type === 'fcgh.prices') {
      const book = await priceBook(message.platform || 'ps5', message.force === true);
      const ids = Array.isArray(message.ids) ? message.ids.slice(0, 10000) : [];
      const prices = {};
      for (const raw of ids) {
        const id = Number(raw);
        if (Number.isSafeInteger(id) && book.map.has(id)) prices[id] = book.map.get(id);
      }
      return {ok: true, at: book.at, version: book.version, prices};
    }
    if (message?.type === 'fcgh.futbin.scores') {
      const book = await futbinScoreBook(message.platform || 'ps5', message.force === true);
      return {ok: true, data: book};
    }
    if (message?.type === 'fcgh.cards') {
      const book = await baseCards(), cards = {};
      for (const rawId of (Array.isArray(message.ids) ? message.ids.slice(0, 10000) : [])) {
        const id = Number(rawId), row = book.index.get(id);
        if (!row) continue;
        const at = book.positions;
        cards[id] = {rating: row[at.overall], rarity: row[at.rarityEaId], nation: row[at.nationEaId], league: row[at.leagueEaId], club: row[at.clubEaId], base: row[at.basePlayerEaId], skillMoves: row[at.skillMoves], weakFoot: row[at.weakFoot], holographic: row[at.holographic]};
      }
      return {ok: true, cards};
    }
    if (message?.type === 'fcgh.futbin.import') {
      const solution = await parseFutbinTab(message.url);
      return {ok: true, data: await resolveFutbinCards(solution)};
    }
    return {ok: false, error: 'Неизвестная команда'};
  })().then(respond, error => respond({ok: false, error: String(error?.message || error)}));
  return true;
});
