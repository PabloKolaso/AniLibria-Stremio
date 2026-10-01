/**
 * ID Bridge & Resolver
 *
 * Connects Stremio requests (IMDB ID + season/episode) to AniLibria releases:
 *
 *  1. IMDB ID → Fribb mapping → the anime entry (MAL/AniList ID) that covers
 *     the requested season/episode (see bridge/targets.js)
 *  2. MAL ID → AniLibria release via the catalog index (exact ID match;
 *     the release year is cross-checked against AniList)
 *  3. Fallback for releases without IDs: AniList titles → exact alias →
 *     (AniLibria search API when the local index is unavailable) →
 *     Fuse.js fuzzy match, every candidate validated so a release tagged as
 *     a different anime is never accepted
 *
 * Per-entry results are memoized; the memo is cleared whenever the catalog
 * index is rebuilt so newly added releases are picked up.
 *
 * Manual match decisions from the dashboard (overrides.js) are applied per
 * anime entry: an approved release is used directly ("pinned"), a rejected
 * one is never matched again. Title-based matches (search/fuse) are recorded
 * for review (telemetry/matches.js).
 */

const mapping   = require('../mapping/cache');
const catalog   = require('../mapping/anilibria-catalog');
const anilibria = require('../api/anilibria');
const anilist   = require('../api/anilist');
const cinemeta  = require('../api/cinemeta');
const franchise = require('./franchise');
const matching  = require('./matching');
const overrides = require('../overrides');
const matches   = require('../telemetry/matches');
const { planTargets } = require('./targets');
const { HttpError } = require('../api/http');
const TTLCache  = require('../util/ttl-cache');

const HIT_TTL_MS      = 6 * 60 * 60 * 1000;
const MISS_TTL_MS     = 30 * 60 * 1000;
const DEGRADED_TTL_MS = 5 * 60 * 1000;
const MAX_HTTP_ALIAS_PROBES = 6;
const MAX_SEARCH_TITLES     = 4;

// entry key -> resolution result
const memo = new TTLCache({
  ttlMs: HIT_TTL_MS, max: 20_000,
  name: 'Resolver', description: 'AniLibria release per anime entry (6 h found, 30 min not found); cleared when the index changes',
});
let lastClear = null; // { at, reason }

function clearMemo(reason) {
  memo.clear();
  lastClear = { at: Date.now(), reason };
}

catalog.onRebuild(() => clearMemo('AniLibria index updated'));
overrides.onChange(event => {
  if (event.type === 'match') memo.delete(event.key);
  else if (event.type === 'import') clearMemo('overrides imported');
});

function entryKey(entry) {
  return entry.mal ? `mal:${entry.mal}` : `al:${entry.anilist}`;
}

/** Entry key of an AniList media object (same format as entryKey). */
function mediaKey(media) {
  return media.idMal ? `mal:${media.idMal}` : `al:${media.id}`;
}

/** Release IDs rejected for an anime entry (null when none). */
function rejectedFor(key) {
  const decision = overrides.getMatchDecision(key);
  return decision?.decision === 'reject' ? new Set([decision.releaseId]) : null;
}

/** Release pinned for an anime entry, or null. */
function pinnedFor(key) {
  const decision = overrides.getMatchDecision(key);
  return decision?.decision === 'approve' ? decision.releaseId : null;
}

// ─── Release lookup for one anime ───────────────────────────────────────────

/**
 * Find AniLibria releases for an anime.
 * @param {{ mal: number|null, year: number|null }} target
 * @param {string[]} titles - AniList title variants
 * @param {import('../mapping/anilibria-catalog').CatalogIndex|null} index
 * @param {{ offline?: boolean, exclude?: Set<number>|null, diag?: object|null }} [opts]
 *   offline — match against the local index only (no API calls)
 *   exclude — release IDs that must never be matched (rejected by the admin)
 *   diag    — receives { release, score } of a title-based (search/fuse) match
 * @returns {Promise<{ releaseIds: number[], method: string|null, uncertain: boolean, error?: Error }>}
 *   uncertain — no match, but upstream failures mean the anime may still exist (error = first failure)
 */
