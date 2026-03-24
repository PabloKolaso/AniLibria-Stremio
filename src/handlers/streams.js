/**
 * Stream Handler
 *
 * Called by Stremio when a user selects an episode.
 * Stremio provides: type = "series" | "movie", id = "tt0388629:1:5"
 *
 * Returns up to 3 stream objects (one per quality: 480p, 720p, 1080p).
 */

const resolver  = require('../bridge/resolver');
const anilibria = require('../api/anilibria');
const { GeoBlockedError } = require('../api/anilibria');
const cinemeta = require('../api/cinemeta');
const logger = require('../logger');
const stats  = require('../stats');

const IMDB_RE = /^tt\d{7,10}$/;

/**
 * Parse a Stremio series ID into its components.
 * "tt0388629:1:5" → { imdbId: "tt0388629", season: 1, episode: 5 }
 * "tt0388629"     → { imdbId: "tt0388629", season: null, episode: null }
 */
function parseId(id) {
  const parts = id.split(':');
  return {
    imdbId:  parts[0],
    season:  parts[1] ? parseInt(parts[1], 10) : null,
    episode: parts[2] ? parseInt(parts[2], 10) : null,
  };
}

/**
 * Given a release's flat episodes array and a season+episode number,
 * find the matching episode.
 *
 * Anilibria stores anime as a flat list (ordinal 1, 2, 3…).
 * For single-season anime this maps 1:1 to episode number.
 * For multi-season we try:
 *   1. Match by ordinal == episode (works for most cases)
 *   2. If season > 1, look for season marker in episode name
 *   3. Last resort: treat all episodes as a flat list
 */
function findEpisode(episodes, season, episode) {
  if (!episodes || episodes.length === 0) return null;

  // Direct ordinal match (works perfectly for most anime)
  const byOrdinal = episodes.find(e => e.ordinal === episode);
  if (byOrdinal) return byOrdinal;

  // Fallback: index-based match
  if (episode >= 1 && episode <= episodes.length) {
    return episodes[episode - 1];
  }

  return null;
}

/**
 * Build stream objects for an episode.
 * Returns 1–3 stream entries (480/720/1080) depending on availability.
 */
function buildStreams(release, episode, imdbId) {
  const streams = [];

  const qualities = [
    { key: 'hls_1080', label: '1080p' },
    { key: 'hls_720',  label: '720p'  },
    { key: 'hls_480',  label: '480p'  },
  ];

  const releaseName  = release.name?.english || release.name?.main || 'AniLibria';
  const episodeTitle = episode.name || episode.name_english || `Episode ${episode.ordinal}`;

  for (const { key, label } of qualities) {
    const url = episode[key];
    if (!url) continue;

    streams.push({
      url,
      name: `AniLibria\n${label}`,
      description: `${releaseName} • ${episodeTitle}\nRussian Dub • HLS`,
      behaviorHints: {
        // REQUIRED for HLS m3u8 to work in Stremio Android/TV
        notWebReady: true,
        // Enables auto-play next episode when in the same group
        bingeGroup: `anilibria-${imdbId}`,
      },
    });
  }

  if (streams.length === 0) {
    console.warn(`[streams] Episode ${episode.ordinal} of "${releaseName}" exists but has no HLS URLs`);
  }

  return streams;
}

/**
 * Main stream handler.
 * @param {{ type: string, id: string }} args
 * @returns {{ streams: object[] }}
 */
