/**
 * Content: "what anime data is available and updating?" — the two live
 * catalogs with their diagnostics, recent AniLibria updates, index and
 * mapping status, low-confidence matches and the coverage report.
 */

const express      = require('express');
const releasing    = require('../../catalogs/releasing');
const trending     = require('../../catalogs/trending');
const updates      = require('../../catalogs/updates');
const catalogIndex = require('../../mapping/anilibria-catalog');
const mapping      = require('../../mapping/cache');
const coverage     = require('../../mapping/coverage');
const anilibria    = require('../../api/anilibria');
const matches      = require('../../telemetry/matches');
const overrides    = require('../../overrides');
const { meta }     = require('./meta');
const { oneOf, int, str } = require('./params');

/** Release IDs currently listed in the addon's catalogs. */
function listedIds() {
  const ids = new Set();
  for (const r of releasing.diagnostics()?.releases || []) if (r.playable) ids.add(r.id);
  for (const r of trending.diagnostics()?.rows || []) if (r.status === 'listed' && r.releaseId) ids.add(r.releaseId);
  return ids;
}

function withReleaseUrls(rows) {
  const index = catalogIndex.peek();
  return rows.map(r => ({
    ...r,
    releaseUrl: anilibria.releaseUrl(r.releaseAlias || index?.byId.get(r.releaseId)?.alias),
  }));
}

function register(router) {
  router.get('/content', (req, res) => {
    const index = catalogIndex.peek();
    const trendingDiag = trending.diagnostics();
    res.json({
      meta: meta(),
      releasing: { info: releasing.info(), diagnostics: releasing.diagnostics() },
      trending: {
        info: trending.info(),
        diagnostics: trendingDiag && {
          ...trendingDiag,
          rows: trendingDiag.rows.map(r => ({ ...r, releaseUrl: anilibria.releaseUrl(index?.byId.get(r.releaseId)?.alias) })),
        },
      },
      updates: updates.list(100).map(e => ({ ...e, url: anilibria.releaseUrl(index?.byId.get(e.releaseId)?.alias) })),
      index: catalogIndex.getInfo(),
      mapping: mapping.getInfo(),
    });
  });

  router.get('/content/coverage', (req, res) => {
    res.json({ meta: meta(), coverage: coverage.compute({ listedIds: listedIds() }) });
  });

  router.get('/matches', (req, res) => {
    const status = oneOf(req.query.status, ['review', 'approved', 'rejected', 'all'], 'review');
    const result = matches.list({ status });
    res.json({ meta: meta(), status, counts: result.counts, rows: withReleaseUrls(result.rows) });
  });

  router.post('/matches/decision', express.json({ limit: '10kb' }), (req, res) => {
    const key = str(req.body?.key, 20);
    const decision = oneOf(req.body?.decision, ['approve', 'reject', 'clear']);
    const releaseId = int(req.body?.releaseId, null, { min: 1, max: 9_999_999 });
    if (!overrides.ENTRY_KEY_RE.test(key) || !decision) return res.status(400).json({ error: 'invalid decision' });
    const previous = overrides.getMatchDecision(key);
    if (decision === 'clear') {
      overrides.clearMatchDecision(key);
    } else if (!releaseId || !overrides.setMatchDecision(key, { releaseId, decision })) {
      return res.status(400).json({ error: 'invalid release' });
    }
    res.json({ ok: true, previous });
  });
}

module.exports = { register };
