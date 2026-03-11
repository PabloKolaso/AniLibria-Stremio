/**
 * IMDB Title Info Fetcher
 *
 * Fetches basic title metadata from IMDB's public HTML (JSON-LD).
 * Used to enrich failed lookups with a human-readable title and to
 * determine whether a given IMDB ID is an anime.
 *
 * Anime detection: IMDB tags anime titles with interest "in0000027".
 */

const axios = require('axios');

const TIMEOUT_MS = 8_000;

const HEADERS = {
  'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
  'Accept-Language': 'en-US,en;q=0.9',
  'Accept': 'text/html,application/xhtml+xml',
};

/**
 * Fetch title info from IMDB for a given IMDB ID.
 *
 * @param {string} imdbId - e.g. "tt2741602"
 * @returns {Promise<{title: string, isAnime: boolean}|null>} null on failure
 */
async function fetchTitleInfo(imdbId) {
  let html;
  try {
    const { data } = await axios.get(`https://www.imdb.com/title/${imdbId}/`, {
      timeout: TIMEOUT_MS,
      headers: HEADERS,
      responseType: 'text',
    });
    html = data;
  } catch (err) {
    console.warn(`[imdb] Failed to fetch ${imdbId}: ${err.message}`);
    return null;
  }

  // Extract JSON-LD block (IMDB embeds structured data in the page)
  const jsonLdMatch = html.match(/<script type="application\/ld\+json">([\s\S]*?)<\/script>/);
  if (!jsonLdMatch) {
    console.warn(`[imdb] No JSON-LD found for ${imdbId}`);
    return null;
  }

  let data;
  try {
    data = JSON.parse(jsonLdMatch[1]);
  } catch {
    console.warn(`[imdb] Failed to parse JSON-LD for ${imdbId}`);
    return null;
  }

  const title = data.name || null;

  // Check anime interest tag "in0000027" anywhere in the raw HTML
  const isAnime = html.includes('in0000027');

  console.log(`[imdb] ${imdbId}: title="${title}" isAnime=${isAnime}`);
  return { title, isAnime };
}

module.exports = { fetchTitleInfo };
