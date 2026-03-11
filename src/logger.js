/**
 * Request Logger
 *
 * Structured logging for stream requests with disk persistence.
 * Stores entries in data/logs.json with auto-cleanup (3-day retention).
 * Max 10,000 entries in memory; oldest dropped if exceeded.
 */

const fs   = require('fs');
const path = require('path');

const DATA_DIR  = path.resolve(__dirname, '../data');
const LOG_FILE  = path.join(DATA_DIR, 'logs.json');
const TEMP_FILE = path.join(DATA_DIR, 'logs.tmp.json');
const MAX_ENTRIES    = 10_000;
const DEFAULT_MAX_AGE_DAYS = 3;

let logs = [];
let flushTimer = null;

// ─── Initialization ──────────────────────────────────────────────────────────

function init() {
  try {
    fs.mkdirSync(DATA_DIR, { recursive: true });
    if (fs.existsSync(LOG_FILE)) {
      const raw = fs.readFileSync(LOG_FILE, 'utf8');
      const parsed = JSON.parse(raw);
      if (Array.isArray(parsed)) {
        logs = parsed;
        // Trim to max on load
        if (logs.length > MAX_ENTRIES) {
          logs = logs.slice(logs.length - MAX_ENTRIES);
        }
      }
    }
  } catch (err) {
    console.warn('[logger] Failed to load logs from disk:', err.message);
    logs = [];
  }
}

init();

// ─── Core API ────────────────────────────────────────────────────────────────

/**
 * Add a log entry.
 * @param {Object} entry
 * @param {string} entry.imdbId
 * @param {string} entry.stremioId
 * @param {string} entry.type - "series" or "movie"
 * @param {'success'|'not_found'|'error'} entry.outcome
 * @param {string|null} entry.title
 * @param {'alias'|'search'|'fuse'|null} entry.method
 * @param {number} entry.responseTimeMs
 * @param {number} entry.streamCount
 * @param {string|null} entry.error
 */
function log(entry) {
  const record = {
    ts: Date.now(),
    imdbId:        entry.imdbId || null,
    stremioId:     entry.stremioId || null,
    type:          entry.type || null,
    outcome:       entry.outcome || 'error',
    title:         entry.title || null,
    isAnime:       entry.isAnime ?? null,
    method:        entry.method || null,
    responseTimeMs: entry.responseTimeMs || 0,
    streamCount:   entry.streamCount || 0,
    error:         entry.error || null,
  };

  logs.push(record);

  // Drop oldest if over limit
  if (logs.length > MAX_ENTRIES) {
    logs = logs.slice(logs.length - MAX_ENTRIES);
  }

  scheduleDebouncedFlush();
}

/**
 * Query logs with optional filters.
 * @param {Object} [opts]
 * @param {number} [opts.from] - Start timestamp (ms)
 * @param {number} [opts.to]   - End timestamp (ms)
 * @param {string} [opts.outcome] - Filter by outcome
 * @param {string} [opts.search] - Search in title or imdbId
 * @param {number} [opts.limit]  - Max entries to return
 * @returns {Object[]}
 */
function getLogs({ from, to, outcome, search, isAnime, limit } = {}) {
  let result = logs;

  if (from) result = result.filter(e => e.ts >= from);
  if (to)   result = result.filter(e => e.ts <= to);
  if (outcome) result = result.filter(e => e.outcome === outcome);
  if (isAnime === true)  result = result.filter(e => e.isAnime === true);
  if (isAnime === false) result = result.filter(e => e.isAnime === false);
  if (search) {
    const q = search.toLowerCase();
    result = result.filter(e =>
      (e.title && e.title.toLowerCase().includes(q)) ||
      (e.imdbId && e.imdbId.toLowerCase().includes(q))
    );
  }

  // Return newest first
  result = result.slice().reverse();

  if (limit && limit > 0) result = result.slice(0, limit);

  return result;
}

/**
 * Update the most recent log entry for a given imdbId.
 * Used to backfill title/isAnime after async IMDB enrichment.
 * @param {string} imdbId
 * @param {Object} updates - Fields to merge into the entry
 * @returns {boolean} true if an entry was found and updated
 */
function updateLastLog(imdbId, updates) {
  for (let i = logs.length - 1; i >= 0; i--) {
    if (logs[i].imdbId === imdbId) {
      Object.assign(logs[i], updates);
      scheduleDebouncedFlush();
      return true;
    }
  }
  return false;
}

/** Return all logs (for stats computation). */
function getAllLogs() {
  return logs;
}

/**
 * Delete logs older than maxAgeDays.
 * @param {number} [maxAgeDays=3]
 */
function cleanup(maxAgeDays = DEFAULT_MAX_AGE_DAYS) {
  const cutoff = Date.now() - (maxAgeDays * 24 * 60 * 60 * 1000);
  const before = logs.length;
  logs = logs.filter(e => e.ts >= cutoff);
  const removed = before - logs.length;
  if (removed > 0) {
    console.log(`[logger] Cleanup: removed ${removed} entries older than ${maxAgeDays} days`);
    flush();
  }
}

// ─── Disk persistence ────────────────────────────────────────────────────────

function scheduleDebouncedFlush() {
  if (flushTimer) return;
  flushTimer = setTimeout(() => {
    flushTimer = null;
    flush();
  }, 1000);
}

/** Write logs to disk atomically (temp file + rename). */
function flush() {
  try {
    fs.mkdirSync(DATA_DIR, { recursive: true });
    fs.writeFileSync(TEMP_FILE, JSON.stringify(logs), 'utf8');
    fs.renameSync(TEMP_FILE, LOG_FILE);
  } catch (err) {
    console.warn('[logger] Failed to flush logs:', err.message);
  }
}

let cleanupInterval = null;

/** Start hourly cleanup timer. */
function startCleanupInterval() {
  if (cleanupInterval) return;
  cleanupInterval = setInterval(() => cleanup(), 60 * 60 * 1000);
}

/** Stop cleanup timer (for graceful shutdown). */
function stopCleanupInterval() {
  if (cleanupInterval) {
    clearInterval(cleanupInterval);
    cleanupInterval = null;
  }
}

module.exports = { log, getLogs, getAllLogs, updateLastLog, cleanup, flush, startCleanupInterval, stopCleanupInterval };
