const fs = require('fs');
const os = require('os');
const path = require('path');
process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'anilibria-mapping-'));

const test = require('node:test');
const assert = require('node:assert/strict');
const mapping = require('../src/mapping/cache');

test('getEntries fails loudly before any mapping is loaded', async t => {
  // Keep the test offline: make the background download fail immediately
  t.mock.method(global, 'fetch', async () => { throw new Error('offline'); });
  await assert.rejects(mapping.getEntries('tt2560140'), mapping.MappingUnavailableError);
});

test('keeps every Fribb entry of an IMDB ID with its TVDB season data', async () => {
  const count = mapping.loadFromRaw([
    { type: 'TV', mal_id: 16498, anilist_id: 16498, imdb_id: ['tt2560140'], season: { tvdb: 1, tmdb: 1 } },
    { type: 'TV', mal_id: 35760, anilist_id: 99147, imdb_id: ['tt2560140'], season: { tvdb: 3 } },
    { type: 'TV', mal_id: 38524, anilist_id: 104578, imdb_id: ['tt2560140'], season: { tvdb: 3 }, episode_offset: { tvdb: 12 } },
    { type: 'MOVIE', mal_id: 32281, anilist_id: 21519, imdb_id: 'tt5311514' },          // legacy string format
    { type: 'TV', anidb_id: 5, imdb_id: ['tt0000009'] },                                 // AniDB-only: dropped
    { type: 'TV', mal_id: 1, imdb_id: ['not-an-imdb-id'] },                              // invalid IMDB: dropped
    { type: 'TV', mal_id: 2, imdb_id: ['tt1000001', 'tt1000002'] },                      // several IMDB IDs
    null,
  ]);
  assert.equal(count, 5);

  const aot = await mapping.getEntries('tt2560140');
  assert.deepEqual(aot.map(e => [e.mal, e.tvdbSeason, e.tvdbOffset]), [[16498, 1, 0], [35760, 3, 0], [38524, 3, 12]]);
  assert.deepEqual(await mapping.getEntries('tt5311514'), [{ type: 'MOVIE', mal: 32281, anilist: 21519, tvdbSeason: null, tvdbOffset: 0 }]);
  assert.deepEqual(await mapping.getEntries('tt0000009'), []);
  assert.equal((await mapping.getEntries('tt1000002'))[0].mal, 2);
  assert.equal(await mapping.getImdbByAnilist(99147), 'tt2560140');
  assert.equal(mapping.getMappingSize(), 4);
});

test('rejects payloads that are not arrays', () => {
  assert.throws(() => mapping.loadFromRaw({ error: 'rate limited' }), /not an array/);
});
