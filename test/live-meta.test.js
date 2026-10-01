const test = require('node:test');
const assert = require('node:assert/strict');
const LiveSnapshot = require('../src/util/live-snapshot');
const meta = require('../src/catalogs/meta');

// ─── LiveSnapshot ───────────────────────────────────────────────────────────

test('LiveSnapshot waits for the first load, then serves instantly and refreshes when stale', async t => {
  t.mock.timers.enable({ apis: ['Date'], now: 1_000_000 });
  let calls = 0;
  const snap = new LiveSnapshot({ name: 'test', ttlMs: 60_000, load: async () => ++calls });

  assert.equal(await snap.get(), 1);
  assert.equal(await snap.get(), 1);          // fresh: no reload
  assert.equal(calls, 1);

  t.mock.timers.tick(60_000);
  assert.equal(await snap.get(), 1);          // stale value served immediately…
  await snap.refreshing;                      // …while the refresh runs in the background
  assert.equal(await snap.get(), 2);
  assert.equal(snap.info().stale, false);
});

test('LiveSnapshot runs one refresh at a time', async () => {
  let calls = 0;
  let release;
  const snap = new LiveSnapshot({ name: 'test', ttlMs: 60_000, load: () => { calls++; return new Promise(r => { release = r; }); } });
  const a = snap.refresh();
  const b = snap.refresh();
  assert.equal(a, b);
  release('done');
  assert.equal(await a, 'done');
  assert.equal(calls, 1);
});

test('LiveSnapshot keeps the last good value when a refresh fails, and backs off', async t => {
  t.mock.timers.enable({ apis: ['Date'], now: 1_000_000 });
  let fail = false;
  let calls = 0;
  const snap = new LiveSnapshot({
    name: 'test', ttlMs: 1000, retryAfterMs: 15_000,
    load: async () => { calls++; if (fail) throw new Error('upstream down'); return ['verified']; },
  });
  await snap.refresh();
  fail = true;
  t.mock.timers.tick(1000);
  await snap.refresh();
  assert.deepEqual(await snap.get(), ['verified']);
  assert.equal(snap.info().lastError, 'upstream down');

  const before = calls;
  await snap.get();                  // within the backoff window: no new attempt
  assert.equal(calls, before);
  t.mock.timers.tick(15_000);
  await snap.get();
  await snap.refreshing;
  assert.equal(calls, before + 1);
});

test('LiveSnapshot returns null (never throws) when nothing has loaded', async () => {
  const snap = new LiveSnapshot({ name: 'test', ttlMs: 1000, load: async () => { throw new Error('down'); } });
  assert.equal(await snap.get(), null);
  assert.equal(snap.info().count, null);
});

// ─── Catalog metadata ───────────────────────────────────────────────────────

const release = {
  id: 9660,
  alias: 'kimetsu-no-yaiba-hashira-geiko-hen',
  year: 2024,
  type: { value: 'TV' },
  name: { english: 'Kimetsu no Yaiba: Hashira Geiko-hen', main: 'Клинок, рассекающий демонов: Тренировка столпов' },
  poster: { src: '/storage/releases/posters/9660/p.jpg' },
  description: 'Описание',
  genres: [{ name: 'Экшен' }, { name: 'Сёнен' }],
  is_in_production: false,
  is_ongoing: false,
  updated_at: '2024-06-30T20:00:00+00:00',
  episodes: [
    { ordinal: 2, name: 'Вторая', hls_720: 'u2', updated_at: '2024-05-19T20:00:00+00:00', preview: { src: '/storage/p/2.jpg' } },
    { ordinal: 1, name: null, name_english: 'Ep One', hls_480: 'u1', updated_at: '2024-05-12T20:00:00+00:00' },
    { ordinal: 2.5, name: 'Recap', hls_1080: 'u25' },
    { ordinal: 3, name: 'No streams yet' },
    { ordinal: null, hls_720: 'x' },
  ],
};

test('catalog IDs round-trip', () => {
  assert.deepEqual(meta.parseId('anilibria:9660'), { releaseId: 9660, ordinal: null });
  assert.deepEqual(meta.parseId('anilibria:9660:8'), { releaseId: 9660, ordinal: 8 });
  assert.deepEqual(meta.parseId('anilibria:9660:12.5'), { releaseId: 9660, ordinal: 12.5 });
  for (const bad of ['tt0388629', 'anilibria:', 'anilibria:abc', 'anilibria:1:2:3', 'anilibria:-1', null]) {
    assert.equal(meta.parseId(bad), null, String(bad));
  }
  assert.equal(meta.episodeVideoId(9660, 12.5), 'anilibria:9660:12.5');
});

test('episode list contains only playable episodes; fractional ordinals become specials', () => {
  assert.deepEqual(meta.toVideos(release).map(v => [v.id, v.season, v.episode, v.title]), [
    ['anilibria:9660:1', 1, 1, 'Ep One'],
    ['anilibria:9660:2', 1, 2, 'Вторая'],
    ['anilibria:9660:2.5', 0, 1, 'Recap'],
  ]);
  const second = meta.toVideos(release)[1];
  assert.equal(second.released, '2024-05-19T20:00:00.000Z');
  assert.equal(second.thumbnail, 'https://anilibria.top/storage/p/2.jpg');
});

test('full meta and catalog preview for a release', () => {
  const info = { id: 9660, type: 'series', live: false, latestEpisode: 2.5, card: meta.releaseCard(release) };
  const full = meta.toMeta(release, info);
  assert.equal(full.id, 'anilibria:9660');
  assert.equal(full.type, 'series');
  assert.equal(full.name, 'Kimetsu no Yaiba: Hashira Geiko-hen');
  assert.equal(full.poster, 'https://anilibria.top/storage/releases/posters/9660/p.jpg');
  assert.equal(full.releaseInfo, '2024');
  assert.deepEqual(full.genres, ['Экшен', 'Сёнен']);
  assert.equal(full.videos.length, 3);
  assert.match(full.description, /^Клинок/);

  const preview = meta.toMetaPreview({ ...info, live: true }, { showLatestEpisode: true });
  assert.equal(preview.releaseInfo, '2024–');
  assert.match(preview.description, /^Latest episode: 2\.5\n\nКлинок/);
  assert.equal(preview.videos, undefined);

  const movie = meta.toMeta(release, { ...info, type: 'movie' });
  assert.equal(movie.type, 'movie');
  assert.equal(movie.videos, undefined);
});
