/**
 * Live catalog scenarios, end to end through the real HTTP client, caches,
 * availability checks, catalogs and Stremio handlers — against a fake
 * AniLibria + AniList upstream whose data changes between polls.
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'anilibria-catalogs-'));
process.env.DASHBOARD_PASSWORD = 'test-password';

const test = require('node:test');
const assert = require('node:assert/strict');

// ─── Fake upstream ──────────────────────────────────────────────────────────

const upstream = {
  releases: new Map(),   // id -> full release (with episodes)
  inProduction: [],      // ids AniLibria is dubbing now, most recently updated first
  trending: [],          // AniList media, most trending first
  latestLimit: Infinity, // how many releases the "latest" feed returns
  failAniLibria: false,
  failAniList: false,
  requests: [],
};

function stamp(minutesAgo) {
  return new Date(Date.now() - minutesAgo * 60_000).toISOString();
}

// Update times are strictly increasing, like on a real server: tests run within
// the same millisecond, and a tie would make the "latest" feed order arbitrary.
let lastUpdate = 0;
function nextUpdateStamp() {
  lastUpdate = Math.max(Date.now(), lastUpdate + 1);
  return new Date(lastUpdate).toISOString();
}

function addRelease(id, { alias, mal = null, year = 2026, live = false, episodes = 0, name = alias }) {
  upstream.releases.set(id, {
    id, alias, year,
    type: { value: 'TV' },
    name: { english: name, main: `Рус ${name}`, alternative: null },
    mal: mal ? { id: mal } : null,
    shikimori: mal ? { id: mal } : null,
    poster: { src: `/storage/releases/posters/${id}/poster.jpg` },
    description: 'Описание релиза',
    genres: [{ id: 1, name: 'Экшен' }],
    is_in_production: live,
    is_ongoing: live,
    is_blocked_by_geo: false,
    is_blocked_by_copyrights: false,
    fresh_at: stamp(60),
    updated_at: stamp(60),
    episodes: [],
  });
  setEpisodes(id, episodes);
}

/** AniLibria publishes episodes 1..count (bumping the release's update time). */
function setEpisodes(id, count) {
  const release = upstream.releases.get(id);
  const updatedAt = nextUpdateStamp();
  release.episodes = Array.from({ length: count }, (_, i) => ({
    ordinal: i + 1,
    name: null,
    hls_720: `https://cdn.example/${id}/${i + 1}/720.m3u8`,
    hls_1080: `https://cdn.example/${id}/${i + 1}/1080.m3u8`,
    updated_at: updatedAt,
  }));
  release.fresh_at = updatedAt;
}

/** A release as list endpoints return it: without the episodes array. */
function summary(release) {
  return Object.fromEntries(Object.entries(release).filter(([key]) => key !== 'episodes'));
}

function json(body, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
}

global.fetch = async url => {
  const u = new URL(url);
  upstream.requests.push(`${u.hostname}${u.pathname}`);

  if (u.hostname === 'graphql.anilist.co') {
    if (upstream.failAniList) throw new TypeError('fetch failed');
    return json({ data: { Page: { pageInfo: { hasNextPage: false }, media: upstream.trending } } });
  }

  if (upstream.failAniLibria) return json({ message: 'Service Unavailable' }, 503);
  const p = u.pathname.replace('/api/v1', '');
  const all = [...upstream.releases.values()];

  if (p === '/anime/catalog/releases') {
    const inProduction = u.searchParams.get('f[production_statuses][]') === 'IS_IN_PRODUCTION';
    const list = inProduction ? upstream.inProduction.map(id => upstream.releases.get(id)) : all;
    return json({ data: list.map(summary), meta: { pagination: { total_pages: 1 } } });
  }
  if (p === '/anime/releases/latest') {
    const latest = [...all].sort((a, b) => b.fresh_at.localeCompare(a.fresh_at)).slice(0, upstream.latestLimit);
    return json(latest.map(r => ({ ...summary(r), latest_episode: r.episodes.at(-1) || null })));
  }
  if (p === '/anime/releases/list') {
    const ids = u.searchParams.getAll('ids[]').map(Number);
    return json({ data: ids.map(id => upstream.releases.get(id)).filter(Boolean), meta: {} });
  }
  const single = /^\/anime\/releases\/(\d+)$/.exec(p);
  if (single) {
    const release = upstream.releases.get(Number(single[1]));
    return release ? json(release) : new Response('<html>not found</html>', { status: 404 });
  }
  return new Response('not found', { status: 404 });
};

