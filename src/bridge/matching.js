/**
 * Title normalization and match validation helpers (pure functions).
 *
 * AniLibria releases usually carry the MyAnimeList ID of the anime they
 * dub (as `shikimori.id` — Shikimori reuses MAL IDs — and/or `mal.id`).
 * Those IDs are the primary matching signal; the title helpers here are
 * the fallback for releases without IDs and guard against false positives.
 */

const STOP_WORDS = new Set(['the', 'a', 'an', 'of', 'in', 'on', 'and', 'or', 'no', 'wo', 'ga', 'wa']);

/** Lowercase ASCII with diacritics removed ("Pokémon" → "pokemon", "HUNTER×HUNTER" → "hunter x hunter"). */
function fold(str) {
  return String(str)
    .replace(/×/g, ' x ')
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase();
}

/** Split a title into lowercase alphanumeric words. */
function normalizeWords(str) {
  return fold(str)
    .replace(/['’`]/g, '')
    .replace(/[^a-z0-9]+/g, ' ')
    .split(' ')
    .filter(Boolean);
}

/** Return the first N words that are ≥3 chars and not stop words. */
function significantWords(str, n = 2) {
  return normalizeWords(str).filter(w => w.length >= 3 && !STOP_WORDS.has(w)).slice(0, n);
}

/**
 * Convert a title to a URL alias (slug) the way AniLibria builds them.
 * e.g. "ONE PIECE" → "one-piece", "JoJo's" → "jojos", "HUNTER×HUNTER" → "hunter-x-hunter"
 */
function toAlias(title) {
  return fold(title)
    .replace(/['’`]/g, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
}

/**
 * Strip a trailing "(2011)"-style year, which AniList uses to tell remakes
 * apart but AniLibria aliases omit. (Season/part suffixes are deliberately
 * kept: stripping them would match a different season's release.)
 */
function stripYear(title) {
  return title.replace(/\s*\(\d{4}\)\s*$/, '').trim();
}

function ordinal(n) {
  const mod100 = n % 100;
  if (mod100 >= 11 && mod100 <= 13) return `${n}th`;
  return `${n}${{ 1: 'st', 2: 'nd', 3: 'rd' }[n % 10] || 'th'}`;
}

/**
 * Equivalent spellings of a season/part suffix, as AniList and AniLibria
 * phrase them differently: "86 Part 2" ↔ "86 2nd Cour", "X Season 2" ↔ "X 2nd Season".
 * The number is preserved, so these never point at another season.
 */
function seasonSpellings(title) {
  let m;
  if ((m = title.match(/^(.+?)[\s:]+part\s*(\d{1,2})$/i))) return [`${m[1]} ${ordinal(+m[2])} Cour`];
  if ((m = title.match(/^(.+?)[\s:]+season\s*(\d{1,2})$/i))) return [`${m[1]} ${ordinal(+m[2])} Season`];
  if ((m = title.match(/^(.+?)\s+(\d{1,2})(?:st|nd|rd|th)\s+season$/i))) return [`${m[1]} Season ${m[2]}`];
  return [];
}

/** Unique aliases for a list of titles (year-stripped and season-respelled variants included), in title order. */
function aliasCandidates(titles) {
  const aliases = [];
  const seen = new Set();
  for (const title of titles) {
    const base = stripYear(title);
    for (const variant of [title, base, ...seasonSpellings(base)]) {
      const alias = toAlias(variant);
      if (alias.length < 2 || seen.has(alias)) continue;
      seen.add(alias);
      aliases.push(alias);
    }
  }
  return aliases;
}

/**
 * Require the first significant word to match exactly and the second to
 * share a 4-character prefix. Prevents fuzzy false positives such as
 * "Shingeki no Kyojin" → "Shingeki no Bahamut".
 */
function wordsMatch(queryWords, candidateWords) {
  if (queryWords.length === 0 || candidateWords.length === 0) return false;
  if (queryWords[0] !== candidateWords[0]) return false;
  if (queryWords.length >= 2 && candidateWords.length >= 2) {
    const a = queryWords[1];
    const b = candidateWords[1];
    return a.startsWith(b.slice(0, 4)) || b.startsWith(a.slice(0, 4));
  }
  return true;
}

const ROMAN = { ii: 2, iii: 3, iv: 4, v: 5, vi: 6, vii: 7, viii: 8, ix: 9, x: 10 };

/**
 * Season/part marker of a title: "Overlord II" → "s2", "Date A Live 4" → "s4",
 * "Mob Psycho 100" → "s1", "86 Part 2" → "s1p2". Used to stop fuzzy matching
 * from pairing different seasons of the same show.
 */
function seasonMarker(title) {
  const t = fold(title).replace(/\(\d{4}\)/g, ' ').replace(/[^a-z0-9]+/g, ' ').trim();
  let season = 1;
  let m;
  if ((m = t.match(/\b(\d{1,2})(?:st|nd|rd|th) season\b/)) || (m = t.match(/\bseason (\d{1,2})\b/))) {
    season = Number(m[1]);
  } else if ((m = t.match(/ (ii|iii|iv|v|vi|vii|viii|ix|x)$/))) {
    season = ROMAN[m[1]];
  } else if ((m = t.match(/ (\d{1,2})$/)) && !/(?:part|cour) \d{1,2}$/.test(t)) {
    season = Number(m[1]);
  }
  const part = t.match(/\b(?:part|cour) (\d{1,2})\b/) || t.match(/\b(\d)(?:st|nd|rd|th) (?:part|cour)\b/);
  return part && Number(part[1]) > 1 ? `s${season}p${part[1]}` : `s${season}`;
}

/** True when some query title has the same season/part marker as the candidate title. */
function sameSeason(queryTitles, candidateTitle) {
  const marker = seasonMarker(candidateTitle);
  return queryTitles.some(t => seasonMarker(t) === marker);
}

function positiveInt(value) {
  const n = Number(value);
  return Number.isInteger(n) && n > 0 ? n : null;
}

/**
 * Normalize a raw AniLibria release (full or catalog entry) to the fields
 * used for matching.
 */
function summarizeRelease(release) {
  const shikimori = positiveInt(release.shikimori?.id);
  const mal = positiveInt(release.mal?.id);
  const alias = typeof release.alias === 'string' ? release.alias : '';
  return {
    id: release.id,
    alias,
    aliasWords: alias.replace(/-/g, ' '),
    year: positiveInt(release.year),
    type: release.type?.value || null,
    en: release.name?.english || '',
    ru: release.name?.main || '',
    alt: release.name?.alternative || '',
    // Shikimori IDs are the more reliable of the two on AniLibria (when they
    // disagree, the MAL field is usually a copy-paste from a sibling season).
    malId: shikimori || mal,
    ids: [...new Set([shikimori, mal].filter(Boolean))],
  };
}

/** Whether two release years are compatible (unknown years never disqualify). */
function yearsCompatible(a, b, tolerance = 1) {
  if (!a || !b) return true;
  return Math.abs(a - b) <= tolerance;
}

/**
 * Decide whether a release can be the anime we are looking for.
 *
 * @param {{ ids: number[], year: number|null }} release - summarized release
 * @param {{ mal: number|null, year: number|null }} target - the anime being resolved
 * @param {{ exactAlias?: boolean }} [opts] - the release was found by exact alias
 * @returns {{ ok: boolean, reason: string }}
 */
function verdict(release, target, { exactAlias = false } = {}) {
  const yearOk = yearsCompatible(release.year, target.year);
  if (target.mal && release.ids.includes(target.mal)) {
    return yearOk ? { ok: true, reason: 'id match' } : { ok: false, reason: 'id match but year differs' };
  }
  if (release.ids.length === 0) {
    return yearOk ? { ok: true, reason: 'no ids on release' } : { ok: false, reason: 'year differs' };
  }
  // The release is tagged as a different anime. Only trust an exact alias
  // match with the same year (AniLibria occasionally mislabels IDs).
  if (exactAlias && target.year && release.year === target.year) {
    return { ok: true, reason: 'exact alias and year (release ids disagree)' };
  }
  return { ok: false, reason: `release is tagged as MAL ${release.ids.join('/')}` };
}

/**
 * Convert Stremio season/episode numbering to an absolute episode number
 * using per-season episode counts (season -> number of episodes).
 * @returns {number|null} null when a preceding season's size is unknown
 */
function absoluteEpisode(seasonCounts, season, episode) {
  if (season === 1) return episode;
  if (!seasonCounts) return null;
  let offset = 0;
  for (let s = 1; s < season; s++) {
    const count = seasonCounts.get(s);
    if (!count) return null;
    offset += count;
  }
  return offset + episode;
}

module.exports = {
  normalizeWords,
  significantWords,
  toAlias,
  stripYear,
  aliasCandidates,
  wordsMatch,
  seasonMarker,
  sameSeason,
  summarizeRelease,
  yearsCompatible,
  verdict,
  absoluteEpisode,
};