async function findReleases(target, titles, index, { offline = false, exclude = null, diag = null } = {}) {
  const allowed = r => !exclude || !exclude.has(r.id);

  // 1. Exact MAL/Shikimori ID match
  if (index && target.mal) {
    let accepted = index.findByMal(target.mal).filter(r => allowed(r) && matching.verdict(r, target).ok);
    // Several releases carrying the same ID (split cours, mislabelled sequels):
    // keep only those from the anime's own year when that disambiguates.
    if (accepted.length > 1 && target.year) {
      const sameYear = accepted.filter(r => r.year === target.year);
      if (sameYear.length > 0) accepted = sameYear;
    }
    if (accepted.length > 0) return { releaseIds: accepted.map(r => r.id), method: 'mal', uncertain: false };
  }
  const indexMissing = index
    ? undefined
    : new HttpError('AniLibria catalog index is not available', { code: 'UNAVAILABLE', service: 'AniLibria' });
  if (titles.length === 0 || (offline && !index)) {
    return { releaseIds: [], method: null, uncertain: !index, error: indexMissing };
  }

  // When the local index is complete and recent it is authoritative, and all
  // title matching happens in memory. Otherwise fall back to the live API.
  const trustIndex = Boolean(index?.isFresh) || offline;
  let uncertain = false;
  let firstError = null;

  // 2. Exact alias
  const aliases = matching.aliasCandidates(titles);
  for (const alias of trustIndex ? aliases : aliases.slice(0, MAX_HTTP_ALIAS_PROBES)) {
    let release = null;
    if (trustIndex) {
      release = index.findByAlias(alias);
    } else {
      try {
        const raw = await anilibria.getRelease(alias);
        release = raw ? matching.summarizeRelease(raw) : null;
      } catch (err) {
        if (!(err instanceof anilibria.GeoBlockedError)) {
          uncertain = true;
          firstError = firstError || err;
        }
        continue;
      }
    }
    if (release && allowed(release) && matching.verdict(release, target, { exactAlias: true }).ok) {
      return { releaseIds: [release.id], method: 'alias', uncertain: false };
    }
  }

  // 3. AniLibria's search API (only when the local index cannot be trusted)
  if (!trustIndex) {
    const searchable = titles.filter(t => t.length >= 3 && /[a-z]/i.test(t)).slice(0, MAX_SEARCH_TITLES);
    for (const title of searchable) {
      let results;
      try {
        results = await anilibria.searchReleases(title);
      } catch (err) {
        uncertain = true;
        firstError = firstError || err;
        continue;
      }
      const queryWords = matching.significantWords(title);
      for (const raw of results.slice(0, 3)) {
        const candidate = matching.summarizeRelease(raw);
        const candidateTitle = candidate.en || candidate.aliasWords;
        if (!matching.wordsMatch(queryWords, matching.significantWords(candidateTitle))) continue;
        if (!matching.sameSeason([title], candidateTitle)) continue;
        if (allowed(candidate) && matching.verdict(candidate, target).ok) {
          if (diag) Object.assign(diag, { release: candidate, score: null });
          return { releaseIds: [candidate.id], method: 'search', uncertain: false };
        }
      }
    }
  }

  // 4. Fuzzy match over the catalog index, among releases whose title starts
  //    with the same significant word as one of the anime's titles (wordsMatch)
  if (index) {
    const querySets = titles.map(t => matching.significantWords(t)).filter(w => w.length > 0);
    const firstWords = [...new Set(querySets.map(words => words[0]))];
    for (const { item, score } of index.search(titles, firstWords, 3)) {
      if (!allowed(item)) continue;
      const itemTitle = item.en || item.aliasWords;
      if (!querySets.some(qw => matching.wordsMatch(qw, matching.significantWords(itemTitle)))) continue;
      if (!matching.sameSeason(titles, itemTitle)) continue;
      if (!matching.verdict(item, target).ok) continue;
      console.log(`[resolver] Fuse match "${item.en || item.ru}" (score ${score.toFixed(3)})`);
      if (diag) Object.assign(diag, { release: item, score });
      return { releaseIds: [item.id], method: 'fuse', uncertain: false };
    }
  }

  if (!uncertain && index) return { releaseIds: [], method: null, uncertain: false };
  return { releaseIds: [], method: null, uncertain: true, error: firstError || indexMissing };
}

/**
 * Resolve one mapping entry (one anime) to AniLibria releases.
 *
 * @returns {Promise<{ releaseIds: number[], method: string|null, title: string|null,
 *                     titles: string[], year: number|null, degraded: boolean, uncertain: boolean }>}
 *   degraded  — AniList was unavailable (no titles / year check)
 *   uncertain — AniLibria availability could not be determined (upstream errors)
 */
async function resolveEntry(entry) {
  const key = entryKey(entry);
  const cached = memo.get(key);
  if (cached) return cached;

  let media = null;
  let degraded = false;
  try {
    media = await anilist.getMedia(entry);
  } catch (err) {
    degraded = true;
    console.warn(`[resolver] AniList lookup failed for ${key}: ${err.message}`);
  }

  const target = { mal: entry.mal || media?.idMal || null, year: anilist.mediaYear(media) };
  const titles = anilist.collectTitles(media);
  const pinned = pinnedFor(key);
  const diag = {};
  const found = pinned
    ? { releaseIds: [pinned], method: 'pinned', uncertain: false }
    : await findReleases(target, titles, await catalog.getIndex(), { exclude: rejectedFor(key), diag });

  const result = {
    releaseIds: found.releaseIds,
    method: found.method,
    title: titles[0] || null,
    titles,
    year: target.year,
    degraded,
    uncertain: found.uncertain,
    error: found.error || null,
  };

  if (found.releaseIds.length > 0) {
    console.log(`[resolver] ${key} (${result.title || 'untitled'}) → release ${found.releaseIds.join(', ')} via ${found.method}`);
  }
  if (diag.release) {
    matches.record({
      key, mal: entry.mal || media?.idMal || null, anilist: entry.anilist || media?.id || null,
      title: result.title, titles, year: target.year, method: found.method, score: diag.score, release: diag.release,
    });
  }

  if (!found.uncertain) {
    const ttl = degraded ? DEGRADED_TTL_MS : (found.releaseIds.length > 0 ? HIT_TTL_MS : MISS_TTL_MS);
    memo.set(key, result, ttl);
  }
  return result;
}

