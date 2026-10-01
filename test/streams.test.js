const fs = require('fs');
const os = require('os');
const path = require('path');
process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'anilibria-streams-'));
process.env.DASHBOARD_PASSWORD = 'test-password';

const test = require('node:test');
const assert = require('node:assert/strict');
const resolver = require('../src/bridge/resolver');
const anilibria = require('../src/api/anilibria');
const cinemeta = require('../src/api/cinemeta');
const { HttpError } = require('../src/api/http');
const { MappingUnavailableError } = require('../src/mapping/cache');
const requestLog = require('../src/telemetry/request-log');
const missing = require('../src/telemetry/missing');
const traffic = require('../src/telemetry/traffic');
const titles = require('../src/telemetry/titles');
const overrides = require('../src/overrides');
const { streamHandler, parseId } = require('../src/handlers/streams');

const ENTRY = { type: 'TV', mal: 100, anilist: 100, tvdbSeason: 1, tvdbOffset: 0 };
const RELEASE = {
  id: 555,
  name: { english: 'Test Show', main: 'Тест' },
  episodes: [
    { ordinal: 1, name: 'Pilot', hls_480: 'https://cdn/1/480.m3u8', hls_720: 'https://cdn/1/720.m3u8', hls_1080: 'https://cdn/1/1080.m3u8' },
    { ordinal: 2, name: null, hls_480: 'https://cdn/2/480.m3u8', hls_720: null, hls_1080: '' },
  ],
};

function stubPipeline(t, { plan, attempt, release }) {
  const planFn = typeof plan === 'function' ? plan : async () => ({
    mode: 'season', isAnime: true, uncertain: false, primary: ENTRY,
    attempts: [{ entry: ENTRY, episode: 1, numbering: 'local' }],
    ...plan,
  });
  t.mock.method(resolver, 'plan', planFn);
  t.mock.method(resolver, 'resolveAttempt', async a => ({
    candidates: [{ releaseId: 555, episode: a.episode, numbering: a.numbering }],
    showFound: true, method: 'mal', title: 'Test Show', degraded: false, uncertain: false,
    ...attempt,
  }));
  t.mock.method(resolver, 'resolveEntry', async () => ({ title: 'Test Show', releaseIds: [] }));
  t.mock.method(anilibria, 'getRelease', typeof release === 'function' ? release : async () => release ?? RELEASE);
  t.mock.method(cinemeta, 'fetchTitleInfo', async () => ({ title: 'Some Movie', isAnime: false }));
}

const lastLog = () => requestLog.query({ scope: 'all', limit: 1 }).rows[0];
const settle = async () => {
  for (let i = 0; i < 3; i++) await new Promise(r => setImmediate(r));
};

/** The stored missing-title record for a key, in whichever tab it is. */
function missingRecord(key) {
  for (const category of missing.CATEGORIES) {
    const row = missing.list({ category, pageSize: 200 }).rows.find(r => r.key === key);
    if (row) return row;
  }
  return null;
}

test('parseId accepts Stremio IDs and rejects malformed ones', () => {
  assert.deepEqual(parseId('tt0388629:1:5'), { imdbId: 'tt0388629', season: 1, episode: 5 });
  assert.deepEqual(parseId('tt5311514'), { imdbId: 'tt5311514', season: null, episode: null });
  for (const bad of ['tt123', 'tt0388629:1', 'tt0388629:a:1', 'tt0388629:1:-1', 'kitsu:1:1', 'tt0388629:1:5:9', null]) {
    assert.equal(parseId(bad), null, String(bad));
  }
});

