/**
 * Debug routes (all require a dashboard session).
 *
 * Kept for scripts and bookmarks; the dashboard itself uses /dashboard/api.
 *   GET  /debug                  → the dashboard's server console
 *   GET  /debug/resolve/:imdbId  → re-resolve an ID (JSON), see monitoring/diagnose.js
 *   GET  /debug/logs             → buffered console lines (JSON array of strings)
 *   GET  /debug/export           → manual overrides as a JSON file
 *   POST /debug/import           → merge an overrides file
 */

const consoleCapture = require('./monitoring/console');
const express = require('express');
const { requireAuth, requireAuthApi } = require('./auth');

const router = express.Router();

router.get('/debug', requireAuth, (req, res) => {
  res.redirect('/dashboard?tab=logs&view=console');
});

/**
 * GET /debug/resolve/:imdbId[?type=series&season=1&episode=1]
 * Forces re-resolution (bypasses the resolver memo) and returns the outcome
 * plus the log lines produced while resolving. Does not affect statistics.
 */
router.get('/debug/resolve/:imdbId', requireAuthApi, async (req, res) => {
  const { diagnose, DiagnoseError } = require('./monitoring/diagnose');
  const { imdbId } = req.params;
  if (!/^tt\d{7,10}$/.test(imdbId)) {
    return res.status(400).json({ imdbId, anilibriaId: null, error: 'Invalid IMDB ID format', logs: [] });
  }
  const type = req.query.type === 'movie' ? 'movie' : 'series';
  try {
    const r = await diagnose({
      input: imdbId, type,
      season: type === 'movie' ? undefined : (typeof req.query.season === 'string' ? req.query.season : 1),
      episode: type === 'movie' ? undefined : (typeof req.query.episode === 'string' ? req.query.episode : 1),
    });
    res.json({
      imdbId, type: r.parsed.type, season: r.parsed.season, episode: r.parsed.episode,
      anilibriaId: r.release?.id ?? null,
      outcome: r.outcome,
      reason: r.reason,
      title: r.title,
      method: r.method,
      streamCount: r.streams.length,
      error: r.error,
      logs: r.logs,
    });
  } catch (err) {
    if (err instanceof DiagnoseError) return res.status(err.status).json({ imdbId, error: err.message, logs: [] });
    throw err;
  }
});

router.get('/debug/logs', requireAuthApi, (req, res) => {
  res.json(consoleCapture.getLines({ limit: 300 }).map(consoleCapture.formatLine));
});

router.get('/debug/export', requireAuth, (req, res) => {
  const overrides = require('./overrides');
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  res.setHeader('Content-Disposition', 'attachment; filename="overrides.json"');
  res.send(JSON.stringify(overrides.exportAll(), null, 2));
});

router.post('/debug/import', requireAuthApi, express.json({ limit: '10mb' }), (req, res) => {
  const overrides = require('./overrides');
  if (!req.body || typeof req.body !== 'object' || Array.isArray(req.body)) {
    return res.status(400).json({ ok: false, error: 'Invalid JSON body' });
  }
  const counts = overrides.importAll(req.body);
  res.json({ ok: true, imported: counts });
});

module.exports = { router };
