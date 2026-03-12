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
const axios = require('axios');

// ─── Title normalization helpers ─────────────────────────────────────────────

const STOP_WORDS = new Set(['the', 'a', 'an', 'of', 'in', 'on', 'and', 'or', 'no', 'wo', 'ga', 'wa']);

/** Strip special chars, lowercase, split into words */
function normalizeWords(str) {
  return str.toLowerCase().replace(/[^a-z0-9\s]/g, '').split(/\s+/).filter(Boolean);
}

/** Return first N words that are ≥3 chars and not stop words */
function significantWords(str, n = 2) {
  return normalizeWords(str).filter(w => w.length >= 3 && !STOP_WORDS.has(w)).slice(0, n);
}

const mappingCache = require('../mapping/cache');
const anilibria    = require('../api/anilibria');
const anilist      = require('../api/anilist');

// Cache: imdbId -> anilibria release id  (permanent for this session)
const resolvedMap = new NodeCache({ stdTTL: 86400, checkperiod: 600 });

// Anilibria full title index, built lazily on first use
let titleIndex = null;
let indexBuilding = null;
let indexSize = 0;
let indexBuiltAt = 0;
const INDEX_TTL_MS = 24 * 60 * 60 * 1000; // 24 hours

/**
 * Build (or return cached) Fuse.js search index over Anilibria catalog.
 * If the index was built empty (due to an earlier API error), it will
 * be rebuilt on the next call.
 */
