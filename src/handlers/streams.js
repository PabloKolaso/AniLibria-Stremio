/**
 * Stream Handler
 *
 * Called by Stremio when a user opens a movie or an episode.
 * Stremio provides: type = "series" | "movie", and an ID that is either
 *   - IMDB-based (Cinemeta and other catalogs): "tt0388629:1:5" | "tt5311514"
 *   - from this addon's catalogs: "anilibria:9660:8" | "anilibria:6826"
 *
 * Returns up to 3 stream objects per episode (1080p, 720p, 480p HLS),
 * followed by a "☕ Support" link (externalUrl) whenever any were found.
 * Outdated installs get a "please reinstall" link (externalUrl) first in
 * every anime answer, see install-version.js.
 *
 * Every request is logged with its outcome category and reason, and feeds
 * the dashboard's telemetry: traffic buckets, users, top titles, missing
 * titles and the low-confidence match review.
 */

const resolver   = require('../bridge/resolver');
const anilibria  = require('../api/anilibria');
const mapping    = require('../mapping/cache');
const { findEpisode, hasHls, QUALITIES } = require('../bridge/episodes');
const { describeError } = require('../api/http');
const { MappingUnavailableError } = mapping;
const { parseId: parseCatalogId, playableEpisodes } = require('../catalogs/meta');
const { withTimeout, TimeoutError } = require('../util/timeout');
const requestLog = require('../telemetry/request-log');
const traffic    = require('../telemetry/traffic');
const users      = require('../telemetry/users');
const titles     = require('../telemetry/titles');
const missing    = require('../telemetry/missing');
const matches    = require('../telemetry/matches');
const problems   = require('../monitoring/problems');
const { withUpdateNotice } = require('../install-version');

const IMDB_RE = /^tt\d{7,10}$/;
const SUPPORTED_TYPES = new Set(['series', 'movie']);

/** Donation page, listed after the video streams of every successful answer. */
const SUPPORT_URL = 'https://buymeacoffee.com/anilibriastremio';

/** Overall budget for one stream request; slower lookups keep running and warm the caches. */
const REQUEST_DEADLINE_MS = 20_000;

// Client-side cache lifetimes (seconds) for empty answers, so Stremio does not poll.
const CACHE_NOT_ANIME = 3600;         // not in the anime mapping
const CACHE_NOT_ON_ANILIBRIA = 1800;  // anime AniLibria has not dubbed (yet)
const CACHE_EPISODE_MISSING = 900;    // episode missing from a finished release
const CACHE_EPISODE_PENDING = 120;    // episode not yet published by a release still being dubbed
const CACHE_DEGRADED = 300;           // answered while an upstream was unavailable

/** When a requested episode is missing, recheck AniLibria if our copy is older than this. */
const RECHECK_AFTER_MS = 30_000;

/** Resolver methods that matched by title and are kept for review. */
const LOW_CONFIDENCE_METHODS = new Set(['fuse', 'search']);

/**
 * Parse a Stremio stream ID into its components.
 * "tt0388629:1:5" → { imdbId: "tt0388629", season: 1, episode: 5 }
 * "tt0388629"     → { imdbId: "tt0388629", season: null, episode: null }
 * @returns {{ imdbId: string, season: number|null, episode: number|null }|null} null when malformed
 */
function parseId(id) {
  if (typeof id !== 'string') return null;
  const parts = id.split(':');
  if (parts.length !== 1 && parts.length !== 3) return null;
  const [imdbId, rawSeason, rawEpisode] = parts;
  if (!IMDB_RE.test(imdbId)) return null;
  if (parts.length === 1) return { imdbId, season: null, episode: null };
  if (!/^\d{1,4}$/.test(rawSeason) || !/^\d{1,5}$/.test(rawEpisode)) return null;
  return { imdbId, season: parseInt(rawSeason, 10), episode: parseInt(rawEpisode, 10) };
}

function releaseName(release) {
  return release.name?.english || release.name?.main || 'AniLibria';
}

/** Highest playable episode ordinal of a release, or null. */
function latestPlayable(release) {
  const playable = playableEpisodes(release);
  return playable.length > 0 ? playable[playable.length - 1].ordinal : null;
}

/**
 * Build stream objects for an episode (one per available quality).
 */
