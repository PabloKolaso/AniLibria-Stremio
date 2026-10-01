/**
 * Dashboard Authentication
 *
 * - Password is persisted as a scrypt hash in data/auth.json (never plaintext)
 * - On first run: generates a random password, sends it via ntfy.sh push
 *   notification (if NTFY_TOPIC env var is set), and writes it to
 *   data/dashboard-password.txt as a backup (readable by the owner only)
 * - Subsequent restarts: loads hash from data/auth.json silently
 * - Cloud/Render: set DASHBOARD_PASSWORD env var — hashed in memory, no file
 * - Password value is NEVER printed to the terminal
 *
 * Sessions are random tokens that expire after 7 days and are revoked on
 * logout. Only SHA-256 hashes of the tokens are kept — in memory and in
 * data/sessions.json, so a normal restart does not sign the admin out. The
 * session file is bound to a fingerprint of the current password: changing
 * the password invalidates every persisted session. Failed logins are
 * rate-limited per client IP and globally.
 */

const crypto    = require('crypto');
const fs        = require('fs');
const path      = require('path');
const { promisify } = require('util');
const config    = require('./config');
const JsonStore = require('./util/json-store');

const scrypt = promisify(crypto.scrypt);

const AUTH_FILE     = path.join(config.dataDir, 'auth.json');
const AUTH_TMP      = path.join(config.dataDir, 'auth.tmp.json');
const PASS_FILE     = path.join(config.dataDir, 'dashboard-password.txt');
const SESSIONS_FILE = path.join(config.dataDir, 'sessions.json');
const KEY_LENGTH = 64;

// ─── Password initialisation ──────────────────────────────────────────────────

let _verifyHash = '';
let _verifySalt = '';
let _passwordFileCreated = false;

function sendPasswordNotification(plaintext) {
  // Loaded lazily: the notifier pulls in the HTTP client
  const ntfy = require('./monitoring/ntfy');
  ntfy.send({
    title: 'AniLibria Dashboard Password',
    message: [
      `Password: ${plaintext}`,
      '',
      'Delete data/dashboard-password.txt after noting this.',
      'To reset: delete data/auth.json and restart.',
    ].join('\n'),
    priority: 4,
    tags: ['key'],
  }); // the backup file is the fallback when this fails
}

function initAuth() {
  // ── Env var path: hash in memory, never persisted ─────────────────────────
  if (config.dashboardPassword) {
    _verifySalt = crypto.randomBytes(32).toString('hex');
    _verifyHash = crypto.scryptSync(config.dashboardPassword, _verifySalt, KEY_LENGTH).toString('hex');
    return;
  }

  // ── Persisted path: load existing hash ───────────────────────────────────
  try {
    const stored = JSON.parse(fs.readFileSync(AUTH_FILE, 'utf8'));
    if (typeof stored.hash === 'string' && typeof stored.salt === 'string' && stored.hash && stored.salt) {
      _verifyHash = stored.hash;
      _verifySalt = stored.salt;
      return;
    }
  } catch (err) {
    if (err.code !== 'ENOENT') console.warn(`[auth] Could not read auth.json (${err.message}); generating a new password.`);
  }

  // ── First run: generate, hash, persist, notify ───────────────────────────
  const plaintext = crypto.randomBytes(24).toString('base64url'); // 32 chars, 192-bit entropy
  _verifySalt = crypto.randomBytes(32).toString('hex');
  _verifyHash = crypto.scryptSync(plaintext, _verifySalt, KEY_LENGTH).toString('hex');

  // Atomic write — hash only, never plaintext
  fs.mkdirSync(config.dataDir, { recursive: true });
  fs.writeFileSync(AUTH_TMP, JSON.stringify({ hash: _verifyHash, salt: _verifySalt }), { encoding: 'utf8', mode: 0o600 });
  fs.renameSync(AUTH_TMP, AUTH_FILE);

  // Backup file — silent (not printed to terminal)
  fs.writeFileSync(PASS_FILE, [
    'AniLibria Dashboard Password',
    '=============================',
    '',
    `Password: ${plaintext}`,
    '',
    'Delete this file after noting the password.',
    'To reset: delete data/auth.json and restart.',
    'For cloud deploys: set DASHBOARD_PASSWORD env var instead.',
    '',
  ].join('\n'), { encoding: 'utf8', mode: 0o600 });

  if (config.ntfyTopic) sendPasswordNotification(plaintext);

  _passwordFileCreated = true;
}

