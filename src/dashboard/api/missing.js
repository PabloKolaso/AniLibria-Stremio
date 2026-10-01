/**
 * Missing titles: "what cannot be resolved right now, and why?" — the
 * categorized list, ignore / not-dubbed / dismiss actions and the
 * overrides export/import.
 */

const express   = require('express');
const missing   = require('../../telemetry/missing');
const overrides = require('../../overrides');
const anilibria = require('../../api/anilibria');
const catalogIndex = require('../../mapping/anilibria-catalog');
const { meta }  = require('./meta');
const { str, int, oneOf } = require('./params');

const IMDB_RE = /^tt\d{7,10}$/;
const smallJson = express.json({ limit: '10kb' });

function validId(req, res) {
  if (IMDB_RE.test(req.params.imdbId)) return true;
  res.status(400).json({ error: 'invalid imdbId' });
  return false;
}

function register(router) {
  router.get('/missing', (req, res) => {
    const result = missing.list({
      category: oneOf(req.query.category, missing.CATEGORIES, 'not_on_anilibria'),
      q: str(req.query.q, 100),
      page: int(req.query.page, 1, { min: 1, max: 100_000 }),
      pageSize: int(req.query.pageSize, 50, { min: 10, max: 200 }),
    });
    const index = catalogIndex.peek();
    const withLinks = row => {
      const releaseId = row.available?.releaseId || row.releaseId;
      return {
        ...row,
        releaseUrl: releaseId ? anilibria.releaseUrl(index?.byId.get(releaseId)?.alias) : null,
        searchUrl: row.title ? anilibria.searchUrl(row.title) : null,
      };
    };
    res.json({
      meta: meta(),
      ...result,
      rows: result.rows.map(withLinks),
      enrichment: missing.enrichmentState(),
      overrides: overrides.counts(),
    });
  });

  router.post('/missing/:imdbId/ignore', smallJson, (req, res) => {
    if (!validId(req, res)) return;
    overrides.ignore(req.params.imdbId, str(req.body?.reason, 500));
    res.json({ ok: true });
  });

  router.delete('/missing/:imdbId/ignore', (req, res) => {
    if (!validId(req, res)) return;
    overrides.unignore(req.params.imdbId);
    res.json({ ok: true });
  });

  router.post('/missing/:imdbId/not-dubbed', (req, res) => {
    if (!validId(req, res)) return;
    overrides.markNotDubbed(req.params.imdbId);
    res.json({ ok: true });
  });

  router.delete('/missing/:imdbId/not-dubbed', (req, res) => {
    if (!validId(req, res)) return;
    overrides.unmarkNotDubbed(req.params.imdbId);
    res.json({ ok: true });
  });

  router.post('/missing/dismiss', smallJson, (req, res) => {
    const key = str(req.body?.key, 60);
    if (!missing.dismiss(key)) return res.status(404).json({ error: 'not found' });
    res.json({ ok: true });
  });

  router.get('/overrides/export', (req, res) => {
    res.setHeader('Content-Type', 'application/json; charset=utf-8');
    res.setHeader('Content-Disposition', 'attachment; filename="overrides.json"');
    res.send(JSON.stringify(overrides.exportAll(), null, 2));
  });

  router.post('/overrides/import', express.json({ limit: '10mb' }), (req, res) => {
    if (!req.body || typeof req.body !== 'object' || Array.isArray(req.body)) {
      return res.status(400).json({ error: 'Invalid JSON file' });
    }
    const dryRun = req.query.dryRun === '1';
    res.json({ ok: true, dryRun, result: overrides.importAll(req.body, { dryRun }) });
  });
}

module.exports = { register };
