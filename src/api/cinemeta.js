/**
 * Cinemeta Title Info Fetcher
 *
 * Fetches title metadata from Stremio's Cinemeta catalog.
 * Used to enrich failed lookups with a human-readable title and
 * to determine whether a given IMDB ID is anime.
 */

const axios = require('axios');

const BASE = 'https://v3-cinemeta.strem.io/meta';
const TIMEOUT_MS = 5_000;

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
    try {
      const { data } = await axios.get(`${BASE}/${type}/${imdbId}.json`, {
        timeout: TIMEOUT_MS,
      });
      if (data?.meta?.name) {
        const genres = (data.meta.genres || []).map(g => g.toLowerCase());
        const isAnime = genres.includes('anime') || genres.includes('animation');
        return { title: data.meta.name, isAnime };
      }
    } catch (err) {
      if (err.response?.status === 404) continue;
      // Network / timeout — try next type
      continue;
    }
  }
  return null;
}

/**
 * Backfill missing titles for failed lookups.
 *
 * @param {Array<{imdbId: string, title: string|null}>} failedLookups
 * @param {(imdbId: string, info: {title: string, isAnime: boolean}) => void} updateCallback
 * @param {{ cap?: number, delayMs?: number }} [opts]
 * @returns {Promise<number>} number of entries enriched
 */
async function backfillMissingTitles(failedLookups, updateCallback, opts = {}) {
  const cap = opts.cap || 50;
  const delayMs = opts.delayMs || 500;

  const missing = failedLookups.filter(e => !e.title);
  const batch = missing.slice(0, cap);
  let enriched = 0;

  for (const entry of batch) {
    try {
      const info = await fetchTitleInfo(entry.imdbId);
      if (info) {
        updateCallback(entry.imdbId, info);
        enriched++;
      }
    } catch {
      // skip this entry
    }
    if (batch.indexOf(entry) < batch.length - 1) {
      await new Promise(r => setTimeout(r, delayMs));
    }
  }

  return enriched;
}

module.exports = { fetchTitleInfo, backfillMissingTitles };