const media = (id, idMal, title, seasonYear = 2026) => ({
  id, idMal, seasonYear, format: 'TV', episodes: 12, trending: 100,
  startDate: { year: seasonYear }, title: { romaji: title, english: title, native: null }, synonyms: [],
});

// ─── Modules under test (loaded after the fake upstream is installed) ─────────

const catalogIndex = require('../src/mapping/anilibria-catalog');
const releasing = require('../src/catalogs/releasing');
const trending = require('../src/catalogs/trending');
const resolver = require('../src/bridge/resolver');
const { catalogHandler } = require('../src/handlers/catalog');
const { metaHandler } = require('../src/handlers/meta');
const { streamHandler } = require('../src/handlers/streams');

async function catalogIds(id) {
  const res = await catalogHandler({ type: 'series', id, extra: {} });
  return res.metas.map(m => m.id);
}

test.before(async () => {
  addRelease(100, { alias: 'anime-a', mal: 1001, live: true, episodes: 5, name: 'Anime A' });
  addRelease(400, { alias: 'anime-d', mal: 4004, episodes: 12, name: 'Anime D' });   // finished
  addRelease(500, { alias: 'anime-e', mal: 5005, live: true, episodes: 0, name: 'Anime E' }); // announced, no episodes yet
  upstream.inProduction = [100, 500];
  await catalogIndex.getIndex(); // initial full catalog (A, D, E)
});

// ─── Releasing ──────────────────────────────────────────────────────────────

test('releasing lists in-production releases that have playable episodes', async () => {
  await releasing.refresh();
  assert.deepEqual(await catalogIds('anilibria-releasing'), ['anilibria:100']); // E has no episodes yet

  const [item] = (await catalogHandler({ type: 'series', id: 'anilibria-releasing', extra: {} })).metas;
  assert.equal(item.type, 'series');
  assert.equal(item.name, 'Anime A');
  assert.equal(item.poster, 'https://anilibria.top/storage/releases/posters/100/poster.jpg');
  assert.match(item.description, /^Latest episode: 5/);
  assert.equal(item.releaseInfo, '2026–');

  const catalog = await catalogHandler({ type: 'series', id: 'anilibria-releasing', extra: {} });
  assert.equal(catalog.cacheMaxAge, 60);
});

test('a new episode is served without restart: episode 5 → 6', async () => {
  const before = await metaHandler({ type: 'series', id: 'anilibria:100' });
  assert.equal(before.meta.videos.length, 5);
  assert.equal(before.cacheMaxAge, 60);

  setEpisodes(100, 6); // AniLibria publishes episode 6
  const bulkBefore = upstream.requests.filter(r => r.endsWith('/releases/list')).length;
  await releasing.refresh(); // next poll detects the change

  // Only the changed release was refetched, in one bulk request
  assert.equal(upstream.requests.filter(r => r.endsWith('/releases/list')).length, bulkBefore + 1);

  const [item] = (await catalogHandler({ type: 'series', id: 'anilibria-releasing', extra: {} })).metas;
  assert.match(item.description, /^Latest episode: 6/);

  const after = await metaHandler({ type: 'series', id: 'anilibria:100' });
  assert.deepEqual(after.meta.videos.map(v => [v.id, v.season, v.episode]).at(-1), ['anilibria:100:6', 1, 6]);

  const streams = await streamHandler({ type: 'series', id: 'anilibria:100:6' });
  assert.deepEqual(streams.streams.map(s => s.url), [
    'https://cdn.example/100/6/1080.m3u8',
    'https://cdn.example/100/6/720.m3u8',
  ]);
  assert.equal(streams.streams[0].behaviorHints.bingeGroup, 'anilibria-r100-1080p');
});

