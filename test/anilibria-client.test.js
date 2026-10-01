const fs = require('fs');
const os = require('os');
const path = require('path');
process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'anilibria-client-'));

const test = require('node:test');
const assert = require('node:assert/strict');
const anilibria = require('../src/api/anilibria');

const release = (id, extra = {}) => ({ id, alias: `r-${id}`, is_in_production: false, episodes: [{ ordinal: 1, hls_720: 'u' }], ...extra });
const json = body => new Response(JSON.stringify(body), { status: 200, headers: { 'Content-Type': 'application/json' } });

test('bulk lookups use at most 50 IDs per request and cache every release', async t => {
  const seen = [];
  t.mock.method(global, 'fetch', async url => {
    const ids = new URL(url).searchParams.getAll('ids[]').map(Number);
    seen.push(ids.length);
    return json({ data: ids.filter(id => id !== 77).map(id => release(id)), meta: {} });
  });
  const ids = Array.from({ length: 120 }, (_, i) => i + 1);
  const found = await anilibria.getReleasesByIds([...ids, 1, 2, -5]);
  assert.deepEqual(seen, [50, 50, 20]);
  assert.equal(found.size, 119);
  assert.equal(found.has(77), false);
  assert.equal(anilibria.peekRelease(5).id, 5);
});

test('live releases expire quickly; maxAgeMs forces a recheck', async t => {
  t.mock.timers.enable({ apis: ['Date'], now: 5_000_000 });
  let version = 1;
  t.mock.method(global, 'fetch', async () => json(release(500, { is_in_production: true, v: version })));

  assert.equal((await anilibria.getRelease(500)).v, 1);
  version = 2;
  assert.equal((await anilibria.getRelease(500)).v, 1);                      // cached
  assert.equal((await anilibria.getRelease(500, { maxAgeMs: 60_000 })).v, 1); // young enough
  t.mock.timers.tick(30_001);
  assert.equal((await anilibria.getRelease(500, { maxAgeMs: 30_000 })).v, 2); // recheck
  version = 3;
  t.mock.timers.tick(anilibria.LIVE_RELEASE_TTL_MS);
  assert.equal((await anilibria.getRelease(500)).v, 3);                      // live TTL (2 min) expired
});

test('targeted invalidation refetches only that release', async t => {
  let calls = 0;
  t.mock.method(global, 'fetch', async url => { calls++; return json(release(Number(new URL(url).pathname.split('/').pop()))); });
  await anilibria.getRelease(600);
  await anilibria.getRelease(601);
  anilibria.invalidateRelease(600);
  await anilibria.getRelease(600);
  await anilibria.getRelease(601);
  assert.equal(calls, 3);
});

test('transient failures serve the last good copy; 404 removes it', async t => {
  t.mock.timers.enable({ apis: ['Date'], now: 9_000_000 });
  let mode = 'ok';
  t.mock.method(global, 'fetch', async () => {
    if (mode === 'down') return new Response('', { status: 503 });
    if (mode === 'gone') return new Response('<html></html>', { status: 404 });
    return json(release(700, { is_in_production: true }));
  });
  await anilibria.getRelease(700);
  mode = 'down';
  t.mock.timers.tick(anilibria.LIVE_RELEASE_TTL_MS + 1);
  assert.equal((await anilibria.getRelease(700)).id, 700); // stale-if-error

  mode = 'gone';
  assert.equal(await anilibria.getRelease(700, { maxAgeMs: 0 }), null);
  mode = 'down';
  t.mock.timers.tick(10 * 60 * 1000 + 1); // past the not-found cache
  await assert.rejects(anilibria.getRelease(700), { status: 503 });
});

test('media paths become absolute URLs', () => {
  assert.equal(anilibria.mediaUrl('/storage/a.jpg'), 'https://anilibria.top/storage/a.jpg');
  assert.equal(anilibria.mediaUrl('https://cdn/x.jpg'), 'https://cdn/x.jpg');
  assert.equal(anilibria.mediaUrl('relative.jpg'), null);
  assert.equal(anilibria.mediaUrl(null), null);
});
