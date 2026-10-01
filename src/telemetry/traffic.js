/**
 * Request telemetry: hourly buckets (UTC), kept for 90 days.
 *
 * Stremio asks this addon for streams for every movie and series a user
 * opens, anime or not. Requests for IMDB IDs that are not in the anime
 * mapping ("non-anime pass-through") are therefore counted separately and
 * never mixed into the anime metrics.
 *
 * Anime stream requests are classified into one outcome category:
 *   found             streams returned
 *   not_on_anilibria  anime AniLibria has no release for
 *   episode_missing   release found, requested episode not available
 *   unsupported       season 0 (specials) — not mapped by design
 *   blocked           geo/copyright-blocked on AniLibria
 *   error             the addon could not answer (timeout, upstream failure, …)
 *   unclassified      imported from before outcome tracking existed
 *
 * Each bucket also holds the outcome reasons, resolver methods of found
 * requests, request sources (IMDB vs. addon catalog), a latency histogram
 * of anime stream requests, the count of every addon resource request
 * (stream / catalog / meta / manifest), and the installed manifest version
 * of stream / catalog / meta requests ("legacy" = not known, see install-version.js).
 */

const path      = require('path');
const config    = require('../config');
const JsonStore = require('../util/json-store');
const legacy    = require('./legacy-stats');
const hist      = require('./histogram');
const { HOUR_MS, MINUTE_MS, hourIndex, hourKey } = require('../util/time');

const FILE = path.join(config.dataDir, 'traffic.json');
const RETENTION_HOURS = 90 * 24;
const RECENT_MINUTES = 60;

const CATEGORIES = ['found', 'not_on_anilibria', 'episode_missing', 'unsupported', 'blocked', 'error'];
const RESOURCES = ['stream', 'catalog', 'meta', 'manifest'];

/** Distinct installed versions kept per hour; more (edited URLs) count as "other". */
const MAX_VERSIONS_PER_HOUR = 20;

/** Chart ranges: `points` blocks of `step` hours, aligned to UTC. */
const RANGES = {
  '24h': { step: 1, points: 24 },
  '7d':  { step: 6, points: 28 },
  '30d': { step: 24, points: 30 },
  '90d': { step: 24, points: 90 },
};

let state = { version: 1, createdAt: Date.now(), detailedSince: Date.now(), hours: {} };
const recent = []; // per-minute ring: { index, requests, errors, found, passThrough }

const store = new JsonStore(FILE, { serialize: () => state, debounceMs: 30_000, label: 'traffic' });

// ─── Initialization / migration ──────────────────────────────────────────────

function init() {
  const saved = JsonStore.read(FILE);
  if (saved && typeof saved.hours === 'object' && saved.hours) {
    state = {
      version: 1,
      createdAt: Number(saved.createdAt) || Date.now(),
      detailedSince: Number(saved.detailedSince) || Date.now(),
      hours: saved.hours,
    };
    prune();
    return;
  }
  // First start after upgrading: import request volume from the v1 stats.json.
  // v1 only knew "anime" (in the mapping) vs. everything else, not outcomes.
  const old = legacy.readStats();
  if (!old || typeof old.hourlyBuckets !== 'object' || !old.hourlyBuckets) return;
  const anime = old.animeBuckets && typeof old.animeBuckets === 'object' ? old.animeBuckets : {};
  let earliest = Date.now();
  for (const [key, total] of Object.entries(old.hourlyBuckets)) {
    if (!/^\d{4}-\d{2}-\d{2}T\d{2}$/.test(key) || !Number.isFinite(total)) continue;
    const animeCount = Math.min(Number(anime[key]) || 0, total);
    const bucket = emptyBucket();
    if (animeCount > 0) bucket.outcomes.unclassified = animeCount;
    bucket.passThrough = total - animeCount;
    state.hours[key] = bucket;
    earliest = Math.min(earliest, Date.parse(`${key}:00:00Z`));
  }
  state.createdAt = earliest;
  prune();
  store.schedule();
}

function emptyBucket() {
  return {
    outcomes: {}, reasons: {}, methods: {}, sources: {},
    passThrough: 0, latency: null, resources: {}, resourceErrors: {}, catalogs: {}, versions: {},
  };
}

function prune() {
  const cutoff = hourKey(Date.now() - RETENTION_HOURS * HOUR_MS);
  for (const key of Object.keys(state.hours)) if (key < cutoff) delete state.hours[key];
}

init();

// ─── Recording ───────────────────────────────────────────────────────────────

