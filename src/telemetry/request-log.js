/**
 * Stream request log.
 *
 * One entry per stream request, with its outcome category and reason,
 * resolver method, AniLibria release, latency and error. Anime requests and
 * non-anime pass-through requests are kept in separate bounded lists, so
 * the (usually far more numerous) pass-through requests never push anime
 * history out:
 *   anime:        up to 10,000 entries
 *   pass-through: up to 2,000 entries
 * Entries older than 3 days are dropped. Every entry has a sequence number
 * used for paging ("load older") and detail lookups.
 *
 * Persisted as append-only NDJSON (data/requests.ndjson), compacted hourly.
 */

const path      = require('path');
const config    = require('../config');
const AppendLog = require('../util/append-log');
const JsonStore = require('../util/json-store');
const legacy    = require('./legacy-stats');

const FILE = path.join(config.dataDir, 'requests.ndjson');
const LIMITS = { anime: 10_000, passThrough: 2_000 };
const MAX_AGE_MS = 3 * 24 * 60 * 60 * 1000;
const CLEANUP_INTERVAL_MS = 60 * 60 * 1000;

let anime = [];       // oldest first
let passThrough = []; // oldest first
let seq = 0;

const log = new AppendLog(FILE, {
  records: () => mergeByseq(anime, passThrough),
  label: 'request log',
});
JsonStore.register(log);

function mergeByseq(a, b) {
  const out = [];
  let i = 0;
  let j = 0;
  while (i < a.length || j < b.length) {
    if (j >= b.length || (i < a.length && a[i].seq < b[j].seq)) out.push(a[i++]);
    else out.push(b[j++]);
  }
  return out;
}

// ─── Initialization ──────────────────────────────────────────────────────────

/** Convert a v1 logs.json entry. */
function fromLegacy(e) {
  const parts = String(e.stremioId || '').split(':');
  const catalog = parts[0] === 'anilibria';
  const passThroughEntry = e.outcome === 'not_found' && e.isAnime !== true;
  return {
    ts: e.ts,
    id: e.stremioId || e.imdbId || null,
    source: catalog ? 'catalog' : 'imdb',
    type: e.type || null,
    imdbId: e.imdbId || null,
    releaseId: e.releaseId ?? (catalog ? Number(parts[1]) || null : null),
    season: !catalog && parts.length === 3 ? Number(parts[1]) : null,
    episode: parts.length === 3 ? Number(parts[2]) : null,
    anime: e.isAnime ?? null,
    outcome: e.outcome || 'error',
    category: e.outcome === 'success' ? 'found' : passThroughEntry ? 'pass_through' : e.outcome === 'error' ? 'error' : 'unclassified',
    reason: null,
    method: e.method || null,
    title: e.title || null,
    streams: e.streamCount || 0,
    ms: e.responseTimeMs || 0,
    error: e.error || null,
  };
}

function place(entry) {
  if (entry.category === 'pass_through') passThrough.push(entry);
  else anime.push(entry);
}

function init() {
  let records = AppendLog.read(FILE);
  if (records.length === 0) {
    const old = legacy.readLogs();
    if (old.length > 0) {
      records = old.filter(e => e && Number.isFinite(e.ts)).map(fromLegacy);
      records.forEach((r, i) => { r.seq = i + 1; });
      for (const r of records) place(r);
      trim();
      log.compact();
      seq = records.length;
      return;
    }
  }
  for (const r of records) {
    if (!Number.isFinite(r.ts) || !Number.isFinite(r.seq)) continue;
    place(r);
    if (r.seq > seq) seq = r.seq;
  }
  anime.sort((a, b) => a.seq - b.seq);
  passThrough.sort((a, b) => a.seq - b.seq);
  log.lines = records.length;
  trim();
}

function trim(now = Date.now()) {
  const cutoff = now - MAX_AGE_MS;
  const dropOld = list => {
    let n = 0;
    while (n < list.length && list[n].ts < cutoff) n++;
    return n > 0 ? list.slice(n) : list;
  };
  anime = dropOld(anime);
  passThrough = dropOld(passThrough);
  if (anime.length > LIMITS.anime) anime = anime.slice(anime.length - LIMITS.anime);
  if (passThrough.length > LIMITS.passThrough) passThrough = passThrough.slice(passThrough.length - LIMITS.passThrough);
}

init();

// ─── Core API ────────────────────────────────────────────────────────────────

/**
 * Add a log entry.
 * @param {{ id: string, source: 'imdb'|'catalog', type: string, imdbId?: string|null,
 *           releaseId?: number|null, season?: number|null, episode?: number|null,
 *           anime: boolean|null, outcome: string, category: string, reason: string,
 *           method?: string|null, title?: string|null, streams: number, ms: number,
 *           error?: string|null, entryKey?: string|null }} entry
 * @returns {number} the entry's sequence number
 */
