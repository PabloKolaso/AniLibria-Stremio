/**
 * Prewarm — Pre-resolve popular anime titles on startup.
 *
 * Fetches top anime from MyAnimeList (via Jikan API), maps MAL IDs
 * to IMDB IDs via Fribb, and pre-resolves them through the resolver
 * so the first user request is instant (cache hit).
 */

const jikan       = require('./api/jikan');
const mappingCache = require('./mapping/cache');
const resolver     = require('./bridge/resolver');

/**
 * Prewarm the resolver cache with top anime from MAL.
 * Runs as a non-blocking background task — never throws.
 *
 * @param {Object} [options]
 * @param {number} [options.count=200]       - Number of top MAL titles to fetch
 * @param {number} [options.concurrency=1]   - Parallel resolution tasks (keep low: AniList rate limit ~90 req/min)
 * @param {number} [options.batchDelay=800]  - Ms between batches (800ms → ~1.25 req/s, safely under AniList limit)
 */
async function prewarmTopAnime({ count = 200, concurrency = 1, batchDelay = 800 } = {}) {
  console.log(`[prewarm] Fetching top ${count} anime from MAL …`);

  let malIds;
  try {
    malIds = await jikan.getTopAnimeIds(count);
  } catch (err) {
    console.warn('[prewarm] Failed to fetch MAL top anime:', err.message);
    return;
  }

  if (malIds.length === 0) {
    console.warn('[prewarm] No MAL IDs received, skipping.');
    return;
  }

  console.log(`[prewarm] Got ${malIds.length} MAL IDs, mapping to IMDB …`);

  // Map MAL IDs to IMDB IDs via Fribb
  const imdbIds = [];
  let noMapping = 0;
  let alreadyCached = 0;

  for (const malId of malIds) {
    const imdbId = await mappingCache.getImdbByMal(malId);
    if (!imdbId) { noMapping++; continue; }
    if (resolver.hasCached(imdbId)) { alreadyCached++; continue; }
    imdbIds.push(imdbId);
  }

  console.log(`[prewarm] ${imdbIds.length} to resolve (${alreadyCached} already cached, ${noMapping} no IMDB mapping)`);

  if (imdbIds.length === 0) {
    console.log('[prewarm] Nothing to resolve, done.');
    return;
  }

  // Resolve in batches with concurrency control
  let resolved = 0;
  let failed = 0;

  for (let i = 0; i < imdbIds.length; i += concurrency) {
    const batch = imdbIds.slice(i, i + concurrency);
    const results = await Promise.allSettled(
      batch.map(id => resolver.resolveImdbToAnilibria(id))
    );

    for (const r of results) {
      if (r.status === 'fulfilled' && r.value) resolved++;
      else failed++;
    }

    // Delay between batches to stay under AniList rate limit (~90 req/min)
    if (i + concurrency < imdbIds.length) {
      await new Promise(r => setTimeout(r, batchDelay));
    }
  }

  console.log(`[prewarm] Done: ${resolved} resolved, ${failed} failed, ${alreadyCached} were cached, ${noMapping} had no IMDB mapping`);
}

module.exports = { prewarmTopAnime };
