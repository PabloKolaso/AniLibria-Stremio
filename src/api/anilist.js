/**
 * AniList GraphQL API client.
 *
 * Used to get canonical titles (for title-based fallback matching and for
 * the dashboard) and the release year (to sanity-check ID matches) for an
 * anime identified by its AniList or MAL ID.
 *
 * Endpoint: https://graphql.anilist.co  (no auth required for reads)
 *
 * Results are cached for a week and persisted to disk: titles practically
 * never change and AniList enforces a tight per-minute rate limit.
 */

const path      = require('path');
const config    = require('../config');
const http      = require('./http');
const TTLCache  = require('../util/ttl-cache');
const JsonStore = require('../util/json-store');
const providers = require('../monitoring/providers');

const ENDPOINT   = 'https://graphql.anilist.co';
const SERVICE    = 'AniList';
const HIT_TTL_MS  = 7 * 24 * 60 * 60 * 1000;
const MISS_TTL_MS = 6 * 60 * 60 * 1000;
const CACHE_FILE  = path.join(config.dataDir, 'anilist-cache.json');
const CACHE_VERSION = 1;

const MEDIA_FIELDS = `
    id
    idMal
    format
    episodes
    seasonYear
    startDate { year }
    title { romaji english native }
    synonyms`;

const BY_ID_QUERY  = `query ($id: Int) { Media(id: $id, type: ANIME) {${MEDIA_FIELDS} } }`;
const BY_MAL_QUERY = `query ($idMal: Int) { Media(idMal: $idMal, type: ANIME) {${MEDIA_FIELDS} } }`;

// `trending` is AniList's measure of recent activity on an anime (what people
// are watching and discussing right now), unlike all-time `popularity`.
const TRENDING_QUERY = `query ($page: Int, $perPage: Int) {
  Page(page: $page, perPage: $perPage) {
    pageInfo { hasNextPage }
    media(type: ANIME, sort: [TRENDING_DESC, POPULARITY_DESC], isAdult: false) {${MEDIA_FIELDS}
      trending
      coverImage { medium }
    }
  }
}`;

// key ("id:123" | "mal:456") -> media object, or null for a confirmed "not found"
const cache = new TTLCache({ ttlMs: HIT_TTL_MS, max: 20_000, name: 'AniList', description: 'Anime titles and years by AniList/MAL ID (persisted, 7 days)' });
const store = new JsonStore(CACHE_FILE, {
  serialize: () => ({ version: CACHE_VERSION, entries: cache.toJSON() }),
  debounceMs: 10_000,
  label: 'AniList cache',
});
const inFlight = new Map();

// After a 429 we stop calling AniList until the advertised Retry-After passes.
let pausedUntil = 0;

/** Restore the persisted cache (call once at startup). */
function loadCache() {
  const data = JsonStore.read(CACHE_FILE);
  if (data?.version !== CACHE_VERSION) return 0;
  const loaded = cache.load(data.entries);
  if (loaded > 0) console.log(`[anilist] Loaded ${loaded} cached media entries from disk.`);
  return loaded;
}

async function gql(query, variables) {
  if (Date.now() < pausedUntil) {
    providers.recordSkip(SERVICE, 'rate-limit cooldown');
    throw new http.HttpError(`${SERVICE} rate-limit cooldown active`, { code: 'HTTP', status: 429, service: SERVICE });
  }
  let body;
  try {
    body = await http.postJson(ENDPOINT, { query, variables }, { service: SERVICE, timeout: 6_000, retries: 1 });
  } catch (err) {
    if (err.status === 429) {
      const seconds = parseInt(err.retryAfter, 10);
      pausedUntil = Date.now() + (Number.isFinite(seconds) && seconds > 0 ? seconds : 60) * 1000;
      console.warn(`[anilist] Rate limited; pausing AniList lookups for ${Math.round((pausedUntil - Date.now()) / 1000)}s`);
    }
    throw err;
  }
  if (body?.errors?.length) {
    const first = body.errors[0];
    throw new http.HttpError(`${SERVICE} GraphQL error: ${first.message}`, { code: 'HTTP', status: first.status || null, service: SERVICE });
  }
  return body?.data;
}