initAuth();

// ─── Password validation ──────────────────────────────────────────────────────

/** Constant-time password check (async scrypt, does not block the event loop). */
async function validatePassword(input) {
  if (!input || typeof input !== 'string' || input.length > 1024) return false;
  try {
    const candidate = await scrypt(input, _verifySalt, KEY_LENGTH);
    const expected = Buffer.from(_verifyHash, 'hex');
    return candidate.length === expected.length && crypto.timingSafeEqual(candidate, expected);
  } catch {
    return false;
  }
}

function isFirstRun() {
  return _passwordFileCreated;
}

/** Where the password comes from ('env' or 'file'), and security notes (never the password). */
function passwordInfo() {
  return {
    source: config.dashboardPassword ? 'env' : 'file',
    passwordFileExists: fs.existsSync(PASS_FILE),
    shortPassword: Boolean(config.dashboardPassword) && config.dashboardPassword.length < 12,
  };
}

// ─── Login rate limiting ──────────────────────────────────────────────────────

const LOGIN_WINDOW_MS       = 15 * 60 * 1000;
const MAX_FAILURES_PER_IP   = 10;
const MAX_FAILURES_GLOBAL   = 100;
const failuresByIp = new Map(); // ip -> { count, resetAt }
const globalFailures = { count: 0, resetAt: 0 };

function currentWindow(record, now) {
  if (now >= record.resetAt) {
    record.count = 0;
    record.resetAt = now + LOGIN_WINDOW_MS;
  }
  return record;
}

/**
 * Check whether a login attempt from this IP may proceed.
 * @returns {{ allowed: boolean, retryAfterSec: number }}
 */
function checkLoginAllowed(ip) {
  const now = Date.now();
  const global = currentWindow(globalFailures, now);
  const perIp = failuresByIp.get(ip);
  if (perIp && now < perIp.resetAt && perIp.count >= MAX_FAILURES_PER_IP) {
    return { allowed: false, retryAfterSec: Math.ceil((perIp.resetAt - now) / 1000) };
  }
  if (global.count >= MAX_FAILURES_GLOBAL) {
    return { allowed: false, retryAfterSec: Math.ceil((global.resetAt - now) / 1000) };
  }
  return { allowed: true, retryAfterSec: 0 };
}

function recordLoginFailure(ip) {
  const now = Date.now();
  currentWindow(globalFailures, now).count++;
  const record = currentWindow(failuresByIp.get(ip) || { count: 0, resetAt: 0 }, now);
  record.count++;
  failuresByIp.set(ip, record);
  // Bound memory: drop expired records once the map grows
  if (failuresByIp.size > 10_000) {
    for (const [key, r] of failuresByIp) if (now >= r.resetAt) failuresByIp.delete(key);
  }
}

function recordLoginSuccess(ip) {
  failuresByIp.delete(ip);
}

// ─── Session management ───────────────────────────────────────────────────────

const SESSION_COOKIE = 'dash_session';
const SESSION_TTL_MS = 7 * 24 * 60 * 60 * 1000;
const MAX_SESSIONS   = 50;
const LAST_SEEN_RESOLUTION_MS = 5 * 60 * 1000;

/** sha256(token) -> { createdAt, expiresAt, lastSeenAt, client } */
const sessions = new Map();
let sessionSalt = '';
let fingerprint = '';

const sessionStore = new JsonStore(SESSIONS_FILE, {
  serialize: () => ({ version: 1, salt: sessionSalt, fingerprint, sessions: [...sessions] }),
  debounceMs: 2000,
  label: 'dashboard sessions',
  mode: 0o600,
});

