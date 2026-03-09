/**
 * ID Bridge & Title Resolver
 *
 * Connects Stremio's IMDB IDs to Anilibria release IDs using:
 *  1. Fribb anime-lists (IMDB → MAL/AniList ID)
 *  2. AniList API (AniList ID → canonical titles)
 *  3. Alias-based direct lookup on Anilibria (fast + accurate)
 *  4. Fuse.js fuzzy matching over the full Anilibria catalog
 *
 * The resolved mapping is cached in memory so each anime is only
 * looked up once per server lifetime.
 */

const Fuse = require('fuse.js');
const NodeCache = require('node-cache');

const mappingCache = require('../mapping/cache');
const anilibria    = require('../api/anilibria');
const anilist      = require('../api/anilist');

// Cache: imdbId -> anilibria release id  (permanent for this session)
const resolvedMap = new NodeCache({ stdTTL: 0, checkperiod: 0 });

// Anilibria full title index, built lazily on first use
let titleIndex = null;
let indexBuilding = null;
let indexSize = 0;

/**
 * Build (or return cached) Fuse.js search index over Anilibria catalog.
 * If the index was built empty (due to an earlier API error), it will
 * be rebuilt on the next call.
 */
async function getTitleIndex() {
  // Treat an empty index as not-yet-built so we retry
  if (titleIndex && indexSize > 0) return titleIndex;
  if (indexBuilding) return indexBuilding;

  indexBuilding = (async () => {
    console.log('[resolver] Building Anilibria title index …');
    const docs = [];

    try {
      for await (const page of anilibria.allReleases(50)) {
        for (const release of page) {
          docs.push({
            id:     release.id,
            alias:  release.alias || '',
            en:     release.name?.english    || '',
            ru:     release.name?.main       || '',
            alt:    release.name?.alternative || '',
          });
        }
      }
    } catch (err) {
      const detail = err.response?.data ? JSON.stringify(err.response.data) : err.message;
      console.warn('[resolver] Could not fully fetch Anilibria catalog:', detail);
    }

    indexSize = docs.length;
    console.log(`[resolver] Indexed ${indexSize} Anilibria releases.`);

    return new Fuse(docs, {
      keys: [
        { name: 'en',    weight: 2 },
        { name: 'alias', weight: 1.5 },
        { name: 'alt',   weight: 1 },
        { name: 'ru',    weight: 0.5 },
      ],
      threshold: 0.25,
      includeScore: true,
    });
  })();

  try {
    titleIndex = await indexBuilding;
  } finally {
    indexBuilding = null;
  }

  return titleIndex;
}

/**
 * Convert a title string to a URL-friendly alias (slug).
 * e.g. "ONE PIECE" → "one-piece", "Hunter x Hunter" → "hunter-x-hunter"
 */
function toAlias(title) {
  return title
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '');
}

/**
 * Try to find an Anilibria release directly by its URL alias.
 * This is fast and accurate — no fuzzy matching needed.
 * Returns the release object or null.
 */
async function tryAliasList(titles) {
  const { getRelease } = anilibria;
  // Only try the GET /releases/{id} endpoint with alias strings
  // It returns 404 for unknown aliases
  const axios = require('axios');

  for (const title of titles) {
    const alias = toAlias(title);
    if (!alias || alias.length < 2) continue;
    try {
      const { data } = await axios.get(
        `https://anilibria.top/api/v1/anime/releases/${alias}`,
        { timeout: 8_000, headers: { 'User-Agent': 'stremio-anilibria-addon/1.0' } }
      );
      if (data?.id) {
        console.log(`[resolver] Alias lookup "${alias}" → release ${data.id} (${data.name?.english || data.name?.main})`);
        return data.id;
      }
    } catch {
      // 404 or other – try the next title
    }
  }
  return null;
}

/**
 * Try to find an Anilibria release using Anilibria's own search API.
 * Called after alias lookup fails but before the full Fuse.js index scan.
 *
 * Validates the top result by requiring its first significant word to match
 * the query's first significant word (prevents false positives).
 *
 * @param {string[]} titles
 * @returns {number|null}
 */
async function tryAnilibriaSearch(titles) {
  const STOP = new Set(['the', 'a', 'an', 'of', 'in', 'on', 'and', 'or', 'no', 'wo', 'ga', 'wa']);

  for (const title of titles) {
    if (!title || title.length < 3) continue;
    // Skip purely non-Latin titles (Japanese native, etc.) — Anilibria search works best with Latin
    if (!/[a-zA-Z]/.test(title)) continue;

    let results;
    try {
      results = await anilibria.searchReleases(title);
    } catch {
      continue;
    }

    if (!results || results.length === 0) continue;

    const top = results[0];
    const candidateName = (top.name?.english || top.name?.main || '').toLowerCase();
    const candidateFirstWord = candidateName.split(/\s+/).filter(w => w.length > 1)[0] || '';

    const queryFirstWord = title.toLowerCase().split(/\s+/)
      .filter(w => w.length > 3 && !STOP.has(w))[0];

    if (!queryFirstWord) continue;

    if (candidateFirstWord.startsWith(queryFirstWord.slice(0, 5))) {
      console.log(`[resolver] API search "${title}" → release ${top.id} (${top.name?.english || top.name?.main})`);
      return top.id;
    }
    console.log(`[resolver] API search "${title}" discarded: "${candidateName}" (query first: "${queryFirstWord}")`);
  }
  return null;
}

