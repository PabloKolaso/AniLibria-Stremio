/**
 * "AniLibria – Releasing" catalog and AniLibria update poller.
 *
 * Source of truth — releases AniLibria is dubbing right now ("Сейчас в озвучке"):
 *   GET /anime/catalog/releases?f[production_statuses][]=IS_IN_PRODUCTION&f[sorting]=FRESH_AT_DESC
 * Change feed — most recently updated releases, with their latest episode:
 *   GET /anime/releases/latest?limit=50
 *
 * AniLibria has no push mechanism, so this polls both lists every minute and:
 *   1. compares every release's update signature with the previous poll and
 *      invalidates the cached data of changed releases only;
 *   2. adds releases the catalog index does not know yet (so IMDB lookups
 *      find a brand-new dub within a minute, not at the next full rebuild);
 *   3. checks availability in bulk (only for unknown or invalidated releases);
 *   4. lists in-production releases with playable episodes, newest update first.
 *
 * A failed poll keeps the previous list (see util/live-snapshot.js).
 *
 * Every successful poll also keeps a diagnostic snapshot for the dashboard
 * (each in-production release, playable or not, and why) and feeds the
 * recent-updates event list (catalogs/updates.js).
 */

const anilibria    = require('../api/anilibria');
const catalogIndex = require('../mapping/anilibria-catalog');
const availability = require('../mapping/availability');
const LiveSnapshot = require('../util/live-snapshot');
const problems     = require('../monitoring/problems');
const updates      = require('./updates');
const { toMetaPreview } = require('./meta');

const CATALOG_ID = 'anilibria-releasing';
const REFRESH_INTERVAL_MS = 60 * 1000;
const CACHE_MAX_AGE = 60; // seconds Stremio clients may cache a page
const LATEST_FEED_LIMIT = 50;

// "<source>:<releaseId>" -> update signature seen in the previous poll
const signatures = new Map();
// Sources polled at least once since startup
const primed = new Set();

function signature(release) {
  return [
    release.fresh_at,
    release.updated_at,
    release.latest_episode?.ordinal,
    release.latest_episode?.updated_at,
    release.is_in_production,
    release.is_ongoing,
    release.is_blocked_by_geo,
    release.is_blocked_by_copyrights,
  ].join('|');
}

/**
 * Record signatures for one source; returns IDs of releases that changed
 * since the previous poll. After the first poll, a release seen for the
 * first time also counts (e.g. a finished show jumping to the top of the
 * latest feed because it got a new episode) — invalidation only drops a
 * cache entry, so erring on that side is cheap.
 */
function detectChanges(source, releases) {
  const changed = [];
  const firstPoll = !primed.has(source);
  for (const release of releases) {
    const key = `${source}:${release.id}`;
    const sig = signature(release);
    const previous = signatures.get(key);
    if (previous === undefined ? !firstPoll : previous !== sig) changed.push(release.id);
    signatures.set(key, sig);
  }
  primed.add(source);
  return changed;
}

let lastIds = null;
let diagnostics = null;

/** Display name of a raw release. */
function nameOf(release, info) {
  return info?.card?.name || release.name?.english || release.name?.main || `AniLibria #${release.id}`;
}

/** Why an in-production release is not listed (null when it is). */
function exclusionReason(info) {
  if (!info) return 'not_checked';
  if (info.available) return null;
  if (info.blocked) return 'blocked';
  if (!info.card) return 'not_returned';
  return 'no_playable_episodes';
}

