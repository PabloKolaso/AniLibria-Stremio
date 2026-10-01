/**
 * Missing titles: anime that users asked for but could not play, by cause.
 *
 *   not_on_anilibria  the IMDB ID is in the anime mapping, but AniLibria has
 *                     no release for it (often: not dubbed yet)
 *   mapping_gap       the IMDB ID is not in the anime mapping (Fribb) although
 *                     Cinemeta lists it as Anime — the addon cannot reach it
 *                     even if AniLibria has a dub
 *   episode_missing   the release was found, the requested episode was not
 *                     (grouped per IMDB ID + season, or per catalog release);
 *                     the usual sign of an episode-numbering problem
 *
 * Non-anime titles are never stored. An IMDB ID outside the mapping is
 * checked on Cinemeta once (queued and throttled) and kept only when
 * Cinemeta classifies it as Anime.
 *
 * "Now available": a stored title that later resolves. Confirmed when a
 * request succeeds (which also clears a "not dubbed yet" mark); detected —
 * unconfirmed — when the AniLibria index or the refreshed mapping now has
 * it (checked offline, no API calls).
 *
 * Persisted to data/missing.json; entries unseen for 90 days are dropped.
 */

const path         = require('path');
const config       = require('../config');
const JsonStore    = require('../util/json-store');
const TTLCache     = require('../util/ttl-cache');
const legacy       = require('./legacy-stats');
const overrides    = require('../overrides');
const mapping      = require('../mapping/cache');
const catalogIndex = require('../mapping/anilibria-catalog');
const availability = require('../mapping/availability');
const cinemeta     = require('../api/cinemeta');
const anilist      = require('../api/anilist');
const matching     = require('../bridge/matching');
const requestLog   = require('./request-log');
const { dayIndex } = require('../util/time');

const FILE = path.join(config.dataDir, 'missing.json');
const RETENTION_MS = 90 * 24 * 60 * 60 * 1000;
const AVAILABLE_KEEP_MS = 14 * 24 * 60 * 60 * 1000;
const MAX_RECORDS = 5000;
const MAX_REQUESTED = 40;
const MAX_USERS = 500;
const MAX_QUEUE = 500;
const MAX_PENDING = 2000;
const CHECK_SPACING_MS = 400;
const RECHECK_INTERVAL_MS = 60 * 60 * 1000;
const RECHECK_DEBOUNCE_MS = 30_000;

const CATEGORIES = ['not_on_anilibria', 'mapping_gap', 'episode_missing', 'not_dubbed', 'now_available', 'ignored'];

/** key -> record (see newRecord) */
let records = {};

// Pass-through IMDB IDs being checked on Cinemeta: imdbId -> partial record
const pending = new Map();
const queue = [];
const queued = new Set();
let draining = false;
const enrichment = { processed: 0, anime: 0, lastRunAt: null };

// IMDB IDs Cinemeta did not classify as anime (not re-checked for a while)
const checkedNonAnime = new TTLCache({
  ttlMs: 7 * 24 * 60 * 60 * 1000, max: 20_000,
  name: 'Non-anime check', description: 'IMDB IDs Cinemeta did not list as Anime (not checked again)',
});

const store = new JsonStore(FILE, {
  serialize: () => {
    prune();
    return { version: 1, records };
  },
  debounceMs: 10_000,
  label: 'missing titles',
});

// ─── Initialization / migration ──────────────────────────────────────────────

function init() {
  const saved = JsonStore.read(FILE);
  if (saved && saved.version === 1 && saved.records && typeof saved.records === 'object') {
    records = saved.records;
    return;
  }
  // First start after upgrading: import v1 failed lookups. v1 stored every
  // title (anime or not); only confirmed anime and overridden ones are kept.
  const old = legacy.readStats();
  if (!old || typeof old.failedLookups !== 'object' || !old.failedLookups) return;
  const overridden = id => Boolean(overrides.getIgnored(id) || overrides.getNotDubbed(id));
  for (const [imdbId, e] of Object.entries(old.failedLookups)) {
    if (!overrides.IMDB_ID_RE.test(imdbId) || !e || typeof e !== 'object') continue;
    if (e.isAnime !== true && !overridden(imdbId)) continue;
    const seen = Number(e.lastSeen) || Date.now();
    records[imdbId] = {
      ...newRecord(imdbId, 'unclassified', seen),
      imdbId,
      title: typeof e.title === 'string' ? e.title : null,
      count: Number(e.count) || 1,
    };
  }
  store.schedule();
}

