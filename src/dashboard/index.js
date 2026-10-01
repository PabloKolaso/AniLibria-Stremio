/**
 * Admin dashboard: login/logout, the single-page app shell, its static
 * assets, the CSV export and the JSON API (/dashboard/api, see api/).
 *
 * The browser app lives in public/ (plain ES modules, no build step) and
 * renders everything from the JSON API, so there is one renderer per view.
 * Every dashboard response carries a strict Content-Security-Policy: no
 * inline scripts or styles; scripts only from this origin and the pinned
 * Chart.js build (with Subresource Integrity).
 */

const path    = require('path');
const express = require('express');
const auth    = require('../auth');
const pages   = require('./pages');
const api     = require('./api');
const { exportCsv } = require('./api/logs');

const router = express.Router();
const PUBLIC_DIR = path.join(__dirname, 'public');

// Body parsers are attached only to the routes that need them, with small limits
const parseLoginForm = express.urlencoded({ extended: false, limit: '10kb' });

const CSP = [
  "default-src 'self'",
  "script-src 'self' https://cdn.jsdelivr.net",
  "style-src 'self'",
  "img-src 'self' https: data:",
  "connect-src 'self'",
  "font-src 'self'",
  "object-src 'none'",
  "base-uri 'none'",
  "form-action 'self'",
  "frame-ancestors 'none'",
].join('; ');

router.use('/dashboard', (req, res, next) => {
  res.setHeader('Content-Security-Policy', CSP);
  next();
});

// Static app assets (no secrets; revalidated on every load so deploys apply at once)
router.use('/dashboard/assets', express.static(PUBLIC_DIR, {
  index: false,
  fallthrough: false,
  setHeaders: res => res.setHeader('Cache-Control', 'no-cache'),
}));

// ─── Auth routes ──────────────────────────────────────────────────────────────

router.get('/dashboard/login', (req, res) => {
  res.setHeader('Content-Type', 'text/html; charset=utf-8');
  res.send(pages.renderLogin(null, auth.sanitizeNext(req.query.next)));
});

router.post('/dashboard/login', parseLoginForm, async (req, res) => {
  const ip = req.ip || 'unknown';
  const next = auth.sanitizeNext((req.body && req.body.next) || req.query.next);

  const limit = auth.checkLoginAllowed(ip);
  if (!limit.allowed) {
    res.setHeader('Retry-After', String(limit.retryAfterSec));
    res.setHeader('Content-Type', 'text/html; charset=utf-8');
    return res.status(429).send(pages.renderLogin('Too many attempts. Try again later.', next));
  }

  const password = (req.body && req.body.password) || '';
  if (await auth.validatePassword(password)) {
    auth.recordLoginSuccess(ip);
    // Secure only makes the cookie stricter, so honouring the proxy header directly is safe
    const secure = req.secure || String(req.headers['x-forwarded-proto'] || '').startsWith('https');
    auth.createSession(res, secure, { userAgent: req.get('user-agent') });
    return res.redirect(next);
  }
  auth.recordLoginFailure(ip);
  console.warn(`[dashboard] Failed login attempt from ${ip}`);
  res.setHeader('Content-Type', 'text/html; charset=utf-8');
  res.status(401).send(pages.renderLogin('Incorrect password', next));
});

// Sign-out changes state, so it is POST-only (a link or image cannot sign the admin out)
router.post('/dashboard/logout', (req, res) => {
  auth.destroySession(req, res);
  res.redirect('/dashboard/login');
});

router.get('/dashboard/logout', (req, res) => {
  res.redirect('/dashboard');
});

// ─── App shell, exports, API ──────────────────────────────────────────────────

router.get('/dashboard', auth.requireAuth, (req, res) => {
  res.setHeader('Content-Type', 'text/html; charset=utf-8');
  res.setHeader('Cache-Control', 'no-store');
  res.send(pages.renderShell());
});

router.get('/dashboard/export/csv', auth.requireAuth, exportCsv);

router.use('/dashboard/api', api);

module.exports = router;
