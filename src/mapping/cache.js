/**
 * Fribb anime-lists mapping cache.
 *
 * Downloads anime-list-mini.json from the Fribb/anime-lists repo on startup
 * and builds fast lookup maps for IMDB <-> MAL/AniList/AniDB IDs.
 *
 * Source: https://github.com/Fribb/anime-lists
 */

const axios = require('axios');

const FRIBB_URL =
  'https://raw.githubusercontent.com/Fribb/anime-lists/master/anime-list-mini.json';

// Refresh the cache every 24 hours
const CACHE_TTL_MS = 24 * 60 * 60 * 1000;

// Maps populated on load:
// imdbId (string)  -> { mal_id, anilist_id, anidb_id }
// malId  (number)  -> imdbId
// anilistId (number) -> imdbId
// anidbId (number)   -> imdbId
const byImdb     = new Map();
const byMal      = new Map();
const byAnilist  = new Map();
const byAnidb    = new Map();

let lastLoaded = 0;
let loading    = null; // promise guard – avoid parallel fetches

async function load() {
  if (loading) return loading;

  loading = (async () => {
    console.log('[mapping] Downloading Fribb anime-list-mini.json …');
    const { data } = await axios.get(FRIBB_URL, { timeout: 30_000 });

    byImdb.clear();
    byMal.clear();
    byAnilist.clear();
    byAnidb.clear();

    for (const entry of data) {
      const imdb = entry.imdb_id;
      if (!imdb) continue;

      const rec = {
        mal_id:     entry.mal_id     || null,
        anilist_id: entry.anilist_id || null,
        anidb_id:   entry.anidb_id   || null,
      };

      byImdb.set(imdb, rec);
      if (rec.mal_id)     byMal.set(rec.mal_id, imdb);
      if (rec.anilist_id) byAnilist.set(rec.anilist_id, imdb);
      if (rec.anidb_id)   byAnidb.set(rec.anidb_id, imdb);
    }

    lastLoaded = Date.now();
    console.log(`[mapping] Loaded ${byImdb.size} IMDB-mapped entries.`);
  })();

  try {
    await loading;
  } finally {
    loading = null;
  }
}

async function ensureFresh() {
  if (Date.now() - lastLoaded > CACHE_TTL_MS) {
    await load();
  }
}

/**
 * Given an IMDB ID (e.g. "tt0388629"), return associated IDs.
 * @returns {{ mal_id, anilist_id, anidb_id } | null}
 */
async function getByImdb(imdbId) {
  await ensureFresh();
  return byImdb.get(imdbId) || null;
}

/**
 * Given a MAL ID, return the IMDB ID string, or null.
 */
async function getImdbByMal(malId) {
  await ensureFresh();
  return byMal.get(malId) || null;
}

/**
 * Given an AniList ID, return the IMDB ID string, or null.
 */
async function getImdbByAnilist(anilistId) {
  await ensureFresh();
  return byAnilist.get(anilistId) || null;
}

/** Number of IMDB entries currently loaded. */
function getMappingSize() {
  return byImdb.size;
}

module.exports = { load, getByImdb, getImdbByMal, getImdbByAnilist, getMappingSize };