/**
 * A fingerprint of the current password. Persisted sessions are only
 * restored when it still matches, so a password change signs everyone out.
 */
function credentialFingerprint(salt) {
  if (config.dashboardPassword) {
    const key = crypto.scryptSync(config.dashboardPassword, `session-binding:${salt}`, 32);
    return crypto.createHash('sha256').update(key).digest('hex');
  }
  return crypto.createHash('sha256').update(`file:${_verifyHash}`).digest('hex');
}

function initSessions() {
  const saved = JsonStore.read(SESSIONS_FILE);
  sessionSalt = typeof saved?.salt === 'string' && /^[0-9a-f]{32}$/.test(saved.salt)
    ? saved.salt
    : crypto.randomBytes(16).toString('hex');
  fingerprint = credentialFingerprint(sessionSalt);
  if (!saved || saved.fingerprint !== fingerprint || !Array.isArray(saved.sessions)) return;
  const now = Date.now();
  for (const row of saved.sessions) {
    if (!Array.isArray(row) || row.length !== 2) continue;
    const [hash, s] = row;
    if (typeof hash !== 'string' || !/^[0-9a-f]{64}$/.test(hash) || !s || !(s.expiresAt > now)) continue;
    sessions.set(hash, {
      createdAt: Number(s.createdAt) || now,
      expiresAt: s.expiresAt,
      lastSeenAt: Number(s.lastSeenAt) || null,
      client: typeof s.client === 'string' ? s.client.slice(0, 60) : null,
    });
  }
}

initSessions();

function hashToken(token) {
  return crypto.createHash('sha256').update(token).digest('hex');
}

function parseCookies(cookieHeader) {
  const out = {};
  if (typeof cookieHeader !== 'string') return out;
  for (const part of cookieHeader.split(';')) {
    const idx = part.indexOf('=');
    if (idx < 0) continue;
    const key = part.slice(0, idx).trim();
    const raw = part.slice(idx + 1).trim();
    if (!key) continue;
    try {
      out[key] = decodeURIComponent(raw);
    } catch {
      out[key] = raw; // malformed percent-encoding: keep raw value
    }
  }
  return out;
}

function getSessionToken(req) {
  const token = parseCookies(req.headers.cookie)[SESSION_COOKIE];
  return typeof token === 'string' && /^[A-Za-z0-9_-]{43}$/.test(token) ? token : null;
}

/** Coarse client label from the User-Agent ("Chrome · Windows"); no raw UA is stored. */
function clientLabel(userAgent) {
  const ua = String(userAgent || '');
  const browser = /Edg\//.test(ua) ? 'Edge' : /OPR\//.test(ua) ? 'Opera' : /Firefox\//.test(ua) ? 'Firefox'
    : /Chrome\//.test(ua) ? 'Chrome' : /Safari\//.test(ua) ? 'Safari' : null;
  const os = /Android/.test(ua) ? 'Android' : /iPhone|iPad/.test(ua) ? 'iOS' : /Windows/.test(ua) ? 'Windows'
    : /Mac OS X/.test(ua) ? 'macOS' : /Linux/.test(ua) ? 'Linux' : null;
  return [browser, os].filter(Boolean).join(' · ') || null;
}

/** The session record for a request (null when missing or expired). */
function sessionFor(req) {
  const token = getSessionToken(req);
  if (!token) return null;
  const key = hashToken(token);
  const session = sessions.get(key);
  if (!session) return null;
  const now = Date.now();
  if (session.expiresAt <= now) {
    sessions.delete(key);
    sessionStore.schedule();
    return null;
  }
  if (!session.lastSeenAt || now - session.lastSeenAt > LAST_SEEN_RESOLUTION_MS) {
    session.lastSeenAt = now;
    sessionStore.schedule();
  }
  return { key, session };
}

function isValidSession(req) {
  return sessionFor(req) !== null;
}

