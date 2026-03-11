/**
 * Statistics Tracker
 *
 * Running counters + hourly buckets for analytics.
 * Persisted to data/stats.json. Session detection via timestamp clustering.
 */

const fs   = require('fs');
const path = require('path');
const os   = require('os');

const DATA_DIR   = path.resolve(__dirname, '../data');
const STATS_FILE = path.join(DATA_DIR, 'stats.json');
const TEMP_FILE  = path.join(DATA_DIR, 'stats.tmp.json');
const BUCKET_MAX_AGE_DAYS = 90;

// ─── Default state ───────────────────────────────────────────────────────────

function defaultState() {
  return {
    counters: {
      totalRequests: 0,
      totalSuccess: 0,
      totalFailed: 0,
      totalErrors: 0,
      animeRequests: 0,
      animeSuccess: 0,
    },
    hourlyBuckets: {},       // "YYYY-MM-DDTHH" → count
    failedLookups: {},       // imdbId → { title, count, lastSeen }
    ignoredLookups: {},      // imdbId → { reason, ignoredAt }
    totalBandwidthBytes: 0,
    bandwidthBuckets: {},    // "YYYY-MM-DDTHH" → bytes
  };
}

let state = defaultState();

// In-memory only: recent request timestamps for session detection (last 24h)
let recentTimestamps = [];

let flushTimer = null;

// ─── Initialization ──────────────────────────────────────────────────────────

function init() {
  try {
    fs.mkdirSync(DATA_DIR, { recursive: true });
    if (fs.existsSync(STATS_FILE)) {
      const raw = fs.readFileSync(STATS_FILE, 'utf8');
      const parsed = JSON.parse(raw);
      if (parsed && parsed.counters) {
        state = {
          counters:           { ...defaultState().counters, ...parsed.counters },
          hourlyBuckets:      parsed.hourlyBuckets || {},
          failedLookups:      parsed.failedLookups || {},
          ignoredLookups:     parsed.ignoredLookups || {},
          totalBandwidthBytes: parsed.totalBandwidthBytes || 0,
          bandwidthBuckets:   parsed.bandwidthBuckets || {},
        };
      }
    }
  } catch (err) {
    console.warn('[stats] Failed to load stats from disk:', err.message);
    state = defaultState();
  }
}

init();

// ─── Helpers ─────────────────────────────────────────────────────────────────

/** Get hourly bucket key for a timestamp. */
function bucketKey(ts) {
  const d = new Date(ts);
  return d.toISOString().slice(0, 13); // "2026-03-11T14"
}

/** Prune hourly buckets older than BUCKET_MAX_AGE_DAYS. */
function pruneBuckets() {
  const cutoff = new Date(Date.now() - BUCKET_MAX_AGE_DAYS * 24 * 60 * 60 * 1000)
    .toISOString().slice(0, 13);
  for (const key of Object.keys(state.hourlyBuckets)) {
    if (key < cutoff) delete state.hourlyBuckets[key];
  }
  for (const key of Object.keys(state.bandwidthBuckets)) {
    if (key < cutoff) delete state.bandwidthBuckets[key];
  }
}

/** Prune in-memory timestamps older than 24h. */
function pruneTimestamps() {
  const cutoff = Date.now() - 24 * 60 * 60 * 1000;
  recentTimestamps = recentTimestamps.filter(ts => ts >= cutoff);
}

// ─── Core API ────────────────────────────────────────────────────────────────

/**
 * Record a stream request.
 * @param {Object} entry
 * @param {'success'|'not_found'|'error'} entry.outcome
 */
function recordRequest(entry) {
  const now = Date.now();

  state.counters.totalRequests++;
  if (entry.outcome === 'success')   state.counters.totalSuccess++;
  if (entry.outcome === 'not_found') state.counters.totalFailed++;
  if (entry.outcome === 'error')     state.counters.totalErrors++;

  if (entry.isAnime === true) {
    state.counters.animeRequests++;
    if (entry.outcome === 'success') state.counters.animeSuccess++;
  }

  // Hourly bucket
  const key = bucketKey(now);
  state.hourlyBuckets[key] = (state.hourlyBuckets[key] || 0) + 1;

  // Session tracking
  recentTimestamps.push(now);

  scheduleDebouncedFlush();
}

