/**
 * Episode selection inside an AniLibria release (pure functions).
 *
 * AniLibria stores a release's episodes as a flat list with an `ordinal`.
 * Most releases number from 1, but some continue the numbering of an
 * earlier cour (13, 14, …) and long runners use absolute numbers
 * (Naruto Shippuden: 370–500). Picking by list position would silently play
 * the wrong episode in those cases, so matching is by ordinal only.
 */

function numberedEpisodes(episodes) {
  if (!Array.isArray(episodes)) return [];
  return episodes
    .filter(e => e && typeof e.ordinal === 'number' && Number.isFinite(e.ordinal))
    .sort((a, b) => a.ordinal - b.ordinal);
}

/**
 * @param {object[]} episodes - release.episodes
 * @param {number} number - episode number to find
 * @param {'local'|'absolute'|'first'} numbering - see bridge/targets.js
 * @returns {object|null}
 */
function findEpisode(episodes, number, numbering) {
  const numbered = numberedEpisodes(episodes);

  if (numbering === 'first') {
    return numbered[0] || (Array.isArray(episodes) && episodes[0]) || null;
  }
  if (numbered.length === 0) return null;

  const exact = numbered.find(e => e.ordinal === number);
  if (exact) return exact;

  // Release continues a previous cour's numbering (first ordinal > 1):
  // local episode N is the release's Nth episode.
  if (numbering === 'local' && numbered[0].ordinal > 1) {
    const target = numbered[0].ordinal + number - 1;
    return numbered.find(e => e.ordinal === target) || null;
  }

  return null;
}

const QUALITIES = [
  { key: 'hls_1080', label: '1080p' },
  { key: 'hls_720',  label: '720p'  },
  { key: 'hls_480',  label: '480p'  },
];

function hasHls(episode) {
  return QUALITIES.some(({ key }) => typeof episode?.[key] === 'string' && episode[key].length > 0);
}

module.exports = { findEpisode, hasHls, QUALITIES };
