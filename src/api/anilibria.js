/**
 * AniLibria API v1 client.
 *
 * Base URL: https://anilibria.top/api/v1/
 * Docs:     https://anilibria.top/api/docs/v1
 */

const axios = require('axios');
const NodeCache = require('node-cache');

/**
 * Thrown when Anilibria returns HTTP 403 or 451, indicating the content
 * is geo-blocked or legally restricted in the user's region.
 */
class GeoBlockedError extends Error {
  constructor(releaseId) {
    super(`Anilibria release ${releaseId} is geo-blocked or restricted`);
    this.name = 'GeoBlockedError';
    this.releaseId = releaseId;
  }
}

const BASE = 'https://anilibria.top/api/v1';

// Cache release details for 10 minutes to avoid hammering the API
const releaseCache = new NodeCache({ stdTTL: 600 });
// Cache search results for 1 hour
const searchCache  = new NodeCache({ stdTTL: 3600 });

const client = axios.create({
  baseURL: BASE,
  timeout: 15_000,
  headers: { 'User-Agent': 'stremio-anilibria-addon/1.0' },
});

/**
 * Search for releases by title string.
 * Returns an array of release objects (without full episode list).
 */
async function searchReleases(query) {
  const cacheKey = `search:${query.toLowerCase()}`;
  if (searchCache.has(cacheKey)) return searchCache.get(cacheKey);

  const { data } = await client.get('/anime/catalog/releases', {
    params: {
      'f[search]': query,
      limit: 10,
      page: 1,
    },
  });

  const results = data?.data || [];
  searchCache.set(cacheKey, results);
  return results;
}

/**
 * Fetch a full release object including its episodes array.
 * @param {number|string} id - Anilibria release ID
 */
async function getRelease(id) {
  if (releaseCache.has(id)) return releaseCache.get(id);

  try {
    const { data } = await client.get(`/anime/releases/${id}`);
    releaseCache.set(id, data);
    return data;
  } catch (err) {
    const status = err.response?.status;
    if (status === 403 || status === 451) {
      throw new GeoBlockedError(id);
    }
    throw err;
  }
}

/**
 * Get all releases from the catalog (paginated).
 * Used to pre-build the title lookup table.
 * Yields pages until exhausted.
 */
async function* allReleases(pageSize = 50) {
  let page = 1;
  while (true) {
    const { data } = await client.get('/anime/catalog/releases', {
      params: { limit: pageSize, page },
    });
    const items = data?.data || [];
    if (items.length === 0) break;
    yield items;
    if (items.length < pageSize) break;
    page++;
  }
}

/**
 * Store a release object in the cache (avoids re-fetching after alias lookup).
 */
function cacheRelease(id, data) {
  releaseCache.set(id, data);
}

module.exports = { searchReleases, getRelease, allReleases, cacheRelease, GeoBlockedError };
