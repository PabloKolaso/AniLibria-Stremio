/**
 * Catalog handler: serves the "Releasing" and "Trending" catalogs from their
 * live snapshots (see catalogs/*.js), paginated with Stremio's `skip`.
 */

const releasing = require('../catalogs/releasing');
const trending  = require('../catalogs/trending');

/** Stremio treats a page with fewer than 100 items as the last one. */
const PAGE_SIZE = 100;
const MAX_SKIP = 10_000;
/** Short client cache while a catalog has not loaded yet, so clients retry soon. */
const CACHE_NOT_READY = 30;

const CATALOGS = {
  [releasing.CATALOG_ID]: releasing,
  [trending.CATALOG_ID]: trending,
};

function parseSkip(value) {
  const n = typeof value === 'string' && /^\d{1,6}$/.test(value) ? parseInt(value, 10) : 0;
  return Math.min(n, MAX_SKIP);
}

/**
 * @param {{ type: string, id: string, extra?: { skip?: string } }} args
 * @returns {Promise<{ metas: object[], cacheMaxAge: number }>}
 */
async function catalogHandler({ type, id, extra = {} }) {
  const catalog = Object.hasOwn(CATALOGS, id) ? CATALOGS[id] : null;
  if (!catalog || type !== 'series') return { metas: [] };

  const items = await catalog.getItems();
  if (!items) return { metas: [], cacheMaxAge: CACHE_NOT_READY };

  const skip = parseSkip(extra.skip);
  return { metas: items.slice(skip, skip + PAGE_SIZE), cacheMaxAge: catalog.CACHE_MAX_AGE };
}

module.exports = { catalogHandler, PAGE_SIZE };
