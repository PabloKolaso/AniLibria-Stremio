const test = require('node:test');
const assert = require('node:assert/strict');
const express = require('express');
const { createAddonRouter } = require('../src/stremio');

const manifest = { id: 'test.addon', version: '1.0.0', name: 'Test', resources: ['stream'], types: ['series'], catalogs: [] };

let server;
let base;
let calls = [];
let nextResponse = null;

test.before(async () => {
  const app = express();
  app.use(createAddonRouter(manifest, {
    stream: async args => {
      calls.push(args);
      if (nextResponse instanceof Error) throw nextResponse;
      return nextResponse;
    },
  }));
  server = app.listen(0, '127.0.0.1');
  await new Promise(resolve => server.once('listening', resolve));
  base = `http://127.0.0.1:${server.address().port}`;
});

test.after(() => server.close());
test.beforeEach(() => { calls = []; nextResponse = { streams: [] }; });

test('serves the manifest as JSON', async () => {
  const res = await fetch(`${base}/manifest.json`);
  assert.equal(res.status, 200);
  assert.equal(res.headers.get('content-type'), 'application/json; charset=utf-8');
  assert.deepEqual(await res.json(), manifest);
});

test('routes resource requests with decoded IDs and parsed extra', async () => {
  nextResponse = { streams: [{ url: 'u' }], cacheMaxAge: 3600, staleRevalidate: 60 };
  const res = await fetch(`${base}/stream/series/tt0000001%3A1%3A2/skip=10&search=a%26b.json`);
  assert.equal(res.status, 200);
  assert.equal(res.headers.get('cache-control'), 'max-age=3600, stale-while-revalidate=60, public');
  assert.deepEqual((await res.json()).streams, [{ url: 'u' }]);
  assert.equal(calls[0].type, 'series');
  assert.equal(calls[0].id, 'tt0000001:1:2');
  assert.deepEqual({ ...calls[0].extra }, { skip: '10', search: 'a&b' });
});

test('no Cache-Control header without cache hints', async () => {
  const res = await fetch(`${base}/stream/series/tt0000001.json`);
  assert.equal(res.headers.get('cache-control'), null);
});

test('handler failures return 500 without details', async () => {
  nextResponse = new Error('boom with secrets');
  const res = await fetch(`${base}/stream/series/tt0000001.json`);
  assert.equal(res.status, 500);
  assert.deepEqual(await res.json(), { err: 'handler error' });
});

test('undeclared resources fall through to 404', async () => {
  const res = await fetch(`${base}/meta/series/tt0000001.json`);
  assert.equal(res.status, 404);
  assert.equal(calls.length, 0);
});

test('declared resources require a handler', () => {
  assert.throws(() => createAddonRouter(manifest, {}), /No handler defined/);
});
