/**
 * Franchise Resolver
 *
 * When a user requests S2E1 and the resolved Anilibria release only has
 * season 1 episodes, this module uses the Anilibria franchise API to
 * find the correct season's release.
 *
 * Endpoint: GET /api/v1/anime/franchises/release/{releaseId}
 * Returns the franchise containing that release with all related releases,
 * each having sort_order and type (TV/MOVIE/ONA).
 */

const NodeCache = require('node-cache');
const anilibria = require('../api/anilibria');

// Cache franchise data per release ID → 24h TTL
const franchiseCache = new NodeCache({ stdTTL: 86400 });

/**
 * Given a release ID and a target season number, find the release
 * that corresponds to that season within the franchise.
 *
 * @param {number} releaseId     - The currently resolved Anilibria release ID
 * @param {number} targetSeason  - The season number requested (1-based)
 * @returns {Promise<{releaseId: number, alias: string}|null>}
 */
async function findSeasonRelease(releaseId, targetSeason) {
  // Check cache first
  let tvReleases = franchiseCache.get(releaseId);

  if (tvReleases === undefined) {
    // Fetch franchise data from Anilibria
    const franchise = await anilibria.getFranchiseByRelease(releaseId);

    if (!franchise || !franchise.franchise_releases || franchise.franchise_releases.length <= 1) {
      // No franchise or single release — cache null for all known IDs
      franchiseCache.set(releaseId, null);
      return null;
    }

    // Filter to TV-type releases only, sorted by sort_order
    tvReleases = franchise.franchise_releases
      .filter(fr => {
        const type = fr.release?.type?.value || fr.type?.value || fr.type || '';
        return String(type).toUpperCase() === 'TV';
      })
      .sort((a, b) => a.sort_order - b.sort_order)
      .map(fr => ({
        releaseId: fr.release?.id || fr.id,
        alias: fr.release?.alias || fr.alias || '',
        sortOrder: fr.sort_order,
      }));

    // Cache for ALL release IDs in the franchise (any future lookup is instant)
    for (const fr of franchise.franchise_releases) {
      const id = fr.release?.id || fr.id;
      if (id) franchiseCache.set(id, tvReleases);
    }

    console.log(`[franchise] ${franchise.name_english || franchise.name}: ${tvReleases.length} TV releases in franchise`);
  }

  if (!tvReleases || tvReleases.length === 0) return null;

  // Map targetSeason to index (season 1 = index 0)
  const targetIndex = targetSeason - 1;
  if (targetIndex < 0 || targetIndex >= tvReleases.length) return null;

  const target = tvReleases[targetIndex];

  // Don't redirect if it's the same release we already have
  if (target.releaseId === releaseId) return null;

  return { releaseId: target.releaseId, alias: target.alias };
}

module.exports = { findSeasonRelease };
