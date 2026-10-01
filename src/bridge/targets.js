/**
 * Episode targeting (pure function).
 *
 * Maps a Stremio request — IMDB ID plus Cinemeta (TVDB-style) season and
 * episode — onto the Fribb mapping entries for that IMDB ID, producing an
 * ordered list of attempts: which anime entry to look up on AniLibria and
 * which episode number to pick inside the matching release.
 *
 * Episode numbering of an attempt:
 *   'local'    — episode number within that anime entry (1 = its first episode)
 *   'absolute' — absolute episode number across the whole show (long runners
 *                such as One Piece are a single MAL entry spanning many
 *                TVDB seasons; AniLibria numbers their episodes absolutely)
 *   'first'    — the release's first episode (movies)
 */

const TYPE_PRIORITY = { TV: 0, ONA: 1, TV_SHORT: 2, OVA: 3, SPECIAL: 4, MOVIE: 5 };

function typeRank(entry) {
  return TYPE_PRIORITY[entry.type] ?? 6;
}

/** Regular seasons first (unknown counts as season 1), specials (season 0) last. */
function seasonRank(entry) {
  if (entry.tvdbSeason === 0) return Number.MAX_SAFE_INTEGER;
  return entry.tvdbSeason ?? 1;
}

/**
 * @typedef {import('../mapping/cache').MappingEntry} MappingEntry
 * @typedef {{ entry: MappingEntry, episode: number|null, numbering: 'local'|'absolute'|'first',
 *             absolute?: { season: number, episode: number }, franchiseSeason?: number }} Attempt
 * @typedef {{ mode: 'none'|'movie'|'special'|'season'|'absolute'|'franchise',
 *             primary: MappingEntry|null, attempts: Attempt[] }} Plan
 */

/**
 * @param {MappingEntry[]} entries - all mapping entries for the IMDB ID
 * @param {{ type: string, season: number|null, episode: number|null }} request
 * @returns {Plan}
 */
function planTargets(entries, { type, season, episode }) {
  if (!entries || entries.length === 0) return { mode: 'none', primary: null, attempts: [] };

  // Movies (and series requests without an episode): play the first episode.
  if (type === 'movie' || season === null || episode === null) {
    const movies = entries.filter(e => e.type === 'MOVIE');
    const pool = type === 'movie' && movies.length > 0
      ? movies
      : [...entries].sort((a, b) => typeRank(a) - typeRank(b) || seasonRank(a) - seasonRank(b));
    return {
      mode: 'movie',
      primary: pool[0],
      attempts: pool.slice(0, 2).map(entry => ({ entry, episode: 1, numbering: 'first' })),
    };
  }

  const primary = [...entries].sort((a, b) =>
    seasonRank(a) - seasonRank(b) || a.tvdbOffset - b.tvdbOffset || typeRank(a) - typeRank(b))[0];

  // Season 0 holds specials/OVAs in TVDB order, which cannot be mapped reliably.
  if (season === 0) return { mode: 'special', primary, attempts: [] };

  // Entries mapped to this exact TVDB season. Split-cour seasons have several
  // entries with increasing episode offsets: pick the one whose range
  // contains the episode, then the others (AniLibria sometimes merges cours
  // into one release that continues the numbering).
  const inSeason = entries
    .filter(e => e.tvdbSeason === season && e.tvdbOffset < episode)
    .sort((a, b) => b.tvdbOffset - a.tvdbOffset);
  if (inSeason.length > 0) {
    return {
      mode: 'season',
      primary: inSeason[0],
      attempts: inSeason.map(entry => ({ entry, episode: episode - entry.tvdbOffset, numbering: 'local' })),
    };
  }

  // A single entry without season data spans the whole show: convert to an
  // absolute episode number (needs the per-season episode counts for season > 1).
  const spanning = entries
    .filter(e => e.tvdbSeason === null && e.type !== 'MOVIE')
    .sort((a, b) => typeRank(a) - typeRank(b));
  if (spanning.length > 0) {
    return {
      mode: 'absolute',
      primary: spanning[0],
      attempts: [{
        entry: spanning[0],
        episode: season === 1 ? episode : null,
        numbering: 'absolute',
        absolute: { season, episode },
      }],
    };
  }

  // Season data exists, but not for this season (e.g. a new season the mapping
  // does not list yet): walk AniLibria's franchise order from the first season.
  const base = entries
    .filter(e => e.tvdbSeason >= 1)
    .sort((a, b) => a.tvdbSeason - b.tvdbSeason || a.tvdbOffset - b.tvdbOffset)[0];
  if (base) {
    return {
      mode: 'franchise',
      primary: base,
      attempts: [{ entry: base, episode, numbering: 'local', franchiseSeason: season }],
    };
  }

  return { mode: 'none', primary, attempts: [] };
}

module.exports = { planTargets };
