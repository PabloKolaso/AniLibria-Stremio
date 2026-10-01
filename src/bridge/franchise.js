/**
 * Franchise Resolver (fallback season routing)
 *
 * Used only when the ID mapping has no entry for the requested season
 * (e.g. a brand-new season). AniLibria's franchise API lists every release
 * of a franchise with a sort order; the Nth TV/ONA release is taken as
 * season N.
 *
 * Endpoint: GET /api/v1/anime/franchises/release/{releaseId}
 */

const anilibria = require('../api/anilibria');
const TTLCache  = require('../util/ttl-cache');

// release ID -> ordered season releases ([] when the release has no franchise)
const franchiseCache = new TTLCache({ ttlMs: 24 * 60 * 60 * 1000, max: 5000, name: 'Franchises', description: 'Season order of AniLibria franchises (fallback season routing)' });

// Definitive non-season content (movies, OVAs, specials, clips).
const NON_SEASON_TYPES = new Set(['MOVIE', 'OVA', 'OVA_13', 'OAD', 'SPECIAL', 'CLIP']);

async function getSeasonReleases(releaseId) {
  const cached = franchiseCache.get(releaseId);
  if (cached !== undefined) return cached;

  // Transient errors propagate (and are not cached).
  const franchise = await anilibria.getFranchiseByRelease(releaseId);
  const members = Array.isArray(franchise?.franchise_releases) ? franchise.franchise_releases : [];

  const seasons = members
    .filter(fr => {
      const raw = fr.release?.type?.value ?? fr.type?.value ?? fr.type ?? '';
      return !NON_SEASON_TYPES.has(String(raw).toUpperCase());
    })
    .sort((a, b) => (a.sort_order ?? 0) - (b.sort_order ?? 0))
    .map(fr => ({ releaseId: fr.release?.id || fr.release_id || fr.id, alias: fr.release?.alias || fr.alias || '' }))
    .filter(s => typeof s.releaseId === 'number');

  // Cache for every member so lookups from any season are instant.
  franchiseCache.set(releaseId, seasons);
  for (const fr of members) {
    const id = fr.release?.id || fr.release_id || fr.id;
    if (typeof id === 'number') franchiseCache.set(id, seasons);
  }
  if (seasons.length > 1) {
    console.log(`[franchise] ${franchise.name_english || franchise.name}: ${seasons.length} season releases`);
  }
  return seasons;
}

/**
 * Find the release for a season within the franchise of `releaseId`.
 *
 * @param {number} releaseId    - any release of the franchise
 * @param {number} targetSeason - requested season (1-based)
 * @returns {Promise<{releaseId: number, alias: string}|null>} null when the franchise has no such season
 */
async function findSeasonRelease(releaseId, targetSeason) {
  const seasons = await getSeasonReleases(releaseId);
  return seasons[targetSeason - 1] || null;
}

module.exports = { findSeasonRelease };
