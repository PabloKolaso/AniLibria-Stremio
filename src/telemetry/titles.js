/**
 * Most watched anime, per AniLibria release.
 *
 * Every successful anime stream request is counted under the AniLibria
 * release that served it — so a show opened from Cinemeta (IMDB ID) and
 * from this addon's catalogs (anilibria: ID) is one entry. For each
 * release: stream requests per UTC day and the users (hashed IPs) with
 * the last day they requested it. History is kept for 30 days.
 *
 * "Stream requests" are what Stremio sends when an episode is opened (a
 * player may send more than one per episode); unique users is the more
 * robust popularity signal, so the ranking uses it first.
 */

const path      = require('path');
const config    = require('../config');
const JsonStore = require('../util/json-store');
const { dayIndex } = require('../util/time');

const FILE = path.join(config.dataDir, 'titles.json');
const KEEP_DAYS = 30;
const MAX_IMDB_IDS = 10;

/** releaseId -> { name, poster, imdbIds: string[], lastAt, days: { dayIndex: count }, users: { hash: dayIndex } } */
let releases = {};

const store = new JsonStore(FILE, {
  serialize: () => {
    prune();
    return { version: 1, releases };
  },
  debounceMs: 30_000,
  label: 'top titles',
});

function init() {
  const saved = JsonStore.read(FILE);
  if (saved && saved.version === 1 && saved.releases && typeof saved.releases === 'object') {
    releases = saved.releases;
    prune();
  }
}

function prune(now = Date.now()) {
  const cutoff = dayIndex(now) - KEEP_DAYS + 1;
  for (const [id, r] of Object.entries(releases)) {
    for (const day of Object.keys(r.days)) if (Number(day) < cutoff) delete r.days[day];
    for (const [hash, day] of Object.entries(r.users)) if (day < cutoff) delete r.users[hash];
    if (Object.keys(r.days).length === 0) delete releases[id];
  }
}

init();

/**
 * Count one successful stream request.
 * @param {{ releaseId: number, name?: string|null, poster?: string|null,
 *           imdbId?: string|null, userHash?: string|null }} req
 */
function record({ releaseId, name = null, poster = null, imdbId = null, userHash = null }) {
  if (!Number.isInteger(releaseId)) return;
  const now = Date.now();
  const day = dayIndex(now);
  let r = releases[releaseId];
  if (!r) r = releases[releaseId] = { name: null, poster: null, imdbIds: [], lastAt: now, days: {}, users: {} };
  if (name) r.name = name;
  if (poster) r.poster = poster;
  if (imdbId && !r.imdbIds.includes(imdbId) && r.imdbIds.length < MAX_IMDB_IDS) r.imdbIds.push(imdbId);
  r.lastAt = now;
  r.days[day] = (r.days[day] || 0) + 1;
  if (userHash) r.users[userHash] = day;
  store.schedule();
}

/**
 * Top releases over the last `days` UTC days (including today).
 * @returns {Array<{ releaseId: number, name: string|null, poster: string|null,
 *                   imdbIds: string[], requests: number, users: number, lastAt: number }>}
 */
function top({ days = 7, limit = 10 } = {}) {
  const from = dayIndex() - Math.min(days, KEEP_DAYS) + 1;
  const rows = [];
  for (const [id, r] of Object.entries(releases)) {
    let requests = 0;
    for (const [day, count] of Object.entries(r.days)) if (Number(day) >= from) requests += count;
    if (requests === 0) continue;
    let users = 0;
    for (const day of Object.values(r.users)) if (day >= from) users++;
    rows.push({ releaseId: Number(id), name: r.name, poster: r.poster, imdbIds: r.imdbIds, requests, users, lastAt: r.lastAt });
  }
  return rows.sort((a, b) => b.users - a.users || b.requests - a.requests).slice(0, limit);
}

module.exports = { record, top, KEEP_DAYS, flush: () => store.flush() };