/**
 * Record a failed lookup (title not found in Anilibria).
 * @param {string} imdbId
 * @param {string|null} title
 * @param {boolean|null} isAnime  true=confirmed anime, false=not anime, null=unknown
 */
function recordFailedLookup(imdbId, title, isAnime = null) {
  if (!imdbId) return;
  const existing = state.failedLookups[imdbId];
  if (existing) {
    existing.count++;
    existing.lastSeen = Date.now();
    if (title) existing.title = title;
    if (isAnime !== null && existing.isAnime === null) existing.isAnime = isAnime;
  } else {
    state.failedLookups[imdbId] = {
      title: title || null,
      isAnime,
      count: 1,
      lastSeen: Date.now(),
    };
  }
  scheduleDebouncedFlush();
}

/**
 * Update an existing failed lookup record (async enrichment).
 * @param {string} imdbId
 * @param {{ title?: string, isAnime?: boolean }} updates
 */
function updateFailedLookup(imdbId, updates) {
  if (!imdbId) return;
  const existing = state.failedLookups[imdbId];
  if (!existing) return;
  if (updates.title && !existing.title) existing.title = updates.title;
  if (updates.isAnime !== undefined && existing.isAnime === null) existing.isAnime = updates.isAnime;
  scheduleDebouncedFlush();
}

/**
 * Get computed statistics snapshot.
 */
function getStats() {
  pruneTimestamps();
  pruneBuckets();

  const now = Date.now();
  const todayKey    = new Date(now).toISOString().slice(0, 10); // "2026-03-11"
  const weekAgo     = now - 7 * 24 * 60 * 60 * 1000;
  const monthAgo    = now - 30 * 24 * 60 * 60 * 1000;

  // Count requests for today/week/month from hourly buckets
  let todayCount = 0, weekCount = 0, monthCount = 0;
  const weekCutoff  = new Date(weekAgo).toISOString().slice(0, 13);
  const monthCutoff = new Date(monthAgo).toISOString().slice(0, 13);

  for (const [key, count] of Object.entries(state.hourlyBuckets)) {
    if (key.startsWith(todayKey)) todayCount += count;
    if (key >= weekCutoff)        weekCount  += count;
    if (key >= monthCutoff)       monthCount += count;
  }

  // Session detection: cluster timestamps within 60s gaps
  const sessions = countSessions(recentTimestamps, 60_000);

  const successRate = state.counters.animeRequests > 0
    ? ((state.counters.animeSuccess / state.counters.animeRequests) * 100).toFixed(1)
    : '0.0';

  return {
    counters: { ...state.counters },
    todayRequests: todayCount,
    weekRequests:  weekCount,
    monthRequests: monthCount,
    sessionsToday: sessions,
    successRate:   parseFloat(successRate),
  };
}

/**
 * Count sessions from a sorted array of timestamps.
 * A session = burst of requests where each is within `gap` ms of the next.
 */
function countSessions(timestamps, gap = 60_000) {
  if (timestamps.length === 0) return 0;
  const sorted = [...timestamps].sort((a, b) => a - b);
  let sessions = 1;
  for (let i = 1; i < sorted.length; i++) {
    if (sorted[i] - sorted[i - 1] > gap) sessions++;
  }
  return sessions;
}

/**
 * Get failed lookups sorted by frequency (desc).
 * @returns {Array<{imdbId, title, count, lastSeen}>}
 */
function getFailedLookups() {
  return Object.entries(state.failedLookups)
    .map(([imdbId, data]) => ({ imdbId, ...data }))
    .sort((a, b) => b.count - a.count);
}

/**
 * Get top N anime by success count from logs.
 * @param {Object[]} logs - All log entries
 * @param {number} [n=5]
 * @returns {Array<{title, imdbId, count}>}
 */
function getTopAnime(logs, n = 5) {
  const counts = {};
  for (const entry of logs) {
    if (entry.outcome === 'success' && entry.title) {
      const key = entry.imdbId || entry.title;
      if (!counts[key]) counts[key] = { title: entry.title, imdbId: entry.imdbId, count: 0 };
      counts[key].count++;
    }
  }
  return Object.values(counts).sort((a, b) => b.count - a.count).slice(0, n);
}

