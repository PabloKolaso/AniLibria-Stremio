/**
 * Admin alerts via ntfy (optional: NTFY_TOPIC + NTFY_ALERTS=true).
 *
 * Conditions are evaluated every minute and must persist before an alert
 * is sent, so single transient failures never notify:
 *   provider-down   AniLibria / AniList / Cinemeta "down" for 10 minutes
 *   catalog-stale   Releasing data older than 30 min, Trending older than 60 min
 *   error-rate      ≥ 20% of anime stream requests failed in the last
 *                   15 minutes (at least 20 requests), on two checks in a row
 *   mapping-stale   the Fribb mapping is older than 48 hours
 *   restart         the previous run ended without a clean shutdown
 *   crash           an uncaught exception / unhandled rejection
 *
 * Each condition notifies once when it starts, reminds every 6 hours while
 * it lasts, and sends one "resolved" message when it clears. At most 12
 * alerts are sent per hour. Without ntfy configured nothing is sent, but
 * the evaluation still runs so the dashboard can show what would alert.
 */

const config    = require('../config');
const ntfy      = require('./ntfy');
const health    = require('./health');
const lifecycle = require('./lifecycle');
const releasing = require('../catalogs/releasing');
const trending  = require('../catalogs/trending');
const mapping   = require('../mapping/cache');
const traffic   = require('../telemetry/traffic');

const CHECK_INTERVAL_MS = 60_000;
const SUSTAIN_MS = 10 * 60_000;
const REMIND_MS = 6 * 60 * 60_000;
const MAX_PER_HOUR = 12;
const CRASH_COOLDOWN_MS = 30 * 60_000;
const MAX_HISTORY = 50;

const conditions = new Map(); // key -> { since, notifiedAt, message, confirmations }
const history = [];           // newest first: { at, key, title, message, delivered, kind }
const sentTimes = [];
let timer = null;
let lastCrashAlertAt = 0;

function enabled() {
  return Boolean(config.ntfyTopic && config.ntfyAlerts);
}

async function notify({ key, title, message, priority = 4, tags = ['warning'], kind = 'alert' }) {
  const now = Date.now();
  while (sentTimes.length > 0 && now - sentTimes[0] > 60 * 60_000) sentTimes.shift();
  const entry = { at: now, key, title, message, kind, delivered: false, suppressed: null };
  if (!enabled()) entry.suppressed = 'alerts disabled';
  else if (sentTimes.length >= MAX_PER_HOUR) entry.suppressed = 'hourly limit reached';
  else {
    sentTimes.push(now);
    entry.delivered = await ntfy.send({ title, message, priority, tags });
  }
  history.unshift(entry);
  if (history.length > MAX_HISTORY) history.length = MAX_HISTORY;
}

/** Current alert conditions: key -> { title, message, sustainMs } */
function activeConditions(now) {
  const active = new Map();
  const report = health.evaluate(now);
  for (const c of report.components) {
    if (c.group === 'providers' && c.status === 'down' && ['AniLibria', 'AniList', 'Cinemeta'].includes(c.provider)) {
      active.set(`provider-down:${c.provider}`, { title: `${c.name} is down`, message: c.summary, sustainMs: SUSTAIN_MS });
    }
  }
  const rel = releasing.info();
  if (rel.updatedAt && now - rel.updatedAt > 30 * 60_000) {
    active.set('catalog-stale:releasing', { title: 'Releasing catalog is stale', message: `Last successful refresh ${Math.round((now - rel.updatedAt) / 60_000)} minutes ago. ${rel.lastError || ''}`.trim(), sustainMs: 0 });
  }
  const tr = trending.info();
  if (tr.updatedAt && now - tr.updatedAt > 60 * 60_000) {
    active.set('catalog-stale:trending', { title: 'Trending catalog is stale', message: `Last successful refresh ${Math.round((now - tr.updatedAt) / 60_000)} minutes ago. ${tr.lastError || ''}`.trim(), sustainMs: 0 });
  }
  const recent = traffic.recentStats(15, now);
  if (recent.requests >= 20 && recent.errorRate >= 0.2) {
    active.set('error-rate', {
      title: 'Stream error rate spike',
      message: `${Math.round(recent.errorRate * 100)}% of ${recent.requests} anime stream requests failed in the last 15 minutes.`,
      sustainMs: CHECK_INTERVAL_MS - 1000, // seen on two consecutive checks
    });
  }
  const map = mapping.getInfo();
  if (map.ready && map.fetchedAt && now - map.fetchedAt > 48 * 60 * 60_000) {
    active.set('mapping-stale', {
      title: 'ID mapping is not refreshing',
      message: `Fribb mapping is ${Math.round((now - map.fetchedAt) / 3_600_000)} hours old.${map.lastError ? ` Last error: ${map.lastError.message}` : ''}`,
      sustainMs: 0,
    });
  }
  return active;
}

