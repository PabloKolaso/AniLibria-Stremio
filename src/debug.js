/**
 * Debug module — live log capture and diagnostic HTTP routes.
 *
 * Must be required FIRST in index.js so console is patched before
 * any other module logs anything.
 */

const express = require('express');
const { Router } = express;
const resolver = require('./bridge/resolver');
const stats = require('./stats');

// ─── Log capture ─────────────────────────────────────────────────────────────

const MAX_LOGS = 300;
const logBuffer = [];

function capture(level, original) {
  return function (...args) {
    const line = `[${new Date().toISOString()}] [${level}] ${args.map(a =>
      typeof a === 'object' ? JSON.stringify(a) : String(a)
    ).join(' ')}`;
    logBuffer.push(line);
    if (logBuffer.length > MAX_LOGS) logBuffer.shift();
    original.apply(console, args);
  };
}

console.log   = capture('LOG',   console.log);
console.warn  = capture('WARN',  console.warn);
console.error = capture('ERROR', console.error);

function getLogs() {
  return logBuffer.slice();
}

// ─── HTML helpers ─────────────────────────────────────────────────────────────

function colorLine(line) {
  if (line.includes('[ERROR]')) return `<span style="color:#ff5555">${esc(line)}</span>`;
  if (line.includes('[WARN]'))  return `<span style="color:#ffaa00">${esc(line)}</span>`;
  return esc(line);
}

function esc(str) {
  return str.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

// ─── Routes ───────────────────────────────────────────────────────────────────

const router = Router();

/**
 * GET /debug
 * Redirects to the dashboard logs tab.
 */
router.get('/debug', (req, res) => {
  res.redirect('/dashboard?tab=logs');
});

/**
 * GET /debug/resolve/:imdbId
 * Forces re-resolution of an IMDB ID (bypasses cache) and returns JSON
 * with the resolved Anilibria ID + recent log lines.
 */
router.get('/debug/resolve/:imdbId', async (req, res) => {
  const { imdbId } = req.params;

  if (!/^tt\d{7,10}$/.test(imdbId)) {
    return res.json({ imdbId, anilibriaId: null, error: 'Invalid IMDB ID format', logs: [] });
  }

  const logsBefore = logBuffer.length;

  let anilibriaId = null;
  let error = null;

  try {
    // Force re-resolution by clearing the cache entry
    resolver.clearCache(imdbId);
    anilibriaId = await resolver.resolveImdbToAnilibria(imdbId);
  } catch (err) {
    error = err.message;
  }

  // Grab only the log lines produced during this resolution
  const newLogs = logBuffer.slice(logsBefore);

  res.json({ imdbId, anilibriaId, error, logs: newLogs });
});

/**
 * GET /debug/logs
 * Raw JSON array of all buffered log lines.
 */
router.get('/debug/logs', (req, res) => {
  res.json(getLogs());
});

/**
 * GET /debug/export
 * Downloads all manual overrides (ignored + not-dubbed) as a JSON file.
 */
router.get('/debug/export', (req, res) => {
  const overrides = stats.getOverrides();
  res.setHeader('Content-Type', 'application/json');
  res.setHeader('Content-Disposition', 'attachment; filename="overrides.json"');
  res.send(JSON.stringify(overrides, null, 2));
});

/**
 * POST /debug/import
 * Accepts a JSON body with ignoredLookups and/or notDubbedLookups and merges them.
 */
router.post('/debug/import', express.json({ limit: '50mb' }), (req, res) => {
  if (!req.body || typeof req.body !== 'object') {
    return res.status(400).json({ ok: false, error: 'Invalid JSON body' });
  }
  const counts = stats.importOverrides(req.body);
  res.json({ ok: true, imported: counts });
});

module.exports = { router, getLogs };