/**
 * Get hourly buckets data for charts.
 * @returns {Object} hourlyBuckets map
 */
function getHourlyBuckets() {
  pruneBuckets();
  return { ...state.hourlyBuckets };
}

/**
 * Get system resource stats (live, not persisted).
 */
function getSystemStats() {
  const mem = process.memoryUsage();
  const totalMem = os.totalmem();
  const freeMem  = os.freemem();
  const cpus = os.cpus();

  // Average CPU usage across cores
  let cpuUsage = 0;
  if (cpus.length > 0) {
    const totals = cpus.map(c => {
      const total = Object.values(c.times).reduce((a, b) => a + b, 0);
      const idle = c.times.idle;
      return { total, idle };
    });
    const totalAll = totals.reduce((a, b) => a + b.total, 0);
    const idleAll  = totals.reduce((a, b) => a + b.idle, 0);
    cpuUsage = totalAll > 0 ? ((1 - idleAll / totalAll) * 100).toFixed(1) : 0;
  }

  return {
    rssBytes:    mem.rss,
    heapUsed:    mem.heapUsed,
    heapTotal:   mem.heapTotal,
    totalMem,
    freeMem,
    cpuUsage:    parseFloat(cpuUsage),
    uptime:      Math.round(process.uptime()),
    platform:    os.platform(),
    nodeVersion: process.version,
  };
}

// ─── Bandwidth tracking ─────────────────────────────────────────────────────

/**
 * Record outbound bandwidth (bytes).
 * @param {number} bytes
 */
function recordBandwidth(bytes) {
  if (!bytes || bytes <= 0) return;
  state.totalBandwidthBytes += bytes;
  const key = bucketKey(Date.now());
  state.bandwidthBuckets[key] = (state.bandwidthBuckets[key] || 0) + bytes;
  scheduleDebouncedFlush();
}

/** Get bandwidth buckets for charts. */
function getBandwidthBuckets() {
  pruneBuckets();
  return { ...state.bandwidthBuckets };
}

/** Get total bandwidth served (bytes). */
function getTotalBandwidth() {
  return state.totalBandwidthBytes;
}

// ─── Ignored lookups ────────────────────────────────────────────────────────

/**
 * Ignore a failed lookup with a reason.
 * @param {string} imdbId
 * @param {string} reason
 */
function ignoreLookup(imdbId, reason) {
  if (!imdbId) return;
  state.ignoredLookups[imdbId] = { reason: reason || '', ignoredAt: Date.now() };
  scheduleDebouncedFlush();
}

/**
 * Un-ignore a previously ignored lookup.
 * @param {string} imdbId
 */
function unignoreLookup(imdbId) {
  if (!imdbId) return;
  delete state.ignoredLookups[imdbId];
  scheduleDebouncedFlush();
}

/** Get the ignored lookups map. */
function getIgnoredLookups() {
  return { ...state.ignoredLookups };
}

// ─── Disk persistence ────────────────────────────────────────────────────────

function scheduleDebouncedFlush() {
  if (flushTimer) return;
  flushTimer = setTimeout(() => {
    flushTimer = null;
    flush();
  }, 2000);
}

/** Write stats to disk atomically. */
function flush() {
  try {
    fs.mkdirSync(DATA_DIR, { recursive: true });
    fs.writeFileSync(TEMP_FILE, JSON.stringify(state), 'utf8');
    fs.renameSync(TEMP_FILE, STATS_FILE);
  } catch (err) {
    console.warn('[stats] Failed to flush stats:', err.message);
  }
}

module.exports = {
  recordRequest,
  recordFailedLookup,
  updateFailedLookup,
  getStats,
  getFailedLookups,
  getTopAnime,
  getHourlyBuckets,
  getSystemStats,
  recordBandwidth,
  getBandwidthBuckets,
  getTotalBandwidth,
  ignoreLookup,
  unignoreLookup,
  getIgnoredLookups,
  flush,
};
