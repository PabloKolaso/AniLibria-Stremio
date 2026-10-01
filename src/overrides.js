/**
 * Manual overrides set from the dashboard.
 *
 *  - ignoredLookups:   IMDB ID -> { reason, ignoredAt }   hidden from Missing Titles
 *  - notDubbedLookups: IMDB ID -> { markedAt }            "not dubbed yet" (temporary)
 *  - matchDecisions:   entry key ("mal:123" | "al:456") -> { releaseId, decision, at }
 *                      approve = pin the release for that anime,
 *                      reject  = never match that release to that anime
 *
 * Persisted to data/overrides.json. An overrides.json in the project root
 * (e.g. committed for hosts with ephemeral disks) is merged in at startup.
 */

const fs        = require('fs');
const path      = require('path');
const config    = require('./config');
const JsonStore = require('./util/json-store');
const legacy    = require('./telemetry/legacy-stats');

const FILE      = path.join(config.dataDir, 'overrides.json');
const ROOT_FILE = path.resolve(__dirname, '../overrides.json');

const IMDB_ID_RE = /^tt\d{7,10}$/;
const ENTRY_KEY_RE = /^(mal|al):\d{1,9}$/;
const MAX_REASON_LENGTH = 500;
const DECISIONS = new Set(['approve', 'reject']);

let state = { ignoredLookups: {}, notDubbedLookups: {}, matchDecisions: {} };
const listeners = new Set();

const store = new JsonStore(FILE, {
  serialize: () => ({ version: 1, ...state }),
  debounceMs: 1000,
  label: 'overrides',
});

function isPlainObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

// ─── Sanitization ────────────────────────────────────────────────────────────

function sanitizeTimestamp(value) {
  const n = Number(value);
  return Number.isFinite(n) && n > 0 && n < 8.64e15 ? n : Date.now();
}

function sanitizeIgnored(value) {
  const reason = isPlainObject(value) && typeof value.reason === 'string' ? value.reason.slice(0, MAX_REASON_LENGTH) : '';
  return { reason, ignoredAt: sanitizeTimestamp(isPlainObject(value) ? value.ignoredAt : undefined) };
}

function sanitizeNotDubbed(value) {
  return { markedAt: sanitizeTimestamp(isPlainObject(value) ? value.markedAt : undefined) };
}

function sanitizeDecision(value) {
  if (!isPlainObject(value) || !DECISIONS.has(value.decision)) return null;
  const releaseId = Number(value.releaseId);
  if (!Number.isInteger(releaseId) || releaseId <= 0) return null;
  return { releaseId, decision: value.decision, at: sanitizeTimestamp(value.at) };
}

const SECTIONS = [
  { name: 'ignoredLookups',   keyRe: IMDB_ID_RE,   sanitize: sanitizeIgnored },
  { name: 'notDubbedLookups', keyRe: IMDB_ID_RE,   sanitize: sanitizeNotDubbed },
  { name: 'matchDecisions',   keyRe: ENTRY_KEY_RE, sanitize: sanitizeDecision },
];

/**
 * Valid entries of an overrides payload, per section.
 * @returns {Record<string, Array<[string, object]>>}
 */
function validEntries(payload) {
  const out = {};
  for (const { name, keyRe, sanitize } of SECTIONS) {
    out[name] = [];
    const source = isPlainObject(payload) ? payload[name] : null;
    if (!isPlainObject(source)) continue;
    for (const [key, value] of Object.entries(source)) {
      if (!keyRe.test(key)) continue;
      const clean = sanitize(value);
      if (clean) out[name].push([key, clean]);
    }
  }
  return out;
}

function merge(payload) {
  const entries = validEntries(payload);
  for (const [name, list] of Object.entries(entries)) {
    for (const [key, value] of list) state[name][key] = value;
  }
  return entries;
}

// ─── Initialization ──────────────────────────────────────────────────────────

function init() {
  const saved = JsonStore.read(FILE);
  if (isPlainObject(saved)) {
    merge(saved);
  } else {
    // First start after upgrading: import the overrides kept in stats.json
    const old = legacy.readStats();
    if (old) {
      const imported = merge(old);
      if (imported.ignoredLookups.length + imported.notDubbedLookups.length > 0) store.schedule();
    }
  }
  if (fs.existsSync(ROOT_FILE)) {
    const root = JsonStore.read(ROOT_FILE);
    if (isPlainObject(root)) {
      merge(root);
      store.schedule();
      console.log('[overrides] Loaded overrides from overrides.json');
    }
  }
}

init();

function changed(event) {
  store.schedule();
  for (const listener of listeners) {
    try { listener(event); } catch (err) { console.warn('[overrides] Listener failed:', err.message); }
  }
}

