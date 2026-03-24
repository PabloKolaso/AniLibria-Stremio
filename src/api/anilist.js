/**
 * AniList GraphQL API client.
 *
 * Used to:
 *  1. Search for anime by English/romanized title → get AniList ID + MAL ID
 *  2. Get canonical English title for an anime we found via another ID
 *
 * Endpoint: https://graphql.anilist.co  (no auth required for reads)
 */

const axios = require('axios');
const NodeCache = require('node-cache');

const ENDPOINT = 'https://graphql.anilist.co';
const cache = new NodeCache({ stdTTL: 3600 });

const SEARCH_QUERY = `
query ($search: String, $type: MediaType) {
  Page(page: 1, perPage: 5) {
    media(search: $search, type: $type) {
      id
      idMal
      title {
        romaji
        english
        native
      }
      synonyms
    }
  }
}`;

const BY_ID_QUERY = `
query ($id: Int) {
  Media(id: $id, type: ANIME) {
    id
    idMal
    title {
      romaji
      english
      native
    }
    synonyms
  }
}`;

async function gql(query, variables) {
  const { data } = await axios.post(
    ENDPOINT,
    { query, variables },
    { headers: { 'Content-Type': 'application/json' }, timeout: 10_000 }
  );
  if (data.errors) throw new Error(data.errors[0].message);
  return data.data;
}

/**
 * Search AniList for anime by title.
 * Returns array of media results with id, idMal, title fields.
 */
async function searchAnime(title) {
  const key = `search:${title.toLowerCase()}`;
  if (cache.has(key)) return cache.get(key);

  const data = await gql(SEARCH_QUERY, { search: title, type: 'ANIME' });
  const results = data?.Page?.media || [];
  cache.set(key, results);
  return results;
}

/**
 * Get a single anime by AniList ID.
 */
async function getById(anilistId) {
  const key = `id:${anilistId}`;
  if (cache.has(key)) return cache.get(key);

  let data;
  try {
    data = await gql(BY_ID_QUERY, { id: anilistId });
  } catch (err) {
    console.warn(`[anilist] getById(${anilistId}) failed: ${err.message}`);
    return null;
  }
  const media = data?.Media || null;
  if (media) cache.set(key, media);
  return media;
}

/**
 * Collect all title variants for an AniList media object into a flat array.
 */
function collectTitles(media) {
  const titles = [];
  if (media.title?.english)  titles.push(media.title.english);
  if (media.title?.romaji)   titles.push(media.title.romaji);
  if (media.title?.native)   titles.push(media.title.native);
  if (media.synonyms)        titles.push(...media.synonyms);
  return titles.filter(Boolean);
}

module.exports = { searchAnime, getById, collectTitles };
