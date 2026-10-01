/**
 * Manifest version each client is known to have.
 *
 * Stremio identifies an installed addon by its install URL: reinstalling
 * from /manifest.json replaces the stored manifest in place, while any other
 * URL would add a second copy of the addon. Every install therefore keeps
 * the same URL, and its requests cannot say which manifest it has. Instead a
 * client (salted IP hash, as in users.js) is known to have
 *   - the version of the manifest it last fetched (installing fetches it), or
 *   - at least CATALOGS_SINCE once it requests a catalog or catalog item,
 *     which only manifests from that version on declare.
 * Clients without such evidence are "legacy", see install-version.js.
 * Evidence expires RETENTION_MS after the client was last seen.
 */

const path      = require('path');
const semver    = require('semver');
const config    = require('../config');
const JsonStore = require('../util/json-store');
const { hashIp } = require('./users');
const { DAY_MS, HOUR_MS } = require('../util/time');

const FILE = path.join(config.dataDir, 'client-versions.json');
const RETENTION_MS = 90 * DAY_MS;
const MAX_CLIENTS = 100_000;
/** A known client's "last seen" is refreshed at most this often (fewer writes). */
const TOUCH_INTERVAL_MS = HOUR_MS;

/** First manifest version that declares catalogs and the meta resource. */
const CATALOGS_SINCE = '3.0.0';

/** hash -> { v: manifest version, at: last seen (ms) }, least recently seen first */
const clients = new Map();

const store = new JsonStore(FILE, {
  serialize: () => {
    prune();
    return { version: 1, clients: [...clients].map(([hash, c]) => [hash, c.v, c.at]) };
  },
  debounceMs: 30_000,
  label: 'client versions',
});

function init() {
  const saved = JsonStore.read(FILE);
  if (!saved || saved.version !== 1 || !Array.isArray(saved.clients)) return;
  const rows = saved.clients
    .filter(r => Array.isArray(r) && typeof r[0] === 'string' && semver.valid(r[1]) === r[1] && Number.isFinite(r[2]))
    .sort((a, b) => a[2] - b[2]);
  for (const [hash, v, at] of rows) clients.set(hash, { v, at });
  prune();
}

function prune(now = Date.now()) {
  for (const [hash, c] of clients) {
    if (now - c.at <= RETENTION_MS) break; // the rest were seen later
    clients.delete(hash);
  }
}

/** Store a client as the most recently seen one, within MAX_CLIENTS. */
function put(hash, v, now) {
  clients.delete(hash);
  clients.set(hash, { v, at: now });
  if (clients.size > MAX_CLIENTS) clients.delete(clients.keys().next().value);
  store.schedule();
}

init();

/** The client fetched the manifest of `version` (an install or reinstall). */
function recordManifest(ip, version, now = Date.now()) {
  const hash = hashIp(ip);
  if (hash) put(hash, version, now);
}

/** The client made a request only manifests of `version` or later can make. */
function recordAtLeast(ip, version, now = Date.now()) {
  const hash = hashIp(ip);
  if (!hash) return;
  const known = clients.get(hash);
  put(hash, known && semver.gt(known.v, version) ? known.v : version, now);
}

/**
 * Manifest version the client is known to have, or null. Keeps the evidence
 * of a client that keeps using the addon from expiring.
 */
function knownVersion(ip, now = Date.now()) {
  const hash = hashIp(ip);
  const known = hash ? clients.get(hash) : undefined;
  if (!known) return null;
  if (now - known.at > RETENTION_MS) {
    clients.delete(hash);
    return null;
  }
  if (now - known.at > TOUCH_INTERVAL_MS) put(hash, known.v, now);
  return known.v;
}

module.exports = { CATALOGS_SINCE, recordManifest, recordAtLeast, knownVersion, flush: () => store.flush() };
