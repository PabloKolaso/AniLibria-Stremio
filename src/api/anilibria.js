/**
 * AniLibria API v1 client.
 *
 * Base URL: https://anilibria.top/api/v1/ (override with ANILIBRIA_API_URL)
 * Docs:     https://anilibria.top/api/docs/v1
 *
 * AniLibria offers no push mechanism (no websocket, webhook or change feed
 * with a "since" parameter). Freshness comes from short cache lifetimes for
 * releases that are being dubbed right now, plus targeted invalidation driven
 * by polling /anime/releases/latest (see catalogs/releasing.js).
 */

const config   = require('../config');
const http     = require('./http');
const TTLCache = require('../util/ttl-cache');

/**
 * Thrown when AniLibria returns HTTP 403 or 451, indicating the content
 * is geo-blocked or legally restricted in the server's region.
 */
class GeoBlockedError extends Error {
  constructor(releaseId) {
    super(`Anilibria release ${releaseId} is geo-blocked or restricted`);
    this.name = 'GeoBlockedError';
    this.releaseId = releaseId;
  }
}

const BASE    = config.anilibriaApiUrl;
const SERVICE = 'AniLibria';

/** Origin serving posters and episode previews (paths in the API are relative). */
const MEDIA_ORIGIN = new URL(BASE).origin;

// Release details (episodes + HLS links). Releases being dubbed right now get
// a short lifetime so new episodes show up quickly; finished ones rarely change.
const LIVE_RELEASE_TTL_MS    = 2 * 60 * 1000;
const SETTLED_RELEASE_TTL_MS = 30 * 60 * 1000;
// Last successfully fetched copy, served when AniLibria is temporarily failing.
const LAST_GOOD_TTL_MS       = 24 * 60 * 60 * 1000;
const BULK_LIMIT = 50; // the API rejects larger pages

const releaseCache  = new TTLCache({ ttlMs: SETTLED_RELEASE_TTL_MS, max: 1000, name: 'AniLibria releases', description: 'Full releases with episodes (2 min while being dubbed, 30 min otherwise)' }); // id -> { data, fetchedAt }
const lastGood      = new TTLCache({ ttlMs: LAST_GOOD_TTL_MS, max: 1000, name: 'AniLibria last-good copies', description: 'Served when AniLibria is failing' }); // id -> { data, fetchedAt }
const notFoundCache = new TTLCache({ ttlMs: 10 * 60 * 1000, max: 5000, name: 'AniLibria not-found', description: 'Release IDs/aliases AniLibria answered 404 for' });
const searchCache   = new TTLCache({ ttlMs: 60 * 60 * 1000, max: 2000, name: 'AniLibria search', description: 'Title search results' });
const aliasToId     = new Map();
const inFlight      = new Map();

function apiUrl(pathname, params = {}) {
  const url = new URL(BASE + pathname);
  for (const [key, value] of Object.entries(params)) {
    if (Array.isArray(value)) for (const v of value) url.searchParams.append(key, String(v));
    else url.searchParams.set(key, String(value));
  }
  return url.toString();
}

/** Whether AniLibria is still publishing episodes for this release. */
function isLive(release) {
  return Boolean(release?.is_in_production || release?.is_ongoing);
}

function validRelease(data) {
  return data && typeof data.id === 'number' && Number.isInteger(data.id);
}

/** Cache a full release object (with episodes). */
function storeRelease(data) {
  const entry = { data, fetchedAt: Date.now() };
  const key = String(data.id);
  releaseCache.set(key, entry, isLive(data) ? LIVE_RELEASE_TTL_MS : SETTLED_RELEASE_TTL_MS);
  lastGood.set(key, entry);
  notFoundCache.delete(key);
  if (typeof data.alias === 'string' && data.alias) {
    aliasToId.set(data.alias, data.id);
    notFoundCache.delete(data.alias);
  }
}

function cacheKey(idOrAlias) {
  const key = String(idOrAlias);
  if (/^\d+$/.test(key)) return key;
  const id = aliasToId.get(key);
  return id ? String(id) : key;
}

