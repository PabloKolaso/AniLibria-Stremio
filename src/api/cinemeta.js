/**
 * Cinemeta client (Stremio's official metadata addon).
 *
 * Used to:
 *  1. Title and classify IMDB IDs outside the anime mapping (missing titles).
 *  2. Get per-season episode counts, needed to convert Stremio's
 *     season/episode numbering into absolute episode numbers for long
 *     single-entry shows (One Piece, Naruto Shippuden, Bleach, ...).
 */

const http     = require('./http');
const TTLCache = require('../util/ttl-cache');

const BASE    = 'https://v3-cinemeta.strem.io/meta';
const SERVICE = 'Cinemeta';

// imdbId:type -> meta object (or null when Cinemeta does not know the ID)
const metaCache = new TTLCache({ ttlMs: 12 * 60 * 60 * 1000, max: 5000, name: 'Cinemeta', description: 'Titles, genres and season sizes by IMDB ID' });
const inFlight  = new Map();

/**
 * Fetch Cinemeta meta for an IMDB ID and type.
 * @returns {Promise<object|null>} null if Cinemeta has no entry
 * @throws {HttpError} on transient failures
 */
async function getMeta(type, imdbId) {
  const key = `${type}:${imdbId}`;
  const cached = metaCache.get(key);
  if (cached !== undefined) return cached;
  if (inFlight.has(key)) return inFlight.get(key);

  const promise = (async () => {
    let meta = null;
    try {
      const data = await http.getJson(`${BASE}/${type}/${encodeURIComponent(imdbId)}.json`, {
        service: SERVICE, timeout: 6_000,
      });
      meta = data?.meta && typeof data.meta === 'object' ? data.meta : null;
    } catch (err) {
      if (err.status !== 404) throw err;
    }
    metaCache.set(key, meta);
    return meta;
  })();

  inFlight.set(key, promise);
  try {
    return await promise;
  } finally {
    inFlight.delete(key);
  }
}

/**
 * Fetch title info from Cinemeta for a given IMDB ID.
 *
 * @param {string} imdbId - e.g. "tt2741602"
 * @param {string} [typeHint] - "series" or "movie" (tried first)
 * @returns {Promise<{title: string, isAnime: boolean}|null>} null on failure
 */
async function fetchTitleInfo(imdbId, typeHint) {
  const types = typeHint === 'movie' ? ['movie', 'series'] : ['series', 'movie'];

  for (const type of types) {
    let meta;
    try {
      meta = await getMeta(type, imdbId);
    } catch {
      continue; // network / timeout — try the other type
    }
    if (meta?.name) {
      const genres = Array.isArray(meta.genres) ? meta.genres.map(g => String(g).toLowerCase()) : [];
      return { title: meta.name, isAnime: genres.includes('anime') };
    }
  }
  return null;
}

/**
 * Highest episode number of every regular season (season >= 1) of a series.
 *
 * @returns {Promise<Map<number, number>|null>} season -> episode count, or null if unknown
 * @throws {HttpError} on transient failures
 */
async function getSeasonEpisodeCounts(imdbId) {
  const meta = await getMeta('series', imdbId);
  const videos = Array.isArray(meta?.videos) ? meta.videos : [];
  const counts = new Map();
  for (const video of videos) {
    const season = Number(video.season);
    const episode = Number(video.episode ?? video.number);
    if (!Number.isInteger(season) || season < 1 || !Number.isFinite(episode)) continue;
    counts.set(season, Math.max(counts.get(season) || 0, episode));
  }
  return counts.size > 0 ? counts : null;
}

module.exports = { fetchTitleInfo, getSeasonEpisodeCounts };