function buildStreams(release, episode, imdbId) {
  const name = releaseName(release);
  const episodeTitle = episode.name || episode.name_english || `Episode ${episode.ordinal}`;
  const streams = [];

  for (const { key, label } of QUALITIES) {
    const url = episode[key];
    if (typeof url !== 'string' || !url) continue;
    streams.push({
      url,
      name: `AniLibria\n${label}`,
      description: `${name} • ${episodeTitle}\nRussian Dub • HLS`,
      behaviorHints: {
        // Required for HLS (m3u8) playback in Stremio Android/TV
        notWebReady: true,
        // Auto-play of the next episode keeps the quality the user picked
        bingeGroup: `anilibria-${imdbId}-${label}`,
      },
    });
  }
  return streams;
}

function isFlaggedBlocked(release) {
  return Boolean(release.is_blocked_by_geo || release.is_blocked_by_copyrights);
}

/** Display facts about the release that served (or failed) a request. */
function releaseDetails(release) {
  return {
    releaseName: releaseName(release),
    alias: release.alias || null,
    poster: anilibria.mediaUrl(release.poster?.src),
    latestEpisode: latestPlayable(release),
    live: anilibria.isLive(release),
  };
}

/**
 * Re-read a release whose cached copy may predate a just-published episode.
 * @returns {Promise<object|null>} a newer copy, or null when there is none
 */
async function recheckRelease(releaseId, current) {
  try {
    const fresh = await anilibria.getRelease(releaseId, { maxAgeMs: RECHECK_AFTER_MS });
    return fresh && fresh !== current ? fresh : null;
  } catch {
    return null;
  }
}

/**
 * Resolve a request to streams without any logging or statistics side effects.
 *
 * @param {{ imdbId: string, type: string, season: number|null, episode: number|null }} req
 * @returns {Promise<{ outcome: 'success'|'not_found'|'error', reason: string, isAnime: true|null,
 *   title: string|null, method: string|null, releaseId: number|null, streams: object[],
 *   cacheMaxAge?: number, error?: Error, details: object }>}
 *   details — how the request was resolved: plan mode, attempts, examined releases
 */
