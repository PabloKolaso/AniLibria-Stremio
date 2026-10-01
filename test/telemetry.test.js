const fs = require('fs');
const os = require('os');
const path = require('path');
process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'anilibria-telemetry-'));

// v1 data files, as left by the previous version
const hourKey = ts => new Date(ts).toISOString().slice(0, 13);
const twoHoursAgo = Date.now() - 2 * 3_600_000;
fs.writeFileSync(path.join(process.env.DATA_DIR, 'stats.json'), JSON.stringify({
  counters: { totalRequests: 12 },
  hourlyBuckets: { [hourKey(twoHoursAgo)]: 12, '2001-01-01T00': 99 },
  animeBuckets: { [hourKey(twoHoursAgo)]: 5 },
}));
fs.writeFileSync(path.join(process.env.DATA_DIR, 'logs.json'), JSON.stringify([
  { ts: Date.now() - 60_000, imdbId: 'tt0000001', stremioId: 'tt0000001:1:2', type: 'series', outcome: 'success', title: 'Old', isAnime: true, method: 'mal', releaseId: 5, responseTimeMs: 300, streamCount: 3, error: null },
  { ts: Date.now() - 50_000, imdbId: 'tt0000009', stremioId: 'tt0000009', type: 'movie', outcome: 'not_found', title: null, isAnime: null, method: null, responseTimeMs: 1, streamCount: 0, error: null },
]));
fs.writeFileSync(path.join(process.env.DATA_DIR, 'users.json'), JSON.stringify({
  [new Date().toISOString().slice(0, 10)]: ['a'.repeat(64), 'b'.repeat(64)],
}));
fs.writeFileSync(path.join(process.env.DATA_DIR, 'salt.key'), 'fixed-test-salt');

const test = require('node:test');
const assert = require('node:assert/strict');
const hist = require('../src/telemetry/histogram');
const traffic = require('../src/telemetry/traffic');
const users = require('../src/telemetry/users');
const titles = require('../src/telemetry/titles');
const requestLog = require('../src/telemetry/request-log');

// ─── Histogram ───────────────────────────────────────────────────────────────

test('latency histogram percentiles interpolate within buckets', () => {
  let counts = hist.empty();
  assert.equal(hist.percentile(counts, 0.5), null);
  for (let i = 0; i < 90; i++) counts = hist.add(counts, 120); // 100–150 bucket
  for (let i = 0; i < 10; i++) counts = hist.add(counts, 4000); // 3000–5000 bucket
  const p50 = hist.percentile(counts, 0.5);
  assert.ok(p50 > 100 && p50 <= 150, `p50 ${p50}`);
  const p95 = hist.percentile(counts, 0.95);
  assert.ok(p95 > 3000 && p95 <= 5000, `p95 ${p95}`);
  const slow = hist.add(hist.empty(), 60_000);
  assert.equal(hist.percentile(slow, 0.5), 20_000, 'open-ended bucket reports its lower bound');
  assert.deepEqual(hist.merge(hist.empty(), 'garbage'), hist.empty());
});

// ─── Traffic ─────────────────────────────────────────────────────────────────

test('categorize maps every stream outcome to one category', () => {
  const cases = [
    [{ outcome: 'success', reason: 'found' }, 'found'],
    [{ outcome: 'not_found', reason: 'not_anime' }, 'pass_through'],
    [{ outcome: 'not_found', reason: 'not_on_anilibria' }, 'not_on_anilibria'],
    [{ outcome: 'not_found', reason: 'release_missing' }, 'not_on_anilibria'],
    [{ outcome: 'not_found', reason: 'episode_not_found' }, 'episode_missing'],
    [{ outcome: 'not_found', reason: 'special_season' }, 'unsupported'],
    [{ outcome: 'error', reason: 'blocked' }, 'blocked'],
    [{ outcome: 'error', reason: 'timeout' }, 'error'],
    [{ outcome: 'error', reason: 'mapping_unavailable' }, 'error'],
  ];
  for (const [res, expected] of cases) assert.equal(traffic.categorize(res), expected, res.reason);
});

test('v1 hourly volume is imported as unclassified anime + pass-through', () => {
  const kpis = traffic.kpis().current;
  assert.equal(kpis.unclassified, 5);
  assert.equal(kpis.passThrough, 7);
  assert.equal(kpis.errorRate, null, 'unclassified requests never count as errors or found');
  const since = traffic.since();
  assert.ok(since.oldestBucket <= twoHoursAgo);
  assert.ok(since.detailedSince > since.oldestBucket);
});

