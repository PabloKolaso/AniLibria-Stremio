const test = require('node:test');
const assert = require('node:assert/strict');
const nodeHttp = require('http');
const { request, getJson, postJson, HttpError, describeError, USER_AGENT } = require('../src/api/http');

let server;
let base;
let hits = {};

test.before(async () => {
  server = nodeHttp.createServer((req, res) => {
    hits[req.url] = (hits[req.url] || 0) + 1;
    if (req.url === '/ok') {
      res.setHeader('Content-Type', 'application/json');
      return res.end(JSON.stringify({ ua: req.headers['user-agent'] }));
    }
    if (req.url === '/echo') {
      let body = '';
      req.on('data', c => (body += c));
      return req.on('end', () => res.end(body));
    }
    if (req.url === '/missing') { res.statusCode = 404; return res.end('<html>nope</html>'); }
    if (req.url === '/flaky') {
      if (hits[req.url] < 3) { res.statusCode = 503; return res.end(); }
      return res.end('{"ok":true}');
    }
    if (req.url === '/limited') { res.statusCode = 429; res.setHeader('Retry-After', '7'); return res.end(); }
    if (req.url === '/slow') return setTimeout(() => res.end('{}'), 500);
    if (req.url === '/html') return res.end('<!DOCTYPE html>');
    res.statusCode = 500;
    res.end();
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  base = `http://127.0.0.1:${server.address().port}`;
});

test.after(() => server.close());
test.beforeEach(() => { hits = {}; });

test('parses JSON and sends the addon User-Agent', async () => {
  assert.deepEqual(await getJson(`${base}/ok`), { ua: USER_AGENT });
  assert.deepEqual(await postJson(`${base}/echo`, { a: 1 }), { a: 1 });
});

test('non-2xx responses throw HttpError with the status', async () => {
  const err = await getJson(`${base}/missing`, { service: 'Test' }).catch(e => e);
  assert.ok(err instanceof HttpError);
  assert.equal(err.status, 404);
  assert.equal(err.code, 'HTTP');
  assert.match(err.message, /^Test GET \/missing failed: HTTP 404$/);
  assert.equal(hits['/missing'], 1); // 4xx is never retried

  const limited = await getJson(`${base}/limited`, { retries: 3 }).catch(e => e);
  assert.equal(limited.status, 429);
  assert.equal(limited.retryAfter, '7');
  assert.equal(hits['/limited'], 1);
});

test('retries transient 5xx responses with backoff', async () => {
  assert.deepEqual(await getJson(`${base}/flaky`, { retries: 2, retryDelayMs: 5 }), { ok: true });
  assert.equal(hits['/flaky'], 3);
  hits = {};
  await assert.rejects(getJson(`${base}/flaky`, { retries: 1, retryDelayMs: 5 }), { status: 503 });
});

test('times out slow responses', async () => {
  const err = await getJson(`${base}/slow`, { timeout: 50 }).catch(e => e);
  assert.equal(err.code, 'TIMEOUT');
  assert.equal(describeError(err), 'upstream timeout');
});

test('invalid JSON and network failures are typed', async () => {
  assert.equal((await getJson(`${base}/html`).catch(e => e)).code, 'PARSE');
  assert.equal(await request(`${base}/html`, { responseType: 'text' }), '<!DOCTYPE html>');
  const net = await getJson('http://127.0.0.1:1/', { timeout: 2000 }).catch(e => e);
  assert.equal(net.code, 'NETWORK');
  assert.equal(describeError(net), 'network error');
  assert.equal(describeError(new Error('secret detail')), 'internal error');
});