/**
 * Fetch a full release object including its episodes array.
 *
 * @param {number|string} idOrAlias - numeric release ID or URL alias ("one-piece")
 * @param {{ maxAgeMs?: number }} [opts] - refetch if the cached copy is older than this
 * @returns {Promise<object|null>} null when the release does not exist
 * @throws {GeoBlockedError|HttpError} (transient errors only when no previous copy exists)
 */
async function getRelease(idOrAlias, { maxAgeMs } = {}) {
  const key = cacheKey(idOrAlias);
  const cached = releaseCache.get(key);
  if (cached && (maxAgeMs === undefined || Date.now() - cached.fetchedAt <= maxAgeMs)) return cached.data;
  if (!cached && notFoundCache.has(key)) return null;
  if (inFlight.has(key)) return inFlight.get(key);

  const promise = (async () => {
    let data;
    try {
      data = await http.getJson(apiUrl(`/anime/releases/${encodeURIComponent(key)}`), {
        service: SERVICE, timeout: 10_000, retries: 1,
      });
    } catch (err) {
      if (err.status === 404) {
        notFoundCache.set(key, true);
        releaseCache.delete(key);
        lastGood.delete(key);
        return null;
      }
      if (err.status === 403 || err.status === 451) throw new GeoBlockedError(key);
      const stale = lastGood.get(key);
      if (stale) {
        console.warn(`[anilibria] ${err.message}; serving release ${key} from ${Math.round((Date.now() - stale.fetchedAt) / 1000)}s ago`);
        return stale.data;
      }
      throw err;
    }
    if (!validRelease(data)) {
      throw new http.HttpError(`${SERVICE} returned an unexpected payload for release ${key}`, { code: 'PARSE', service: SERVICE });
    }
    storeRelease(data);
    return data;
  })();

  inFlight.set(key, promise);
  try {
    return await promise;
  } finally {
    inFlight.delete(key);
  }
}

/** The cached copy of a release (no network), or null. */
function peekRelease(id) {
  return releaseCache.get(String(id))?.data || null;
}

/** Drop the cached copy of a release so the next read refetches it. */
function invalidateRelease(id) {
  releaseCache.delete(String(id));
}

/**
 * Fetch full releases (with episodes) in bulk: 50 per request via
 * /anime/releases/list. Every result is cached.
 *
 * @param {number[]} ids
 * @returns {Promise<Map<number, object>>} releases that exist, by ID
 * @throws {HttpError}
 */
async function getReleasesByIds(ids) {
  const unique = [...new Set(ids.filter(id => Number.isInteger(id) && id > 0))];
  const found = new Map();
  for (let i = 0; i < unique.length; i += BULK_LIMIT) {
    const chunk = unique.slice(i, i + BULK_LIMIT);
    const key = `list:${chunk.join(',')}`;
    let promise = inFlight.get(key);
    if (!promise) {
      promise = http.getJson(apiUrl('/anime/releases/list', { 'ids[]': chunk, limit: BULK_LIMIT, page: 1 }), {
        service: SERVICE, timeout: 30_000, retries: 1,
      }).finally(() => inFlight.delete(key));
      inFlight.set(key, promise);
    }
    const data = await promise;
    if (!Array.isArray(data?.data)) {
      throw new http.HttpError(`${SERVICE} bulk release list has an unexpected shape`, { code: 'PARSE', service: SERVICE });
    }
    for (const release of data.data) {
      if (!validRelease(release)) continue;
      storeRelease(release);
      found.set(release.id, release);
    }
  }
  return found;
}

/**
 * Search releases by title via AniLibria's catalog search.
 * Returns release summaries (no episodes).
 */
async function searchReleases(query) {
  const key = query.toLowerCase();
  const cached = searchCache.get(key);
  if (cached) return cached;

  const data = await http.getJson(apiUrl('/anime/catalog/releases', { 'f[search]': query, limit: 10, page: 1 }), {
    service: SERVICE, timeout: 10_000,
  });
  const results = Array.isArray(data?.data) ? data.data : [];
  searchCache.set(key, results);
  return results;
}

