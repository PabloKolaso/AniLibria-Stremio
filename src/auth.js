/**
 * Dashboard Authentication
 *
 * Generates a strong random password and session secret on startup.
 * Uses an HMAC-signed cookie for session management — no extra deps.
 */

const crypto = require('crypto');

// Generated once per process lifetime — fresh on every restart
const DASHBOARD_PASSWORD = crypto.randomBytes(24).toString('base64url'); // ~32 chars, ~144-bit entropy
const SESSION_SECRET      = crypto.randomBytes(32).toString('hex');       // in-memory only, never persisted
const SESSION_COOKIE      = 'dash_session';

// The expected cookie value: HMAC-SHA256(secret, "authenticated")
const SESSION_TOKEN = crypto
  .createHmac('sha256', SESSION_SECRET)
  .update('authenticated')
  .digest('hex');

// ─── Helpers ─────────────────────────────────────────────────────────────────

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
  DASHBOARD_PASSWORD,
  requireAuth,
  requireAuthApi,
  setSessionCookie,
  clearSessionCookie,
  isValidSession,
};
