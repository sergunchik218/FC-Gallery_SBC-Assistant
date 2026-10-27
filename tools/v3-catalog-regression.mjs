import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';

const catalog = JSON.parse(await readFile(new URL('../gallery-catalog-27.json', import.meta.url), 'utf8'));
const background = await readFile(new URL('../background.js', import.meta.url), 'utf8');
const categories = new Map(catalog.categories.map(category => [category.name, category]));
const expected = new Map([
  ['Rarities', 8],
  ['Premier League / Barclays WSL', 24],
  ['LALIGA EA SPORTS / Liga F Moeve', 26],
  ['Bundesliga / Frauen-Bundesliga', 20],
  ["Ligue 1 McDonald's / Arkema PL", 22],
  ['Serie A Enilive', 20],
  ['Leagues', 12],
  ['ROSHN Saudi League', 18],
  ['MLS', 30],
  ["National Women's Soccer League", 16]
]);

assert.equal(catalog.version, 23);
assert.equal(catalog.categories.length, 10);
assert.equal(catalog.categories.reduce((sum, row) => sum + row.sets.length, 0), 196);
for (const [name, count] of expected) {
  assert.ok(categories.has(name), `Missing V3 category: ${name}`);
  assert.equal(categories.get(name).sets.length, count, `Wrong set count for ${name}`);
}
for (const name of ['ROSHN Saudi League', 'MLS', "National Women's Soccer League"]) {
  assert.ok(categories.get(name).sets.every(set => set.pool.length > 0), `${name} must contain usable club pools`);
}
assert.match(background, /BUILTIN_CATALOG_VERSION\s*=\s*23/);
assert.match(background, /cached\.catalog\?\.version\)\s*>=\s*BUILTIN_CATALOG_VERSION/);
console.log('V3 catalog passed: 196 sets, 10 visible categories, new league teams and automatic V2 cache invalidation.');
