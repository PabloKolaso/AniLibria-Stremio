/**
 * AniLibria availability: which releases can actually be played.
 *
 * A release is available when it is not flagged as blocked and has at least
 * one episode with an HLS stream. Both catalogs filter through this module,
 * so nothing is ever listed that the stream handler cannot play.
 *
 * Results are fetched in bulk (/anime/releases/list, 50 per request) and
 * cached per release; releases being dubbed right now are re-checked
 * quickly, and the releasing poller invalidates entries as soon as AniLibria
 * reports a change.
 */

const anilibria = require('../api/anilibria');
const { releaseCard, playableEpisodes } = require('../catalogs/meta');
const TTLCache  = require('../util/ttl-cache');

// Backstop only: the releasing poller invalidates live releases within a
// minute of any change, so this just bounds how long a missed change could last.
const LIVE_TTL_MS    = 30 * 60 * 1000;
const SETTLED_TTL_MS = 6 * 60 * 60 * 1000;
const MISSING_TTL_MS = 30 * 60 * 1000;

// release ID -> Availability
const cache = new TTLCache({ ttlMs: SETTLED_TTL_MS, max: 2000, name: 'Availability', description: 'Which releases are playable (catalog listings)' });

/**
 * @typedef {{ id: number, available: boolean, blocked: boolean, live: boolean, type: 'series'|'movie',
 *             playableCount: number, latestEpisode: number|null, card: object|null }} Availability
 *   card — compact display data for catalog entries (see catalogs/meta.js)
 */

/** Compute availability from a full release object. */
function describe(release) {
  const playable = playableEpisodes(release);
  const blocked = Boolean(release.is_blocked_by_geo || release.is_blocked_by_copyrights);
  return {
    id: release.id,
    available: !blocked && playable.length > 0,
    blocked,
    live: anilibria.isLive(release),
    // A MOVIE release with a single video is shown as a movie; anything else as a series
    type: release.type?.value === 'MOVIE' && playable.length === 1 ? 'movie' : 'series',
    playableCount: playable.length,
    latestEpisode: playable.length > 0 ? playable[playable.length - 1].ordinal : null,
    card: releaseCard(release),
  };
}

function remember(info) {
  cache.set(info.id, info, info.live ? LIVE_TTL_MS : SETTLED_TTL_MS);
  return info;
}

/**
 * Availability for many releases at once; unknown or expired entries are
 * fetched in bulk.
 *
 * @param {number[]} ids
 * @returns {Promise<Map<number, Availability>>}
 * @throws {HttpError} when AniLibria cannot be reached for releases not in the cache
 */
async function check(ids) {
  const result = new Map();
  const missing = [];
  for (const id of new Set(ids)) {
    const cached = cache.get(id);
    if (cached) result.set(id, cached);
    else missing.push(id);
  }
  if (missing.length > 0) {
    const releases = await anilibria.getReleasesByIds(missing);
    for (const id of missing) {
      const release = releases.get(id);
      if (release) {
        result.set(id, remember(describe(release)));
      } else {
        // Not returned by AniLibria: removed or never existed
        const gone = { id, available: false, blocked: false, live: false, type: 'series', playableCount: 0, latestEpisode: null, card: null };
        cache.set(id, gone, MISSING_TTL_MS);
        result.set(id, gone);
      }
    }
  }
  return result;
}

/** Record fresh release data (e.g. from a single-release fetch). */
function update(release) {
  return remember(describe(release));
}

/** Cached availability of a release (no network), or null. */
function peek(id) {
  return cache.get(id) || null;
}

/** Forget a release so the next check refetches it. */
function invalidate(id) {
  cache.delete(id);
}

module.exports = { check, update, invalidate, describe, peek };
