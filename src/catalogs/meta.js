/**
 * Stremio metadata for AniLibria releases.
 *
 * Catalog items use their own ID space, "anilibria:<releaseId>", whose
 * episodes are "anilibria:<releaseId>:<ordinal>". Metadata, the episode list
 * and streams all come from the same AniLibria release, so an item in a
 * catalog can always be played.
 */

const anilibria = require('../api/anilibria');
const { hasHls } = require('../bridge/episodes');

const ID_PREFIX = 'anilibria:';
const ID_RE = /^anilibria:(\d{1,7})(?::(\d{1,5}(?:\.\d{1,3})?))?$/;
const PREVIEW_DESCRIPTION_LENGTH = 400;

/**
 * Parse "anilibria:9660" or "anilibria:9660:8".
 * @returns {{ releaseId: number, ordinal: number|null }|null}
 */
function parseId(id) {
  const m = typeof id === 'string' ? ID_RE.exec(id) : null;
  if (!m) return null;
  return { releaseId: parseInt(m[1], 10), ordinal: m[2] === undefined ? null : Number(m[2]) };
}

function releaseMetaId(releaseId) {
  return `${ID_PREFIX}${releaseId}`;
}

function episodeVideoId(releaseId, ordinal) {
  return `${ID_PREFIX}${releaseId}:${ordinal}`;
}

function truncate(text, max) {
  if (typeof text !== 'string') return undefined;
  const clean = text.replace(/\r\n/g, '\n').trim();
  if (clean.length <= max) return clean || undefined;
  return `${clean.slice(0, max - 1).trimEnd()}…`;
}

/** Compact, display-only facts about a release (kept in the availability cache). */
function releaseCard(release) {
  const genres = Array.isArray(release.genres)
    ? release.genres.map(g => g?.name).filter(n => typeof n === 'string' && n)
    : [];
  return {
    name: release.name?.english || release.name?.main || `AniLibria #${release.id}`,
    nameRu: release.name?.main || null,
    poster: anilibria.mediaUrl(release.poster?.src),
    year: Number.isInteger(release.year) ? release.year : null,
    genres,
    description: typeof release.description === 'string' ? release.description : null,
  };
}

function releaseInfo(card, live) {
  if (!card.year) return undefined;
  return live ? `${card.year}–` : String(card.year);
}

/**
 * Catalog entry for an available release.
 * @param {import('../mapping/availability').Availability} info
 * @param {{ showLatestEpisode?: boolean }} [opts]
 */
function toMetaPreview(info, { showLatestEpisode = false } = {}) {
  const { card } = info;
  const lines = [];
  if (showLatestEpisode && info.type === 'series' && info.latestEpisode !== null) {
    lines.push(`Latest episode: ${info.latestEpisode}`);
  }
  if (card.nameRu && card.nameRu !== card.name) lines.push(card.nameRu);
  const description = truncate(card.description, PREVIEW_DESCRIPTION_LENGTH);
  if (description) lines.push(description);

  return {
    id: releaseMetaId(info.id),
    type: info.type,
    name: card.name,
    poster: card.poster || undefined,
    posterShape: 'poster',
    genres: card.genres.length > 0 ? card.genres : undefined,
    releaseInfo: releaseInfo(card, info.live),
    description: lines.length > 0 ? lines.join('\n\n') : undefined,
  };
}

function isoDate(value) {
  const date = new Date(value);
  return Number.isFinite(date.getTime()) ? date.toISOString() : undefined;
}

/** Episodes that can be listed and played: a valid ordinal and at least one HLS stream. */
function playableEpisodes(release) {
  return (Array.isArray(release?.episodes) ? release.episodes : [])
    .filter(e => e && typeof e.ordinal === 'number' && Number.isFinite(e.ordinal) && e.ordinal >= 0 && hasHls(e))
    .sort((a, b) => a.ordinal - b.ordinal);
}

/**
 * Episode list: whole-number ordinals are season 1 episodes; recaps and
 * specials with fractional ordinals (12.5) go to season 0, as Stremio
 * expects whole episode numbers.
 */
function toVideos(release) {
  let special = 0;
  return playableEpisodes(release).map(ep => {
    const whole = Number.isInteger(ep.ordinal);
    return {
      id: episodeVideoId(release.id, ep.ordinal),
      title: ep.name || ep.name_english || `Episode ${ep.ordinal}`,
      season: whole ? 1 : 0,
      episode: whole ? ep.ordinal : ++special,
      released: isoDate(ep.updated_at) || isoDate(release.updated_at) || isoDate(release.created_at),
      thumbnail: anilibria.mediaUrl(ep.preview?.src) || undefined,
    };
  });
}

/**
 * Full Stremio meta object for a release.
 * @param {object} release - full release (with episodes)
 * @param {import('../mapping/availability').Availability} info - availability of the same release
 */
function toMeta(release, info) {
  const card = releaseCard(release);
  const videos = info.type === 'series' ? toVideos(release) : undefined;
  const latestVideo = videos?.[videos.length - 1];
  const description = [card.nameRu && card.nameRu !== card.name ? card.nameRu : null, card.description?.trim()]
    .filter(Boolean).join('\n\n');

  return {
    id: releaseMetaId(release.id),
    type: info.type,
    name: card.name,
    poster: card.poster || undefined,
    posterShape: 'poster',
    background: latestVideo?.thumbnail || card.poster || undefined,
    genres: card.genres.length > 0 ? card.genres : undefined,
    releaseInfo: releaseInfo(card, info.live),
    description: description || undefined,
    videos,
  };
}

module.exports = {
  ID_PREFIX,
  parseId,
  releaseMetaId,
  episodeVideoId,
  releaseCard,
  toMetaPreview,
  toMeta,
  toVideos,
  playableEpisodes,
};
