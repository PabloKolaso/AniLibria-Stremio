/**
 * Traffic: "how is the addon used and how does it perform?" — outcome,
 * latency, users, resources, installed versions and resolver methods over a range.
 */

const traffic = require('../../telemetry/traffic');
const users   = require('../../telemetry/users');
const installs = require('../../install-version');
const { version } = require('../../../package.json');
const { meta } = require('./meta');
const { oneOf } = require('./params');

/** Unique users per chart point and for the whole period (and the one before). */
function usersFor(range) {
  const counts = users.counts();
  switch (range) {
    case '24h': return { granularity: 'hour', points: users.hourlyCounts(24), current: counts.day, previous: counts.dayPrev, window: 'last 24 hours' };
    case '7d':  return { granularity: 'day', points: users.dailyCounts(7), current: counts.week, previous: counts.weekPrev, window: 'last 7 UTC days' };
    case '30d': return { granularity: 'day', points: users.dailyCounts(30), current: counts.month, previous: counts.monthPrev, window: 'last 30 UTC days' };
    default:    return { granularity: 'day', points: users.dailyCounts(90), current: counts.quarter, previous: null, window: 'last 90 UTC days' };
  }
}

/** Requests per installed manifest version; outdated installs see the reinstall notice. */
function installsFor(series) {
  const prev = series.previous?.versions || {};
  const rows = Object.entries(series.current.versions || {})
    .map(([v, requests]) => ({ version: v, requests, previous: prev[v] ?? null, outdated: installs.needsReinstall(v) }))
    .sort((a, b) => b.requests - a.requests);
  return { current: version, minSupported: installs.MIN_SUPPORTED_MANIFEST_VERSION, legacy: installs.LEGACY, rows };
}

function register(router) {
  router.get('/traffic', (req, res) => {
    const range = oneOf(req.query.range, Object.keys(traffic.RANGES), '24h');
    const series = traffic.series(range);
    res.json({
      meta: meta(),
      range,
      series,
      users: usersFor(range),
      installs: installsFor(series),
      since: traffic.since(),
    });
  });
}

module.exports = { register };
