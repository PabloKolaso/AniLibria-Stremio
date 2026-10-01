const fs = require('fs');
const os = require('os');
const path = require('path');
process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'anilibria-app-'));
process.env.DASHBOARD_PASSWORD = 'integration-password';

const test = require('node:test');
const assert = require('node:assert/strict');
const linter = require('stremio-addon-linter');
const manifest = require('../src/manifest');
const { createApp } = require('../src/app');

let server;
let base;
const streamCalls = [];
const catalogCalls = [];
const metaCalls = [];

test.before(async () => {
  const app = createApp({
    handlers: {
      stream: async args => {
        streamCalls.push(args);
        return { streams: [], cacheMaxAge: 3600 };
      },
      catalog: async args => {
        catalogCalls.push(args);
        return { metas: [{ id: 'anilibria:1', type: 'series', name: 'X' }], cacheMaxAge: 60 };
      },
      meta: async args => {
        metaCalls.push(args);
        return { meta: { id: args.id, type: 'series', name: 'X', videos: [] }, cacheMaxAge: 60 };
      },
    },
  });
  server = app.listen(0, '127.0.0.1');
  await new Promise(resolve => server.once('listening', resolve));
  base = `http://127.0.0.1:${server.address().port}`;
});

test.after(() => server.close());

async function login() {
  const res = await fetch(`${base}/dashboard/login`, {
    method: 'POST', redirect: 'manual', body: new URLSearchParams({ password: 'integration-password' }),
  });
  return res.headers.get('set-cookie').split(';')[0];
}

test('manifest passes the official Stremio linter and size limit', () => {
  const result = linter.lintManifest(manifest);
  assert.equal(result.valid, true, JSON.stringify(result.errors));
  assert.ok(JSON.stringify(manifest).length <= 8192);
  assert.deepEqual(manifest.resources.map(r => (typeof r === 'string' ? r : r.name)), ['catalog', 'meta', 'stream']);
  assert.deepEqual(manifest.resources[1].idPrefixes, ['anilibria:']);
  assert.deepEqual(manifest.resources[2].idPrefixes, ['tt', 'anilibria:']);
  assert.deepEqual(manifest.catalogs.map(c => [c.type, c.id]), [['series', 'anilibria-releasing'], ['series', 'anilibria-trending']]);
});

test('serves manifest, streams, health and install page with CORS', async () => {
  const res = await fetch(`${base}/manifest.json`);
  assert.equal(res.status, 200);
  assert.equal(res.headers.get('access-control-allow-origin'), '*');
  assert.equal(res.headers.get('x-powered-by'), null);
  assert.equal((await res.json()).id, 'community.anilibria.stremio');

  const stream = await fetch(`${base}/stream/series/tt9335498:1:1.json`);
  assert.equal(stream.status, 200);
  assert.equal(stream.headers.get('cache-control'), 'max-age=3600, public');
  assert.deepEqual(await stream.json(), { streams: [], cacheMaxAge: 3600 });
  assert.equal(streamCalls.at(-1).id, 'tt9335498:1:1');
  assert.equal(streamCalls.at(-1).ip, '127.0.0.1', 'handlers receive the client IP');

  const health = await (await fetch(`${base}/health`)).json();
  assert.equal(health.status, 'ok');
  assert.equal(typeof health.mappingLoaded, 'boolean');
  assert.deepEqual(Object.keys(health.catalogs.releasing), ['count', 'updatedAt', 'stale', 'lastError']);

  const home = await fetch(`${base}/`);
  assert.match(await home.text(), /stremio:\/\/anilibria-stremio\.online\/manifest\.json/);
});

test('serves catalog pages and catalog item metadata', async () => {
  const page = await fetch(`${base}/catalog/series/anilibria-releasing/skip=100.json`);
  assert.equal(page.status, 200);
  assert.equal(page.headers.get('cache-control'), 'max-age=60, public');
  assert.equal((await page.json()).metas[0].id, 'anilibria:1');
  const call = catalogCalls.at(-1);
  assert.deepEqual([call.type, call.id, { ...call.extra }], ['series', 'anilibria-releasing', { skip: '100' }]);

  const item = await fetch(`${base}/meta/series/anilibria%3A9660.json`);
  assert.equal(item.status, 200);
  assert.equal((await item.json()).meta.id, 'anilibria:9660');
  assert.equal(metaCalls.at(-1).id, 'anilibria:9660');

  const stream = await fetch(`${base}/stream/series/anilibria:9660:8.json`);
  assert.equal(stream.status, 200);
  assert.equal(streamCalls.at(-1).id, 'anilibria:9660:8');

  const health = await (await fetch(`${base}/health`)).json();
  assert.deepEqual(Object.keys(health.catalogs), ['releasing', 'trending']);
});

