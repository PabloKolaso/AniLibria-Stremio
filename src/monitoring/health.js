/**
 * Service health: one status per component plus an overall banner.
 *
 * Statuses, best to worst: healthy, idle (no recent activity to judge),
 * warning, degraded, down. The overall status is the worst component.
 *
 * Providers (from monitoring/providers.js, recent attempts only):
 *   down      last 3+ attempts failed and no success for 10 minutes
 *   degraded  ≥ 25% of attempts failed in the last 15 minutes (≥ 4 attempts),
 *             or AniList is pausing lookups after a rate limit (HTTP 429)
 *   warning   any failed attempt in the last 15 minutes, or p95 latency of
 *             recent attempts above the provider's threshold
 *   idle      no attempt in the last 60 minutes
 *
 * Data and jobs: AniLibria index age/completeness, Releasing and Trending
 * refresh age, Fribb mapping age, stream error rate of the last hour,
 * process health (event loop, memory, uncaught exceptions), persistence
 * and the keep-alive ping.
 */

const config       = require('../config');
const providers    = require('./providers');
const processStats = require('./process-metrics');
const lifecycle    = require('./lifecycle');
const jobs         = require('./jobs');
const JsonStore    = require('../util/json-store');
const catalogIndex = require('../mapping/anilibria-catalog');
const mapping      = require('../mapping/cache');
const releasing    = require('../catalogs/releasing');
const trending     = require('../catalogs/trending');
const anilist      = require('../api/anilist');
const traffic      = require('../telemetry/traffic');

const RANK = { healthy: 0, idle: 0, warning: 1, degraded: 2, down: 3 };
const MIN = 60_000;
const STARTUP_GRACE_MS = 3 * MIN;

/** Providers shown even before their first call, with their p95 warning threshold (ms). */
const PROVIDERS = [
  { name: 'AniLibria', label: 'AniLibria API', p95Warn: 4000, core: true },
  { name: 'AniList', label: 'AniList', p95Warn: 3000 },
  { name: 'Cinemeta', label: 'Cinemeta', p95Warn: 3000 },
  { name: 'Fribb', label: 'Fribb mapping (GitHub)', p95Warn: 30_000, occasional: true },
  { name: 'Stremio API', label: 'Stremio API', p95Warn: 10_000, occasional: true },
];

function worst(statuses) {
  return statuses.reduce((w, s) => (RANK[s] > RANK[w] ? s : w), 'healthy');
}

function age(ts, now) {
  return ts ? now - ts : null;
}

function fmtAge(ms) {
  if (ms === null) return 'never';
  if (ms < MIN) return `${Math.round(ms / 1000)}s`;
  if (ms < 60 * MIN) return `${Math.round(ms / MIN)}m`;
  if (ms < 48 * 60 * MIN) return `${Math.round(ms / (60 * MIN))}h`;
  return `${Math.round(ms / (24 * 60 * MIN))}d`;
}

function fmtPct(ratio) {
  return `${Math.round(ratio * 100)}%`;
}

// ─── Providers ───────────────────────────────────────────────────────────────

function providerComponent(def, now) {
  const p = providers.get(def.name);
  const base = { id: `provider:${def.name}`, group: 'providers', name: def.label, provider: def.name };
  if (def.name === 'AniList') {
    const limit = anilist.rateLimit();
    if (limit.paused) {
      return { ...base, status: 'degraded', summary: `Rate limited — lookups paused for ${fmtAge(limit.remainingMs)}`, issue: 'AniList rate limited', data: p };
    }
  }
  if (!p || p.calls === 0) {
    return { ...base, status: 'idle', summary: 'No calls since startup', data: p };
  }
  const recent = p.last15m;
  const sinceSuccess = age(p.lastSuccessAt, now);
  const lastCall = age(p.lastCallAt, now);
  const latency = p.latency.p95 !== null ? `p95 ${p.latency.p95} ms` : null;

  if (def.occasional) {
    // Called rarely (daily / at boot): judge by the last call only
    const lastFailed = p.lastFailureAt && (!p.lastSuccessAt || p.lastFailureAt > p.lastSuccessAt);
    return lastFailed
      ? { ...base, status: 'warning', summary: `Last call failed ${fmtAge(age(p.lastFailureAt, now))} ago: ${p.lastError?.kind}`, issue: `${def.label} failing`, data: p }
      : { ...base, status: 'healthy', summary: `Last call OK ${fmtAge(sinceSuccess)} ago`, data: p };
  }

  if (p.consecutiveFailures >= 3 && (sinceSuccess === null || sinceSuccess > 10 * MIN)) {
    return { ...base, status: 'down', summary: `${p.consecutiveFailures} failed attempts in a row · last success ${sinceSuccess === null ? 'never' : `${fmtAge(sinceSuccess)} ago`}`, issue: `${def.label} down`, data: p };
  }
  if (recent.calls >= 4 && recent.failureRate >= 0.25) {
    return { ...base, status: 'degraded', summary: `${fmtPct(recent.failureRate)} of ${recent.calls} calls failed (15m)`, issue: `${def.label} failing ${fmtPct(recent.failureRate)}`, data: p };
  }
  if (recent.failures > 0) {
    return { ...base, status: 'warning', summary: `${recent.failures} of ${recent.calls} calls failed (15m)${latency ? ` · ${latency}` : ''}`, issue: `${def.label} errors`, data: p };
  }
  if (p.latency.p95 !== null && p.latency.p95 > def.p95Warn) {
    return { ...base, status: 'warning', summary: `Slow: ${latency} (last ${p.latency.samples} calls)`, issue: `${def.label} slow`, data: p };
  }
  if (lastCall === null || lastCall > 60 * MIN) {
    return { ...base, status: 'idle', summary: `No calls for ${fmtAge(lastCall)}`, data: p };
  }
  return { ...base, status: 'healthy', summary: `${recent.calls} calls (15m)${latency ? ` · ${latency}` : ''}`, data: p };
}