/** Called with { type: 'ignore'|'notDubbed'|'match'|'import', key } after every change. */
function onChange(listener) {
  listeners.add(listener);
}

// ─── Ignored / not dubbed ────────────────────────────────────────────────────

function ignore(imdbId, reason) {
  if (!IMDB_ID_RE.test(imdbId)) return false;
  state.ignoredLookups[imdbId] = sanitizeIgnored({ reason: String(reason || ''), ignoredAt: Date.now() });
  changed({ type: 'ignore', key: imdbId });
  return true;
}

function unignore(imdbId) {
  if (!state.ignoredLookups[imdbId]) return false;
  delete state.ignoredLookups[imdbId];
  changed({ type: 'ignore', key: imdbId });
  return true;
}

function getIgnored(imdbId) {
  return Object.hasOwn(state.ignoredLookups, imdbId) ? state.ignoredLookups[imdbId] : null;
}

function markNotDubbed(imdbId) {
  if (!IMDB_ID_RE.test(imdbId)) return false;
  state.notDubbedLookups[imdbId] = { markedAt: Date.now() };
  changed({ type: 'notDubbed', key: imdbId });
  return true;
}

function unmarkNotDubbed(imdbId) {
  if (!state.notDubbedLookups[imdbId]) return false;
  delete state.notDubbedLookups[imdbId];
  changed({ type: 'notDubbed', key: imdbId });
  return true;
}

function getNotDubbed(imdbId) {
  return Object.hasOwn(state.notDubbedLookups, imdbId) ? state.notDubbedLookups[imdbId] : null;
}

function listIgnored() {
  return Object.entries(state.ignoredLookups).map(([imdbId, v]) => ({ imdbId, ...v }));
}

function listNotDubbed() {
  return Object.entries(state.notDubbedLookups).map(([imdbId, v]) => ({ imdbId, ...v }));
}

// ─── Match decisions ─────────────────────────────────────────────────────────

/**
 * @param {string} key - "mal:<id>" or "al:<id>"
 * @param {{ releaseId: number, decision: 'approve'|'reject' }} value
 */
function setMatchDecision(key, value) {
  if (!ENTRY_KEY_RE.test(key)) return false;
  const clean = sanitizeDecision({ ...value, at: Date.now() });
  if (!clean) return false;
  state.matchDecisions[key] = clean;
  changed({ type: 'match', key });
  return true;
}

function clearMatchDecision(key) {
  if (!state.matchDecisions[key]) return false;
  delete state.matchDecisions[key];
  changed({ type: 'match', key });
  return true;
}

function getMatchDecision(key) {
  return Object.hasOwn(state.matchDecisions, key) ? state.matchDecisions[key] : null;
}

function listMatchDecisions() {
  return Object.entries(state.matchDecisions).map(([key, v]) => ({ key, ...v }));
}

// ─── Export / import ─────────────────────────────────────────────────────────

function exportAll() {
  return {
    ignoredLookups: { ...state.ignoredLookups },
    notDubbedLookups: { ...state.notDubbedLookups },
    matchDecisions: { ...state.matchDecisions },
  };
}

/**
 * Merge an exported overrides file. Keys and values are validated so a
 * malformed file can never break the dashboard.
 * @param {object} data
 * @param {{ dryRun?: boolean }} [opts] - dryRun: only report what would change
 * @returns {{ ignored: number, notDubbed: number, matchDecisions: number,
 *             added: number, replaced: number, unchanged: number }}
 */
function importAll(data, { dryRun = false } = {}) {
  const entries = validEntries(data);
  let added = 0;
  let replaced = 0;
  let unchanged = 0;
  for (const [name, list] of Object.entries(entries)) {
    for (const [key, value] of list) {
      const current = state[name][key];
      if (!current) added++;
      else if (JSON.stringify(current) === JSON.stringify(value)) unchanged++;
      else replaced++;
    }
  }
  if (!dryRun) {
    merge(data);
    changed({ type: 'import', key: null });
  }
  return {
    ignored: entries.ignoredLookups.length,
    notDubbed: entries.notDubbedLookups.length,
    matchDecisions: entries.matchDecisions.length,
    added,
    replaced,
    unchanged,
  };
}

function counts() {
  return {
    ignored: Object.keys(state.ignoredLookups).length,
    notDubbed: Object.keys(state.notDubbedLookups).length,
    matchDecisions: Object.keys(state.matchDecisions).length,
  };
}

module.exports = {
  ignore, unignore, getIgnored, listIgnored,
  markNotDubbed, unmarkNotDubbed, getNotDubbed, listNotDubbed,
  setMatchDecision, clearMatchDecision, getMatchDecision, listMatchDecisions,
  exportAll, importAll, counts, onChange,
  flush: () => store.flush(),
  IMDB_ID_RE, ENTRY_KEY_RE,
};