/**
 * Search Anilibria title index for the best matching release ID.
 * Tries multiple title variants; also validates the result by checking
 * that the matched title is a genuine substring match (not just fuzzy noise).
 *
 * @param {string[]} titleVariants
 * @returns {number|null}
 */
async function findInIndex(titleVariants) {
  const index = await getTitleIndex();
  if (!index) return null;

  let best = null;
  let bestScore = Infinity;

  for (const title of titleVariants) {
    if (!title) continue;
    const results = index.search(title, { limit: 3 });
    for (const r of results) {
      if (r.score < bestScore) {
        bestScore = r.score;
        best = r.item;
      }
    }
  }

  if (best && bestScore < 0.25) {
    // Sanity check: the FIRST significant word of the query must be the FIRST word
    // of the matched title. This prevents "Attack on Titan" from matching something
    // like "Nagatoro 2nd Attack" just because both contain the word "attack".
    const matchedFirstWord = (best.en || best.alias || '').toLowerCase().split(/\s+/)[0] || '';

    const STOP = new Set(['the', 'a', 'an', 'of', 'in', 'on', 'and', 'or', 'no', 'wo', 'ga', 'wa']);

    // Collect the FIRST meaningful word from EACH title variant.
    // Any one of them matching the result's first word is enough.
    const queryFirstWords = titleVariants
      .map(t => t.toLowerCase().split(/\s+/).filter(w => w.length > 3 && !STOP.has(w))[0])
      .filter(Boolean);

    const firstWordMatch = queryFirstWords.some(w => matchedFirstWord.startsWith(w.slice(0, 5)));

    if (firstWordMatch) {
      console.log(`[resolver] Fuse match "${best.en || best.ru}" (score ${bestScore.toFixed(3)})`);
      return best.id;
    }
    console.log(`[resolver] Fuse match discarded: ${JSON.stringify(queryFirstWords)} ≠ "${matchedFirstWord}" (title: "${best.en}")`);
  }

  return null;
}

/**
 * Resolve an IMDB ID to an Anilibria release ID.
 *
 * Resolution chain:
 *  1. IMDB ID → Fribb map → AniList ID
 *  2. AniList ID → canonical titles (English, romaji, synonyms)
 *  3. Try alias-based direct lookup on Anilibria API (fast, no false positives)
 *  4. Try Fuse.js index search (full catalog fuzzy match)
 *
 * @param {string} imdbId - e.g. "tt0388629"
 * @returns {number|null}
 */
async function resolveImdbToAnilibria(imdbId) {
  const cached = resolvedMap.get(imdbId);
  if (cached !== undefined) return cached;

  let anilibriaId = null;

  try {
    // Step 1: get associated IDs from Fribb mapping
    const ids = await mappingCache.getByImdb(imdbId);
    let titleVariants = [];

    if (ids?.anilist_id || ids?.mal_id) {
      // Step 2: fetch canonical titles from AniList
      if (ids.anilist_id) {
        const media = await anilist.getById(ids.anilist_id);
        if (media) titleVariants = anilist.collectTitles(media);
      }
      // Fallback: search AniList by MAL ID
      if (titleVariants.length === 0 && ids.mal_id) {
        const results = await anilist.searchAnime(`mal:${ids.mal_id}`).catch(() => []);
        const match = results.find(r => r.idMal === ids.mal_id);
        if (match) titleVariants = anilist.collectTitles(match);
      }
    }

    console.log(`[resolver] Trying titles for ${imdbId}:`, titleVariants.slice(0, 3));

    if (titleVariants.length > 0) {
      // Step 3: try alias-based direct lookup (most accurate)
      anilibriaId = await tryAliasList(titleVariants);

      // Step 3.5: try Anilibria's own search API (catches alias mismatches)
      if (!anilibriaId) {
        anilibriaId = await tryAnilibriaSearch(titleVariants);
      }

      // Step 4: fall back to fuzzy index search
      if (!anilibriaId) {
        anilibriaId = await findInIndex(titleVariants);
      }
    }

    if (!anilibriaId) {
      console.warn(`[resolver] No Anilibria match for ${imdbId} (titles: ${titleVariants.slice(0, 2).join(', ')})`);
    }
  } catch (err) {
    console.error(`[resolver] Error resolving ${imdbId}:`, err.message);
  }

  if (anilibriaId) {
    resolvedMap.set(imdbId, anilibriaId);        // permanent for this session
  } else {
    resolvedMap.set(imdbId, null, 300);          // retry after 5 minutes
  }
  return anilibriaId;
}

/**
 * Pre-warm the title index in the background (call on server start).
 */
function warmup() {
  getTitleIndex().catch(err =>
    console.warn('[resolver] Warmup failed:', err.message)
  );
}

/**
 * Remove a cached resolution result so the next call re-resolves from scratch.
 * Used by the debug endpoint to force a fresh lookup.
 */
function clearCache(imdbId) {
  resolvedMap.del(imdbId);
}

module.exports = { resolveImdbToAnilibria, clearCache, warmup };