function newRecord(key, category, now = Date.now()) {
  return {
    key, category, imdbId: null, releaseId: null, season: null, type: null, title: null,
    mapping: [], requested: {}, latestEpisode: null, live: null, numbering: null, likelyCause: null,
    count: 0, users: {}, usersOverflow: false, firstSeen: now, lastSeen: now, available: null,
  };
}

function prune(now = Date.now()) {
  for (const [key, r] of Object.entries(records)) {
    if (r.available?.confirmed && now - r.available.since > AVAILABLE_KEEP_MS) delete records[key];
    else if (now - r.lastSeen > RETENTION_MS) delete records[key];
  }
  const keys = Object.keys(records);
  if (keys.length > MAX_RECORDS) {
    keys.sort((a, b) => records[a].lastSeen - records[b].lastSeen);
    for (const key of keys.slice(0, keys.length - MAX_RECORDS)) delete records[key];
  }
}

init();

// ─── Helpers ─────────────────────────────────────────────────────────────────

function snapshotMapping(entries) {
  return (entries || []).slice(0, 10).map(e => ({
    mal: e.mal ?? null, anilist: e.anilist ?? null, type: e.type ?? null,
    tvdbSeason: e.tvdbSeason ?? null, tvdbOffset: e.tvdbOffset ?? 0,
  }));
}

function requestLabel({ source, type, season, episode }) {
  if (source === 'catalog') return episode === null || episode === undefined ? 'first' : `E${episode}`;
  if (type === 'movie' || season === null || season === undefined) return 'movie';
  return `S${season}E${episode}`;
}

function touch(r, { userHash, label, target = null, now }) {
  r.count++;
  r.lastSeen = now;
  if (label) {
    const entry = r.requested[label] || (Object.keys(r.requested).length < MAX_REQUESTED ? (r.requested[label] = { count: 0, target }) : null);
    if (entry) {
      entry.count++;
      if (target !== null) entry.target = target;
    }
  }
  if (userHash) {
    if (r.users[userHash] !== undefined || Object.keys(r.users).length < MAX_USERS) r.users[userHash] = dayIndex(now);
    else r.usersOverflow = true;
  }
}

/** Why an episode could not be found (a hint, not a certainty). */
function likelyCause({ target, latestEpisode, live }) {
  if (target === null || target === undefined) return 'numbering_unknown';
  if (latestEpisode === null || latestEpisode === undefined) return 'no_episodes';
  if (target > latestEpisode) return live ? 'not_released_yet' : 'beyond_release';
  return 'numbering_mismatch';
}

// ─── Recording ───────────────────────────────────────────────────────────────

/**
 * Record an anime request that could not be played.
 * @param {{ category: 'not_on_anilibria'|'episode_missing', imdbId?: string|null,
 *           releaseId?: number|null, source: 'imdb'|'catalog', type: string,
 *           season?: number|null, episode?: number|null, target?: number|null,
 *           title?: string|null, userHash?: string|null, entries?: object[],
 *           latestEpisode?: number|null, live?: boolean|null, numbering?: string|null }} req
 */
function recordFailure(req) {
  const now = Date.now();
  let key;
  if (req.category === 'not_on_anilibria') {
    if (!req.imdbId) return;
    key = req.imdbId;
  } else if (req.category === 'episode_missing') {
    if (req.imdbId) key = `ep:${req.imdbId}:s${req.season ?? 0}`;
    else if (req.releaseId) key = `ep:r${req.releaseId}`;
    else return;
  } else {
    return;
  }

  let r = records[key];
  if (!r) r = records[key] = newRecord(key, req.category, now);
  r.category = req.category;
  r.imdbId = req.imdbId || r.imdbId;
  r.type = req.type || r.type;
  r.title = req.title || r.title;
  r.available = null; // failing right now
  if (req.entries?.length) r.mapping = snapshotMapping(req.entries);
  if (req.category === 'episode_missing') {
    r.season = req.season ?? null;
    r.releaseId = req.releaseId ?? r.releaseId;
    r.latestEpisode = req.latestEpisode ?? null;
    r.live = req.live ?? null;
    r.numbering = req.numbering || null;
    r.likelyCause = likelyCause({ target: req.target, latestEpisode: r.latestEpisode, live: r.live });
  }
  touch(r, { userHash: req.userHash, label: requestLabel(req), target: req.target ?? null, now });
  if (!r.title && r.imdbId) enqueue(r.imdbId, r.type, 'title');
  store.schedule();
}