async function findStreams(req) {
  const details = { planMode: null, attempts: [], examined: [], entryKey: null };
  const result = {
    outcome: 'not_found', reason: 'not_anime', isAnime: null,
    title: null, method: null, releaseId: null, streams: [], details,
  };

  let plan;
  try {
    plan = await resolver.plan(req);
  } catch (err) {
    return { ...result, outcome: 'error', reason: err instanceof MappingUnavailableError ? 'mapping_unavailable' : 'plan_failed', error: err };
  }
  result.isAnime = plan.isAnime;
  details.planMode = plan.mode;
  details.attempts = plan.attempts.map(a => ({
    entryKey: resolver.entryKey(a.entry), mal: a.entry.mal ?? null, anilist: a.entry.anilist ?? null,
    type: a.entry.type ?? null, tvdbSeason: a.entry.tvdbSeason ?? null, tvdbOffset: a.entry.tvdbOffset ?? 0,
    episode: a.episode, numbering: a.numbering, franchiseSeason: a.franchiseSeason ?? null,
  }));

  if (plan.mode === 'none') {
    // Not in the anime mapping, or an anime without any usable season data
    return plan.isAnime
      ? { ...result, reason: 'not_on_anilibria', cacheMaxAge: CACHE_NOT_ON_ANILIBRIA }
      : { ...result, reason: 'not_anime', cacheMaxAge: CACHE_NOT_ANIME };
  }
  if (plan.mode === 'special') {
    const primary = await resolver.resolveEntry(plan.primary).catch(() => null);
    return { ...result, reason: 'special_season', title: primary?.title || null, cacheMaxAge: CACHE_NOT_ANIME };
  }

  let showFound = false;   // the anime is on AniLibria (maybe not this season/episode)
  let sawRelease = false;  // at least one candidate release was tried
  let sawLive = false;     // a candidate release is still being dubbed
  let blocked = false;
  let degraded = false;
  let uncertain = plan.uncertain;
  let lastError = plan.error || null;

  // Collect candidate releases from every attempt (cours of the season, in
  // priority order). A release reached from several cours is a merged
  // release covering all of them, numbered from the earliest cour — which
  // is the attempt with the largest local episode number.
  const candidates = [];
  const byRelease = new Map();
  for (const attempt of plan.attempts) {
    let resolved;
    try {
      resolved = await resolver.resolveAttempt(attempt);
    } catch (err) {
      lastError = err;
      continue;
    }
    result.title = result.title || resolved.title;
    result.method = result.method || resolved.method;
    showFound = showFound || resolved.showFound;
    degraded = degraded || resolved.degraded;
    uncertain = uncertain || resolved.uncertain;
    if (resolved.uncertain && resolved.error) lastError = lastError || resolved.error;

    for (const candidate of resolved.candidates) {
      const seen = byRelease.get(candidate.releaseId);
      if (!seen) {
        const entry = { ...candidate, method: resolved.method, entryKey: resolver.entryKey(attempt.entry) };
        byRelease.set(candidate.releaseId, entry);
        candidates.push(entry);
      } else if (seen.numbering === candidate.numbering && candidate.episode > seen.episode) {
        seen.episode = candidate.episode;
      }
    }
  }

  for (const candidate of candidates) {
    const exam = { releaseId: candidate.releaseId, target: candidate.episode, numbering: candidate.numbering, method: candidate.method };
    details.examined.push(exam);
    if (candidate.episode === null) continue; // absolute episode number unknown
    sawRelease = true;
    let release;
    try {
      release = await anilibria.getRelease(candidate.releaseId);
    } catch (err) {
      if (err instanceof anilibria.GeoBlockedError) {
        blocked = true;
        exam.blocked = true;
      } else {
        lastError = err;
        exam.error = err.message;
      }
      continue;
    }
    if (!release) {
      exam.missing = true;
      continue;
    }

    let ep = findEpisode(release.episodes, candidate.episode, candidate.numbering);
    if (!ep) {
      const fresh = await recheckRelease(candidate.releaseId, release);
      if (fresh) {
        release = fresh;
        ep = findEpisode(release.episodes, candidate.episode, candidate.numbering);
      }
    }
    Object.assign(exam, releaseDetails(release));
    sawLive = sawLive || anilibria.isLive(release);
    if (!ep) continue;
    if (!hasHls(ep)) {
      if (isFlaggedBlocked(release)) blocked = true;
      else console.warn(`[streams] Episode ${ep.ordinal} of "${releaseName(release)}" exists but has no HLS URLs`);
      exam.noHls = true;
      continue;
    }

    exam.found = true;
    details.entryKey = candidate.entryKey;
    Object.assign(details, releaseDetails(release));
    return {
      ...result,
      outcome: 'success',
      reason: 'found',
      title: result.title || releaseName(release),
      method: candidate.method,
      releaseId: release.id,
      streams: buildStreams(release, ep, req.imdbId),
    };
  }

  if (blocked) return { ...result, outcome: 'error', reason: 'blocked' };
  if (lastError || uncertain) {
    return { ...result, outcome: 'error', reason: sawRelease ? 'release_fetch_failed' : 'lookup_failed', error: lastError };
  }
  if (!showFound) {
    return { ...result, reason: 'not_on_anilibria', cacheMaxAge: degraded ? CACHE_DEGRADED : CACHE_NOT_ON_ANILIBRIA };
  }
  const missingCache = sawLive ? CACHE_EPISODE_PENDING : CACHE_EPISODE_MISSING;
  return { ...result, reason: 'episode_not_found', cacheMaxAge: degraded ? Math.min(CACHE_DEGRADED, missingCache) : missingCache };
}

/**
 * Streams for this addon's own catalog IDs: the release is known, so the
 * episode is looked up directly (the same data the meta handler lists).
 *
 * @param {{ releaseId: number, ordinal: number|null }} req - ordinal null = first episode (movies)
 * @returns {Promise<object>} same shape as findStreams()
 */