test('returns one stream per available quality with per-quality binge groups', async t => {
  stubPipeline(t, {});
  const res = await streamHandler({ type: 'series', id: 'tt0000001:1:1' });
  assert.equal(res.cacheMaxAge, undefined);
  assert.deepEqual(res.streams.map(s => s.name), ['AniLibria\n1080p', 'AniLibria\n720p', 'AniLibria\n480p']);
  assert.equal(res.streams[0].url, 'https://cdn/1/1080.m3u8');
  assert.equal(res.streams[0].description, 'Test Show • Pilot\nRussian Dub • HLS');
  assert.deepEqual(res.streams[0].behaviorHints, { notWebReady: true, bingeGroup: 'anilibria-tt0000001-1080p' });
  const log = lastLog();
  assert.equal(log.outcome, 'success');
  assert.equal(log.category, 'found');
  assert.equal(log.reason, 'found');
  assert.equal(log.releaseId, 555);
  assert.equal(log.method, 'mal');
  assert.equal(log.source, 'imdb');
  assert.equal(log.season, 1);
  assert.equal(log.episode, 1);
});

test('a found request feeds traffic and top titles (merged per release)', async t => {
  stubPipeline(t, {});
  const before = traffic.kpis().current;
  await streamHandler({ type: 'series', id: 'tt0000001:1:1', ip: '198.51.100.1' });
  const after = traffic.kpis().current;
  assert.equal(after.found - before.found, 1);
  assert.equal(after.requests - before.requests, 1);
  const top = titles.top({ days: 7 }).find(r => r.releaseId === 555);
  assert.ok(top.users >= 1);
  assert.deepEqual(top.imdbIds, ['tt0000001']);
});

test('skips empty quality URLs and titles untitled episodes', async t => {
  stubPipeline(t, { plan: { attempts: [{ entry: ENTRY, episode: 2, numbering: 'local' }] } });
  const res = await streamHandler({ type: 'series', id: 'tt0000001:1:2' });
  assert.deepEqual(res.streams.map(s => s.name), ['AniLibria\n480p']);
  assert.match(res.streams[0].description, /Episode 2/);
});

test('a release reached from several cours uses season-relative numbering', async t => {
  // Bungo Stray Dogs: TVDB season 1 = cours 1+2 (offset 12); AniLibria has one
  // 24-episode release. S1E13 must play episode 13, not episode 1.
  const merged = { ...RELEASE, episodes: Array.from({ length: 24 }, (_, i) => ({ ordinal: i + 1, hls_720: `https://cdn/${i + 1}.m3u8` })) };
  stubPipeline(t, {
    plan: {
      attempts: [
        { entry: { ...ENTRY, mal: 32867, tvdbOffset: 12 }, episode: 1, numbering: 'local' },
        { entry: { ...ENTRY, mal: 31478 }, episode: 13, numbering: 'local' },
      ],
    },
    release: merged,
  });
  const res = await streamHandler({ type: 'series', id: 'tt5679720:1:13' });
  assert.equal(res.streams[0].url, 'https://cdn/13.m3u8');
});

test('non-anime IDs return a cached empty list, are logged as pass-through and never stored', async t => {
  stubPipeline(t, { plan: { mode: 'none', isAnime: null, attempts: [] } });
  const before = traffic.kpis().current;
  const res = await streamHandler({ type: 'movie', id: 'tt0111161', ip: '198.51.100.3' });
  assert.deepEqual(res, { streams: [], cacheMaxAge: 3600 });
  assert.equal(resolver.resolveAttempt.mock.callCount(), 0);
  assert.equal(lastLog().category, 'pass_through');
  assert.equal(lastLog().reason, 'not_anime');
  const after = traffic.kpis().current;
  assert.equal(after.passThrough - before.passThrough, 1);
  assert.equal(after.requests, before.requests, 'not counted as an anime request');
  await settle(); // the Cinemeta check runs in the background
  assert.equal(missingRecord('tt0111161'), null, 'Cinemeta says not anime: never stored');
  assert.equal(requestLog.query({ scope: 'pass', q: 'tt0111161' }).rows[0].title, 'Some Movie');
});