async function getTitleIndex() {
  // Return cached index if still fresh; treat empty as not-yet-built
  if (titleIndex && indexSize > 0 && (Date.now() - indexBuiltAt < INDEX_TTL_MS)) return titleIndex;
  if (indexBuilding) return indexBuilding;

  indexBuilding = (async () => {
    console.log('[resolver] Building Anilibria title index …');
    const docs = [];

    try {
      for await (const page of anilibria.allReleases(50)) {
        for (const release of page) {
          const alias = release.alias || '';
          docs.push({
            id:         release.id,
            alias,
            aliasWords: alias.replace(/-/g, ' '),   // "one-piece" → "one piece" for Fuse
            en:         release.name?.english    || '',
            ru:         release.name?.main       || '',
            alt:        release.name?.alternative || '',
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
        { name: 'en',         weight: 2   },
        { name: 'aliasWords', weight: 1.5 },  // spaced version: "one piece" matches "One Piece"
        { name: 'alias',      weight: 1   },
        { name: 'alt',        weight: 1   },
        { name: 'ru',         weight: 0.5 },
      ],
      threshold: 0.25,
      includeScore: true,
    });
  })();

  try {
    titleIndex = await indexBuilding;
    indexBuiltAt = Date.now();
  } finally {
    indexBuilding = null;
  }

  return titleIndex;
}

/**
 * Convert a title string to a URL-friendly alias (slug).
 * e.g. "ONE PIECE" → "one-piece", "JoJo's" → "jojos-..."
 */
function toAlias(title) {
  return title
    .toLowerCase()
    .replace(/[''`]/g, '')           // strip apostrophes: "jojo's" → "jojos"
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '');
}

/** Strip trailing year, season, part, or Roman-numeral suffixes from a title. */
function stripSuffixes(title) {
  return title
    .replace(/\s*\(\d{4}\)\s*$/i, '')               // "(2011)"
    .replace(/\s+(?:season|part|s)\s*\d+\s*$/i, '') // "Season 2", "Part 3", "S2"
    .replace(/\s+[IVX]{1,4}\s*$/i, '')              // trailing " II", " III", " IV"
    .trim();
}

/**
 * Try to find an Anilibria release directly by its URL alias.
 * This is fast and accurate — no fuzzy matching needed.
 * Returns the release object or null.
 */
async function tryAliasList(titles) {
  // Expand each title with a suffix-stripped variant to handle e.g. "Hunter x Hunter (2011)"
  const expanded = [];
  for (const t of titles) {
    expanded.push(t);
    const s = stripSuffixes(t);
    if (s && s !== t) expanded.push(s);
  }

  // Build unique aliases, preserving title order (romaji first)
  const aliases = [];
  const seen = new Set();
  for (const title of expanded) {
    const alias = toAlias(title);
    if (!alias || alias.length < 2 || seen.has(alias)) continue;
    seen.add(alias);
    aliases.push(alias);
  }

  if (aliases.length === 0) return null;

  // Try aliases sequentially, stop on first hit (avoids firing many parallel 404s)
  for (const alias of aliases) {
    try {
      const { data } = await axios.get(`https://anilibria.top/api/v1/anime/releases/${alias}`, {
        timeout: 8_000,
        headers: { 'User-Agent': 'stremio-anilibria-addon/1.0' },
      });
      if (data?.id) {
        console.log(`[resolver] Alias lookup "${alias}" → release ${data.id} (${data.name?.english || data.name?.main})`);
        anilibria.cacheRelease(data.id, data);
        return data.id;
      }
    } catch {
      // 404 or timeout — try next alias
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

    const queryWords = significantWords(title, 2);
    if (queryWords.length === 0) continue;

    for (const candidate of results.slice(0, 3)) {
      const candidateName = (candidate.name?.english || candidate.name?.main || '').toLowerCase();
      const candidateWords = significantWords(candidateName, 2);

      if (candidateWords.length === 0) continue;
      if (candidateWords[0] !== queryWords[0]) {
        console.log(`[resolver] API search "${title}" discarded: "${candidateName}" (first: "${queryWords[0]}" ≠ "${candidateWords[0]}")`);
        continue;
      }

      if (candidateWords.length >= 2 && queryWords.length >= 2) {
        const w1 = candidateWords[1], w2 = queryWords[1];
        if (!w1.startsWith(w2.slice(0, 4)) && !w2.startsWith(w1.slice(0, 4))) {
          console.log(`[resolver] API search "${title}" discarded: "${candidateName}" (second: "${w2}" ≠ "${w1}")`);
          continue;
        }
      }

      console.log(`[resolver] API search "${title}" → release ${candidate.id} (${candidate.name?.english || candidate.name?.main})`);
      return candidate.id;
    }
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
    // Sanity check: require matching on the first two significant words.
    // This prevents false positives like "Mushoku Tensei" → "Mushoku no Eiyuu"
    // or "Shingeki no Kyojin" → "Shingeki no Bahamut".
    const matchedWords = significantWords(best.en || best.aliasWords || best.alias || '', 2);
    const queryWordSets = titleVariants.map(t => significantWords(t, 2)).filter(w => w.length > 0);

    const wordMatch = queryWordSets.some(qw => {
      if (qw[0] !== matchedWords[0]) return false;
      if (qw.length >= 2 && matchedWords.length >= 2) {
        const w1 = qw[1], w2 = matchedWords[1];
        return w1.startsWith(w2.slice(0, 4)) || w2.startsWith(w1.slice(0, 4));
      }
      return true;
    });

    if (wordMatch) {
      console.log(`[resolver] Fuse match "${best.en || best.ru}" (score ${bestScore.toFixed(3)})`);
      return best.id;
    }
    console.log(`[resolver] Fuse match discarded: ${JSON.stringify(queryWordSets)} ≠ ${JSON.stringify(matchedWords)} (title: "${best.en}")`);
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
/**
 * Internal resolution logic returning full metadata.
 * @param {string} imdbId
 * @returns {{ id: number|null, title: string|null, method: string|null, titleVariants: string[] }}
 */
async function _resolve(imdbId) {
  let anilibriaId = null;
  let method = null;
  let titleVariants = [];

  try {
    // Step 1: get associated IDs from Fribb mapping
    const ids = await mappingCache.getByImdb(imdbId);

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

      // Reorder: put rōmaji first — Anilibria catalogs by Japanese romanized names.
      // collectTitles returns [english, romaji, native, ...synonyms]; swap 0 and 1.
      if (titleVariants.length >= 2 && titleVariants[1]) {
        titleVariants = [titleVariants[1], titleVariants[0], ...titleVariants.slice(2)];
      }
    }

    console.log(`[resolver] Trying titles for ${imdbId}:`, titleVariants.slice(0, 3));

    if (titleVariants.length > 0) {
      // Step 3: try alias-based direct lookup (most accurate)
      anilibriaId = await tryAliasList(titleVariants);
      if (anilibriaId) method = 'alias';

      // Step 3.5: try Anilibria's own search API (catches alias mismatches)
      if (!anilibriaId) {
        anilibriaId = await tryAnilibriaSearch(titleVariants);
        if (anilibriaId) method = 'search';
      }

      // Step 4: fall back to fuzzy index search
      if (!anilibriaId) {
        anilibriaId = await findInIndex(titleVariants);
        if (anilibriaId) method = 'fuse';
      }
    }

    if (!anilibriaId) {
      console.warn(`[resolver] No Anilibria match for ${imdbId} (titles: ${titleVariants.slice(0, 2).join(', ')})`);
    }
  } catch (err) {
    console.error(`[resolver] Error resolving ${imdbId}:`, err.message);
    throw err;  // let the stream handler show an error to the user
  }

  const title = titleVariants[0] || null;
  const inFribb = titleVariants.length > 0;
  return { id: anilibriaId, title, method, titleVariants, inFribb };
}

/**
 * Resolve an IMDB ID to an Anilibria release ID.
 * Backwards-compatible: returns number|null.
 */
async function resolveImdbToAnilibria(imdbId) {
  const cached = resolvedMap.get(imdbId);
  if (cached !== undefined) {
    // cached is either a result object or null
    return cached ? cached.id : null;
  }

  const result = await _resolve(imdbId);

  if (result.id) {
    resolvedMap.set(imdbId, result);              // permanent for this session
  } else {
    resolvedMap.set(imdbId, null, 7200);          // retry after 2 hours
  }
  return result.id;
}

/**
 * Resolve an IMDB ID with full metadata (title, method, titleVariants).
 * @param {string} imdbId
 * @returns {{ id: number|null, title: string|null, method: string|null, titleVariants: string[] }}
 */
async function resolveImdbToAnilibriaDetailed(imdbId) {
  const cached = resolvedMap.get(imdbId);
  if (cached !== undefined) {
    if (cached) return { ...cached, method: cached.method || 'cache' };
    return { id: null, title: null, method: null, titleVariants: [] };
  }

  const result = await _resolve(imdbId);

  if (result.id) {
    resolvedMap.set(imdbId, result);
  } else {
    resolvedMap.set(imdbId, null, 7200);
  }
  return result;
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

/**
 * Resolve an Anilibria release ID directly from a list of title strings,
 * bypassing the IMDB→Fribb→AniList lookup chain.
 * Useful for scripts that already hold canonical titles.
 *
 * @param {string[]} titles - ordered list of title variants to try
 * @returns {number|null}
 */
async function resolveByTitles(titles) {
  if (!titles || titles.length === 0) return null;
  let id = await tryAliasList(titles);
  if (!id) id = await tryAnilibriaSearch(titles);
  if (!id) id = await findInIndex(titles);
  return id || null;
}

/** Whether the Fuse.js title index has been built with entries. */
function isIndexReady() {
  return indexSize > 0;
}

module.exports = { resolveImdbToAnilibria, resolveImdbToAnilibriaDetailed, resolveByTitles, clearCache, warmup, isIndexReady };