/**
 * Record a request for an IMDB ID outside the anime mapping. Stored only if
 * it is a known mapping gap, or once Cinemeta classifies it as Anime.
 * @param {{ imdbId: string, type: string, season?: number|null, episode?: number|null,
 *           userHash?: string|null, logSeq?: number|null }} req
 */
function recordPassThrough(req) {
  const { imdbId } = req;
  if (!imdbId || overrides.getIgnored(imdbId)) return;
  const now = Date.now();
  const label = requestLabel({ ...req, source: 'imdb' });
  const existing = records[imdbId];
  if (existing && (existing.category === 'mapping_gap' || existing.category === 'unclassified')) {
    existing.category = 'mapping_gap';
    existing.available = null;
    touch(existing, { userHash: req.userHash, label, now });
    store.schedule();
    return;
  }
  if (checkedNonAnime.get(imdbId) !== undefined) return;

  let p = pending.get(imdbId);
  if (!p) {
    if (pending.size >= MAX_PENDING) return;
    p = { ...newRecord(imdbId, 'mapping_gap', now), imdbId, type: req.type, logSeqs: [] };
    pending.set(imdbId, p);
  }
  touch(p, { userHash: req.userHash, label, now });
  if (req.logSeq && p.logSeqs.length < 20) p.logSeqs.push(req.logSeq);
  enqueue(imdbId, req.type, 'classify');
}

/**
 * Record a successful request: marks stored failures as available.
 * @param {{ imdbId?: string|null, releaseId: number, source: string, season?: number|null,
 *           episode?: number|null, title?: string|null, type?: string }} req
 */
function recordSuccess(req) {
  const now = Date.now();
  let changed = false;
  const available = { since: now, releaseId: req.releaseId ?? null, via: 'request', confirmed: true };

  if (req.imdbId) {
    const r = records[req.imdbId];
    const notDubbed = overrides.getNotDubbed(req.imdbId);
    if (r && !r.available?.confirmed) {
      r.available = available;
      changed = true;
    } else if (!r && notDubbed) {
      // A "not dubbed yet" title without history (e.g. imported): show it as available
      records[req.imdbId] = { ...newRecord(req.imdbId, 'not_on_anilibria', now), imdbId: req.imdbId, type: req.type || null, title: req.title || null, available };
      changed = true;
    }
    if (notDubbed) {
      overrides.unmarkNotDubbed(req.imdbId);
      if (records[req.imdbId]) records[req.imdbId].notDubbedClearedAt = now;
      changed = true;
    }
  }

  const epKey = req.imdbId ? `ep:${req.imdbId}:s${req.season ?? 0}` : `ep:r${req.releaseId}`;
  const ep = records[epKey];
  if (ep && !ep.available?.confirmed) {
    delete ep.requested[requestLabel(req)];
    if (Object.keys(ep.requested).length === 0) ep.available = available;
    changed = true;
  }
  if (changed) store.schedule();
}

// ─── Cinemeta checks (queued, throttled) ─────────────────────────────────────

function enqueue(imdbId, type, purpose) {
  if (queued.has(imdbId) || queue.length >= MAX_QUEUE) return;
  queued.add(imdbId);
  queue.push({ imdbId, type, purpose });
  drain();
}

async function drain() {
  if (draining) return;
  draining = true;
  try {
    while (queue.length > 0) {
      const item = queue.shift();
      queued.delete(item.imdbId);
      await processItem(item);
      if (queue.length > 0) await new Promise(r => setTimeout(r, CHECK_SPACING_MS).unref?.());
    }
  } finally {
    draining = false;
  }
}

async function processItem({ imdbId, type, purpose }) {
  let info = null;
  try {
    info = await cinemeta.fetchTitleInfo(imdbId, type);
  } catch { /* treated as unknown */ }
  enrichment.processed++;
  enrichment.lastRunAt = Date.now();

  if (purpose === 'title') {
    const r = records[imdbId];
    if (r && !r.title && info?.title) {
      r.title = info.title;
      store.schedule();
    }
    return;
  }

  const p = pending.get(imdbId);
  pending.delete(imdbId);
  if (info?.title && p?.logSeqs) for (const seq of p.logSeqs) requestLog.update(seq, { title: info.title });
  if (info?.isAnime) {
    enrichment.anime++;
    const { logSeqs: _ignored, ...rest } = p || newRecord(imdbId, 'mapping_gap');
    records[imdbId] = { ...rest, key: imdbId, imdbId, category: 'mapping_gap', title: info.title };
    store.schedule();
  } else {
    // Not anime, or unknown to Cinemeta: do not ask again for a while
    checkedNonAnime.set(imdbId, true, info ? undefined : 6 * 60 * 60 * 1000);
  }
}