test('an IMDB ID missing from the mapping that Cinemeta lists as anime is a mapping gap', async t => {
  stubPipeline(t, { plan: { mode: 'none', isAnime: null, attempts: [] } });
  t.mock.method(cinemeta, 'fetchTitleInfo', async () => ({ title: 'Obscure Anime', isAnime: true }));
  await streamHandler({ type: 'series', id: 'tt0222222:1:3', ip: '198.51.100.4' });
  await settle();
  const row = missingRecord('tt0222222');
  assert.equal(row.status, 'mapping_gap');
  assert.equal(row.title, 'Obscure Anime');
  assert.deepEqual(row.requested.map(q => q.label), ['S1E3']);
  assert.equal(row.users, 1);

  // Later requests update the record directly (no new Cinemeta check)
  await streamHandler({ type: 'series', id: 'tt0222222:1:4', ip: '198.51.100.5' });
  assert.equal(cinemeta.fetchTitleInfo.mock.callCount(), 1);
  assert.equal(missingRecord('tt0222222').users, 2);
});

test('anime missing from AniLibria is cached and recorded with its title', async t => {
  stubPipeline(t, { attempt: { candidates: [], showFound: false, method: null, title: 'Shingeki no Kyojin' } });
  const res = await streamHandler({ type: 'series', id: 'tt2560140:1:1' });
  assert.deepEqual(res, { streams: [], cacheMaxAge: 1800 });
  const row = missingRecord('tt2560140');
  assert.equal(row.status, 'not_on_anilibria');
  assert.equal(row.title, 'Shingeki no Kyojin');
  assert.equal(lastLog().category, 'not_on_anilibria');
});

test('a missing title that later resolves is "now available" and loses its not-dubbed mark', async t => {
  stubPipeline(t, { attempt: { candidates: [], showFound: false, method: null, title: 'Late Dub' } });
  await streamHandler({ type: 'series', id: 'tt0333333:1:1' });
  overrides.markNotDubbed('tt0333333');
  assert.equal(missingRecord('tt0333333').status, 'not_dubbed');

  t.mock.restoreAll();
  stubPipeline(t, {});
  await streamHandler({ type: 'series', id: 'tt0333333:1:1' });
  const row = missingRecord('tt0333333');
  assert.equal(row.status, 'now_available');
  assert.equal(row.available.confirmed, true);
  assert.equal(row.available.releaseId, 555);
  assert.equal(overrides.getNotDubbed('tt0333333'), null);
});

test('an episode missing from our cached copy is rechecked, so new episodes are found immediately', async t => {
  const withSix = { ...RELEASE, is_in_production: true, episodes: [...RELEASE.episodes, { ordinal: 6, hls_720: 'https://cdn/6/720.m3u8' }] };
  stubPipeline(t, {
    plan: { attempts: [{ entry: ENTRY, episode: 6, numbering: 'local' }] },
    release: async (id, opts) => (opts?.maxAgeMs !== undefined ? withSix : { ...RELEASE, is_in_production: true }),
  });
  const res = await streamHandler({ type: 'series', id: 'tt0000011:1:6' });
  assert.equal(res.streams[0].url, 'https://cdn/6/720.m3u8');
});

test('episodes not yet out for a release still being dubbed are cached briefly', async t => {
  stubPipeline(t, {
    plan: { attempts: [{ entry: ENTRY, episode: 9, numbering: 'local' }] },
    release: async () => ({ ...RELEASE, is_in_production: true }),
  });
  assert.deepEqual(await streamHandler({ type: 'series', id: 'tt0000012:1:9' }), { streams: [], cacheMaxAge: 120 });
  assert.equal(missingRecord('ep:tt0000012:s1').likelyCause, 'not_released_yet');
});

test('missing episodes get a short cache and an "episode not found" record with a likely cause', async t => {
  stubPipeline(t, { plan: { attempts: [{ entry: ENTRY, episode: 9, numbering: 'local' }] } });
  const res = await streamHandler({ type: 'series', id: 'tt0000002:1:9' });
  assert.deepEqual(res, { streams: [], cacheMaxAge: 900 });
  assert.equal(missingRecord('tt0000002'), null, 'the show itself is not missing');
  const ep = missingRecord('ep:tt0000002:s1');
  assert.equal(ep.status, 'episode_missing');
  assert.equal(ep.releaseId, 555);
  assert.equal(ep.latestEpisode, 2);
  assert.equal(ep.likelyCause, 'beyond_release');
  assert.deepEqual(ep.requested, [{ label: 'S1E9', count: 1, target: 9 }]);
});