async function findCatalogStreams({ releaseId, ordinal }) {
  const exam = { releaseId, target: ordinal, numbering: 'direct', method: 'direct' };
  const details = { planMode: 'catalog', attempts: [], examined: [exam], entryKey: null };
  const result = {
    outcome: 'not_found', reason: 'release_missing', isAnime: true,
    title: null, method: 'direct', releaseId, streams: [], details,
  };
  const pick = release => {
    const playable = playableEpisodes(release);
    return ordinal === null ? playable[0] || null : playable.find(e => e.ordinal === ordinal) || null;
  };

  let release;
  try {
    release = await anilibria.getRelease(releaseId);
  } catch (err) {
    if (err instanceof anilibria.GeoBlockedError) return { ...result, outcome: 'error', reason: 'blocked' };
    return { ...result, outcome: 'error', reason: 'release_fetch_failed', error: err };
  }
  if (!release) return { ...result, cacheMaxAge: CACHE_NOT_ON_ANILIBRIA };
  result.title = releaseName(release);

  let ep = pick(release);
  if (!ep) {
    const fresh = await recheckRelease(releaseId, release);
    if (fresh) {
      release = fresh;
      ep = pick(release);
    }
  }
  Object.assign(exam, releaseDetails(release));
  Object.assign(details, releaseDetails(release));
  if (!ep) {
    if (isFlaggedBlocked(release)) return { ...result, outcome: 'error', reason: 'blocked' };
    return {
      ...result,
      reason: 'episode_not_found',
      cacheMaxAge: anilibria.isLive(release) ? CACHE_EPISODE_PENDING : CACHE_EPISODE_MISSING,
    };
  }
  exam.found = true;
  return { ...result, outcome: 'success', reason: 'found', streams: buildStreams(release, ep, `r${releaseId}`) };
}

// ─── Stremio-facing handler (logging, telemetry, response shaping) ───────────

function errorStream(description) {
  return {
    name: 'AniLibria\n⚠ Error',
    description,
    externalUrl: 'https://anilibria.top',
  };
}

/**
 * Append the support link after the video streams. Never added to an empty
 * list (it would hide "no streams"), and has no bingeGroup so auto-play of the
 * next episode never picks it.
 */
function withSupportLink(streams) {
  if (streams.length === 0) return streams;
  return [...streams, {
    name: '☕ Support',
    description: 'Support AniLibria for Stremio on Buy Me a Coffee',
    externalUrl: SUPPORT_URL,
  }];
}

/** Feed the dashboard's telemetry with one finished request. */
function recordTelemetry({ id, type, ip, imdbId, direct, parsed, res, category, ms, errorText }) {
  const source = direct ? 'catalog' : 'imdb';
  const season = parsed ? parsed.season : null;
  const episode = parsed ? parsed.episode : direct.ordinal;
  const details = res.details || {};
  const passThrough = category === 'pass_through';
  // Non-anime requests are not anime usage: hashed only to group repeat requests
  const userHash = passThrough ? users.hashIp(ip) : users.recordUser(ip);
  const releaseId = res.releaseId ?? (direct ? direct.releaseId : null);

  const logSeq = requestLog.add({
    id, source, type, imdbId, releaseId, season, episode,
    anime: res.isAnime, outcome: res.outcome, category, reason: res.reason, method: res.method,
    title: res.title, streams: res.streams.length, ms, error: errorText, entryKey: details.entryKey,
  });
  traffic.recordStream({ category, reason: res.reason, method: res.method, source, ms });

  if (category === 'found') {
    titles.record({ releaseId, name: details.releaseName || res.title, poster: details.poster, imdbId, userHash });
    missing.recordSuccess({ imdbId, releaseId, source, type, season, episode, title: res.title });
    if (LOW_CONFIDENCE_METHODS.has(res.method)) matches.recordUse(details.entryKey, imdbId);
  } else if (category === 'not_on_anilibria' && imdbId) {
    missing.recordFailure({
      category, imdbId, source, type, season, episode, title: res.title, userHash,
      entries: mapping.getEntriesSync(imdbId),
    });
  } else if (category === 'episode_missing') {
    const exam = details.examined?.find(e => e.latestEpisode !== undefined) || details.examined?.[0] || {};
    missing.recordFailure({
      category, imdbId, releaseId: exam.releaseId ?? releaseId, source, type, season, episode,
      target: exam.target ?? null, title: res.title, userHash,
      entries: imdbId ? mapping.getEntriesSync(imdbId) : [],
      latestEpisode: exam.latestEpisode ?? null, live: exam.live ?? null, numbering: exam.numbering || null,
    });
  } else if (passThrough && imdbId) {
    missing.recordPassThrough({ imdbId, type, season, episode, userHash, logSeq });
  } else if (category === 'error' && res.reason !== 'unexpected') {
    problems.record({
      source: 'streams',
      key: `${res.reason}:${res.error?.service || ''}:${res.error?.code || ''}`,
      title: `Stream lookup failed (${res.reason})`,
      message: `${id}${res.title ? ` "${res.title}"` : ''}: ${errorText}`,
    });
  }
}