// ─── Offline recheck ("now available") ───────────────────────────────────────

/** An index release matching one of the mapping entries (year-checked when AniList data is cached). */
function findIndexRelease(entries, index) {
  for (const entry of entries || []) {
    if (!entry.mal) continue;
    const media = anilist.peekMedia(entry);
    const target = { mal: entry.mal, year: anilist.mediaYear(media) };
    const hit = index.findByMal(entry.mal).find(release => matching.verdict(release, target).ok);
    if (hit) return hit;
  }
  return null;
}

/**
 * Re-examine stored failures against the local index, mapping and
 * availability cache. No network calls.
 * @returns {{ checked: number, available: number, classified: number }}
 */
function recheck() {
  const now = Date.now();
  const index = catalogIndex.peek();
  const mappingReady = mapping.isReady();
  let checked = 0;
  let found = 0;
  let classified = 0;

  for (const r of Object.values(records)) {
    if (r.available?.confirmed) continue;
    checked++;
    if (r.category === 'unclassified' && mappingReady && r.imdbId) {
      const entries = mapping.getEntriesSync(r.imdbId);
      r.category = entries.length > 0 ? 'not_on_anilibria' : 'mapping_gap';
      if (entries.length > 0) r.mapping = snapshotMapping(entries);
      classified++;
    }
    const before = r.available;
    if (r.category === 'mapping_gap' && mappingReady && r.imdbId) {
      const entries = mapping.getEntriesSync(r.imdbId);
      if (entries.length > 0) {
        const release = index ? findIndexRelease(entries, index) : null;
        r.mapping = snapshotMapping(entries);
        r.available = before || { since: now, releaseId: release?.id ?? null, via: 'mapping', confirmed: false };
      }
    } else if (r.category === 'not_on_anilibria' && index) {
      const entries = r.mapping?.length ? r.mapping : (r.imdbId ? mapping.getEntriesSync(r.imdbId) : []);
      const release = findIndexRelease(entries, index);
      if (release) r.available = before || { since: now, releaseId: release.id, via: 'index', confirmed: false };
      else if (before && !before.confirmed) r.available = null;
    } else if (r.category === 'episode_missing' && r.releaseId) {
      const info = availability.peek(r.releaseId);
      const targets = Object.values(r.requested).map(q => q.target).filter(t => Number.isFinite(t));
      if (info && info.latestEpisode !== null && targets.length > 0 && info.latestEpisode >= Math.max(...targets)) {
        r.available = before || { since: now, releaseId: r.releaseId, via: 'release_update', confirmed: false };
        r.latestEpisode = info.latestEpisode;
      }
    }
    if (!before && r.available) found++;
  }
  if (found > 0 || classified > 0) store.schedule();
  return { checked, available: found, classified };
}

let recheckTimer = null;
let recheckDebounce = null;

function scheduleRecheck() {
  if (recheckDebounce) return;
  recheckDebounce = setTimeout(() => {
    recheckDebounce = null;
    try { recheck(); } catch (err) { console.warn('[missing] Recheck failed:', err.message); }
  }, RECHECK_DEBOUNCE_MS);
  recheckDebounce.unref?.();
}

catalogIndex.onRebuild(scheduleRecheck);
mapping.onRefresh(scheduleRecheck);

/** Classify imported entries, fetch missing titles, and recheck hourly. */
function start() {
  recheck();
  for (const r of Object.values(records)) if (!r.title && r.imdbId) enqueue(r.imdbId, r.type, 'title');
  if (!recheckTimer) {
    recheckTimer = setInterval(() => {
      try { recheck(); } catch (err) { console.warn('[missing] Recheck failed:', err.message); }
      prune();
    }, RECHECK_INTERVAL_MS);
    recheckTimer.unref();
  }
}

function stop() {
  clearInterval(recheckTimer);
  clearTimeout(recheckDebounce);
  recheckTimer = recheckDebounce = null;
}

// ─── Listing ─────────────────────────────────────────────────────────────────

/** Which tab a record belongs to. */
function statusOf(r) {
  const titleLevel = r.category !== 'episode_missing' && r.imdbId;
  if (titleLevel && overrides.getIgnored(r.imdbId)) return 'ignored';
  if (r.available) return 'now_available';
  if (titleLevel && overrides.getNotDubbed(r.imdbId)) return 'not_dubbed';
  return r.category === 'unclassified' ? 'not_on_anilibria' : r.category;
}

