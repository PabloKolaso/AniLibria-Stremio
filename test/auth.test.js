const fs = require('fs');
const os = require('os');
const path = require('path');
process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'anilibria-auth-'));
process.env.DASHBOARD_PASSWORD = 'correct horse battery staple';

const test = require('node:test');
const assert = require('node:assert/strict');
const JsonStore = require('../src/util/json-store');

let auth = require('../src/auth');

function mockRes() {
  const headers = {};
  return { headers, setHeader: (k, v) => { headers[k.toLowerCase()] = v; } };
}

/** Log in and return a request object carrying the session cookie. */
function login(meta) {
  const res = mockRes();
  auth.createSession(res, true, meta);
  return { headers: { cookie: res.headers['set-cookie'].split(';')[0] } };
}

/** Re-load the auth module (and config) as a restart would. */
function restart() {
  for (const id of ['../src/auth', '../src/config']) delete require.cache[require.resolve(id)];
  auth = require('../src/auth');
}

test('validatePassword checks the configured password', async () => {
  assert.equal(await auth.validatePassword('correct horse battery staple'), true);
  assert.equal(await auth.validatePassword('wrong'), false);
  assert.equal(await auth.validatePassword(''), false);
  assert.equal(await auth.validatePassword(['array']), false);
  assert.equal(auth.isFirstRun(), false);
  assert.equal(fs.existsSync(path.join(process.env.DATA_DIR, 'dashboard-password.txt')), false);
  assert.deepEqual(auth.passwordInfo(), { source: 'env', passwordFileExists: false, shortPassword: false });
});

test('sessions are random, expire on logout, and survive malformed cookies', () => {
  const res = mockRes();
  auth.createSession(res, true);
  const cookie = res.headers['set-cookie'];
  assert.match(cookie, /^dash_session=[A-Za-z0-9_-]{43}; HttpOnly; SameSite=Strict; Path=\/; Max-Age=604800; Secure$/);
  const token = cookie.split(';')[0];
  const req = { headers: { cookie: `other=1; ${token}` } };
  assert.equal(auth.isValidSession(req), true);

  const res2 = mockRes();
  auth.createSession(res2, false);
  assert.notEqual(res2.headers['set-cookie'].split(';')[0], token);
  assert.doesNotMatch(res2.headers['set-cookie'], /Secure/);

  auth.destroySession(req, mockRes());
  assert.equal(auth.isValidSession(req), false);
  assert.equal(auth.isValidSession({ headers: { cookie: 'dash_session=%E0%A4%A' } }), false);
  assert.equal(auth.isValidSession({ headers: {} }), false);
});

test('sessions are persisted as hashes only and survive a restart', async () => {
  const req = login({ userAgent: 'Mozilla/5.0 (Windows NT 10.0) AppleWebKit Chrome/120 Safari/537' });
  await JsonStore.flushAll();
  const token = req.headers.cookie.split('=')[1];
  const file = fs.readFileSync(path.join(process.env.DATA_DIR, 'sessions.json'), 'utf8');
  assert.equal(file.includes(token), false, 'the raw token is never written');

  restart();
  assert.equal(auth.isValidSession(req), true);
  const listed = auth.listSessions(req).find(s => s.current);
  assert.equal(listed.client, 'Chrome · Windows');
  assert.match(listed.id, /^[0-9a-f]{12}$/);
});

test('a password change invalidates persisted sessions', async () => {
  const req = login();
  await JsonStore.flushAll();
  process.env.DASHBOARD_PASSWORD = 'a completely different password';
  restart();
  assert.equal(auth.isValidSession(req), false);
  process.env.DASHBOARD_PASSWORD = 'correct horse battery staple';
  restart();
});

test('"sign out other sessions" keeps only the current one', () => {
  const mine = login();
  const other = login();
  const third = login();
  assert.ok(auth.revokeOtherSessions(mine) >= 2);
  assert.equal(auth.isValidSession(mine), true);
  assert.equal(auth.isValidSession(other), false);
  assert.equal(auth.isValidSession(third), false);

  const again = login();
  const id = auth.listSessions(mine).find(s => !s.current).id;
  assert.equal(auth.revokeSession(mine, 'not-an-id'), false);
  assert.equal(auth.revokeSession(mine, id), true);
  assert.equal(auth.isValidSession(again), false);
});

test('login attempts are rate limited per IP', () => {
  const ip = '203.0.113.7';
  for (let i = 0; i < 10; i++) {
    assert.equal(auth.checkLoginAllowed(ip).allowed, true);
    auth.recordLoginFailure(ip);
  }
  const blocked = auth.checkLoginAllowed(ip);
  assert.equal(blocked.allowed, false);
  assert.ok(blocked.retryAfterSec > 0);
  assert.equal(auth.checkLoginAllowed('203.0.113.8').allowed, true);
  auth.recordLoginSuccess(ip);
  assert.equal(auth.checkLoginAllowed(ip).allowed, true);
});

test('sanitizeNext only allows dashboard paths', () => {
  assert.equal(auth.sanitizeNext('/dashboard?tab=logs'), '/dashboard?tab=logs');
  assert.equal(auth.sanitizeNext('/dashboard'), '/dashboard');
  for (const bad of ['//evil.com', 'https://evil.com/dashboard', '/dashboardx', '/dashboard\\@evil', '/dashboard/\r\nx', ['/dashboard'], undefined]) {
    assert.equal(auth.sanitizeNext(bad), '/dashboard', String(bad));
  }
});