// ─── Per-request API ────────────────────────────────────────────────────────

/**
 * Plan which anime entries/episodes to try for a Stremio request.
 * Absolute episode numbers are computed here (needs Cinemeta for season > 1);
 * when that is impossible the attempt keeps `episode: null`, so the show can
 * still be resolved (and reported as "episode not found", not "missing").
 *
 * @param {{ imdbId: string, type: string, season: number|null, episode: number|null }} request
 * @returns {Promise<import('./targets').Plan & { isAnime: true|null, uncertain: boolean }>}
 * @throws {mapping.MappingUnavailableError}
 */
async function plan({ imdbId, type, season, episode }) {
  const entries = await mapping.getEntries(imdbId);
  const result = planTargets(entries, { type, season, episode });
  result.isAnime = entries.length > 0 ? true : null;
  result.uncertain = false;

  for (const attempt of result.attempts) {
    if (attempt.numbering !== 'absolute' || attempt.episode !== null) continue;
    let counts = null;
    try {
      counts = await cinemeta.getSeasonEpisodeCounts(imdbId);
    } catch (err) {
      result.uncertain = true;
      result.error = err;
      console.warn(`[resolver] Cinemeta episode counts failed for ${imdbId}: ${err.message}`);
    }
    attempt.episode = matching.absoluteEpisode(counts, attempt.absolute.season, attempt.absolute.episode);
  }
  return result;
}

/**
 * Resolve one planned attempt into concrete release candidates.
 * @returns {Promise<{ candidates: { releaseId: number, episode: number, numbering: string }[],
 *                     showFound: boolean, method: string|null, title: string|null,
 *                     degraded: boolean, uncertain: boolean }>}
 *   showFound — the anime itself is on AniLibria (even if the requested season is not)
 */
async function resolveAttempt(attempt) {
  const res = await resolveEntry(attempt.entry);
  let releaseIds = res.releaseIds;

  if (attempt.franchiseSeason && releaseIds.length > 0) {
    const seasonRelease = await franchise.findSeasonRelease(releaseIds[0], attempt.franchiseSeason);
    if (seasonRelease) {
      releaseIds = [seasonRelease.releaseId];
    } else if (attempt.franchiseSeason !== 1) {
      releaseIds = [];
    }
  }

  return {
    candidates: releaseIds.map(releaseId => ({ releaseId, episode: attempt.episode, numbering: attempt.numbering })),
    showFound: res.releaseIds.length > 0,
    method: res.method,
    title: res.title,
    degraded: res.degraded,
    uncertain: res.uncertain,
    error: res.error,
  };
}

/**
 * Resolve an AniList media object directly (bypassing the IMDB mapping and
 * the AniList lookup); used by the trending catalog and by scripts that
 * already hold AniList data.
 * @param {object} media - AniList media with idMal, title, synonyms, seasonYear
 * @param {{ offline?: boolean }} [opts] - offline: local catalog index only, no API calls
 * @returns {Promise<{ releaseIds: number[], method: string|null, uncertain: boolean }>}
 */
async function resolveMedia(media, { offline = false } = {}) {
  const key = mediaKey(media);
  const pinned = pinnedFor(key);
  if (pinned) return { releaseIds: [pinned], method: 'pinned', uncertain: false };
  const target = { mal: media.idMal || null, year: anilist.mediaYear(media) };
  const index = await catalog.getIndex();
  return findReleases(target, anilist.collectTitles(media), index, { offline, exclude: rejectedFor(key) });
}

/**
 * Forget memoized results for an IMDB ID so the next request re-resolves it.
 * @returns {Promise<number>} how many anime entries were cleared
 */
async function clearCache(imdbId) {
  let entries = [];
  try {
    entries = await mapping.getEntries(imdbId);
  } catch { /* mapping not loaded: nothing memoized either */ }
  let cleared = 0;
  for (const entry of entries) if (memo.delete(entryKey(entry))) cleared++;
  return cleared;
}

/** Forget every memoized result; returns how many entries were dropped. */
function clearAll(reason = 'cleared from the dashboard') {
  const size = memo.size;
  clearMemo(reason);
  return size;
}

/** Start building the AniLibria catalog index in the background. */
function warmup() {
  catalog.start();
}

/** Whether the AniLibria catalog index has been built. */
function isIndexReady() {
  return catalog.getInfo().size > 0;
}

/** When and why the resolver memo was last cleared ({ at, reason } or null). */
function lastCleared() {
  return lastClear;
}

module.exports = {
  plan,
  resolveAttempt,
  resolveEntry,
  resolveMedia,
  clearCache,
  clearAll,
  lastCleared,
  entryKey,
  warmup,
  isIndexReady,
};