test('an uncomputable absolute episode is "episode not found", not a missing show', async t => {
  stubPipeline(t, { plan: { mode: 'absolute', attempts: [{ entry: ENTRY, episode: null, numbering: 'absolute' }] } });
  const res = await streamHandler({ type: 'series', id: 'tt0000010:30:1' });
  assert.deepEqual(res, { streams: [], cacheMaxAge: 900 });
  assert.equal(anilibria.getRelease.mock.callCount(), 0);
  assert.equal(missingRecord('tt0000010'), null);
  assert.equal(missingRecord('ep:tt0000010:s30').likelyCause, 'numbering_unknown');
});

test('season 0 requests return an empty cached list', async t => {
  stubPipeline(t, { plan: { mode: 'special', attempts: [] } });
  const res = await streamHandler({ type: 'series', id: 'tt0000003:0:1' });
  assert.deepEqual(res, { streams: [], cacheMaxAge: 3600 });
  assert.equal(lastLog().title, 'Test Show');
  assert.equal(lastLog().category, 'unsupported');
});

test('geo-blocked releases show the blocked notice', async t => {
  stubPipeline(t, { release: async () => { throw new anilibria.GeoBlockedError(555); } });
  const res = await streamHandler({ type: 'series', id: 'tt0000004:1:1' });
  assert.equal(res.streams.length, 1);
  assert.equal(res.streams[0].name, 'AniLibria\nBlocked');
  assert.equal(res.cacheMaxAge, undefined);
  assert.equal(lastLog().category, 'blocked');
});

test('upstream failures show a generic, uncached error without internals', async t => {
  stubPipeline(t, {
    release: async () => { throw new HttpError('AniLibria GET /anime/releases/555 failed: HTTP 503', { code: 'HTTP', status: 503 }); },
  });
  const res = await streamHandler({ type: 'series', id: 'tt0000005:1:1' });
  assert.equal(res.cacheMaxAge, undefined);
  assert.equal(res.streams[0].name, 'AniLibria\n⚠ Error');
  assert.match(res.streams[0].description, /upstream HTTP 503/);
  assert.doesNotMatch(res.streams[0].description, /anime\/releases/);
  const log = lastLog();
  assert.equal(log.outcome, 'error');
  assert.equal(log.category, 'error');
  assert.equal(log.reason, 'release_fetch_failed');
  assert.match(log.error, /HTTP 503/);
});

test('an unloaded ID mapping is reported as a temporary error', async t => {
  stubPipeline(t, { plan: async () => { throw new MappingUnavailableError(); } });
  const res = await streamHandler({ type: 'series', id: 'tt0000006:1:1' });
  assert.equal(res.streams[0].name, 'AniLibria\n⚠ Error');
  assert.equal(res.cacheMaxAge, undefined);
  assert.equal(lastLog().reason, 'mapping_unavailable');
});

test('an inconclusive lookup is an error, a degraded one gets a short cache', async t => {
  stubPipeline(t, { attempt: { candidates: [], showFound: false, uncertain: true } });
  const uncertain = await streamHandler({ type: 'series', id: 'tt0000007:1:1' });
  assert.equal(uncertain.streams[0].name, 'AniLibria\n⚠ Error');

  t.mock.restoreAll();
  stubPipeline(t, { attempt: { candidates: [], showFound: false, degraded: true } });
  assert.deepEqual(await streamHandler({ type: 'series', id: 'tt0000008:1:1' }), { streams: [], cacheMaxAge: 300 });
});

test('invalid IDs and unsupported types are ignored without lookups', async t => {
  stubPipeline(t, {});
  assert.deepEqual(await streamHandler({ type: 'series', id: 'kitsu:1:1' }), { streams: [] });
  assert.deepEqual(await streamHandler({ type: 'channel', id: 'tt0000001' }), { streams: [] });
  assert.equal(resolver.plan.mock.callCount(), 0);
});