function inc(obj, key, by = 1) {
  if (!key) return;
  obj[key] = (obj[key] || 0) + by;
}

function currentBucket(now) {
  const key = hourKey(now);
  let bucket = state.hours[key];
  if (!bucket) {
    bucket = state.hours[key] = emptyBucket();
    prune();
  }
  return bucket;
}

function recentBucket(now) {
  const index = Math.floor(now / MINUTE_MS);
  let b = recent[recent.length - 1];
  if (!b || b.index !== index) {
    b = { index, requests: 0, errors: 0, found: 0, passThrough: 0 };
    recent.push(b);
    while (recent.length > RECENT_MINUTES) recent.shift();
  }
  return b;
}

/**
 * Outcome category of a stream lookup result.
 * @param {{ outcome: string, reason: string }} res
 * @returns {string} one of CATEGORIES, or 'pass_through' for non-anime IDs
 */
function categorize({ outcome, reason }) {
  if (outcome === 'success') return 'found';
  if (reason === 'not_anime') return 'pass_through';
  if (reason === 'not_on_anilibria' || reason === 'release_missing') return 'not_on_anilibria';
  if (reason === 'episode_not_found') return 'episode_missing';
  if (reason === 'special_season') return 'unsupported';
  if (reason === 'blocked') return 'blocked';
  return 'error';
}

/**
 * Record one stream request.
 * @param {{ category: string, reason: string, method?: string|null,
 *           source: 'imdb'|'catalog', ms: number }} req
 */
function recordStream({ category, reason, method = null, source, ms }) {
  const now = Date.now();
  const bucket = currentBucket(now);
  const minute = recentBucket(now);
  inc(bucket.reasons, reason);
  if (category === 'pass_through') {
    bucket.passThrough++;
    minute.passThrough++;
  } else {
    inc(bucket.outcomes, category);
    inc(bucket.sources, source);
    if (category === 'found') inc(bucket.methods, method || 'unknown');
    bucket.latency = hist.add(bucket.latency, ms);
    minute.requests++;
    if (category === 'error') minute.errors++;
    if (category === 'found') minute.found++;
  }
  store.schedule();
}

/**
 * Record one addon protocol request (any resource).
 * @param {{ resource: string, catalogId?: string|null, ok: boolean, installVersion?: string|null }} req
 *        installVersion — see install-version.js; manifest fetches are installs, not usage, and are not counted
 */
function recordResource({ resource, catalogId = null, ok, installVersion = null }) {
  const bucket = currentBucket(Date.now());
  const name = RESOURCES.includes(resource) ? resource : 'other';
  inc(bucket.resources, name);
  if (!ok) inc(bucket.resourceErrors, name);
  if (catalogId) inc(bucket.catalogs, catalogId);
  if (installVersion && resource !== 'manifest') {
    bucket.versions ??= {}; // buckets saved before version tracking
    const known = installVersion in bucket.versions || Object.keys(bucket.versions).length < MAX_VERSIONS_PER_HOUR;
    inc(bucket.versions, known ? installVersion : 'other');
  }
  store.schedule();
}

// ─── Aggregation ─────────────────────────────────────────────────────────────

function emptyAggregate() {
  return {
    outcomes: {}, reasons: {}, methods: {}, sources: {},
    passThrough: 0, latency: hist.empty(), resources: {}, resourceErrors: {}, catalogs: {}, versions: {},
  };
}

function addInto(target, bucket) {
  for (const field of ['outcomes', 'reasons', 'methods', 'sources', 'resources', 'resourceErrors', 'catalogs', 'versions']) {
    for (const [k, v] of Object.entries(bucket[field] || {})) inc(target[field], k, v);
  }
  target.passThrough += bucket.passThrough || 0;
  if (bucket.latency) hist.merge(target.latency, bucket.latency);
}

/** Aggregate the hourly buckets with index in [fromHour, toHour]. */
function aggregate(fromHour, toHour) {
  const agg = emptyAggregate();
  for (let h = fromHour; h <= toHour; h++) {
    const bucket = state.hours[hourKey(h * HOUR_MS)];
    if (bucket) addInto(agg, bucket);
  }
  return agg;
}

/**
 * Headline numbers of an aggregate (see the module header for categories).
 *   errorRate = errors / classified anime requests
 *   coverage  = found / (classified anime requests − errors)
 */