test('a stream request for a just-published episode rechecks AniLibria before the next poll', async t => {
  t.mock.timers.enable({ apis: ['Date'], now: Date.now() });
  setEpisodes(100, 7); // published after the last poll

  // Our copy is brand new: no recheck, short client cache so it is retried soon
  const pending = await streamHandler({ type: 'series', id: 'anilibria:100:7' });
  assert.deepEqual(pending, { streams: [], cacheMaxAge: 120 });

  t.mock.timers.tick(31_000);
  const found = await streamHandler({ type: 'series', id: 'anilibria:100:7' });
  assert.equal(found.streams.length, 2);
});

test('a newly dubbed anime appears in the catalog and becomes resolvable for IMDB lookups', async () => {
  addRelease(200, { alias: 'anime-b', mal: 2002, live: true, episodes: 3, name: 'Anime B' });
  upstream.inProduction = [200, 100, 500];
  await releasing.refresh();

  assert.deepEqual(await catalogIds('anilibria-releasing'), ['anilibria:200', 'anilibria:100']);
  // Added to the catalog index without waiting for the next full rebuild
  const index = await catalogIndex.getIndex();
  assert.deepEqual(index.findByMal(2002).map(r => r.id), [200]);
});

test('a release that gets its first episode joins; a finished one leaves', async () => {
  setEpisodes(500, 1);
  const a = upstream.releases.get(100);
  a.is_in_production = false;
  a.is_ongoing = false;
  a.updated_at = nextUpdateStamp();
  upstream.inProduction = [500, 200];
  await releasing.refresh();
  assert.deepEqual(await catalogIds('anilibria-releasing'), ['anilibria:500', 'anilibria:200']);
});

test('a finished release that gets a new episode is refreshed as soon as it enters the update feed', async t => {
  t.mock.timers.enable({ apis: ['Date'], now: Date.now() }); // freeze time: no 30s recheck can help
  upstream.latestLimit = 1;
  addRelease(800, { alias: 'anime-h', mal: 8008, episodes: 2, name: 'Anime H' });
  upstream.releases.get(800).fresh_at = stamp(600); // old: not in the one-item feed
  await releasing.refresh();
  assert.equal((await streamHandler({ type: 'series', id: 'anilibria:800:2' })).streams.length, 2); // cached now

  setEpisodes(800, 3); // now the most recently updated release
  await releasing.refresh();
  const res = await streamHandler({ type: 'series', id: 'anilibria:800:3' });
  assert.equal(res.streams.length, 2);
  upstream.latestLimit = Infinity;
});

// ─── Trending ───────────────────────────────────────────────────────────────

test('trending shows only trending anime that AniLibria has, in trending order', async () => {
  upstream.trending = [media(1, 1001, 'Anime A')];
  await trending.refresh();
  assert.deepEqual(await catalogIds('anilibria-trending'), ['anilibria:100']);

  // Anime D starts trending (AniLibria has it); Anime C trends but AniLibria does not have it
  upstream.trending = [media(4, 4004, 'Anime D'), media(3, 3003, 'Anime C'), media(1, 1001, 'Anime A')];
  await trending.refresh();
  assert.deepEqual(await catalogIds('anilibria-trending'), ['anilibria:400', 'anilibria:100']);

  const catalog = await catalogHandler({ type: 'series', id: 'anilibria-trending', extra: {} });
  assert.equal(catalog.cacheMaxAge, 300);
});

