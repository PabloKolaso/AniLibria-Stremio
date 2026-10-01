/**
 * Meta handler for catalog items ("anilibria:<releaseId>").
 *
 * The episode list comes straight from the AniLibria release, whose cache
 * is short-lived for releases being dubbed (and invalidated by the releasing
 * poller on every change), so a new episode appears within about a minute.
 */

const anilibria    = require('../api/anilibria');
const availability = require('../mapping/availability');
const { parseId, toMeta } = require('../catalogs/meta');

const CACHE_LIVE = 60;       // seconds: releases still being dubbed
const CACHE_SETTLED = 3600;  // seconds: finished releases
const CACHE_MISSING = 300;

/**
 * @param {{ type: string, id: string }} args
 * @returns {Promise<{ meta: object|null, cacheMaxAge?: number }>}
 */
async function metaHandler({ id }) {
  const parsed = parseId(id);
  if (!parsed || parsed.ordinal !== null) return { meta: null };

  let release;
  try {
    release = await anilibria.getRelease(parsed.releaseId);
  } catch (err) {
    if (err instanceof anilibria.GeoBlockedError) return { meta: null, cacheMaxAge: CACHE_MISSING };
    throw err; // no cached copy either: let the router report a server error
  }
  if (!release) return { meta: null, cacheMaxAge: CACHE_MISSING };

  const info = availability.update(release);
  return { meta: toMeta(release, info), cacheMaxAge: info.live ? CACHE_LIVE : CACHE_SETTLED };
}

module.exports = { metaHandler };
