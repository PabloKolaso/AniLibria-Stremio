/**
 * Coverage report: how much of AniLibria's catalog this addon can reach.
 *
 * Computed offline by comparing the local AniLibria index with the Fribb
 * mapping (no API calls), and cached until either changes. Each indexed
 * release falls in exactly one group:
 *
 *   imdb          has a MAL/Shikimori ID that the mapping links to an IMDB
 *                 ID — reachable from Cinemeta/IMDB pages in Stremio
 *   catalogOnly   has a MAL ID without an IMDB mapping, but is listed in
 *                 this addon's Releasing/Trending catalogs right now
 *   unmapped      has a MAL ID without an IMDB mapping, and is not listed
 *                 — not reachable at the moment
 *   noIds         carries no MAL/Shikimori ID; only title matching (exact
 *                 alias or fuzzy) can find it for an IMDB request
 *
 * "Reachable" means the addon can map a request to the release; whether a
 * given episode plays still depends on season/episode numbering.
 */

const catalogIndex = require('./anilibria-catalog');
const mapping      = require('./cache');
const anilibria    = require('../api/anilibria');

const SAMPLE_SIZE = 60;

let cached = null; // { signature, report }

/**
 * @param {{ listedIds?: Iterable<number> }} [opts] - release IDs currently in the addon's catalogs
 * @returns {object|null} null while the index or the mapping is not loaded
 */
function compute({ listedIds = [] } = {}) {
  const index = catalogIndex.peek();
  const mapInfo = mapping.getInfo();
  if (!index || !mapInfo.ready) return null;

  const listed = new Set(listedIds);
  const signature = `${index.builtAt}:${index.size}:${mapInfo.fetchedAt}:${mapInfo.imdbIds}:${[...listed].sort().join(',')}`;
  if (cached && cached.signature === signature) return cached.report;

  const malWithImdb = mapping.malIdsWithImdb();
  const counts = { total: 0, imdb: 0, catalogOnly: 0, unmapped: 0, noIds: 0 };
  const unmapped = [];
  const noIds = [];
  for (const release of index.byId.values()) {
    counts.total++;
    const row = {
      id: release.id, name: release.en || release.ru || release.alias, nameRu: release.ru || null,
      year: release.year, type: release.type, ids: release.ids, url: anilibria.releaseUrl(release.alias),
    };
    if (release.ids.length === 0) {
      counts.noIds++;
      noIds.push(row);
    } else if (release.ids.some(id => malWithImdb.has(id))) {
      counts.imdb++;
    } else if (listed.has(release.id)) {
      counts.catalogOnly++;
    } else {
      counts.unmapped++;
      unmapped.push(row);
    }
  }
  const newestFirst = (a, b) => b.id - a.id;
  const report = {
    generatedAt: Date.now(),
    indexBuiltAt: index.builtAt,
    indexComplete: index.complete,
    mappingFetchedAt: mapInfo.fetchedAt,
    counts,
    externalIdCoverage: counts.total > 0 ? (counts.total - counts.noIds) / counts.total : null,
    imdbCoverage: counts.total > 0 ? counts.imdb / counts.total : null,
    unmapped: unmapped.sort(newestFirst).slice(0, SAMPLE_SIZE),
    noIds: noIds.sort(newestFirst).slice(0, SAMPLE_SIZE),
    sampleSize: SAMPLE_SIZE,
  };
  cached = { signature, report };
  return report;
}

module.exports = { compute };
