/**
 * Low-confidence resolver matches, kept for review.
 *
 * Most anime resolve to an AniLibria release by MAL ID (exact). When a
 * release is found by title instead — AniLibria's search API ("search") or
 * fuzzy matching over the local index ("fuse") — the match is recorded here
 * with what was requested and what was chosen, so the dashboard can show
 * it for approval (pin) or rejection (block). Decisions are stored in the
 * overrides (overrides.js) and applied by the resolver.
 *
 * Persisted to data/matches.json; bounded by count and age.
 */

const path      = require('path');
const config    = require('../config');
const JsonStore = require('../util/json-store');
const overrides = require('../overrides');

const FILE = path.join(config.dataDir, 'matches.json');
const MAX_RECORDS = 500;
const RETENTION_MS = 90 * 24 * 60 * 60 * 1000;
const MAX_IMDB_IDS = 10;

/** entry key -> record */
let records = {};

const store = new JsonStore(FILE, {
  serialize: () => {
    prune();
    return { version: 1, records };
  },
  debounceMs: 10_000,
  label: 'match review',
});

function init() {
  const saved = JsonStore.read(FILE);
  if (saved && saved.version === 1 && saved.records && typeof saved.records === 'object') records = saved.records;
}

function prune(now = Date.now()) {
  for (const [key, r] of Object.entries(records)) if (now - r.lastSeen > RETENTION_MS) delete records[key];
  const keys = Object.keys(records);
  if (keys.length > MAX_RECORDS) {
    keys.sort((a, b) => records[a].lastSeen - records[b].lastSeen);
    for (const key of keys.slice(0, keys.length - MAX_RECORDS)) delete records[key];
  }
}

init();

/**
 * Record a title-based match made by the resolver.
 * @param {{ key: string, mal?: number|null, anilist?: number|null, title?: string|null,
 *           titles?: string[], year?: number|null, method: 'fuse'|'search',
 *           score?: number|null, release: { id: number, en?: string, ru?: string,
 *           alias?: string, year?: number|null, ids?: number[] } }} match
 */
function record(match) {
  const now = Date.now();
  const prev = records[match.key];
  const sameRelease = prev && prev.releaseId === match.release.id;
  records[match.key] = {
    key: match.key,
    mal: match.mal ?? null,
    anilist: match.anilist ?? null,
    title: match.title || prev?.title || null,
    titles: (match.titles || []).slice(0, 6),
    year: match.year ?? null,
    method: match.method,
    score: Number.isFinite(match.score) ? Math.round(match.score * 1000) / 1000 : null,
    releaseId: match.release.id,
    releaseName: match.release.en || match.release.ru || null,
    releaseNameRu: match.release.ru || null,
    releaseAlias: match.release.alias || null,
    releaseYear: match.release.year ?? null,
    releaseIds: match.release.ids || [],
    resolutions: (sameRelease ? prev.resolutions : 0) + 1,
    requests: sameRelease ? prev.requests : 0,
    imdbIds: sameRelease ? prev.imdbIds : [],
    firstSeen: sameRelease ? prev.firstSeen : now,
    lastSeen: now,
  };
  store.schedule();
}

/** A successful stream request served through a recorded match. */
function recordUse(key, imdbId) {
  const r = key && records[key];
  if (!r) return;
  r.requests++;
  r.lastSeen = Date.now();
  if (imdbId && !r.imdbIds.includes(imdbId) && r.imdbIds.length < MAX_IMDB_IDS) r.imdbIds.push(imdbId);
  store.schedule();
}

/**
 * Recorded matches with their review state.
 * @param {{ status?: 'review'|'approved'|'rejected'|'all' }} [opts]
 */
function list({ status = 'review' } = {}) {
  const rows = Object.values(records).map(r => {
    const decision = overrides.getMatchDecision(r.key);
    const applies = decision && decision.releaseId === r.releaseId;
    return {
      ...r,
      decision: decision || null,
      status: !applies ? 'review' : decision.decision === 'approve' ? 'approved' : 'rejected',
    };
  });
  // Decisions whose match record has aged out still need to be visible
  for (const d of overrides.listMatchDecisions()) {
    if (rows.some(r => r.key === d.key && r.releaseId === d.releaseId)) continue;
    rows.push({ key: d.key, releaseId: d.releaseId, title: null, method: null, decision: d, status: d.decision === 'approve' ? 'approved' : 'rejected', lastSeen: d.at, requests: 0, resolutions: 0, imdbIds: [] });
  }
  const counts = { review: 0, approved: 0, rejected: 0 };
  for (const r of rows) counts[r.status]++;
  const filtered = status === 'all' ? rows : rows.filter(r => r.status === status);
  filtered.sort((a, b) => (b.requests || 0) - (a.requests || 0) || b.lastSeen - a.lastSeen);
  return { counts, rows: filtered };
}

function get(key) {
  return records[key] || null;
}

module.exports = { record, recordUse, list, get, flush: () => store.flush() };
