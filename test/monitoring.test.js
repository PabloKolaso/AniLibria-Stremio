const fs = require('fs');
const os = require('os');
const path = require('path');
process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'anilibria-monitoring-'));

// The previous run never shut down cleanly
fs.writeFileSync(path.join(process.env.DATA_DIR, 'lifecycle.json'), JSON.stringify({
  version: 1,
  boots: [{ id: 'old', startedAt: Date.now() - 3_600_000, version: '0.9.0', lastAliveAt: Date.now() - 600_000, endedAt: null, clean: false }],
  fatal: [],
}));

const test = require('node:test');
const assert = require('node:assert/strict');
const nodeHttp = require('http');
const consoleCapture = require('../src/monitoring/console');
const providers = require('../src/monitoring/providers');
const problems = require('../src/monitoring/problems');
const jobs = require('../src/monitoring/jobs');
const lifecycle = require('../src/monitoring/lifecycle');
const health = require('../src/monitoring/health');
const alerts = require('../src/monitoring/alerts');
const { parseInput } = require('../src/monitoring/diagnose');
const http = require('../src/api/http');
const TTLCache = require('../src/util/ttl-cache');

// ─── Providers ───────────────────────────────────────────────────────────────

test('provider telemetry classifies failures; 404 is a valid answer', async () => {
  const server = nodeHttp.createServer((req, res) => {
    if (req.url === '/ok') return res.end('{}');
    if (req.url === '/missing') { res.statusCode = 404; return res.end(); }
    if (req.url === '/limited') { res.statusCode = 429; return res.end(); }
    res.statusCode = 503;
    res.end();
  });
  await new Promise(r => server.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${server.address().port}`;
  try {
    await http.getJson(`${base}/ok`, { service: 'TestProvider' });
    await http.getJson(`${base}/missing`, { service: 'TestProvider' }).catch(() => {});
    await http.getJson(`${base}/limited`, { service: 'TestProvider' }).catch(() => {});
    await http.getJson(`${base}/down`, { service: 'TestProvider', retries: 1, retryDelayMs: 1 }).catch(() => {});
  } finally {
    server.close();
  }
  const p = providers.get('TestProvider');
  assert.equal(p.calls, 5, 'every attempt counts, retries included');
  assert.equal(p.ok, 2);
  assert.equal(p.notFound, 1);
  assert.equal(p.failures.http429, 1);
  assert.equal(p.failures.http5xx, 2);
  assert.equal(p.consecutiveFailures, 3);
  assert.equal(p.last15m.calls, 5);
  assert.match(p.lastError.message, /HTTP 503/);
  assert.equal(p.lastError.path, '/down');
  assert.ok(p.latency.p95 !== null);

  providers.record('keepalive', { ms: 5 });
  assert.equal(providers.get('keepalive'), null, 'self-pings are not a provider');
  providers.record('Stremio publish', { ms: 5 });
  assert.equal(providers.get('Stremio API').calls, 1, 'display names');
});

test('health turns provider failures into statuses and a banner', () => {
  providers.reset();
  const evalFor = name => health.evaluate().components.find(c => c.provider === name);
  assert.equal(evalFor('AniLibria').status, 'idle');

  for (let i = 0; i < 8; i++) providers.record('AniLibria', { ms: 100 });
  assert.equal(evalFor('AniLibria').status, 'healthy');

  providers.record('AniLibria', { ms: 100, error: { code: 'TIMEOUT', message: 'timed out' } });
  assert.equal(evalFor('AniLibria').status, 'warning');

  for (let i = 0; i < 3; i++) providers.record('AniLibria', { ms: 100, error: { code: 'NETWORK', message: 'reset' } });
  assert.equal(evalFor('AniLibria').status, 'degraded', '4 of 12 calls failed (33%)');

  const report = health.evaluate();
  assert.notEqual(report.status, 'healthy');
  assert.match(report.banner, /AniLibria API/);
  assert.ok(report.components.some(c => c.id === 'index'));
  assert.ok(report.components.some(c => c.id === 'process'));
});

// ─── Jobs ────────────────────────────────────────────────────────────────────

test('jobs run once at a time and respect their cooldown', async () => {
  let release;
  jobs.define('slow', { label: 'Slow', cooldownMs: 1000, run: () => new Promise(r => { release = r; }) });
  const first = jobs.trigger('slow');
  await assert.rejects(jobs.trigger('slow'), { status: 429, message: 'already running' });
  release('done');
  assert.equal((await first).message, 'done');
  await assert.rejects(jobs.trigger('slow'), err => err.status === 429 && err.retryAfterMs > 0);
  await assert.rejects(jobs.trigger('nope'), { status: 404 });

  jobs.define('failing', { label: 'Failing', run: async () => { throw new Error('upstream down'); } });
  await assert.rejects(jobs.trigger('failing'), /upstream down/);
  const failing = jobs.get('failing');
  assert.equal(failing.lastOk, false);
  assert.equal(failing.lastError, 'upstream down');

  jobs.define('passive', { label: 'Passive' });
  jobs.report('passive', { ok: true, message: 'Ping OK', durationMs: 12 });
  assert.equal(jobs.get('passive').lastMessage, 'Ping OK');
  assert.equal(jobs.get('passive').manual, false);
});

// ─── Problems & console ──────────────────────────────────────────────────────

test('console errors become grouped problems; the console is read incrementally', () => {
  const marker = consoleCapture.lastSeq();
  console.error('[catalog] Build failed for release 1234: HTTP 503');
  console.error('[catalog] Build failed for release 98765: HTTP 503');
  console.warn('[x] just a warning');
  const lines = consoleCapture.getLines({ after: marker });
  assert.deepEqual(lines.map(l => l.level), ['error', 'error', 'warn']);
  assert.equal(consoleCapture.getLines({ after: consoleCapture.lastSeq() }).length, 0);

  const group = problems.list().find(p => p.title === 'catalog');
  assert.equal(group.count, 2, 'numbers are ignored when grouping');
  assert.equal(group.active, true);
  assert.match(group.message, /98765/, 'the latest message is kept as the sample');
  assert.equal(problems.list().some(p => /warning/.test(p.message)), false, 'warnings are not problems');

  problems.record({ source: 'streams', key: 'timeout::', title: 'Stream lookup failed (timeout)', message: 'a' });
  problems.record({ source: 'streams', key: 'timeout::', title: 'Stream lookup failed (timeout)', message: 'b' });
  assert.equal(problems.list().find(p => p.source === 'streams').count, 2);
  problems.dismiss('streams:timeout::');
  assert.equal(problems.list().some(p => p.source === 'streams'), false);
});

test('problems persist across a restart', async () => {
  await problems.flush();
  const saved = JSON.parse(fs.readFileSync(path.join(process.env.DATA_DIR, 'problems.json'), 'utf8'));
  assert.ok(saved.groups.some(g => g.title === 'catalog'));
});

// ─── Lifecycle ───────────────────────────────────────────────────────────────

test('an unclean previous run is detected; crashes are counted', async () => {
  lifecycle.start();
  const info = lifecycle.info();
  assert.equal(info.previousShutdown.clean, false);
  assert.equal(info.previousShutdown.version, '0.9.0');
  assert.equal(info.restarts24h, 1);

  let notified = null;
  lifecycle.onFatal(f => { notified = f; });
  lifecycle.recordFatal('uncaughtException', new Error('kaboom'));
  assert.equal(lifecycle.info().uncaughtExceptions, 1);
  assert.equal(notified.message, 'kaboom');
  assert.match(lifecycle.info().lastFatal.stack, /kaboom/);
  const proc = health.evaluate().components.find(c => c.id === 'process');
  assert.equal(proc.status, 'degraded', 'a recent crash is never hidden');

  await lifecycle.markShutdown('SIGTERM');
  const saved = JSON.parse(fs.readFileSync(path.join(process.env.DATA_DIR, 'lifecycle.json'), 'utf8'));
  assert.equal(saved.boots.at(-1).clean, true);
  assert.equal(saved.boots.at(-1).signal, 'SIGTERM');
});

// ─── Alerts ──────────────────────────────────────────────────────────────────

test('alerts need a sustained condition, dedupe, and are only recorded when ntfy is off', async () => {
  const traffic = require('../src/telemetry/traffic');
  for (let i = 0; i < 25; i++) traffic.recordStream({ category: i < 10 ? 'error' : 'found', reason: 'x', method: 'mal', source: 'imdb', ms: 100 });
  const t0 = Date.now();
  await alerts.check(t0);
  assert.equal(alerts.info().history.length, 0, 'not sent on the first check');
  await alerts.check(t0 + 60_000);
  const sent = alerts.info().history.filter(h => h.key === 'error-rate');
  assert.equal(sent.length, 1);
  assert.equal(sent[0].delivered, false);
  assert.equal(sent[0].suppressed, 'alerts disabled');
  await alerts.check(t0 + 120_000);
  assert.equal(alerts.info().history.filter(h => h.key === 'error-rate').length, 1, 'no repeat within the reminder window');
  assert.equal(alerts.info().enabled, false);
});

// ─── Resolve tester input ────────────────────────────────────────────────────

test('the resolve tester understands IDs and pasted URLs', () => {
  assert.deepEqual(parseInput('tt0388629:1:5'), { kind: 'imdb', imdbId: 'tt0388629', type: 'series', season: 1, episode: 5, id: 'tt0388629:1:5' });
  assert.equal(parseInput('tt0388629').id, 'tt0388629:1:1', 'series default to S1E1');
  assert.equal(parseInput('tt5311514', { type: 'movie' }).id, 'tt5311514');
  assert.equal(parseInput('https://web.stremio.com/#/detail/series/tt0388629/tt0388629%3A3%3A7').id, 'tt0388629:3:7');
  assert.equal(parseInput('stremio:///detail/movie/tt5311514/tt5311514').type, 'movie');
  assert.equal(parseInput('https://www.imdb.com/title/tt0388629/').imdbId, 'tt0388629');
  assert.equal(parseInput('tt0388629:1:5', { season: '2', episode: '3' }).id, 'tt0388629:2:3');
  assert.deepEqual(parseInput('anilibria:9660:8'), { kind: 'catalog', releaseId: 9660, ordinal: 8, id: 'anilibria:9660:8', type: 'series', season: null, episode: 8 });
  assert.throws(() => parseInput('   '), /Enter an IMDB ID/);
  assert.throws(() => parseInput('hello world'), /No IMDB ID/);
  assert.throws(() => parseInput('tt0388629', { season: 'x' }), /whole numbers/);
});

// ─── Named caches ────────────────────────────────────────────────────────────

test('named caches report size and hit rate', () => {
  const cache = new TTLCache({ ttlMs: 1000, name: 'Test cache' });
  cache.set('a', 1);
  cache.get('a');
  cache.get('b');
  const stats = TTLCache.list().find(c => c.name === 'Test cache');
  assert.deepEqual([stats.size, stats.hits, stats.misses, stats.hitRate], [1, 1, 1, 0.5]);
  cache.clear();
  assert.ok(TTLCache.list().find(c => c.name === 'Test cache').lastClearedAt);
});