/** Stremio response for a finished lookup. */
function respond(res) {
  if (res.outcome === 'success') return { streams: withSupportLink(res.streams) };

  if (res.outcome === 'error') {
    if (res.reason === 'blocked') {
      return {
        streams: [{
          name: 'AniLibria\nBlocked',
          description: 'This content is restricted or geo-blocked on AniLibria in your region.',
          externalUrl: 'https://anilibria.top',
        }],
      };
    }
    const detail = res.reason === 'timeout'
      ? 'lookup is taking longer than usual'
      : res.error ? describeError(res.error) : 'service temporarily unavailable';
    return {
      streams: [errorStream(`Temporary error looking up this anime (${detail}).\nTry again in a moment.`)],
    };
  }

  return { streams: [], cacheMaxAge: res.cacheMaxAge };
}

/**
 * Main stream handler.
 * @param {{ type: string, id: string, ip?: string|null, installVersion?: string|null }} args
 *        installVersion: the installed manifest version, see install-version.js
 *        (null for calls that are not addon requests: never shows the update notice)
 * @returns {Promise<{ streams: object[], cacheMaxAge?: number }>}
 */
async function streamHandler({ type, id, ip = null, installVersion = null }) {
  const startTime = Date.now();
  if (!SUPPORTED_TYPES.has(type)) return { streams: [] };
  const direct = parseCatalogId(id);
  const parsed = direct ? null : parseId(id);
  if (!direct && !parsed) return { streams: [] };

  const imdbId = parsed ? parsed.imdbId : null;
  let label;
  let lookup;
  if (direct) {
    label = direct.ordinal === null ? id : `anilibria:${direct.releaseId} e${direct.ordinal}`;
    lookup = findCatalogStreams(direct);
  } else {
    const { season, episode } = parsed;
    label = season === null ? imdbId : `${imdbId} s${season}e${episode}`;
    lookup = findStreams({ imdbId, type, season, episode });
  }

  let res;
  try {
    res = await withTimeout(lookup, REQUEST_DEADLINE_MS);
  } catch (err) {
    res = {
      outcome: 'error', reason: err instanceof TimeoutError ? 'timeout' : 'unexpected', isAnime: null,
      title: null, method: null, releaseId: null, streams: [], error: err, details: {},
    };
  }

  const responseTimeMs = Date.now() - startTime;
  const category = traffic.categorize(res);
  const errorText = res.outcome === 'error'
    ? (res.reason === 'blocked' ? 'Geo-blocked' : `${res.reason}${res.error ? `: ${res.error.message}` : ''}`)
    : null;

  try {
    recordTelemetry({ id, type, ip, imdbId, direct, parsed, res, category, ms: responseTimeMs, errorText });
  } catch (err) {
    console.error('[streams] Telemetry failed:', err); // never fail a request because of statistics
  }

  const summary = res.outcome === 'success'
    ? `${res.streams.length} stream(s) from release ${res.releaseId} via ${res.method}`
    : `${res.outcome} (${res.reason})${res.error ? ` — ${res.error.message}` : ''}`;
  const logLine = `[streams] ${type} ${label}${res.title ? ` "${res.title}"` : ''} → ${summary} [${responseTimeMs}ms]`;
  if (res.reason === 'unexpected') console.error(logLine, res.error);
  else if (res.outcome === 'error') console.warn(logLine);
  else console.log(logLine);

  // Non-anime titles never get the update notice: Stremio asks this addon
  // about every movie and series, so it would follow users everywhere
  const response = respond(res);
  return category === 'pass_through' ? response : withUpdateNotice(response, installVersion);
}

module.exports = { streamHandler, findStreams, findCatalogStreams, parseId, buildStreams };