async function streamHandler({ type, id }) {
  const startTime = Date.now();
  const { imdbId, season, episode } = parseId(id);

  if (!IMDB_RE.test(imdbId)) return { streams: [] };

  console.log(`[streams] Request: type=${type} imdb=${imdbId} s=${season} e=${episode}`);

  // Step 1: resolve IMDB ID to Anilibria release ID (with metadata)
  let resolution;
  try {
    resolution = await resolver.resolveImdbToAnilibriaDetailed(imdbId);
  } catch (err) {
    console.error(`[streams] Resolution error for ${imdbId}:`, err.message);
    logger.log({
      imdbId, stremioId: id, type,
      outcome: 'error', title: null, isAnime: null, method: null,
      responseTimeMs: Date.now() - startTime,
      streamCount: 0, error: err.message,
    });
    stats.recordRequest({ outcome: 'error', isAnime: null });
    return {
      streams: [{
        name: 'AniLibria\n\u26A0 Error',
        description: `Temporary error looking up this anime.\n${err.message}\nTry again in a moment.`,
        externalUrl: 'https://anilibria.top',
      }],
    };
  }

  const anilibriaId = resolution.id;

  if (!anilibriaId) {
    console.log(`[streams] No Anilibria match for ${imdbId}`);
    // inFribb=true means we have AniList data → definitely anime, just not on Anilibria
    const isAnime = resolution.inFribb ? true : null;
    logger.log({
      imdbId, stremioId: id, type,
      outcome: 'not_found', title: resolution.title, isAnime, method: null,
      responseTimeMs: Date.now() - startTime,
      streamCount: 0, error: null,
    });
    stats.recordRequest({ outcome: 'not_found', isAnime });
    const failedTitle = resolution.title || resolution.titleVariants?.[0] || null;
    stats.recordFailedLookup(imdbId, failedTitle, isAnime);
    // Async-enrich from Cinemeta when title is missing (no latency impact)
    if (!failedTitle) {
      cinemeta.fetchTitleInfo(imdbId, type).then(info => {
        if (info) {
          stats.updateFailedLookup(imdbId, { title: info.title, isAnime: info.isAnime });
          logger.updateLastLog(imdbId, { title: info.title, isAnime: info.isAnime });
        }
      }).catch(() => {});
    }
    return { streams: [] };
  }

  // Step 2: fetch full release (includes episodes array)
  let release;
  try {
    release = await anilibria.getRelease(anilibriaId);
  } catch (err) {
    if (err instanceof GeoBlockedError) {
      console.warn(`[streams] Release ${anilibriaId} is geo-blocked for ${imdbId}`);
      logger.log({
        imdbId, stremioId: id, type,
        outcome: 'error', title: resolution.title, isAnime: true, method: resolution.method,
        responseTimeMs: Date.now() - startTime,
        streamCount: 0, error: 'Geo-blocked',
      });
      stats.recordRequest({ outcome: 'error', isAnime: true });
      return {
        streams: [{
          name: 'AniLibria\nBlocked',
          description: 'This content is restricted or geo-blocked on AniLibria in your region.',
          externalUrl: 'https://anilibria.top',
        }],
      };
    }
    console.error(`[streams] Failed to fetch release ${anilibriaId}:`, err.message);
    logger.log({
      imdbId, stremioId: id, type,
      outcome: 'error', title: resolution.title, isAnime: true, method: resolution.method,
      responseTimeMs: Date.now() - startTime,
      streamCount: 0, error: err.message,
    });
    stats.recordRequest({ outcome: 'error', isAnime: true });
    return {
      streams: [{
        name: 'AniLibria\n\u26A0 Error',
        description: `Could not load episode data.\n${err.message}\nTry again in a moment.`,
        externalUrl: 'https://anilibria.top',
      }],
    };
  }

  const episodes = release?.episodes;
  if (!episodes || episodes.length === 0) {
    console.log(`[streams] Release ${anilibriaId} has no episodes`);
    logger.log({
      imdbId, stremioId: id, type,
      outcome: 'success', title: resolution.title, isAnime: true, method: resolution.method,
      responseTimeMs: Date.now() - startTime,
      streamCount: 0, error: null,
    });
    stats.recordRequest({ outcome: 'success', isAnime: true });
    return { streams: [] };
  }

  // Step 3: for movies (no season/episode), use first (only) episode
  let resultStreams;
  if (type === 'movie' || episode === null) {
    const ep = episodes[0];
    resultStreams = buildStreams(release, ep, imdbId);
  } else {
    // Step 4: find the specific episode
    const ep = findEpisode(episodes, season, episode);
    if (!ep) {
      console.log(`[streams] Episode s${season}e${episode} not found in release ${anilibriaId} (${episodes.length} eps)`);
      resultStreams = [];
    } else {
      resultStreams = buildStreams(release, ep, imdbId);
      console.log(`[streams] Returning ${resultStreams.length} stream(s) for ${imdbId} s${season}e${episode}`);
    }
  }

  logger.log({
    imdbId, stremioId: id, type,
    outcome: 'success', title: resolution.title, isAnime: true, method: resolution.method,
    responseTimeMs: Date.now() - startTime,
    streamCount: resultStreams.length, error: null,
  });
  stats.recordRequest({ outcome: 'success', isAnime: true });

  return { streams: resultStreams };
}

module.exports = { streamHandler };