function toRow(r) {
  const requested = Object.entries(r.requested)
    .map(([label, q]) => ({ label, count: q.count, target: q.target ?? null }))
    .sort((a, b) => b.count - a.count);
  const ignored = r.imdbId ? overrides.getIgnored(r.imdbId) : null;
  const notDubbed = r.imdbId ? overrides.getNotDubbed(r.imdbId) : null;
  return {
    key: r.key,
    status: statusOf(r),
    category: r.category,
    imdbId: r.imdbId,
    releaseId: r.releaseId,
    season: r.season,
    type: r.type,
    title: r.title,
    mapping: r.mapping || [],
    requested,
    latestEpisode: r.latestEpisode,
    live: r.live,
    numbering: r.numbering,
    likelyCause: r.likelyCause,
    count: r.count,
    users: Object.keys(r.users).length,
    usersOverflow: r.usersOverflow,
    firstSeen: r.firstSeen,
    lastSeen: r.lastSeen,
    available: r.available,
    ignored,
    notDubbed,
  };
}

/** Rows for overrides that have no stored record (e.g. imported). */
function orphanRows(status) {
  const list = status === 'ignored' ? overrides.listIgnored() : status === 'not_dubbed' ? overrides.listNotDubbed() : [];
  return list
    .filter(o => !records[o.imdbId])
    .map(o => ({
      ...toRow({ ...newRecord(o.imdbId, 'not_on_anilibria', o.ignoredAt || o.markedAt), imdbId: o.imdbId }),
      status, count: 0, firstSeen: null, lastSeen: null,
    }));
}

const SORTS = {
  now_available: (a, b) => b.available.since - a.available.since,
  ignored: (a, b) => (b.ignored?.ignoredAt || 0) - (a.ignored?.ignoredAt || 0),
  not_dubbed: (a, b) => (b.notDubbed?.markedAt || 0) - (a.notDubbed?.markedAt || 0),
  default: (a, b) => b.users - a.users || b.count - a.count || (b.lastSeen || 0) - (a.lastSeen || 0),
};

/**
 * One tab of the Missing Titles page.
 * @param {{ category?: string, q?: string, page?: number, pageSize?: number }} [opts]
 */
function list({ category = 'not_on_anilibria', q = '', page = 1, pageSize = 50 } = {}) {
  const counts = Object.fromEntries(CATEGORIES.map(c => [c, 0]));
  const all = Object.values(records).map(toRow);
  for (const row of all) counts[row.status]++;
  const orphansIgnored = orphanRows('ignored');
  const orphansNotDubbed = orphanRows('not_dubbed');
  counts.ignored += orphansIgnored.length;
  counts.not_dubbed += orphansNotDubbed.length;

  const status = CATEGORIES.includes(category) ? category : 'not_on_anilibria';
  let rows = all.filter(r => r.status === status);
  if (status === 'ignored') rows = rows.concat(orphansIgnored);
  if (status === 'not_dubbed') rows = rows.concat(orphansNotDubbed);
  const needle = String(q || '').trim().toLowerCase();
  if (needle) rows = rows.filter(r => [r.title, r.imdbId, r.key, r.releaseId].some(v => v !== null && v !== undefined && String(v).toLowerCase().includes(needle)));
  rows.sort(SORTS[status] || SORTS.default);

  const total = rows.length;
  const totalPages = Math.max(1, Math.ceil(total / pageSize));
  const current = Math.min(Math.max(1, page), totalPages);
  return {
    category: status,
    counts,
    total,
    page: current,
    totalPages,
    pageSize,
    rows: rows.slice((current - 1) * pageSize, current * pageSize),
  };
}

/** Stored records related to an IMDB ID or catalog release (for the request drawer). */
function related({ imdbId = null, releaseId = null }) {
  return Object.values(records)
    .filter(r => (imdbId && r.imdbId === imdbId) || (!imdbId && releaseId && r.key === `ep:r${releaseId}`))
    .map(toRow);
}

/** Remove a record (it comes back if requested again). */
function dismiss(key) {
  if (!records[key]) return false;
  delete records[key];
  store.schedule();
  return true;
}

function enrichmentState() {
  return { queued: queue.length, pending: pending.size, checked: checkedNonAnime.stats().size, ...enrichment };
}

module.exports = {
  recordFailure, recordPassThrough, recordSuccess, recheck, start, stop,
  list, related, dismiss, enrichmentState, CATEGORIES,
  flush: () => store.flush(),
};
