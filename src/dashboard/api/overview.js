/**
 * Overview: "is everything working?" — health, 24 h KPIs, recent problems
 * and the most watched anime.
 */

const health       = require('../../monitoring/health');
const problems     = require('../../monitoring/problems');
const traffic      = require('../../telemetry/traffic');
const users        = require('../../telemetry/users');
const titles       = require('../../telemetry/titles');
const catalogIndex = require('../../mapping/anilibria-catalog');
const anilibria    = require('../../api/anilibria');
const { meta }     = require('./meta');
const { int, str } = require('./params');

const DAY_MS = 24 * 60 * 60 * 1000;

/** Top titles with AniLibria links (alias from the local index). */
function topTitles(days) {
  const index = catalogIndex.peek();
  return titles.top({ days, limit: 10 }).map(row => {
    const alias = index?.byId.get(row.releaseId)?.alias || null;
    return { ...row, url: anilibria.releaseUrl(alias) };
  });
}

function register(router) {
  router.get('/status', (req, res) => {
    res.json({ meta: meta() });
  });

  router.get('/overview', (req, res) => {
    const topDays = int(req.query.top, 7, { min: 1, max: titles.KEEP_DAYS }) === 30 ? 30 : 7;
    const kpis = traffic.kpis();
    res.json({
      meta: meta(),
      health: health.current(),
      kpis: { ...kpis, users: users.counts() },
      since: traffic.since(),
      problems: problems.list({ sinceMs: DAY_MS, limit: 10 }),
      problemsOlder: problems.list({ limit: 200 }).filter(p => Date.now() - p.lastAt >= DAY_MS).length,
      top: { days: topDays, rows: topTitles(topDays) },
    });
  });

  router.get('/problems', (req, res) => {
    res.json({ meta: meta(), problems: problems.list({ limit: 200 }) });
  });

  router.post('/problems/dismiss', require('express').json({ limit: '10kb' }), (req, res) => {
    const key = str(req.body?.key, 300);
    problems.dismiss(key || undefined);
    res.json({ ok: true });
  });
}

module.exports = { register };
