import {readFile, writeFile} from 'node:fs/promises';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {execFileSync} from 'node:child_process';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const sourceArg = process.argv.find(value => !value.startsWith('--') && value !== process.argv[0] && value !== process.argv[1]);
const source = sourceArg
  ? await readFile(path.resolve(sourceArg), 'utf8')
  : await (await fetch('https://www.fut.gg/fut-gallery/', {headers: {'user-agent': 'FC-Gallery-Assistant catalog updater'}})).text();

const decode = value => JSON.parse(`"${value}"`);
const categories = [];
const categoryPattern = /\{id:(\d+),name:"((?:\\.|[^"])*)",slug:"((?:\\.|[^"])*)",priority:(\d+),sets:\$R\[\d+\]=\[/g;
for (const match of source.matchAll(categoryPattern)) {
  categories.push({remoteId: Number(match[1]), name: decode(match[2]), slug: decode(match[3]), priority: Number(match[4]), offset: match.index, sets: []});
}
if (!categories.length) throw new Error('В странице FUT.GG не найден каталог Gallery');

const setPattern = /\{id:(\d+),categoryId:(\d+),name:"((?:\\.|[^"])*)",slug:"((?:\\.|[^"])*)",description:"((?:\\.|[^"])*)",requiredCards:(\d+),priority:(\d+),startTime:\d+,grades:\$R\[\d+\]=\[(.*?)\],clubEaId:(null|\d+)/g;
for (const match of source.matchAll(setPattern)) {
  const category = categories.find(row => row.remoteId === Number(match[2]));
  if (!category) continue;
  const grades = [...match[8].matchAll(/name:"([DCSAB])",threshold:(\d+)/g)].map(row => ({letter: row[1], threshold: Number(row[2])}));
  category.sets.push({remoteId: Number(match[1]), name: decode(match[3]), slug: decode(match[4]), description: decode(match[5]), requiredCards: Number(match[6]), priority: Number(match[7]), grades, clubEaId: match[9] === 'null' ? null : Number(match[9])});
}

const expectedSets = categories.reduce((sum, row) => sum + row.sets.length, 0);
if (categories.length !== 10 || expectedSets !== 196) throw new Error(`Неполный каталог: ${categories.length} категорий, ${expectedSets} наборов (ожидалось 10/196)`);

const baseCatalog = process.argv.includes('--base-git')
  ? JSON.parse(execFileSync('git', ['show', 'origin/main:gallery-catalog-27.json'], {cwd: root, encoding: 'utf8'}))
  : JSON.parse(await readFile(path.join(root, 'gallery-catalog-27.json'), 'utf8'));
const [catalog, database] = await Promise.all([
  Promise.resolve(baseCatalog),
  readFile(path.join(root, 'cards-27.json'), 'utf8').then(JSON.parse)
]);
const at = Object.fromEntries(database.fields.map((name, index) => [name, index]));
const cards = database.cards;
const byClub = id => cards.filter(row => Number(row[at.clubEaId]) === id || Number(row[at.uniqueClubEaId]) === id).map(row => Number(row[at.eaId]));
const byLeague = id => cards.filter(row => Number(row[at.leagueEaId]) === id).map(row => Number(row[at.eaId]));
const byRarity = ids => cards.filter(row => ids.includes(Number(row[at.rarityEaId]))).map(row => Number(row[at.eaId]));
const oldSets = new Map(catalog.categories.flatMap(category => category.sets.map(set => [`${category.name}\0${set.name}`, set])));
const oldBySlug = new Map(catalog.categories.flatMap(category => category.sets.map(set => [set.id, set])));
const oldCategoryIds = new Map(catalog.categories.map(category => [category.name, category.id]));
const leagueIds = new Map([
  ['premier-league', 13], ['barclays-wsl', 2216], ['ligue-1-mcdonald-s', 53], ['arkema-pl', 2222],
  ['laliga-ea-sports', 19], ['liga-f-moeve', 2215], ['bundesliga', 16], ['frauen-bundesliga', 2218],
  ['serie-a-enilive', 31], ['roshn-saudi-pro-league', 350], ['mls', 39], ['nwsl', 2221]
]);
const rarityRules = new Map([
  ['potm', [42, 43, 79, 86, 114, 177]],
  ['ultimate-scream', [151, 168]]
]);

const next = {
  ...catalog,
  version: 23,
  updatedAt: new Date().toISOString(),
  upstream: {name: 'FUT.GG Gallery', capturedAt: source.match(/capturedAt:"([^"]+)"/)?.[1] || null, categories: 10, sets: 196},
  categories: categories.sort((a, b) => a.priority - b.priority).map(category => ({
    id: oldCategoryIds.get(category.name) || category.slug,
    name: category.name,
    sets: category.sets.sort((a, b) => a.priority - b.priority).map(remote => {
      const previous = oldSets.get(`${category.name}\0${remote.name}`) || oldBySlug.get(remote.slug);
      let pool = previous?.pool || [];
      let rule = {...(previous?.rule || {}), description: remote.description, clubEaId: remote.clubEaId};
      if (remote.clubEaId != null) {
        pool = [...new Set([...pool, ...byClub(remote.clubEaId)])];
        rule = {...rule, clubEaId: remote.clubEaId};
      } else if (category.slug === 'leagues' && leagueIds.has(remote.slug)) {
        const leagueEaId = leagueIds.get(remote.slug);
        pool = [...new Set([...pool, ...byLeague(leagueEaId)])];
        rule = {...rule, leagueEaId};
      } else if (rarityRules.has(remote.slug)) {
        const rarityEaIds = rarityRules.get(remote.slug);
        pool = [...new Set([...pool, ...byRarity(rarityEaIds)])];
        rule = {...rule, rarityEaIds};
      }
      return {id: remote.slug, name: remote.name, cards: remote.requiredCards, grades: remote.grades, pool: [...new Set(pool)].sort((a, b) => a - b), rule, remoteId: remote.remoteId};
    })
  }))
};

await writeFile(path.join(root, 'gallery-catalog-27.json'), `${JSON.stringify(next)}\n`);
console.log(`Каталог обновлён: ${next.categories.length} категорий, ${expectedSets} наборов, версия ${next.version}.`);
