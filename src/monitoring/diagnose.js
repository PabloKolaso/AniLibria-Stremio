/**
 * Resolve tester: re-resolves one Stremio ID, bypassing the resolver memo,
 * and reports every step. It runs the same code as real stream requests
 * (findStreams / findCatalogStreams) but records no statistics.
 *
 * Accepts an IMDB ID ("tt0388629"), a Stremio ID ("tt0388629:1:5",
 * "anilibria:9660:8") or a pasted URL containing one (Stremio web/app links,
 * IMDB title pages). Explicit type/season/episode values override the ones
 * found in the input.
 */

const consoleCapture = require('./console');
const resolver   = require('../bridge/resolver');
const mapping    = require('../mapping/cache');
const catalogIndex = require('../mapping/anilibria-catalog');
const anilibria  = require('../api/anilibria');
const traffic    = require('../telemetry/traffic');

const MAX_INPUT = 500;
const RATE_WINDOW_MS = 60_000;
const RATE_MAX = 12;

let running = false;
const recentRuns = [];

class DiagnoseError extends Error {
  constructor(message, status = 400) {
    super(message);
    this.status = status;
  }
}

function toInt(value, { min = 0, max = 99_999 } = {}) {
  if (value === undefined || value === null || value === '') return null;
  const n = Number(value);
  return Number.isInteger(n) && n >= min && n <= max ? n : undefined;
}

/**
 * Parse tester input into a request.
 * @returns {{ kind: 'imdb'|'catalog', id: string, imdbId?: string, releaseId?: number,
 *             ordinal?: number|null, type: 'series'|'movie', season: number|null, episode: number|null }}
 * @throws {DiagnoseError}
 */
function parseInput(input, { type, season, episode } = {}) {
  let text = String(input || '').trim().slice(0, MAX_INPUT);
  try { text = decodeURIComponent(text); } catch { /* keep as typed */ }
  if (!text) throw new DiagnoseError('Enter an IMDB ID, a Stremio ID or a Stremio URL');

  const urlType = /\/(series|movie)\//.exec(text)?.[1] || null;
  const explicitType = type === 'movie' || type === 'series' ? type : null;
  const s = toInt(season, { max: 9999 });
  const e = toInt(episode, { max: 99_999 });
  if (s === undefined || e === undefined) throw new DiagnoseError('Season and episode must be whole numbers');

  const catalog = /anilibria:(\d{1,7})(?::(\d{1,5}(?:\.\d{1,3})?))?/.exec(text);
  if (catalog) {
    const releaseId = Number(catalog[1]);
    const ordinal = e !== null ? e : catalog[2] !== undefined ? Number(catalog[2]) : null;
    return {
      kind: 'catalog', releaseId, ordinal,
      id: ordinal === null ? `anilibria:${releaseId}` : `anilibria:${releaseId}:${ordinal}`,
      type: explicitType || urlType || 'series', season: null, episode: ordinal,
    };
  }

  // The last IMDB ID in the text is the most specific one (Stremio URLs repeat it)
  const all = [...text.matchAll(/(tt\d{7,10})(?::(\d{1,4}):(\d{1,5}))?/g)];
  const imdb = all.find(m => m[2] !== undefined) || all[all.length - 1];
  if (!imdb) throw new DiagnoseError('No IMDB ID (tt…) or AniLibria catalog ID (anilibria:…) found');
  const imdbId = imdb[1];
  let resolvedType = explicitType || urlType || (imdb[2] !== undefined || s !== null ? 'series' : 'series');
  let seasonNo = s !== null ? s : imdb[2] !== undefined ? Number(imdb[2]) : null;
  let episodeNo = e !== null ? e : imdb[3] !== undefined ? Number(imdb[3]) : null;
  if (resolvedType === 'movie') {
    seasonNo = null;
    episodeNo = null;
  } else if (seasonNo === null || episodeNo === null) {
    // A series needs both; default to the first episode of season 1
    seasonNo = seasonNo ?? 1;
    episodeNo = episodeNo ?? 1;
  }
  return {
    kind: 'imdb', imdbId, type: resolvedType, season: seasonNo, episode: episodeNo,
    id: seasonNo === null ? imdbId : `${imdbId}:${seasonNo}:${episodeNo}`,
  };
}

function checkRate() {
  const now = Date.now();
  while (recentRuns.length > 0 && now - recentRuns[0] > RATE_WINDOW_MS) recentRuns.shift();
  if (running) throw new DiagnoseError('Another test is still running', 429);
  if (recentRuns.length >= RATE_MAX) throw new DiagnoseError('Too many tests in the last minute; wait a moment', 429);
  recentRuns.push(now);
}

/**
 * Run a diagnostic resolution.
 * @param {{ input: string, type?: string, season?: any, episode?: any }} opts
 * @throws {DiagnoseError} invalid input (400) or too many runs (429)
 */
async function diagnose({ input, type, season, episode }) {
  const parsed = parseInput(input, { type, season, episode });
  checkRate();
  running = true;
  const before = consoleCapture.lastSeq();
  const started = Date.now();
  let result;
  let cacheCleared = 0;
  try {
    // Loaded lazily: the stream handler pulls in all telemetry modules
    const { findStreams, findCatalogStreams } = require('../handlers/streams');
    if (parsed.kind === 'catalog') {
      anilibria.invalidateRelease(parsed.releaseId);
      result = await findCatalogStreams({ releaseId: parsed.releaseId, ordinal: parsed.ordinal });
    } else {
      cacheCleared = await resolver.clearCache(parsed.imdbId);
      result = await findStreams({ imdbId: parsed.imdbId, type: parsed.type, season: parsed.season, episode: parsed.episode });
    }
  } catch (err) {
    result = { outcome: 'error', reason: 'unexpected', error: err, streams: [], details: {} };
  } finally {
    running = false;
  }

  const details = result.details || {};
  const releaseId = result.releaseId ?? (parsed.kind === 'catalog' ? parsed.releaseId : null);
  const indexed = releaseId ? catalogIndex.peek()?.byId.get(releaseId) : null;
  const alias = details.alias || indexed?.alias || null;
  return {
    input: String(input).slice(0, MAX_INPUT),
    parsed,
    durationMs: Date.now() - started,
    outcome: result.outcome,
    reason: result.reason,
    category: traffic.categorize(result),
    isAnime: result.isAnime ?? null,
    title: result.title ?? null,
    method: result.method ?? null,
    release: releaseId ? {
      id: releaseId,
      name: details.releaseName || indexed?.en || indexed?.ru || null,
      alias,
      url: anilibria.releaseUrl(alias),
      poster: details.poster || null,
      latestEpisode: details.latestEpisode ?? null,
      live: details.live ?? null,
    } : null,
    streams: (result.streams || []).map(s => ({ quality: String(s.name || '').split('\n')[1] || s.name, url: s.url || null })),
    error: result.error ? result.error.message : null,
    details,
    mapping: parsed.imdbId ? mapping.getEntriesSync(parsed.imdbId) : [],
    cacheCleared,
    logs: consoleCapture.getLines({ after: before }).map(consoleCapture.formatLine),
  };
}

module.exports = { diagnose, parseInput, DiagnoseError };
