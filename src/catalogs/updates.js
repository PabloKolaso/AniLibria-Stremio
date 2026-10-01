/**
 * Recent AniLibria updates, as seen by the releasing poller.
 *
 * The poller already detects changed releases every minute; this module
 * turns those observations into a bounded event feed for the dashboard:
 *   episode   — a release's latest playable episode number went up
 *   release   — a release appeared that the catalog index did not have
 *   blocked / unblocked — AniLibria's geo/copyright flags changed
 *
 * The last known episode per release is persisted with the events
 * (data/updates.json), so a restart neither loses the feed nor reports
 * every release as new. Events: newest 100, at most 30 days old.
 */

const path      = require('path');
const config    = require('../config');
const JsonStore = require('../util/json-store');

const FILE = path.join(config.dataDir, 'updates.json');
const MAX_EVENTS = 100;
const EVENT_RETENTION_MS = 30 * 24 * 60 * 60 * 1000;
const KNOWN_RETENTION_MS = 30 * 24 * 60 * 60 * 1000;

let events = [];  // newest first: { at, type, releaseId, name, poster, episode, fromEpisode }
let known = {};   // releaseId -> { episode, blocked, seenAt }

const store = new JsonStore(FILE, {
  serialize: () => ({ version: 1, events, known }),
  debounceMs: 5000,
  label: 'AniLibria updates',
});

function init() {
  const saved = JsonStore.read(FILE);
  if (saved && saved.version === 1) {
    if (Array.isArray(saved.events)) events = saved.events.filter(e => e && Number.isFinite(e.at));
    if (saved.known && typeof saved.known === 'object') known = saved.known;
  }
  prune();
}

function prune(now = Date.now()) {
  events = events.filter(e => now - e.at < EVENT_RETENTION_MS).slice(0, MAX_EVENTS);
  for (const [id, k] of Object.entries(known)) if (now - k.seenAt > KNOWN_RETENTION_MS) delete known[id];
}

init();

function push(event) {
  events.unshift({ at: Date.now(), ...event });
  if (events.length > MAX_EVENTS) events.length = MAX_EVENTS;
}

/**
 * Observe the current state of a release.
 * @param {{ id: number, name: string|null, poster?: string|null, episode: number|null,
 *           blocked: boolean, isNew?: boolean }} release
 *   isNew — the catalog index did not know this release before this poll
 */
function observe({ id, name, poster = null, episode, blocked, isNew = false }) {
  const now = Date.now();
  const prev = known[id];
  const base = { releaseId: id, name, poster };
  if (!prev) {
    if (isNew) push({ ...base, type: 'release', episode });
  } else {
    if (episode !== null && prev.episode !== null && episode > prev.episode) {
      push({ ...base, type: 'episode', episode, fromEpisode: prev.episode });
    }
    if (blocked !== prev.blocked) push({ ...base, type: blocked ? 'blocked' : 'unblocked', episode });
  }
  known[id] = {
    episode: episode ?? prev?.episode ?? null,
    blocked,
    seenAt: now,
  };
  store.schedule();
}

/** The event feed, newest first. */
function list(limit = MAX_EVENTS) {
  prune();
  return events.slice(0, limit);
}

module.exports = { observe, list, flush: () => store.flush() };
