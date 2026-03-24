/**
 * Jikan API v4 client (unofficial MyAnimeList API).
 *
 * Endpoint: https://api.jikan.moe/v4
 * No authentication required.
 * Rate limit: 3 requests/second, 60/minute.
 */

const axios = require('axios');

const BASE = 'https://api.jikan.moe/v4';

const client = axios.create({
  baseURL: BASE,
  timeout: 15_000,
  headers: { 'User-Agent': 'stremio-anilibria-addon/1.0' },
});

const PAGE_DELAY_MS = 1100; // ~0.9 req/s — safely under Jikan's 60/min limit
const MAX_RETRIES   = 3;
const RETRY_DELAY_MS = 5000; // wait 5s after a 429 before retrying

/**
 * Fetch top anime MAL IDs from Jikan.
 * @param {number} count - How many titles to fetch (default 350)
 * @returns {Promise<number[]>} Array of mal_id values
 */
async function getTopAnimeIds(count = 350) {
  const ids = [];
  let page = 1;

  while (ids.length < count) {
    let attempt = 0;
    let success = false;

    while (attempt < MAX_RETRIES && !success) {
      try {
        const { data } = await client.get('/top/anime', {
          params: { limit: 25, page },
        });

        const items = data?.data || [];
        if (items.length === 0) return ids.slice(0, count);

        for (const item of items) {
          if (item.mal_id) ids.push(item.mal_id);
        }

        if (!data?.pagination?.has_next_page) return ids.slice(0, count);
        success = true;
      } catch (err) {
        attempt++;
        const status = err.response?.status;
        if (status === 429 && attempt < MAX_RETRIES) {
          console.warn(`[jikan] Rate limited on page ${page}, retrying in ${RETRY_DELAY_MS}ms… (attempt ${attempt}/${MAX_RETRIES})`);
          await new Promise(r => setTimeout(r, RETRY_DELAY_MS));
        } else {
          console.warn(`[jikan] Failed to fetch page ${page}:`, err.message);
          return ids.slice(0, count);
        }
      }
    }

    page++;
    await new Promise(r => setTimeout(r, PAGE_DELAY_MS));
  }

  return ids.slice(0, count);
}

module.exports = { getTopAnimeIds };
