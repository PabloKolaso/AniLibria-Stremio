/**
 * Recent operational problems, grouped.
 *
 * Repeated occurrences of the same problem are one group with a count
 * ("AniLibria · timeout ×14, last 2 min ago") instead of 14 lines. Sources:
 *  - every console.error line (unexpected errors, handler failures, crashes);
 *  - explicit reports: failed upstream attempts, stream lookup errors and
 *    failing background refreshes.
 *
 * Groups are persisted (data/problems.json) so a restart does not erase the
 * evidence; the list is bounded by count and age.
 */

const path      = require('path');
const config    = require('../config');
const JsonStore = require('../util/json-store');
const consoleCapture = require('./console');

const FILE = path.join(config.dataDir, 'problems.json');
const MAX_GROUPS = 200;
const RETENTION_MS = 14 * 24 * 60 * 60 * 1000;
const ACTIVE_MS = 15 * 60 * 1000;
const MAX_MESSAGE = 500;
const MAX_DETAIL = 3000;

/** key -> { key, source, level, title, message, detail, count, firstAt, lastAt } */
let groups = new Map();

const store = new JsonStore(FILE, {
  serialize: () => ({ version: 1, groups: [...groups.values()] }),
  debounceMs: 10_000,
  label: 'problems',
});

function init() {
  const saved = JsonStore.read(FILE);
  if (saved && Array.isArray(saved.groups)) {
    for (const g of saved.groups) {
      if (g && typeof g.key === 'string' && Number.isFinite(g.lastAt)) groups.set(g.key, g);
    }
    prune();
  }
}

/** Stable fingerprint of a message: numbers, IDs and quoted values removed. */
function fingerprint(text) {
  return String(text)
    .split('\n')[0]
    .replace(/\[[0-9T:.\-Z]+\]/g, '')           // timestamps
    .replace(/"[^"]*"/g, '"…"')                  // quoted titles
    .replace(/\b[0-9a-f]{8,}\b/gi, '#')          // hashes / hex IDs
    .replace(/\btt\d+\b/g, 'tt#')
    .replace(/\d+(\.\d+)?/g, '#')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 200);
}

function prune() {
  const cutoff = Date.now() - RETENTION_MS;
  for (const [key, g] of groups) if (g.lastAt < cutoff) groups.delete(key);
  if (groups.size > MAX_GROUPS) {
    const oldest = [...groups.values()].sort((a, b) => a.lastAt - b.lastAt);
    for (const g of oldest.slice(0, groups.size - MAX_GROUPS)) groups.delete(g.key);
  }
}

/**
 * Record one occurrence of a problem.
 * @param {{ source: string, key: string, title: string, message?: string,
 *           detail?: string, level?: 'error'|'warning' }} problem
 *   key — groups occurrences (within the source); title — short group label
 */
function record({ source, key, title, message = '', detail = null, level = 'error' }) {
  const id = `${source}:${key}`;
  const now = Date.now();
  let g = groups.get(id);
  if (!g) {
    g = { key: id, source, level, title, message: '', detail: null, count: 0, firstAt: now, lastAt: now };
    groups.set(id, g);
    if (groups.size > MAX_GROUPS) prune();
  }
  g.count++;
  g.lastAt = now;
  g.level = level;
  g.title = title;
  g.message = String(message).slice(0, MAX_MESSAGE);
  g.detail = detail ? String(detail).slice(0, MAX_DETAIL) : null;
  store.schedule();
}

/**
 * Problem groups, most recent first.
 * @param {{ sinceMs?: number, limit?: number }} [opts]
 */
function list({ sinceMs = RETENTION_MS, limit = 50 } = {}) {
  const cutoff = Date.now() - sinceMs;
  const now = Date.now();
  return [...groups.values()]
    .filter(g => g.lastAt >= cutoff)
    .sort((a, b) => b.lastAt - a.lastAt)
    .slice(0, limit)
    .map(g => ({ ...g, active: now - g.lastAt < ACTIVE_MS }));
}

/** Dismiss one group (or all when key is omitted). */
function dismiss(key) {
  if (key === undefined) groups.clear();
  else groups.delete(key);
  store.schedule();
}

// Every console.error line is a problem (grouped by its fingerprint)
consoleCapture.onLine(line => {
  if (line.level !== 'error') return;
  const [first, ...rest] = line.text.split('\n');
  const tag = /^\[([^\]]+)\]/.exec(first)?.[1] || 'console';
  record({
    source: 'console',
    key: fingerprint(first),
    title: tag,
    message: first,
    detail: rest.length > 0 ? line.text : null,
  });
});

init();

module.exports = { record, list, dismiss, fingerprint, flush: () => store.flush() };
