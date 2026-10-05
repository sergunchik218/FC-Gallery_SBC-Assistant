import {readFile} from 'node:fs/promises';

const catalog = JSON.parse(await readFile(new URL('../gallery-catalog-27.json', import.meta.url), 'utf8'));
const database = JSON.parse(await readFile(new URL('../cards-27.json', import.meta.url), 'utf8'));

const fail = message => { throw new Error(message); };
if (catalog?.schema !== 1 || catalog?.game !== 'fc27' || !Array.isArray(catalog.categories)) fail('Неверный заголовок каталога');
if (!Array.isArray(database?.fields) || !Array.isArray(database?.cards)) fail('Неверный формат cards-27.json');

const eaIdAt = database.fields.indexOf('eaId');
if (eaIdAt < 0) fail('В cards-27.json нет поля eaId');
const knownCards = new Set(database.cards.map(row => Number(row[eaIdAt])).filter(Number.isSafeInteger));
const setIds = new Set(), usedCards = new Set();
let setCount = 0;

for (const category of catalog.categories) {
  if (!category?.id || !category?.name || !Array.isArray(category.sets)) fail('Некорректная категория');
  for (const set of category.sets) {
    setCount++;
    if (!set?.id || !set?.name) fail(`Набор без id или имени в ${category.id}`);
    const fullId = `${category.id}/${set.id}`;
    if (setIds.has(fullId)) fail(`Повтор набора ${fullId}`);
    setIds.add(fullId);
    if (!Number.isSafeInteger(Number(set.cards)) || Number(set.cards) <= 0) fail(`Некорректное число карт: ${fullId}`);
    if ((!Array.isArray(set.pool) || !set.pool.length) && set.rule?.anyCommon !== true) fail(`Пустой пул: ${fullId}`);
    if (!Array.isArray(set.grades) || !set.grades.length) fail(`Нет грейдов: ${fullId}`);
    let lastThreshold = -1;
    for (const grade of set.grades) {
      const threshold = Number(grade?.threshold);
      if (!grade?.letter || !Number.isFinite(threshold) || threshold < lastThreshold) fail(`Некорректные грейды: ${fullId}`);
      lastThreshold = threshold;
    }
    for (const rawId of set.pool || []) {
      const id = Number(rawId);
      if (!Number.isSafeInteger(id) || !knownCards.has(id)) fail(`Неизвестная карточка ${rawId} в ${fullId}`);
      usedCards.add(id);
    }
  }
}

console.log(`Каталог корректен: ${catalog.categories.length} категорий, ${setCount} наборов, ${usedCards.size} уникальных карточек.`);
