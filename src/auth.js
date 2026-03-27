/**
 * Dashboard Authentication
 *
 * - Password is persisted as a scrypt hash in data/auth.json (never plaintext)
 * - On first run: generates a random password, sends it via ntfy.sh push
 *   notification (if NTFY_TOPIC env var is set), and writes it to
 *   data/dashboard-password.txt as a silent backup
 * - Subsequent restarts: loads hash from data/auth.json silently
 * - Cloud/Render: set DASHBOARD_PASSWORD env var — hashed in memory, no file
 * - Password value is NEVER printed to the terminal
 */

const crypto = require('crypto');
const fs     = require('fs');
const path   = require('path');
const https  = require('https');

const DATA_DIR  = path.resolve(__dirname, '../data');
const AUTH_FILE = path.join(DATA_DIR, 'auth.json');
const AUTH_TMP  = path.join(DATA_DIR, 'auth.tmp.json');
const PASS_FILE = path.join(DATA_DIR, 'dashboard-password.txt');

// ─── Password initialisation ──────────────────────────────────────────────────

let _verifyHash = '';
let _verifySalt = '';
let _passwordFileCreated = false;

function sendNtfy(topic, plaintext) {
  const body = [
    `Password: ${plaintext}`,
    '',
    'Delete data/dashboard-password.txt after noting this.',
    'To reset: delete data/auth.json and restart.',
  ].join('\n');

  const req = https.request({
    hostname: 'ntfy.sh',
    path: `/${encodeURIComponent(topic)}`,
    method: 'POST',
    headers: {
      'Title': 'AniLibria Dashboard Password',
      'Content-Type': 'text/plain',
      'Content-Length': Buffer.byteLength(body),
    },
  });
  req.on('error', () => {}); // silent — backup file is the fallback
  req.write(body);
  req.end();
}

function initAuth() {
  // ── Env var path: hash in memory, never persisted ─────────────────────────
  if (process.env.DASHBOARD_PASSWORD) {
    _verifySalt = crypto.randomBytes(32).toString('hex');
    _verifyHash = crypto.scryptSync(process.env.DASHBOARD_PASSWORD, _verifySalt, 64).toString('hex');
    return;
  }

  // ── Persisted path: load existing hash ───────────────────────────────────
  try {
    const stored = JSON.parse(fs.readFileSync(AUTH_FILE, 'utf8'));
    if (stored.hash && stored.salt) {
      _verifyHash = stored.hash;
      _verifySalt = stored.salt;
      return;
    }
  } catch (_) { /* first run — fall through */ }

  // ── First run: generate, hash, persist, notify ───────────────────────────
  const plaintext = crypto.randomBytes(24).toString('base64url'); // ~32 chars, 144-bit entropy
  _verifySalt = crypto.randomBytes(32).toString('hex');
  _verifyHash = crypto.scryptSync(plaintext, _verifySalt, 64).toString('hex');

  // Atomic write — hash only, never plaintext
  fs.mkdirSync(DATA_DIR, { recursive: true });
  fs.writeFileSync(AUTH_TMP, JSON.stringify({ hash: _verifyHash, salt: _verifySalt }), 'utf8');
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
  ].join('\n'), 'utf8');

  // Push notification to phone (if configured)
  if (process.env.NTFY_TOPIC) {
    sendNtfy(process.env.NTFY_TOPIC, plaintext);
  }

  _passwordFileCreated = true;
}

initAuth();

// ─── Password validation ──────────────────────────────────────────────────────

function validatePassword(input) {
  if (!input || typeof input !== 'string') return false;
  try {
    const candidate = crypto.scryptSync(input, _verifySalt, 64).toString('hex');
    if (candidate.length !== _verifyHash.length) return false;
    return crypto.timingSafeEqual(Buffer.from(candidate), Buffer.from(_verifyHash));
  } catch (_) {
    return false;
  }
}

function isFirstRun() {
  return _passwordFileCreated;
}

// ─── Session management ───────────────────────────────────────────────────────

const SESSION_SECRET = crypto.randomBytes(32).toString('hex'); // in-memory only, never persisted
const SESSION_COOKIE = 'dash_session';

// Expected cookie value: HMAC-SHA256(secret, "authenticated")
const SESSION_TOKEN = crypto
  .createHmac('sha256', SESSION_SECRET)
  .update('authenticated')
  .digest('hex');

function parseCookies(cookieHeader) {
  const out = {};
  for (const part of (cookieHeader || '').split(';')) {
    const idx = part.indexOf('=');
    if (idx < 0) continue;
    const key = part.slice(0, idx).trim();
    const val = part.slice(idx + 1).trim();
    if (key) out[key] = decodeURIComponent(val);
  }
  return out;
}

function isValidSession(req) {
  const provided = parseCookies(req.headers.cookie)[SESSION_COOKIE] || '';
  if (provided.length !== SESSION_TOKEN.length) return false;
  // Timing-safe comparison prevents timing-based attacks
  return crypto.timingSafeEqual(Buffer.from(provided), Buffer.from(SESSION_TOKEN));
}

function setSessionCookie(res, secure) {
  const flags = [
    `${SESSION_COOKIE}=${SESSION_TOKEN}`,
    'HttpOnly',
    'SameSite=Strict',
    'Path=/',
    secure ? 'Secure' : '',
  ].filter(Boolean).join('; ');
  res.setHeader('Set-Cookie', flags);
}

function clearSessionCookie(res) {
  res.setHeader('Set-Cookie', `${SESSION_COOKIE}=; HttpOnly; SameSite=Strict; Path=/; Max-Age=0`);
}

// ─── Middleware ───────────────────────────────────────────────────────────────

function requireAuth(req, res, next) {
  if (isValidSession(req)) return next();
  const dest = encodeURIComponent(req.originalUrl);
  res.redirect(`/dashboard/login?next=${dest}`);
}

/** Like requireAuth but returns 401 JSON instead of redirecting (for API endpoints). */
function requireAuthApi(req, res, next) {
  if (isValidSession(req)) return next();
  res.status(401).json({ error: 'unauthorized' });
}

module.exports = {
  validatePassword,
  isFirstRun,
  requireAuth,
  requireAuthApi,
  setSessionCookie,
  clearSessionCookie,
  isValidSession,
};