function add(entry) {
  const record = {
    seq: ++seq,
    ts: Date.now(),
    id: entry.id || null,
    source: entry.source || null,
    type: entry.type || null,
    imdbId: entry.imdbId || null,
    releaseId: entry.releaseId ?? null,
    season: entry.season ?? null,
    episode: entry.episode ?? null,
    anime: entry.anime ?? null,
    outcome: entry.outcome || 'error',
    category: entry.category || 'error',
    reason: entry.reason || null,
    method: entry.method || null,
    title: entry.title || null,
    streams: entry.streams || 0,
    ms: entry.ms || 0,
    error: entry.error || null,
    entryKey: entry.entryKey || null,
  };
  place(record);
  const list = record.category === 'pass_through' ? passThrough : anime;
  const limit = record.category === 'pass_through' ? LIMITS.passThrough : LIMITS.anime;
  if (list.length > limit * 1.1) trim(); // amortized: trim in batches
  log.append(record);
  return record.seq;
}

/** Update an entry in memory (e.g. a title found later). */
function update(seqNo, fields) {
  const entry = get(seqNo);
  if (entry) Object.assign(entry, fields);
}

function find(list, seqNo) {
  let lo = 0;
  let hi = list.length - 1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (list[mid].seq === seqNo) return list[mid];
    if (list[mid].seq < seqNo) lo = mid + 1;
    else hi = mid - 1;
  }
  return null;
}

function get(seqNo) {
  return find(anime, seqNo) || find(passThrough, seqNo);
}

function matches(e, f) {
  if (f.after !== undefined && e.seq <= f.after) return false;
  if (f.from !== undefined && e.ts < f.from) return false;
  if (f.to !== undefined && e.ts > f.to) return false;
  if (f.category && e.category !== f.category) return false;
  if (f.outcome && e.outcome !== f.outcome) return false;
  if (f.reason && e.reason !== f.reason) return false;
  if (f.method && e.method !== f.method) return false;
  if (f.source && e.source !== f.source) return false;
  if (f.minMs !== undefined && e.ms < f.minMs) return false;
  if (f.q) {
    const hay = [e.id, e.imdbId, e.releaseId, e.title, e.error, e.reason].filter(v => v !== null && v !== undefined).join(' ').toLowerCase();
    if (!hay.includes(f.q)) return false;
  }
  return true;
}

/**
 * Query entries, newest first.
 * @param {{ scope?: 'anime'|'pass'|'all', from?: number, to?: number, category?: string,
 *           outcome?: string, reason?: string, method?: string, source?: string,
 *           minMs?: number, q?: string, after?: number, before?: number, limit?: number }} [filters]
 *   after — only entries newer than this sequence number; before — page cursor
 * @returns {{ rows: object[], matched: number, nextBefore: number|null }}
 */
function query(filters = {}) {
  const f = { ...filters, q: typeof filters.q === 'string' && filters.q ? filters.q.toLowerCase() : null };
  const limit = filters.limit > 0 ? filters.limit : 100;
  const lists = f.scope === 'pass' ? [passThrough] : f.scope === 'all' ? [anime, passThrough] : [anime];
  const idx = lists.map(l => l.length - 1);
  const rows = [];
  let matched = 0;
  let nextBefore = null;

  // Merge the lists newest first by sequence number
  for (;;) {
    let pick = -1;
    for (let k = 0; k < lists.length; k++) {
      if (idx[k] >= 0 && (pick < 0 || lists[k][idx[k]].seq > lists[pick][idx[pick]].seq)) pick = k;
    }
    if (pick < 0) break;
    const e = lists[pick][idx[pick]--];
    if (f.after !== undefined && e.seq <= f.after) break; // newest first: nothing newer remains
    if (!matches(e, f)) continue;
    matched++;
    if (filters.before !== undefined && e.seq >= filters.before) continue;
    if (rows.length < limit) rows.push(e);
    else if (nextBefore === null) nextBefore = rows[rows.length - 1].seq;
  }
  return { rows, matched, nextBefore };
}

/** Newest sequence number (to detect new entries). */
function latestSeq() {
  return seq;
}

function retention() {
  const oldest = [anime[0], passThrough[0]].filter(Boolean).map(e => e.ts);
  return {
    maxAgeDays: MAX_AGE_MS / (24 * 60 * 60 * 1000),
    limits: { ...LIMITS },
    counts: { anime: anime.length, passThrough: passThrough.length },
    oldestTs: oldest.length ? Math.min(...oldest) : null,
  };
}

/** Drop expired entries and compact the file when worthwhile. */
function cleanup() {
  const before = anime.length + passThrough.length;
  trim();
  const removed = before - anime.length - passThrough.length;
  if (removed > 0) console.log(`[requests] Cleanup: removed ${removed} expired log entries`);
  return log.compactIfNeeded();
}

let cleanupTimer = null;

function start() {
  if (cleanupTimer) return;
  cleanupTimer = setInterval(cleanup, CLEANUP_INTERVAL_MS);
  cleanupTimer.unref();
}

function stop() {
  clearInterval(cleanupTimer);
  cleanupTimer = null;
}

module.exports = { add, update, get, query, latestSeq, retention, cleanup, start, stop, flush: () => log.flush() };