test('KPIs separate errors from "not on AniLibria" and exclude non-anime', () => {
  const before = traffic.kpis().current;
  const add = (category, n, ms = 200, method = null) => {
    for (let i = 0; i < n; i++) traffic.recordStream({ category, reason: category, method, source: 'imdb', ms });
  };
  add('found', 6, 300, 'mal');
  add('found', 1, 300, 'fuse');
  add('not_on_anilibria', 2);
  add('error', 1, 20_000);
  add('pass_through', 50, 1);
  const k = traffic.kpis().current;
  assert.equal(k.requests - before.requests, 10);
  assert.equal(k.errors - before.errors, 1);
  assert.equal(k.passThrough - before.passThrough, 50);
  assert.equal(k.errorRate, 1 / 10);
  assert.equal(k.coverage, 7 / 9, 'found ÷ (anime requests − errors)');
  assert.ok(k.p95 >= 3000, 'the 20 s timeout dominates p95, pass-through does not pull it down');
  assert.ok(k.p50 > 200 && k.p50 <= 400, `p50 ${k.p50}`);

  const recent = traffic.recentStats(15);
  assert.equal(recent.requests, 10);
  assert.equal(recent.errors, 1);
});

test('series are aligned to UTC blocks and compare with the previous period', () => {
  traffic.recordResource({ resource: 'catalog', catalogId: 'anilibria-trending', ok: true });
  traffic.recordResource({ resource: 'meta', ok: false });
  for (const [range, points, step] of [['24h', 24, 1], ['7d', 28, 6], ['30d', 30, 24], ['90d', 90, 24]]) {
    const s = traffic.series(range);
    assert.equal(s.points.length, points, range);
    assert.equal(s.stepHours, step, range);
    assert.equal(s.points[0].t % (step * 3_600_000), 0, `${range} aligned`);
    assert.ok(s.points.at(-1).t <= Date.now());
  }
  const day = traffic.series('24h');
  assert.equal(day.current.catalogs['anilibria-trending'], 1);
  assert.equal(day.current.resourceErrors.meta, 1);
  assert.equal(day.current.methods.fuse, 1);
  assert.equal(day.points.reduce((a, p) => a + p.outcomes.found, 0), day.current.found);
});

test('installed versions are counted per request, without manifest fetches and with a cap', () => {
  traffic.recordResource({ resource: 'stream', ok: true, installVersion: 'legacy' });
  traffic.recordResource({ resource: 'stream', ok: true, installVersion: 'legacy' });
  traffic.recordResource({ resource: 'catalog', catalogId: 'anilibria-releasing', ok: true, installVersion: '3.0.0' });
  traffic.recordResource({ resource: 'manifest', ok: true, installVersion: '3.0.0' });
  traffic.recordResource({ resource: 'meta', ok: true }); // direct call, no version
  let versions = traffic.series('24h').current.versions;
  assert.deepEqual(versions, { legacy: 2, '3.0.0': 1 });

  // Edited URLs cannot grow the hourly bucket without bound
  for (let i = 0; i < 30; i++) traffic.recordResource({ resource: 'stream', ok: true, installVersion: `9.9.${i}` });
  versions = traffic.series('24h').current.versions;
  assert.equal(Object.keys(versions).length, 21, 'MAX_VERSIONS_PER_HOUR keys + "other"');
  assert.equal(versions.other, 12);
  traffic.recordResource({ resource: 'stream', ok: true, installVersion: 'legacy' });
  assert.equal(traffic.series('24h').current.versions.legacy, 3, 'known versions keep counting');
});

// ─── Users ───────────────────────────────────────────────────────────────────

test('users are counted by salted IP hash; v1 hashes are migrated', () => {
  const before = users.counts();
  assert.equal(before.week, 2, 'two v1 users today');
  const a = users.recordUser('203.0.113.10');
  const b = users.recordUser('::ffff:203.0.113.10');
  assert.equal(a, b, 'IPv4-mapped IPv6 is the same user');
  assert.match(a, /^[0-9a-f]{16}$/);
  assert.equal(users.recordUser(null), null);
  users.recordUser('203.0.113.11');
  const after = users.counts();
  assert.equal(after.now, 2);
  assert.equal(after.day, 2, 'rolling 24 h only has the new hourly data');
  assert.equal(after.month, 4);
  assert.equal(users.dailyCounts(7).length, 7);
  assert.equal(users.hourlyCounts(24).at(-1).users, 2);
});