async function load() {
  const started = Date.now();
  const [inProduction, latest] = await Promise.all([
    anilibria.fetchInProductionReleases(),
    anilibria.fetchLatestReleases(LATEST_FEED_LIMIT).catch(err => {
      // Optional: only improves change detection for releases that just finished
      console.warn(`[releasing] Latest-releases feed failed: ${err.message}`);
      return [];
    }),
  ]);

  // Releases the catalog index does not know yet (reported as new in the update feed)
  const indexBefore = catalogIndex.peek();
  const newIds = new Set(indexBefore
    ? [...inProduction, ...latest].filter(r => !indexBefore.byId.has(r.id)).map(r => r.id)
    : []);

  // 1. Targeted invalidation of changed releases
  const changed = [...new Set([...detectChanges('production', inProduction), ...detectChanges('latest', latest)])];
  for (const id of changed) {
    anilibria.invalidateRelease(id);
    availability.invalidate(id);
  }

  // 2. Make brand-new releases resolvable for IMDB-based stream requests
  catalogIndex.upsert([...inProduction, ...latest]);

  // 3. Availability (bulk fetch of unknown / invalidated releases only)
  const infos = await availability.check(inProduction.map(r => r.id));

  // 4. Playable releases, most recently updated first (the API's order)
  const items = [];
  for (const release of inProduction) {
    const info = infos.get(release.id);
    if (info?.available) items.push(toMetaPreview(info, { showLatestEpisode: true }));
  }

  // 5. Update feed: new releases, new episodes, block flag changes
  const observed = new Map();
  for (const release of [...inProduction, ...latest]) if (!observed.has(release.id)) observed.set(release.id, release);
  for (const release of observed.values()) {
    const info = infos.get(release.id);
    updates.observe({
      id: release.id,
      name: nameOf(release, info),
      poster: info?.card?.poster || anilibria.mediaUrl(release.poster?.src),
      episode: info ? info.latestEpisode : (release.latest_episode?.ordinal ?? null),
      blocked: Boolean(release.is_blocked_by_geo || release.is_blocked_by_copyrights),
      isNew: newIds.has(release.id),
    });
  }

  diagnostics = {
    at: Date.now(),
    durationMs: Date.now() - started,
    inProduction: inProduction.length,
    playable: items.length,
    changed: changed.length,
    releases: inProduction.map(release => {
      const info = infos.get(release.id);
      return {
        id: release.id,
        name: nameOf(release, info),
        nameRu: info?.card?.nameRu || release.name?.main || null,
        poster: info?.card?.poster || anilibria.mediaUrl(release.poster?.src),
        url: anilibria.releaseUrl(release.alias),
        type: info?.type || null,
        latestEpisode: info ? info.latestEpisode : null,
        playableCount: info?.playableCount ?? 0,
        playable: Boolean(info?.available),
        reason: exclusionReason(info),
        updatedAt: release.fresh_at || release.updated_at || null,
      };
    }),
  };

  if (changed.length > 0) {
    const names = changed.slice(0, 5).map(id => {
      const info = infos.get(id);
      return info?.card ? `${info.card.name}${info.latestEpisode !== null ? ` (ep ${info.latestEpisode})` : ''}` : `#${id}`;
    });
    console.log(`[releasing] ${changed.length} release(s) updated: ${names.join(', ')}${changed.length > 5 ? ', …' : ''}`);
  }
  const ids = items.map(i => i.id).join(',');
  if (ids !== lastIds) {
    console.log(`[releasing] ${items.length} of ${inProduction.length} in-production releases are playable.`);
    lastIds = ids;
  }
  return items;
}

const snapshot = new LiveSnapshot({
  name: 'releasing', ttlMs: REFRESH_INTERVAL_MS, load,
  onError: err => problems.record({
    source: 'catalogs', key: 'releasing', level: 'warning',
    title: 'Releasing catalog refresh failed', message: err.message,
  }),
});

/** Catalog items (null until the first successful load). */
function getItems() {
  return snapshot.get();
}

function start() {
  snapshot.start(REFRESH_INTERVAL_MS);
}

function stop() {
  snapshot.stop();
}

module.exports = {
  CATALOG_ID,
  CACHE_MAX_AGE,
  REFRESH_INTERVAL_MS,
  getItems,
  refresh: () => snapshot.refresh(),
  start,
  stop,
  info: () => snapshot.info(),
  /** Last successful poll in detail (null before the first one). */
  diagnostics: () => diagnostics,
};