/**
 * Start a new session and set its cookie.
 * @param {object} res
 * @param {boolean} secure - add the Secure cookie flag
 * @param {{ userAgent?: string }} [meta]
 */
function createSession(res, secure, meta = {}) {
  const now = Date.now();
  for (const [key, s] of sessions) if (s.expiresAt <= now) sessions.delete(key);
  while (sessions.size >= MAX_SESSIONS) sessions.delete(sessions.keys().next().value);

  const token = crypto.randomBytes(32).toString('base64url');
  sessions.set(hashToken(token), { createdAt: now, expiresAt: now + SESSION_TTL_MS, lastSeenAt: now, client: clientLabel(meta.userAgent) });
  sessionStore.schedule();

  const flags = [
    `${SESSION_COOKIE}=${token}`,
    'HttpOnly',
    'SameSite=Strict',
    'Path=/',
    `Max-Age=${Math.floor(SESSION_TTL_MS / 1000)}`,
    secure ? 'Secure' : '',
  ].filter(Boolean).join('; ');
  res.setHeader('Set-Cookie', flags);
}

/** Revoke the current session (if any) and clear its cookie. */
function destroySession(req, res) {
  const token = getSessionToken(req);
  if (token && sessions.delete(hashToken(token))) sessionStore.schedule();
  res.setHeader('Set-Cookie', `${SESSION_COOKIE}=; HttpOnly; SameSite=Strict; Path=/; Max-Age=0`);
}

/**
 * Active sessions for the dashboard. `id` is a short prefix of the token
 * hash — enough to tell sessions apart and revoke one, useless to log in.
 */
function listSessions(req) {
  const current = sessionFor(req)?.key;
  const now = Date.now();
  return [...sessions]
    .filter(([, s]) => s.expiresAt > now)
    .map(([key, s]) => ({ id: key.slice(0, 12), current: key === current, ...s }))
    .sort((a, b) => (b.lastSeenAt || 0) - (a.lastSeenAt || 0));
}

/** Revoke every session except the requester's; returns how many were revoked. */
function revokeOtherSessions(req) {
  const current = sessionFor(req)?.key;
  let revoked = 0;
  for (const key of [...sessions.keys()]) {
    if (key !== current) {
      sessions.delete(key);
      revoked++;
    }
  }
  if (revoked > 0) sessionStore.schedule();
  return revoked;
}

/** Revoke one session by its id prefix (not the requester's own). */
function revokeSession(req, id) {
  if (typeof id !== 'string' || !/^[0-9a-f]{12}$/.test(id)) return false;
  const current = sessionFor(req)?.key;
  for (const key of sessions.keys()) {
    if (key.startsWith(id) && key !== current) {
      sessions.delete(key);
      sessionStore.schedule();
      return true;
    }
  }
  return false;
}

/**
 * Validate a post-login redirect target: only same-origin dashboard paths.
 * @returns {string}
 */
function sanitizeNext(next) {
  if (typeof next !== 'string') return '/dashboard';
  if (!/^\/dashboard(?:[/?#]|$)/.test(next) || /[\\\r\n]/.test(next) || next.startsWith('//')) return '/dashboard';
  return next;
}

// ─── Middleware ───────────────────────────────────────────────────────────────

function requireAuth(req, res, next) {
  if (isValidSession(req)) return next();
  res.redirect(`/dashboard/login?next=${encodeURIComponent(sanitizeNext(req.originalUrl))}`);
}

/** Like requireAuth but returns 401 JSON instead of redirecting (for API endpoints). */
function requireAuthApi(req, res, next) {
  if (isValidSession(req)) return next();
  res.status(401).json({ error: 'unauthorized' });
}

module.exports = {
  validatePassword,
  isFirstRun,
  passwordInfo,
  checkLoginAllowed,
  recordLoginFailure,
  recordLoginSuccess,
  createSession,
  destroySession,
  isValidSession,
  listSessions,
  revokeOtherSessions,
  revokeSession,
  sanitizeNext,
  requireAuth,
  requireAuthApi,
};