/**
 * Fetch one page of the release catalog (optionally filtered).
 * The API caps `limit` at 50.
 *
 * @returns {Promise<{ items: object[], totalPages: number|null }>}
 */
async function fetchCatalogPage(page, limit = 50, filters = {}) {
  const data = await http.getJson(apiUrl('/anime/catalog/releases', { ...filters, limit, page }), {
    service: SERVICE, timeout: 15_000, retries: 2,
  });
  if (!Array.isArray(data?.data)) {
    throw new http.HttpError(`${SERVICE} catalog page ${page} has an unexpected shape`, { code: 'PARSE', service: SERVICE });
  }
  const totalPages = Number(data.meta?.pagination?.total_pages);
  return { items: data.data, totalPages: Number.isFinite(totalPages) ? totalPages : null };
}

/**
 * Releases AniLibria is dubbing right now ("Сейчас в озвучке"), most recently
 * updated first. Summaries only (no episodes).
 */
async function fetchInProductionReleases() {
  const filters = { 'f[production_statuses][]': 'IS_IN_PRODUCTION', 'f[sorting]': 'FRESH_AT_DESC' };
  const releases = [];
  for (let page = 1; page <= 20; page++) {
    const { items, totalPages } = await fetchCatalogPage(page, BULK_LIMIT, filters);
    releases.push(...items);
    if (items.length < BULK_LIMIT || (totalPages !== null && page >= totalPages)) break;
  }
  return releases.filter(validRelease);
}

/**
 * Most recently updated releases (new episodes first), each with its
 * `latest_episode`. Used as a change feed.
 */
async function fetchLatestReleases(limit = BULK_LIMIT) {
  const data = await http.getJson(apiUrl('/anime/releases/latest', { limit: Math.min(limit, BULK_LIMIT) }), {
    service: SERVICE, timeout: 15_000, retries: 1,
  });
  if (!Array.isArray(data)) {
    throw new http.HttpError(`${SERVICE} latest releases have an unexpected shape`, { code: 'PARSE', service: SERVICE });
  }
  return data.filter(validRelease);
}

/**
 * Get the franchise containing a release (all related seasons/movies).
 * Uses GET /anime/franchises/release/{releaseId}.
 *
 * @returns {Promise<object|null>} franchise with franchise_releases[], or null if none exists
 * @throws {HttpError} on transient failures, so callers do not cache a false "no franchise"
 */
async function getFranchiseByRelease(releaseId) {
  try {
    const data = await http.getJson(apiUrl(`/anime/franchises/release/${encodeURIComponent(releaseId)}`), {
      service: SERVICE, timeout: 10_000, retries: 1,
    });
    // The API returns an array; take the first (and only) franchise object.
    return Array.isArray(data) ? (data[0] || null) : (data || null);
  } catch (err) {
    if (err.status === 404) return null;
    throw err;
  }
}

/** AniLibria web page of a release (by its alias), or null. */
function releaseUrl(alias) {
  return typeof alias === 'string' && alias ? `${MEDIA_ORIGIN}/anime/releases/release/${encodeURIComponent(alias)}` : null;
}

/** AniLibria web catalog searched for a title. */
function searchUrl(title) {
  const q = typeof title === 'string' ? title.trim() : '';
  return `${MEDIA_ORIGIN}/anime/catalog${q ? `?search=${encodeURIComponent(q)}` : ''}`;
}

/** Absolute URL for a media path returned by the API ("/storage/..."). */
function mediaUrl(path) {
  if (typeof path !== 'string' || !path) return null;
  if (/^https?:\/\//.test(path)) return path;
  return path.startsWith('/') ? MEDIA_ORIGIN + path : null;
}

module.exports = {
  getRelease,
  peekRelease,
  invalidateRelease,
  getReleasesByIds,
  storeRelease,
  searchReleases,
  fetchCatalogPage,
  fetchInProductionReleases,
  fetchLatestReleases,
  getFranchiseByRelease,
  isLive,
  mediaUrl,
  releaseUrl,
  searchUrl,
  WEB_ORIGIN: MEDIA_ORIGIN,
  GeoBlockedError,
  LIVE_RELEASE_TTL_MS,
};
