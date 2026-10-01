/**
 * "Trending Anime – AniLibria" catalog.
 *
 * Source: AniList's live trending ranking — Page.media(sort: TRENDING_DESC).
 * AniList's `trending` score measures recent activity on an anime, so the
 * list follows what is popular right now rather than all-time popularity.
 *
 * Every 5 minutes:
 *   1. take the top trending anime from AniList (2 pages × 50);
 *   2. match each to AniLibria with the same resolver the stream handler uses,
 *      against the local catalog index only, and accept only exact matches
 *      (MAL/Shikimori ID, or exact alias with the same year) — fuzzy title
 *      matches are never listed;
 *   3. verify the matched release has playable episodes (bulk availability);
 *   4. keep AniList's order and drop everything else.
 *
 * Nothing unverified is ever listed: if AniList, the catalog index or
 * AniLibria cannot be reached, the refresh fails and the previous (verified)
 * list stays in place.
 *
 * Every successful refresh keeps a diagnostic snapshot for the dashboard:
 * each trending anime, whether it was listed, and if not, why.
 */

const anilist      = require('../api/anilist');
const resolver     = require('../bridge/resolver');
const catalogIndex = require('../mapping/anilibria-catalog');
const availability = require('../mapping/availability');
const LiveSnapshot = require('../util/live-snapshot');
const problems     = require('../monitoring/problems');
const { HttpError } = require('../api/http');
const { toMetaPreview } = require('./meta');

const CATALOG_ID = 'anilibria-trending';
const REFRESH_INTERVAL_MS = 5 * 60 * 1000;
const CACHE_MAX_AGE = 300; // seconds Stremio clients may cache a page
const TRENDING_PAGES = 2;
const PER_PAGE = 50;
/**
 * Resolver methods trusted for catalog listing: exact ID, exact alias, or a
 * match the admin approved. Title-based "fuse"/"search" matches are not.
 */
const TRUSTED_METHODS = new Set(['mal', 'alias', 'pinned']);

let lastIds = null;
let diagnostics = null;

async function load() {
  const started = Date.now();
  const trending = await anilist.getTrending({ pages: TRENDING_PAGES, perPage: PER_PAGE });

  const index = await catalogIndex.getIndex();
  if (!index) {
    throw new HttpError('AniLibria catalog index is not available', { code: 'UNAVAILABLE', service: 'AniLibria' });
  }

  // Candidate AniLibria releases per trending anime, in trending order
  const rows = [];
  const candidates = [];
  for (const [i, media] of trending.entries()) {
    const row = {
      rank: i + 1,
      anilistId: media.id,
      malId: media.idMal || null,
      title: media.title?.english || media.title?.romaji || media.title?.native || `AniList #${media.id}`,
      year: anilist.mediaYear(media),
      cover: media.coverImage?.medium || null,
      status: 'excluded',
      reason: null,
      method: null,
      releaseId: null,
      releaseName: null,
    };
    rows.push(row);
    if (!media.idMal && anilist.collectTitles(media).length === 0) {
      row.reason = 'no_metadata';
      continue;
    }
    const match = await resolver.resolveMedia(media, { offline: true });
    row.method = match.method;
    if (match.releaseIds.length === 0) {
      row.reason = match.uncertain ? 'lookup_uncertain' : 'not_on_anilibria';
      continue;
    }
    row.releaseId = match.releaseIds[0];
    row.releaseName = index.byId.get(row.releaseId)?.en || null;
    if (!TRUSTED_METHODS.has(match.method)) {
      row.reason = 'untrusted_match';
      continue;
    }
    candidates.push({ row, releaseIds: match.releaseIds });
  }

  // Verify availability (bulk; throws if AniLibria is unreachable)
  const infos = await availability.check(candidates.flatMap(c => c.releaseIds));

  const items = [];
  const listed = new Set();
  for (const { row, releaseIds } of candidates) {
    const id = releaseIds.find(rid => infos.get(rid)?.available && !listed.has(rid));
    if (id === undefined) {
      const info = infos.get(releaseIds[0]);
      row.reason = releaseIds.some(rid => listed.has(rid)) ? 'duplicate'
        : info?.blocked ? 'blocked'
          : !info?.card ? 'not_returned'
            : 'not_playable';
      continue;
    }
    listed.add(id);
    const info = infos.get(id);
    Object.assign(row, { status: 'listed', reason: null, releaseId: id, releaseName: info.card.name, poster: info.card.poster });
    items.push(toMetaPreview(info));
  }

  diagnostics = { at: Date.now(), durationMs: Date.now() - started, total: trending.length, listed: items.length, rows };

  const ids = items.map(i => i.id).join(',');
  if (ids !== lastIds) {
    console.log(`[trending] ${items.length} of ${trending.length} trending anime are available on AniLibria.`);
    lastIds = ids;
  }
  return items;
}

const snapshot = new LiveSnapshot({
  name: 'trending', ttlMs: REFRESH_INTERVAL_MS, load,
  onError: err => problems.record({
    source: 'catalogs', key: 'trending', level: 'warning',
    title: 'Trending catalog refresh failed', message: err.message,
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
  /** Last successful refresh in detail (null before the first one). */
  diagnostics: () => diagnostics,
};