test('trending anime whose AniLibria release has no playable episode is excluded', async () => {
  addRelease(600, { alias: 'anime-f', mal: 6006, live: true, episodes: 0, name: 'Anime F' });
  upstream.inProduction = [600, 500, 200];
  await releasing.refresh(); // indexes release 600
  upstream.trending = [media(6, 6006, 'Anime F'), media(1, 1001, 'Anime A')];
  await trending.refresh();
  assert.deepEqual(await catalogIds('anilibria-trending'), ['anilibria:100']);
});

test('fuzzy title matches are never listed', async t => {
  t.mock.method(resolver, 'resolveMedia', async m =>
    m.idMal === 1001 ? { releaseIds: [100], method: 'fuse', uncertain: false } : { releaseIds: [], method: null, uncertain: false });
  upstream.trending = [media(1, 1001, 'Anime A')];
  await trending.refresh();
  assert.deepEqual(await catalogIds('anilibria-trending'), []);
});

test('anime that stop trending leave the catalog', async () => {
  upstream.trending = [media(4, 4004, 'Anime D')];
  await trending.refresh();
  assert.deepEqual(await catalogIds('anilibria-trending'), ['anilibria:400']);
});

// ─── Failures ───────────────────────────────────────────────────────────────

test('a trending provider outage keeps the last verified list', async () => {
  upstream.failAniList = true;
  upstream.trending = [media(1, 1001, 'Anime A')];
  await trending.refresh();
  assert.deepEqual(await catalogIds('anilibria-trending'), ['anilibria:400']);
  assert.match(trending.info().lastError, /network error/);
  upstream.failAniList = false;
});

test('an AniLibria outage never lets unverified anime through', async () => {
  // A finished release: the poll indexes it (latest feed) but does not verify it
  addRelease(700, { alias: 'anime-g', mal: 7007, episodes: 4, name: 'Anime G' });
  await releasing.refresh();
  assert.deepEqual((await catalogIndex.getIndex()).findByMal(7007).map(r => r.id), [700]);

  upstream.failAniLibria = true;
  try {
    // Anime G starts trending while AniLibria cannot confirm it has episodes
    upstream.trending = [media(7, 7007, 'Anime G'), media(4, 4004, 'Anime D')];
    await trending.refresh();
    assert.deepEqual(await catalogIds('anilibria-trending'), ['anilibria:400']); // previous list, not G
    assert.match(trending.info().lastError, /HTTP 503/);

    // The releasing catalog also keeps its last list
    const releasingBefore = await catalogIds('anilibria-releasing');
    await releasing.refresh();
    assert.deepEqual(await catalogIds('anilibria-releasing'), releasingBefore);
    assert.match(releasing.info().lastError, /HTTP 503/);

    // Meta and streams fall back to the last good copy of a release
    const meta = await metaHandler({ type: 'series', id: 'anilibria:400' });
    assert.equal(meta.meta.videos.length, 12);
    const streams = await streamHandler({ type: 'series', id: 'anilibria:400:12' });
    assert.equal(streams.streams.length, 2);
  } finally {
    upstream.failAniLibria = false;
  }

  // Once AniLibria is back, G is verified and listed
  await trending.refresh();
  assert.deepEqual(await catalogIds('anilibria-trending'), ['anilibria:700', 'anilibria:400']);
  assert.equal(trending.info().lastError, null);
});

// ─── Catalog protocol details ───────────────────────────────────────────────

test('catalog paging and unknown catalogs', async () => {
  assert.deepEqual(await catalogHandler({ type: 'series', id: 'anilibria-releasing', extra: { skip: '100' } }),
    { metas: [], cacheMaxAge: 60 });
  assert.deepEqual(await catalogHandler({ type: 'movie', id: 'anilibria-releasing', extra: {} }), { metas: [] });
  assert.deepEqual(await catalogHandler({ type: 'series', id: '__proto__', extra: {} }), { metas: [] });
  assert.deepEqual(await metaHandler({ type: 'series', id: 'anilibria:999999' }), { meta: null, cacheMaxAge: 300 });
  assert.deepEqual(await metaHandler({ type: 'series', id: 'tt0000001' }), { meta: null });
});