function summarize(agg) {
  const o = agg.outcomes;
  const requests = Object.values(o).reduce((a, b) => a + b, 0);
  const unclassified = o.unclassified || 0;
  const classified = requests - unclassified;
  const errors = o.error || 0;
  const answerable = classified - errors;
  return {
    requests,
    classified,
    unclassified,
    found: o.found || 0,
    notOnAnilibria: o.not_on_anilibria || 0,
    episodeMissing: o.episode_missing || 0,
    unsupported: o.unsupported || 0,
    blocked: o.blocked || 0,
    errors,
    answerable,
    errorRate: classified > 0 ? errors / classified : null,
    coverage: answerable > 0 ? (o.found || 0) / answerable : null,
    p50: hist.percentile(agg.latency, 0.5),
    p95: hist.percentile(agg.latency, 0.95),
    latencySamples: hist.total(agg.latency),
    passThrough: agg.passThrough,
    sources: { imdb: agg.sources.imdb || 0, catalog: agg.sources.catalog || 0 },
  };
}

/** Last 24 hours (current hour + previous 23) and the 24 hours before. */
function kpis(now = Date.now()) {
  const cur = hourIndex(now);
  return {
    current: summarize(aggregate(cur - 23, cur)),
    previous: summarize(aggregate(cur - 47, cur - 24)),
  };
}

/**
 * Chart series and period totals for a range ("24h", "7d", "30d", "90d").
 * Blocks are aligned to UTC (6 h blocks at 00/06/12/18, days at midnight);
 * the last block is the current, partial one.
 */
function series(range, now = Date.now()) {
  const { step, points } = RANGES[range] || RANGES['24h'];
  const cur = hourIndex(now);
  const lastBlock = Math.floor(cur / step);
  const firstHour = (lastBlock - points + 1) * step;

  const out = [];
  for (let b = lastBlock - points + 1; b <= lastBlock; b++) {
    const from = b * step;
    const agg = aggregate(from, Math.min(from + step - 1, cur));
    const sum = summarize(agg);
    out.push({
      t: from * HOUR_MS,
      outcomes: {
        found: sum.found,
        not_on_anilibria: sum.notOnAnilibria,
        episode_missing: sum.episodeMissing,
        unsupported: sum.unsupported,
        blocked: sum.blocked,
        error: sum.errors,
        unclassified: sum.unclassified,
      },
      passThrough: sum.passThrough,
      p50: sum.p50,
      p95: sum.p95,
      errorRate: sum.errorRate,
      resources: Object.fromEntries(RESOURCES.map(r => [r, agg.resources[r] || 0])),
    });
  }

  const currentAgg = aggregate(firstHour, cur);
  const previousAgg = aggregate(firstHour - points * step, firstHour - 1);
  const hasPrevious = Object.keys(state.hours).some(k => k < hourKey(firstHour * HOUR_MS));
  return {
    range,
    stepHours: step,
    from: firstHour * HOUR_MS,
    points: out,
    current: { ...summarize(currentAgg), methods: currentAgg.methods, reasons: currentAgg.reasons,
      resources: currentAgg.resources, resourceErrors: currentAgg.resourceErrors, catalogs: currentAgg.catalogs,
      versions: currentAgg.versions },
    previous: hasPrevious
      ? { ...summarize(previousAgg), methods: previousAgg.methods, reasons: previousAgg.reasons,
        resources: previousAgg.resources, resourceErrors: previousAgg.resourceErrors, catalogs: previousAgg.catalogs,
        versions: previousAgg.versions }
      : null,
  };
}

/** Anime stream requests of the last `minutes` minutes (in memory, for health checks). */
function recentStats(minutes = 15, now = Date.now()) {
  const from = Math.floor(now / MINUTE_MS) - minutes + 1;
  let requests = 0, errors = 0, found = 0, passThrough = 0;
  for (const b of recent) {
    if (b.index < from) continue;
    requests += b.requests;
    errors += b.errors;
    found += b.found;
    passThrough += b.passThrough;
  }
  return { minutes, requests, errors, found, passThrough, errorRate: requests > 0 ? errors / requests : null };
}

/** When collection started, and since when outcomes are classified. */
function since() {
  const keys = Object.keys(state.hours).sort();
  const oldest = keys.length > 0 ? Date.parse(`${keys[0]}:00:00Z`) : null;
  return { createdAt: state.createdAt, detailedSince: state.detailedSince, oldestBucket: oldest, retentionDays: RETENTION_HOURS / 24 };
}

module.exports = {
  categorize, recordStream, recordResource, kpis, series, recentStats, since,
  CATEGORIES, RESOURCES, RANGES,
  flush: () => store.flush(),
};
