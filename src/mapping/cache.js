/**
 * Fribb anime-lists mapping (IMDB ↔ MAL / AniList).
 *
 * Downloads anime-list-mini.json from the Fribb/anime-lists repo and keeps
 * every anime entry that has an IMDB ID, grouped by IMDB ID.
 *
 * One IMDB ID usually covers a whole show, while MAL/AniList have one entry
 * per season or cour. Each Fribb entry carries its TVDB season number and
 * episode offset — the same numbering Stremio (Cinemeta) uses — so a
 * request for `tt…:season:episode` can be mapped to the exact anime entry.
 *
 * The compact mapping is persisted to disk, so restarts do not depend on
 * GitHub being reachable, and the daily refresh runs in the background.
 *
 * Source: https://github.com/Fribb/anime-lists
 */

const path      = require('path');
const config    = require('../config');
const http      = require('../api/http');
const JsonStore = require('../util/json-store');
const { withTimeout } = require('../util/timeout');

const FRIBB_URL = 'https://raw.githubusercontent.com/Fribb/anime-lists/master/anime-list-mini.json';
const REFRESH_INTERVAL_MS = 24 * 60 * 60 * 1000;
const RETRY_INTERVAL_MS   = 10 * 60 * 1000;
const FIRST_LOAD_WAIT_MS  = 15_000;
const MIN_EXPECTED_ROWS   = 1000;
const CACHE_FILE    = path.join(config.dataDir, 'fribb-mapping.json');
const CACHE_VERSION = 1;

/** Thrown when no mapping data is available at all (first boot, GitHub unreachable). */
class MappingUnavailableError extends http.HttpError {
  constructor() {
    super('Anime ID mapping is not loaded yet', { code: 'UNAVAILABLE', service: 'Fribb' });
    this.name = 'MappingUnavailableError';
  }
}

/**
 * @typedef {{ type: string|null, mal: number|null, anilist: number|null,
 *             tvdbSeason: number|null, tvdbOffset: number }} MappingEntry
 */

let byImdb    = new Map(); // imdbId -> MappingEntry[]
let byAnilist = new Map(); // anilistId -> imdbId
let rows      = [];        // compact rows, as persisted
let fetchedAt = 0;         // when the current data was downloaded
let loading   = null;
let lastAttempt = 0;
let source    = null;      // 'disk' | 'download'
let lastError = null;      // { at, message } of the last failed download
let malWithImdb = null;    // Set of MAL IDs that have an IMDB ID (built lazily)
const refreshListeners = new Set();

const store = new JsonStore(CACHE_FILE, {
  serialize: () => ({ version: CACHE_VERSION, fetchedAt, rows }),
  debounceMs: 1000,
  label: 'Fribb mapping',
});

function positiveInt(value) {
  const n = Number(value);
  return Number.isInteger(n) && n > 0 ? n : null;
}

function nonNegativeInt(value) {
  const n = Number(value);
  return Number.isInteger(n) && n >= 0 ? n : null;
}

/**
 * Reduce a raw Fribb entry to [imdbIds, type, mal, anilist, tvdbSeason, tvdbOffset].
 * Entries without an IMDB ID, or without a MAL/AniList ID, are dropped:
 * AniDB-only entries also cover western cartoons, which are not anime.
 */
function compactEntry(entry) {
  if (!entry || typeof entry !== 'object') return null;
  const rawImdb = Array.isArray(entry.imdb_id) ? entry.imdb_id : [entry.imdb_id];
  const imdbIds = rawImdb.filter(id => typeof id === 'string' && /^tt\d+$/.test(id));
  const mal = positiveInt(entry.mal_id);
  const anilist = positiveInt(entry.anilist_id);
  if (imdbIds.length === 0 || (!mal && !anilist)) return null;
  return [
    imdbIds,
    typeof entry.type === 'string' ? entry.type.toUpperCase() : null,
    mal,
    anilist,
    nonNegativeInt(entry.season?.tvdb),
    nonNegativeInt(entry.episode_offset?.tvdb) || 0,
  ];
}

function applyRows(newRows) {
  const imdbMap = new Map();
  const anilistMap = new Map();
  for (const [imdbIds, type, mal, anilist, tvdbSeason, tvdbOffset] of newRows) {
    const entry = Object.freeze({ type, mal, anilist, tvdbSeason, tvdbOffset });
    for (const id of imdbIds) {
      let list = imdbMap.get(id);
      if (!list) imdbMap.set(id, (list = []));
      list.push(entry);
    }
    if (anilist && !anilistMap.has(anilist)) anilistMap.set(anilist, imdbIds[0]);
  }
  byImdb = imdbMap;
  byAnilist = anilistMap;
  rows = newRows;
  malWithImdb = null;
}

/** Replace the mapping with raw Fribb data (exported for tests and tooling). */
function loadFromRaw(data) {
  if (!Array.isArray(data)) throw new Error('unexpected Fribb payload (not an array)');
  const newRows = data.map(compactEntry).filter(Boolean);
  applyRows(newRows);
  return newRows.length;
}