/**
 * Fetch one media object, using the cache.
 * @returns {Promise<object|null>} null when AniList has no such anime
 * @throws {HttpError} on transient failures (not cached)
 */
async function fetchMedia(key, query, variables) {
  const cached = cache.get(key);
  if (cached !== undefined) return cached;
  if (inFlight.has(key)) return inFlight.get(key);

  const promise = (async () => {
    let media;
    try {
      const data = await gql(query, variables);
      media = data?.Media || null;
    } catch (err) {
      if (err.status !== 404) throw err;
      media = null; // AniList answers unknown IDs with HTTP 404
    }
    if (media) {
      cache.set(`id:${media.id}`, media);
      if (media.idMal) cache.set(`mal:${media.idMal}`, media);
    }
    cache.set(key, media, media ? HIT_TTL_MS : MISS_TTL_MS);
    store.schedule();
    return media;
  })();

  inFlight.set(key, promise);
  try {
    return await promise;
  } finally {
    inFlight.delete(key);
  }
}

/** Get a single anime by AniList ID. */
function getById(anilistId) {
  return fetchMedia(`id:${anilistId}`, BY_ID_QUERY, { id: anilistId });
}

/** Get a single anime by MAL ID (uses the `idMal` variable, not text search). */
function getByMalId(malId) {
  return fetchMedia(`mal:${malId}`, BY_MAL_QUERY, { idMal: malId });
}

/**
 * Look up an anime by whichever IDs are known, preferring AniList's own ID.
 * @param {{ anilist?: number|null, mal?: number|null }} ids
 */
async function getMedia({ anilist, mal }) {
  if (anilist) {
    const media = await getById(anilist);
    if (media) return media;
  }
  if (mal) return getByMalId(mal);
  return null;
}

/**
 * Anime trending on AniList right now, most trending first.
 * Results also warm the media cache used by IMDB stream lookups.
 *
 * @param {{ pages?: number, perPage?: number }} [opts]
 * @returns {Promise<object[]>} media objects (with `trending`)
 * @throws {HttpError} when any page fails (callers keep their previous list)
 */
async function getTrending({ pages = 2, perPage = 50 } = {}) {
  const media = [];
  for (let page = 1; page <= pages; page++) {
    const data = await gql(TRENDING_QUERY, { page, perPage });
    const items = data?.Page?.media;
    if (!Array.isArray(items)) {
      throw new http.HttpError(`${SERVICE} trending page ${page} has an unexpected shape`, { code: 'PARSE', service: SERVICE });
    }
    for (const item of items) {
      if (!item || !Number.isInteger(item.id)) continue;
      media.push(item);
      cache.set(`id:${item.id}`, item);
      if (item.idMal) cache.set(`mal:${item.idMal}`, item);
    }
    if (!data.Page.pageInfo?.hasNextPage) break;
  }
  store.schedule();
  return media;
}

/**
 * Collect all title variants for an AniList media object into a flat array.
 * Romaji is placed first because Anilibria catalogues by romanized Japanese names.
 * English follows as a strong secondary signal for alias/search matching.
 */
function collectTitles(media) {
  if (!media) return [];
  const titles = [media.title?.romaji, media.title?.english, media.title?.native, ...(media.synonyms || [])];
  return [...new Set(titles.filter(t => typeof t === 'string' && t.trim()))];
}

/**
 * Cached media for an anime entry, without any network call.
 * @returns {object|null|undefined} undefined when not cached
 */
function peekMedia({ anilist, mal } = {}) {
  if (anilist) {
    const media = cache.get(`id:${anilist}`);
    if (media !== undefined) return media;
  }
  return mal ? cache.get(`mal:${mal}`) : undefined;
}

/** AniList rate-limit state: lookups are paused after an HTTP 429. */
function rateLimit() {
  const remainingMs = Math.max(0, pausedUntil - Date.now());
  return { paused: remainingMs > 0, pausedUntil: pausedUntil || null, remainingMs };
}

/** First-air year of a media object, or null. */
function mediaYear(media) {
  return media?.seasonYear || media?.startDate?.year || null;
}

module.exports = {
  getById, getByMalId, getMedia, getTrending, collectTitles, mediaYear, peekMedia, rateLimit,
  loadCache, flushCache: () => store.flush(),
};
