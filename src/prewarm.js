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

/** Draw an inline progress bar using carriage return (overwrites same line). */
function drawBar(done, total, ok, fail) {
  const W      = 30;
  const pct    = total ? Math.round(done / total * 100) : 0;
  const filled = total ? Math.round(done / total * W) : 0;
  const bar    = '#'.repeat(filled) + '.'.repeat(W - filled);
  process.stdout.write(`\r[prewarm] [${bar}] ${done}/${total} (${pct}%)  \u2713${ok} \u2717${fail}   `);
}

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

  // ─── First pass ──────────────────────────────────────────────────────────────

  let resolved   = 0;
  let done       = 0;
  const notFound = []; // { imdbId, title }
  const errors   = []; // { imdbId, title, reason }

  resolver.setSilentMode(true);
  drawBar(0, imdbIds.length, 0, 0);

  for (let i = 0; i < imdbIds.length; i += concurrency) {
    const batch = imdbIds.slice(i, i + concurrency);

    await Promise.allSettled(
      batch.map(async (imdbId) => {
        let result;
        try {
          result = await resolver.resolveImdbToAnilibriaDetailed(imdbId);
        } catch (err) {
          errors.push({ imdbId, title: null, reason: err.message });
          return;
        }
        if (result.id) {
          resolved++;
        } else {
          notFound.push({ imdbId, title: result.titleVariants?.[0] || null });
        }
      })
    );

    done += batch.length;
    drawBar(done, imdbIds.length, resolved, notFound.length + errors.length);

    if (i + concurrency < imdbIds.length) {
      await new Promise(r => setTimeout(r, batchDelay));
    }
  }

  resolver.setSilentMode(false);

  // ─── Retry pass (not-found only) ─────────────────────────────────────────────

  if (notFound.length > 0) {
    process.stdout.write('\n');
    console.log(`[prewarm] Retrying ${notFound.length} not-found items once …`);

    const toRetry   = notFound.splice(0); // drain the array
    const retryBar  = toRetry.length;
    let retryDone   = 0;

    resolver.setSilentMode(true);
    drawBar(retryDone, retryBar, 0, 0);

    for (const item of toRetry) {
      resolver.clearCache(item.imdbId); // remove negative cache so we do a real re-resolve

      let result;
      try {
        result = await resolver.resolveImdbToAnilibriaDetailed(item.imdbId);
      } catch (err) {
        errors.push({ imdbId: item.imdbId, title: item.title, reason: err.message });
        retryDone++;
        drawBar(retryDone, retryBar, resolved, notFound.length + errors.length);
        await new Promise(r => setTimeout(r, batchDelay));
        continue;
      }

      if (result.id) {
        resolved++;
      } else {
        // Still not found — give up
        notFound.push({ imdbId: item.imdbId, title: item.title || result.titleVariants?.[0] || null });
      }

      retryDone++;
      drawBar(retryDone, retryBar, resolved, notFound.length + errors.length);
      await new Promise(r => setTimeout(r, batchDelay));
    }

    resolver.setSilentMode(false);
  }

  // ─── Final report ─────────────────────────────────────────────────────────────

  process.stdout.write('\n');

  const totalFail = notFound.length + errors.length;
  console.log(
    `[prewarm] Done: ${resolved} resolved, ${notFound.length} not found (skipped), ` +
    `${errors.length} errors — ${alreadyCached} cached, ${noMapping} no mapping`
  );

  if (totalFail === 0) return;

  if (notFound.length > 0) {
    console.log(`\n[prewarm] Not found on Anilibria (${notFound.length}):`);
    for (const { imdbId, title } of notFound) {
      console.log(`  ${imdbId.padEnd(12)}  ${title || '(unknown title)'}`);
    }
  }

  if (errors.length > 0) {
    console.log(`\n[prewarm] Errors (${errors.length}):`);
    for (const { imdbId, title, reason } of errors) {
      console.log(`  ${imdbId.padEnd(12)}  ${title || '(unknown title)'}  →  ${reason}`);
    }
  }
}

module.exports = { prewarmTopAnime };
