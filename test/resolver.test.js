const fs = require('fs');
const os = require('os');
const path = require('path');
process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'anilibria-resolver-'));

const test = require('node:test');
const assert = require('node:assert/strict');
const Fuse = require('fuse.js');
const catalog = require('../src/mapping/anilibria-catalog');
const resolver = require('../src/bridge/resolver');

// Real AniLibria catalog entries (trimmed), including its data quirks
const release = (id, alias, year, mal, shikimori, english) => ({
  id, alias, year, type: { value: 'TV' },
  mal: mal ? { id: mal } : null, shikimori: shikimori ? { id: shikimori } : null,
  name: { english, main: '' },
});
const CATALOG = [
  release(1410, 'shingeki-kyojin-chuugakkou', 2015, 31374, 31374, 'Shingeki! Kyojin Chuugakkou'),
  release(5682, 'karakai-jouzu-no-takagi-san', 2018, 35860, 35860, 'Karakai Jouzu no Takagi-san'),
  release(8407, '8309205', 2019, 35860, 38993, 'Karakai Jouzu no Takagi-san 2'),   // MAL field copied from S1
  release(9210, 'hataraku-maou-sama-2nd-season', 2022, 53200, 53200, 'Hataraku Maou-sama!! 2nd Season'),
  release(9475, 'hataraku-maou-sama-2nd-season-part-2', 2023, 53200, 53200, 'Hataraku Maou-sama!! 2nd Season Part 2'),
  release(10294, 'hunter-x-hunter', 2011, 136, 136, 'Hunter x Hunter'),              // tagged as the 1999 series
  release(8710, 'date-a-live', 2013, null, null, "Date A Live (Director's Cut)"),     // no IDs at all
  release(8659, 'maou-gakuin-no-futekigousha-shijou-saikyou-no-maou-no-shiso-tensei-shite-shison-tachi-no-gakkou-e', 2020, null, null, 'Maou Gakuin no Futekigousha'),
];

const media = (idMal, seasonYear, romaji, english = null) => ({ idMal, seasonYear, title: { romaji, english }, synonyms: [] });

test.beforeEach(t => {
  const index = new catalog.CatalogIndex(CATALOG, true);
  t.mock.method(catalog, 'getIndex', async () => index);
  t.mock.method(global, 'fetch', async () => { throw new Error('network disabled in tests'); });
});

async function resolve(m) {
  return resolver.resolveMedia(m);
}

test('exact MAL/Shikimori ID match, disambiguated by year', async () => {
  // Takagi-san S1: both releases carry 35860, only one is from 2018
  assert.deepEqual(await resolve(media(35860, 2018, 'Karakai Jouzu no Takagi-san')), { releaseIds: [5682], method: 'mal', uncertain: false });
  assert.deepEqual((await resolve(media(38993, 2019, 'Karakai Jouzu no Takagi-san 2'))).releaseIds, [8407]);
  // Devil is a Part-Timer S2 Part 2: both cours carry 53200
  assert.deepEqual((await resolve(media(53200, 2023, 'Hataraku Maou-sama!! 2nd Season Part 2'))).releaseIds, [9475]);
});

test('releases tagged as a different anime are rejected', async () => {
  // Attack on Titan must not resolve to the Junior High parody
  const aot = await resolve(media(16498, 2013, 'Shingeki no Kyojin', 'Attack on Titan'));
  assert.deepEqual(aot, { releaseIds: [], method: null, uncertain: false });
  // HxH 1999 matches the ID of release 10294, but that release is the 2011 series
  assert.deepEqual((await resolve(media(136, 1999, 'HUNTER×HUNTER'))).releaseIds, []);
});

test('mislabelled releases are rescued only by exact alias and year', async () => {
  const hxh2011 = await resolve(media(11061, 2011, 'HUNTER×HUNTER (2011)', 'Hunter x Hunter (2011)'));
  assert.deepEqual(hxh2011, { releaseIds: [10294], method: 'alias', uncertain: false });
  // The S2 part 1 release carries part 2's ID; exact alias + year still finds it
  const part1 = await resolve({ ...media(48413, 2022, 'Hataraku Maou-sama!!'), synonyms: ['Hataraku Maou-sama! 2nd Season'] });
  assert.deepEqual(part1.releaseIds, [9210]);
});

test('ID-less releases match by title, but never across seasons', async () => {
  assert.deepEqual((await resolve(media(22535, 2013, 'Date A Live'))).releaseIds, [8710]);
  assert.deepEqual((await resolve(media(19163, 2014, 'Date A Live II'))).releaseIds, []);
  // The AniList synonym matches the release name; its alias is a truncated slug
  const fuzzy = await resolve({
    ...media(40496, 2020, 'Maou Gakuin no Futekigousha: Shijou Saikyou no Maou no Shiso, Tensei shite Shison-tachi no Gakkou e Kayou'),
    synonyms: ['Maou Gakuin no Futekigousha'],
  });
  assert.deepEqual(fuzzy, { releaseIds: [8659], method: 'fuse', uncertain: false });
});

test('fuzzy search only scans releases that share a first title word', async t => {
  // Scanning the whole catalog for every title variant blocked the event loop for seconds
  const filler = Array.from({ length: 500 }, (_, i) => release(20000 + i, `filler-show-${i}`, 2020, null, null, `Filler Show ${i}`));
  const index = new catalog.CatalogIndex([...CATALOG, ...filler], true);
  t.mock.method(catalog, 'getIndex', async () => index);
  const scanned = [];
  const search = Fuse.prototype.search;
  t.mock.method(Fuse.prototype, 'search', function (...args) {
    scanned.push(this.getIndex().size());
    return search.apply(this, args);
  });

  const fuzzy = await resolve({
    ...media(40496, 2020, 'Maou Gakuin no Futekigousha: Shijou Saikyou no Maou no Shiso, Tensei shite Shison-tachi no Gakkou e Kayou'),
    synonyms: ['Maou Gakuin no Futekigousha', 'ทรราชตกยุคไปอยู่ในโรงเรียนลูกหลาน'],
  });
  assert.deepEqual(fuzzy, { releaseIds: [8659], method: 'fuse', uncertain: false });
  assert.ok(scanned.length > 0);
  assert.ok(scanned.every(size => size === 1), `scanned ${scanned.join(', ')} releases`);

  // No release starts with any of the anime's title words: nothing to scan
  scanned.length = 0;
  assert.deepEqual((await resolve(media(38000, 2019, 'Kimetsu no Yaiba', 'Demon Slayer'))).releaseIds, []);
  assert.deepEqual(scanned, []);
});

test('without an index, failed live lookups are reported as uncertain', async t => {
  t.mock.method(catalog, 'getIndex', async () => null);
  const res = await resolve(media(16498, 2013, 'Shingeki no Kyojin'));
  assert.deepEqual(res.releaseIds, []);
  assert.equal(res.uncertain, true);
});