// ─── Top titles ──────────────────────────────────────────────────────────────

test('top titles rank by unique users and merge requests per release', () => {
  titles.record({ releaseId: 1, name: 'Busy', imdbId: 'tt1', userHash: 'u1' });
  for (let i = 0; i < 5; i++) titles.record({ releaseId: 1, name: 'Busy', imdbId: 'tt1', userHash: 'u1' });
  titles.record({ releaseId: 2, name: 'Popular', imdbId: 'tt2', userHash: 'u1' });
  titles.record({ releaseId: 2, name: 'Popular', userHash: 'u2' }); // catalog request, same release
  titles.record({ releaseId: 2, name: 'Popular', userHash: 'u3' });
  const top = titles.top({ days: 7 });
  assert.deepEqual(top.map(r => r.releaseId), [2, 1]);
  assert.equal(top[0].users, 3);
  assert.equal(top[0].requests, 3);
  assert.equal(top[1].requests, 6);
  assert.deepEqual(top[0].imdbIds, ['tt2']);
});

// ─── Request log ─────────────────────────────────────────────────────────────

test('v1 logs.json entries are imported with categories', () => {
  const all = requestLog.query({ scope: 'all' }).rows;
  const old = all.find(e => e.imdbId === 'tt0000001');
  assert.equal(old.category, 'found');
  assert.equal(old.season, 1);
  assert.equal(old.episode, 2);
  assert.equal(requestLog.query({ scope: 'pass' }).rows[0].imdbId, 'tt0000009');
});

test('request log: filters, cursor paging, new-entry counts and separate retention', () => {
  const base = { source: 'imdb', type: 'series', outcome: 'not_found', streams: 0 };
  for (let i = 0; i < 30; i++) requestLog.add({ ...base, id: `tt10000${String(i).padStart(2, '0')}`, imdbId: `tt10000${String(i).padStart(2, '0')}`, category: 'not_on_anilibria', reason: 'not_on_anilibria', ms: i * 100 });
  const marker = requestLog.latestSeq();
  requestLog.add({ ...base, id: 'tt2000001', category: 'error', outcome: 'error', reason: 'timeout', ms: 20_000, error: 'timeout: took too long', title: 'Slow Show' });
  requestLog.add({ ...base, id: 'tt2000002', category: 'pass_through', reason: 'not_anime', ms: 1 });

  const page1 = requestLog.query({ category: 'not_on_anilibria', limit: 10 });
  assert.equal(page1.rows.length, 10);
  assert.equal(page1.matched, 30);
  const page2 = requestLog.query({ category: 'not_on_anilibria', limit: 10, before: page1.nextBefore });
  assert.ok(page2.rows[0].seq < page1.rows.at(-1).seq, 'older page continues where the first ended');
  assert.equal(new Set([...page1.rows, ...page2.rows].map(r => r.seq)).size, 20);

  assert.equal(requestLog.query({ q: 'too long' }).rows[0].id, 'tt2000001', 'search covers errors');
  assert.equal(requestLog.query({ q: 'slow show' }).rows.length, 1, 'search covers titles');
  assert.equal(requestLog.query({ minMs: 2500 }).rows.length, 6, '5 slow not-found entries + the timeout');
  assert.equal(requestLog.query({ reason: 'timeout' }).rows.length, 1);
  assert.equal(requestLog.query({}).rows.some(r => r.category === 'pass_through'), false, 'anime scope by default');
  assert.equal(requestLog.query({ after: marker }).matched, 1, 'one new anime entry since the marker');
  assert.equal(requestLog.query({ scope: 'all', after: marker }).matched, 2);

  const r = requestLog.retention();
  assert.equal(r.maxAgeDays, 3);
  assert.deepEqual(r.limits, { anime: 10_000, passThrough: 2_000 });
  const seq = requestLog.query({ limit: 1 }).rows[0].seq;
  assert.equal(requestLog.get(seq).seq, seq);
  assert.equal(requestLog.get(999_999), null);
});

test('request log survives a reload from its NDJSON file', async () => {
  await requestLog.flush();
  const file = path.join(process.env.DATA_DIR, 'requests.ndjson');
  const lines = fs.readFileSync(file, 'utf8').trim().split('\n');
  assert.ok(lines.length >= 34);
  const last = JSON.parse(lines.at(-1));
  assert.equal(last.id, 'tt2000002');
});