// ─── Data and jobs ───────────────────────────────────────────────────────────

function indexComponent(now, uptimeMs) {
  const info = catalogIndex.getInfo();
  const base = { id: 'index', group: 'data', name: 'AniLibria index', data: info };
  if (info.size === 0) {
    const status = uptimeMs < STARTUP_GRACE_MS || info.building ? 'warning' : 'down';
    return { ...base, status, summary: info.building ? 'Building…' : `Not built${info.lastError ? `: ${info.lastError.message}` : ''}`, issue: 'AniLibria index not built' };
  }
  const builtAgo = age(info.builtAt, now);
  const summary = `${info.size.toLocaleString('en')} releases · built ${fmtAge(builtAgo)} ago`;
  if (!info.fresh && info.complete) return { ...base, status: 'degraded', summary: `${summary} (stale)`, issue: `AniLibria index ${fmtAge(builtAgo)} old` };
  if (!info.complete) return { ...base, status: 'warning', summary: `${summary} · incomplete`, issue: 'AniLibria index incomplete' };
  if (info.lastError) return { ...base, status: 'warning', summary: `${summary} · last refresh: ${info.lastError.message}`, issue: 'AniLibria index refresh failed' };
  return { ...base, status: 'healthy', summary };
}

function snapshotComponent({ id, name, info, staleMs, downAfterMs }, now, uptimeMs) {
  const base = { id, group: 'data', name, data: info };
  if (info.count === null) {
    if (uptimeMs < downAfterMs) return { ...base, status: 'warning', summary: 'Loading…', issue: `${name} not loaded yet` };
    return { ...base, status: 'down', summary: `Never loaded${info.lastError ? `: ${info.lastError}` : ''}`, issue: `${name} empty` };
  }
  const updatedAgo = age(info.updatedAt, now);
  const summary = `${info.count} titles · updated ${fmtAge(updatedAgo)} ago`;
  if (updatedAgo > staleMs) return { ...base, status: 'degraded', summary: `${summary} (stale)`, issue: `${name} data ${fmtAge(updatedAgo)} old` };
  if (info.lastError) return { ...base, status: 'warning', summary: `${summary} · refresh failing`, issue: `${name} refresh failing` };
  return { ...base, status: 'healthy', summary };
}

function mappingComponent(now, uptimeMs) {
  const info = mapping.getInfo();
  const base = { id: 'mapping', group: 'data', name: 'ID mapping (Fribb)', data: info };
  if (!info.ready) {
    const status = uptimeMs < STARTUP_GRACE_MS || info.loading ? 'warning' : 'down';
    return { ...base, status, summary: info.loading ? 'Downloading…' : `Not loaded${info.lastError ? `: ${info.lastError.message}` : ''}`, issue: 'ID mapping not loaded' };
  }
  const fetchedAgo = age(info.fetchedAt, now);
  const summary = `${info.imdbIds.toLocaleString('en')} IMDB IDs · downloaded ${fmtAge(fetchedAgo)} ago`;
  if (fetchedAgo !== null && fetchedAgo > 48 * 60 * MIN) return { ...base, status: 'degraded', summary, issue: `ID mapping ${fmtAge(fetchedAgo)} old` };
  if (info.lastError || (fetchedAgo !== null && fetchedAgo > 26 * 60 * MIN)) {
    return { ...base, status: 'warning', summary: `${summary}${info.lastError ? ' · refresh failing' : ''}`, issue: 'ID mapping refresh failing' };
  }
  return { ...base, status: 'healthy', summary };
}

function streamsComponent() {
  const hour = traffic.recentStats(60);
  const base = { id: 'streams', group: 'service', name: 'Stream lookups', data: hour };
  if (hour.requests === 0) return { ...base, status: 'idle', summary: 'No anime requests in the last hour' };
  const rate = hour.errorRate;
  const summary = `${hour.requests} anime requests (1h) · ${fmtPct(rate)} errors`;
  if (hour.requests >= 10 && rate >= 0.2) return { ...base, status: 'degraded', summary, issue: `Stream error rate ${fmtPct(rate)}` };
  if (hour.requests >= 10 && rate >= 0.05) return { ...base, status: 'warning', summary, issue: `Stream error rate ${fmtPct(rate)}` };
  return { ...base, status: 'healthy', summary };
}