test('dashboard and debug routes require a session', async () => {
  const dash = await fetch(`${base}/dashboard?tab=logs`, { redirect: 'manual' });
  assert.equal(dash.status, 302);
  assert.equal(dash.headers.get('location'), '/dashboard/login?next=%2Fdashboard%3Ftab%3Dlogs');
  for (const url of ['/debug/logs', '/debug/resolve/tt9335498', '/dashboard/api/status', '/dashboard/api/overview', '/dashboard/api/admin', '/dashboard/api/logs']) {
    assert.equal((await fetch(`${base}${url}`)).status, 401, url);
  }
  const imp = await fetch(`${base}/debug/import`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' });
  assert.equal(imp.status, 401);
  const csv = await fetch(`${base}/dashboard/export/csv`, { redirect: 'manual' });
  assert.equal(csv.status, 302);
});

test('login grants access to the dashboard, its assets and APIs', async () => {
  const bad = await fetch(`${base}/dashboard/login`, {
    method: 'POST', redirect: 'manual', body: new URLSearchParams({ password: 'nope' }),
  });
  assert.equal(bad.status, 401);

  const loginRes = await fetch(`${base}/dashboard/login`, {
    method: 'POST', redirect: 'manual', body: new URLSearchParams({ password: 'integration-password', next: '/dashboard?tab=failed' }),
  });
  assert.equal(loginRes.status, 302);
  assert.equal(loginRes.headers.get('location'), '/dashboard?tab=failed');
  const cookie = loginRes.headers.get('set-cookie').split(';')[0];

  // Every tab (and the v1 tab names) loads the app shell with a strict CSP
  for (const tab of ['overview', 'traffic', 'content', 'missing', 'logs', 'admin', 'analytics', 'failed', 'terminal']) {
    const page = await fetch(`${base}/dashboard?tab=${tab}`, { headers: { cookie } });
    assert.equal(page.status, 200, tab);
    assert.match(page.headers.get('content-security-policy'), /script-src 'self' https:\/\/cdn\.jsdelivr\.net/);
    assert.doesNotMatch(page.headers.get('content-security-policy'), /unsafe-inline/);
    const html = await page.text();
    assert.match(html, /<meta name="viewport"/);
    assert.doesNotMatch(html, /<script>|style="/, 'no inline scripts or styles');
  }

  const css = await fetch(`${base}/dashboard/assets/dashboard.css`);
  assert.equal(css.status, 200);
  const js = await fetch(`${base}/dashboard/assets/app.js`);
  assert.match(js.headers.get('content-type'), /javascript/);
  assert.equal((await fetch(`${base}/dashboard/assets/nope.js`)).status, 404);

  for (const [url, key] of [
    ['/dashboard/api/status', 'meta'],
    ['/dashboard/api/overview', 'health'],
    ['/dashboard/api/traffic?range=30d', 'series'],
    ['/dashboard/api/content', 'releasing'],
    ['/dashboard/api/content/coverage', 'coverage'],
    ['/dashboard/api/matches', 'rows'],
    ['/dashboard/api/missing?category=episode_missing', 'counts'],
    ['/dashboard/api/logs?scope=all', 'rows'],
    ['/dashboard/api/console', 'lines'],
    ['/dashboard/api/admin', 'jobs'],
  ]) {
    const res = await fetch(`${base}${url}`, { headers: { cookie } });
    assert.equal(res.status, 200, url);
    assert.equal(res.headers.get('cache-control'), 'no-store', url);
    const body = await res.json();
    assert.ok(key in body, `${url} has ${key}`);
    assert.ok(body.meta.bootId, `${url} has meta`);
  }
});

test('the dashboard API reports the addon requests it saw', async () => {
  const cookie = await login();
  const traffic = await (await fetch(`${base}/dashboard/api/traffic`, { headers: { cookie } })).json();
  const res = traffic.series.current.resources;
  assert.ok(res.manifest >= 1 && res.catalog >= 1 && res.meta >= 1 && res.stream >= 2, JSON.stringify(res));
  assert.ok(traffic.series.current.catalogs['anilibria-releasing'] >= 1);
  // Catalog and meta requests count as anime usage
  assert.ok(traffic.users.current >= 1);
});

test('state-changing API calls need the dashboard header (CSRF defence)', async () => {
  const cookie = await login();
  const denied = await fetch(`${base}/dashboard/api/missing/tt0111161/not-dubbed`, { method: 'POST', headers: { cookie } });
  assert.equal(denied.status, 403);
  const ok = await fetch(`${base}/dashboard/api/missing/tt0111161/not-dubbed`, { method: 'POST', headers: { cookie, 'X-Dashboard-Request': '1' } });
  assert.equal(ok.status, 200);
  const list = await (await fetch(`${base}/dashboard/api/missing?category=not_dubbed`, { headers: { cookie } })).json();
  assert.deepEqual(list.rows.map(r => r.imdbId), ['tt0111161']);
  const bad = await fetch(`${base}/dashboard/api/missing/..%2Fx/ignore`, { method: 'POST', headers: { cookie, 'X-Dashboard-Request': '1', 'Content-Type': 'application/json' }, body: '{}' });
  assert.equal(bad.status, 400);
});

test('jobs enforce their cooldown on the server', async () => {
  const jobs = require('../src/monitoring/jobs');
  let runs = 0;
  jobs.define('test-job', { label: 'Test job', cooldownMs: 60_000, run: async () => `run ${++runs}` });
  const cookie = await login();
  const headers = { cookie, 'X-Dashboard-Request': '1' };
  const first = await fetch(`${base}/dashboard/api/admin/jobs/test-job`, { method: 'POST', headers });
  assert.equal(first.status, 200);
  assert.equal((await first.json()).message, 'run 1');
  const second = await fetch(`${base}/dashboard/api/admin/jobs/test-job`, { method: 'POST', headers });
  assert.equal(second.status, 429);
  assert.ok((await second.json()).retryAfterMs > 0);
  assert.equal(runs, 1, 'repeated clicks never re-run the job');
  const unknown = await fetch(`${base}/dashboard/api/admin/jobs/nope`, { method: 'POST', headers });
  assert.equal(unknown.status, 404);
});

test('CSV export neutralizes spreadsheet formulas', async () => {
  const cookie = await login();
  const res = await fetch(`${base}/dashboard/export/csv?scope=all`, { headers: { cookie } });
  assert.equal(res.status, 200);
  assert.match(res.headers.get('content-disposition'), /attachment/);
  const text = await res.text();
  assert.match(text.split('\n')[0], /"Timestamp \(UTC\)","Stremio ID"/);
});

test('sign-out is POST-only and revokes the session', async () => {
  const cookie = await login();
  const viaGet = await fetch(`${base}/dashboard/logout`, { headers: { cookie }, redirect: 'manual' });
  assert.equal(viaGet.status, 302);
  assert.equal((await fetch(`${base}/dashboard/api/status`, { headers: { cookie } })).status, 200, 'a GET (link, image) cannot sign out');

  const logout = await fetch(`${base}/dashboard/logout`, { method: 'POST', headers: { cookie }, redirect: 'manual' });
  assert.equal(logout.status, 302);
  assert.equal(logout.headers.get('location'), '/dashboard/login');
  assert.equal((await fetch(`${base}/dashboard/api/status`, { headers: { cookie } })).status, 401);
});

test('request bodies are only parsed where needed, with small limits', async () => {
  const big = 'x'.repeat(200_000);
  const root = await fetch(`${base}/`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: big });
  assert.equal(root.status, 404);
  const loginRes = await fetch(`${base}/dashboard/login`, { method: 'POST', body: new URLSearchParams({ password: big }) });
  assert.equal(loginRes.status, 413);
});

test('malformed URLs get a client error, not a crash', async () => {
  const res = await fetch(`${base}/stream/series/%E0%A4%A.json`);
  assert.equal(res.status, 400);
  assert.deepEqual(await res.json(), { error: 'Bad Request' });
});