function loadFromDisk() {
  const data = JsonStore.read(CACHE_FILE);
  if (data?.version !== CACHE_VERSION || !Array.isArray(data.rows)) return false;
  applyRows(data.rows.filter(row => Array.isArray(row) && row.length === 6 && Array.isArray(row[0])));
  fetchedAt = Number(data.fetchedAt) || 0;
  source = 'disk';
  console.log(`[mapping] Loaded ${byImdb.size} IMDB IDs from disk cache.`);
  return byImdb.size > 0;
}

/** Download the latest mapping from GitHub. Concurrent calls share one download. */
function refresh() {
  if (loading) return loading;
  lastAttempt = Date.now();
  loading = (async () => {
    console.log('[mapping] Downloading Fribb anime-list-mini.json …');
    const data = await http.getJson(FRIBB_URL, { service: 'Fribb', timeout: 60_000, retries: 1 });
    if (!Array.isArray(data)) throw new Error('unexpected Fribb payload (not an array)');
    const newRows = data.map(compactEntry).filter(Boolean);
    // Guard against a truncated or broken upstream file replacing good data
    if (newRows.length < MIN_EXPECTED_ROWS) {
      throw new Error(`Fribb mapping looks incomplete (${newRows.length} usable entries)`);
    }
    applyRows(newRows);
    fetchedAt = Date.now();
    source = 'download';
    lastError = null;
    store.schedule();
    console.log(`[mapping] Loaded ${byImdb.size} IMDB IDs (${newRows.length} anime entries).`);
    for (const listener of refreshListeners) {
      try { listener(); } catch (err) { console.warn('[mapping] Refresh listener failed:', err.message); }
    }
  })()
    .catch(err => {
      lastError = { at: Date.now(), message: err.message };
      throw err;
    })
    .finally(() => { loading = null; });
  return loading;
}

function isReady() {
  return byImdb.size > 0;
}

/** Start a background refresh when the data is stale, without blocking callers. */
function refreshInBackgroundIfStale() {
  if (loading) return;
  const stale = !isReady() || Date.now() - fetchedAt > REFRESH_INTERVAL_MS;
  if (!stale || Date.now() - lastAttempt < RETRY_INTERVAL_MS) return;
  refresh().catch(err => console.warn(`[mapping] Refresh failed (keeping current data): ${err.message}`));
}

/**
 * Startup: load the disk cache immediately, then refresh from GitHub in the
 * background if needed. Resolves once some mapping data is available or the
 * first download attempt has finished.
 */
async function init() {
  loadFromDisk();
  if (isReady()) {
    refreshInBackgroundIfStale();
    return;
  }
  try {
    await refresh();
  } catch (err) {
    console.error(`[mapping] Initial download failed: ${err.message}. Will retry in background.`);
  }
}

/** Load the mapping, downloading it if it is missing or stale (used by scripts). */
async function load() {
  if (!isReady()) loadFromDisk();
  if (!isReady() || Date.now() - fetchedAt > REFRESH_INTERVAL_MS) await refresh();
}

/**
 * All mapping entries for an IMDB ID (empty array when it is not an anime).
 * @returns {Promise<MappingEntry[]>}
 * @throws {MappingUnavailableError} when no mapping has been loaded yet
 */
async function getEntries(imdbId) {
  if (!isReady()) {
    // First boot without a disk cache: wait briefly for a download in progress.
    if (!loading && Date.now() - lastAttempt > 30_000) refresh().catch(() => {});
    if (loading) await withTimeout(loading, FIRST_LOAD_WAIT_MS).catch(() => {});
    if (!isReady()) throw new MappingUnavailableError();
  }
  refreshInBackgroundIfStale();
  return byImdb.get(imdbId) || [];
}

/** Given an AniList ID, return an associated IMDB ID string, or null. */
async function getImdbByAnilist(anilistId) {
  if (!isReady()) await load();
  return byAnilist.get(anilistId) || null;
}

/** Mapping entries for an IMDB ID without waiting ([] when not loaded). */
function getEntriesSync(imdbId) {
  return byImdb.get(imdbId) || [];
}

/** MAL IDs that the mapping links to at least one IMDB ID. */
function malIdsWithImdb() {
  if (!malWithImdb) {
    malWithImdb = new Set();
    for (const list of byImdb.values()) for (const e of list) if (e.mal) malWithImdb.add(e.mal);
  }
  return malWithImdb;
}

/** Download the mapping now (joins a download in progress). */
function forceRefresh() {
  return refresh();
}

/** Called after every successful download. */
function onRefresh(listener) {
  refreshListeners.add(listener);
}

/** Mapping status for the dashboard. */
function getInfo() {
  return {
    ready: isReady(),
    imdbIds: byImdb.size,
    entries: rows.length,
    fetchedAt: fetchedAt || null,
    source,
    loading: Boolean(loading),
    lastAttemptAt: lastAttempt || null,
    lastError,
    refreshIntervalMs: REFRESH_INTERVAL_MS,
  };
}

/** Number of IMDB IDs currently mapped. */
function getMappingSize() {
  return byImdb.size;
}

module.exports = {
  init,
  load,
  loadFromRaw,
  getEntries,
  getImdbByAnilist,
  getEntriesSync,
  malIdsWithImdb,
  getMappingSize,
  getInfo,
  forceRefresh,
  onRefresh,
  isReady,
  MappingUnavailableError,
};