/** One evaluation pass (exported for tests). */
async function check(now = Date.now()) {
  const active = activeConditions(now);
  for (const [key, cond] of active) {
    let state = conditions.get(key);
    if (!state) conditions.set(key, (state = { since: now, notifiedAt: null }));
    state.message = cond.message;
    state.title = cond.title;
    const due = now - state.since >= cond.sustainMs;
    if (due && (!state.notifiedAt || now - state.notifiedAt >= REMIND_MS)) {
      const reminder = Boolean(state.notifiedAt);
      state.notifiedAt = now;
      await notify({ key, title: reminder ? `Still: ${cond.title}` : cond.title, message: cond.message });
    }
  }
  for (const [key, state] of conditions) {
    if (active.has(key)) continue;
    conditions.delete(key);
    if (state.notifiedAt) {
      await notify({ key, title: `Resolved: ${state.title}`, message: `Cleared after ${Math.round((now - state.since) / 60_000)} minutes.`, priority: 3, tags: ['white_check_mark'], kind: 'resolved' });
    }
  }
}

function start() {
  if (timer) return;
  timer = setInterval(() => check().catch(err => console.warn('[alerts] Check failed:', err.message)), CHECK_INTERVAL_MS);
  timer.unref();

  const prev = lifecycle.info().previousShutdown;
  if (prev && !prev.clean) {
    const lastSeen = prev.lastAliveAt ? new Date(prev.lastAliveAt).toISOString() : 'unknown';
    notify({
      key: 'restart',
      title: 'Addon restarted after an abnormal shutdown',
      message: `The previous run (started ${new Date(prev.startedAt).toISOString()}) ended without a clean shutdown; last heartbeat ${lastSeen}.`,
      tags: ['rotating_light'],
    });
  }
  lifecycle.onFatal(fatal => {
    const now = Date.now();
    if (now - lastCrashAlertAt < CRASH_COOLDOWN_MS) return;
    lastCrashAlertAt = now;
    notify({ key: 'crash', title: `Uncaught error (${fatal.kind})`, message: fatal.message, priority: 5, tags: ['rotating_light'] });
  });
}

function stop() {
  clearInterval(timer);
  timer = null;
}

/** Alert configuration, active conditions and recent history. */
function info() {
  return {
    enabled: enabled(),
    ntfyConfigured: Boolean(config.ntfyTopic),
    rules: {
      providerDownMinutes: SUSTAIN_MS / 60_000,
      releasingStaleMinutes: 30,
      trendingStaleMinutes: 60,
      errorRate: { threshold: 0.2, windowMinutes: 15, minRequests: 20 },
      mappingStaleHours: 48,
      remindHours: REMIND_MS / 3_600_000,
      maxPerHour: MAX_PER_HOUR,
    },
    active: [...conditions].map(([key, s]) => ({ key, title: s.title, message: s.message, since: s.since, notifiedAt: s.notifiedAt })),
    history: history.slice(),
  };
}

module.exports = { start, stop, check, info };