function processComponent(now) {
  const snap = processStats.snapshot();
  const life = lifecycle.info();
  const base = { id: 'process', group: 'service', name: 'Server process', data: { process: snap, lifecycle: life } };
  const fatal = life.lastFatal;
  const notes = [];
  let status = 'healthy';
  const raise = (s, note) => {
    if (RANK[s] > RANK[status]) status = s;
    notes.push(note);
  };
  if (fatal && now - fatal.at < 60 * MIN) raise('degraded', `${fatal.kind} ${fmtAge(now - fatal.at)} ago: ${fatal.message}`);
  else if (life.uncaughtExceptions + life.unhandledRejections > 0) raise('warning', `${life.uncaughtExceptions + life.unhandledRejections} uncaught error(s) since start`);
  if (snap.memory.limitSource === 'container' && snap.memory.percent >= 0.95) raise('degraded', `memory ${fmtPct(snap.memory.percent)} of limit`);
  else if (snap.memory.limitSource === 'container' && snap.memory.percent >= 0.85) raise('warning', `memory ${fmtPct(snap.memory.percent)} of limit`);
  if (snap.eventLoop && snap.eventLoop.p99 >= 1000) raise('degraded', `event loop p99 ${Math.round(snap.eventLoop.p99)} ms`);
  else if (snap.eventLoop && snap.eventLoop.p99 >= 250) raise('warning', `event loop p99 ${Math.round(snap.eventLoop.p99)} ms`);
  if (life.previousShutdown && !life.previousShutdown.clean && life.uptimeMs < 60 * MIN) {
    raise('warning', 'restarted after an abnormal shutdown');
  }
  const mem = `${Math.round(snap.memory.rss / 1048576)} MB RSS`;
  return {
    ...base,
    status,
    summary: notes.length > 0 ? notes.join(' · ') : `${mem} · up ${fmtAge(life.uptimeMs)}`,
    issue: notes.length > 0 ? `Server: ${notes[0]}` : undefined,
  };
}

function persistenceComponent() {
  const failing = JsonStore.statusAll().filter(s => s.lastError && (!s.lastSavedAt || s.lastErrorAt > s.lastSavedAt));
  const base = { id: 'persistence', group: 'service', name: 'Data persistence', data: { failing } };
  if (failing.length === 0) return { ...base, status: 'healthy', summary: 'All data files saving' };
  return { ...base, status: 'warning', summary: `Cannot save ${failing.map(s => s.label).join(', ')}: ${failing[0].lastError}`, issue: 'Data files not saving' };
}

function keepaliveComponent() {
  if (!config.publicUrl) return null;
  const job = jobs.get('keepalive');
  const base = { id: 'keepalive', group: 'service', name: 'Keep-alive ping', data: job };
  if (!job || job.runs === 0) return { ...base, status: 'idle', summary: 'First ping pending (every 12 min)' };
  if (job.lastOk === false) return { ...base, status: 'warning', summary: `Last ping failed: ${job.lastError}`, issue: 'Keep-alive ping failing' };
  return { ...base, status: 'healthy', summary: 'Last ping OK' };
}

// ─── Evaluation ──────────────────────────────────────────────────────────────

/**
 * Evaluate every component.
 * @returns {{ status: string, banner: string, issues: string[], components: object[], at: number }}
 */
function evaluate(now = Date.now()) {
  const uptimeMs = lifecycle.info().uptimeMs;
  const components = [
    ...PROVIDERS.map(def => providerComponent(def, now)),
    indexComponent(now, uptimeMs),
    snapshotComponent({ id: 'releasing', name: 'Releasing catalog', info: releasing.info(), staleMs: 10 * MIN, downAfterMs: STARTUP_GRACE_MS }, now, uptimeMs),
    snapshotComponent({ id: 'trending', name: 'Trending catalog', info: trending.info(), staleMs: 30 * MIN, downAfterMs: 5 * MIN }, now, uptimeMs),
    mappingComponent(now, uptimeMs),
    streamsComponent(),
    processComponent(now),
    persistenceComponent(),
    keepaliveComponent(),
  ].filter(Boolean);

  const status = worst(components.map(c => c.status));
  const issues = components
    .filter(c => RANK[c.status] > 0)
    .sort((a, b) => RANK[b.status] - RANK[a.status])
    .map(c => c.issue || `${c.name}: ${c.summary}`);
  const label = { healthy: 'All systems operational', warning: 'Warning', degraded: 'Degraded', down: 'Outage' }[status];
  return {
    at: now,
    status,
    banner: status === 'healthy' ? label : `${label} — ${issues.slice(0, 3).join(' · ')}`,
    issues,
    components,
  };
}

let cached = null;

/** evaluate(), cached for a few seconds (many dashboard polls share it). */
function current() {
  const now = Date.now();
  if (!cached || now - cached.at > 5000) cached = evaluate(now);
  return cached;
}

module.exports = { evaluate, current, RANK };
