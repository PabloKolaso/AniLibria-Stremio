/**
 * Process lifecycle: boots, restarts, crashes and shutdowns.
 *
 * Every boot is recorded in data/lifecycle.json with a heartbeat, and a
 * graceful shutdown marks the run as clean. A run that ends without that
 * mark (killed, out of memory, crashed) is reported as an abnormal shutdown
 * at the next boot. Uncaught exceptions and unhandled rejections — which
 * index.js survives to keep serving — are counted and kept with their stack.
 */

const crypto    = require('crypto');
const path      = require('path');
const config    = require('../config');
const JsonStore = require('../util/json-store');
const { version } = require('../../package.json');

const FILE = path.join(config.dataDir, 'lifecycle.json');
const HEARTBEAT_MS = 60_000;
const MAX_BOOTS = 200;
const BOOT_RETENTION_MS = 90 * 24 * 60 * 60 * 1000;
const MAX_FATAL = 25;
const MAX_STACK = 4000;

const bootId = crypto.randomBytes(8).toString('hex');
const startedAt = Date.now() - Math.round(process.uptime() * 1000);

let state = { version: 1, boots: [], fatal: [] };
let current = null;            // this run's boot record (after start())
let previousShutdown = null;   // how the previous run ended
let heartbeat = null;
const counters = { uncaughtException: 0, unhandledRejection: 0 };
let lastFatal = null;
const fatalListeners = new Set();

const store = new JsonStore(FILE, { serialize: () => state, debounceMs: 1000, label: 'lifecycle' });

/** Record this boot and start the heartbeat. Call once at startup. */
function start() {
  if (current) return;
  const saved = JsonStore.read(FILE);
  if (saved && Array.isArray(saved.boots)) {
    state = {
      version: 1,
      boots: saved.boots.filter(b => b && Number.isFinite(b.startedAt)),
      fatal: Array.isArray(saved.fatal) ? saved.fatal.slice(-MAX_FATAL) : [],
    };
  }
  const previous = state.boots.at(-1);
  if (previous) {
    previousShutdown = {
      startedAt: previous.startedAt,
      endedAt: previous.endedAt || null,
      lastAliveAt: previous.lastAliveAt || null,
      clean: Boolean(previous.clean),
      signal: previous.signal || null,
      version: previous.version || null,
    };
  }

  const cutoff = Date.now() - BOOT_RETENTION_MS;
  state.boots = state.boots.filter(b => b.startedAt >= cutoff).slice(-(MAX_BOOTS - 1));
  current = { id: bootId, startedAt, version, node: process.version, lastAliveAt: Date.now(), endedAt: null, clean: false, signal: null };
  state.boots.push(current);
  store.schedule();

  heartbeat = setInterval(() => {
    current.lastAliveAt = Date.now();
    store.schedule();
  }, HEARTBEAT_MS);
  heartbeat.unref();

  if (previousShutdown && !previousShutdown.clean) {
    const lastSeen = previousShutdown.lastAliveAt ? new Date(previousShutdown.lastAliveAt).toISOString() : 'unknown';
    console.warn(`[lifecycle] Previous run did not shut down cleanly (last heartbeat ${lastSeen}).`);
  }
}

/** Mark this run as cleanly shut down and persist it. */
function markShutdown(signal) {
  clearInterval(heartbeat);
  if (!current) return Promise.resolve();
  current.endedAt = Date.now();
  current.lastAliveAt = current.endedAt;
  current.clean = true;
  current.signal = signal || null;
  store.schedule();
  return store.flush();
}

/**
 * Record an uncaught exception or unhandled rejection.
 * @param {'uncaughtException'|'unhandledRejection'} kind
 */
function recordFatal(kind, err) {
  counters[kind] = (counters[kind] || 0) + 1;
  const message = err instanceof Error ? err.message : String(err);
  const stack = err instanceof Error && err.stack ? err.stack.slice(0, MAX_STACK) : null;
  lastFatal = { at: Date.now(), kind, message, stack, bootId };
  state.fatal.push(lastFatal);
  if (state.fatal.length > MAX_FATAL) state.fatal.splice(0, state.fatal.length - MAX_FATAL);
  store.schedule();
  for (const listener of fatalListeners) {
    try { listener(lastFatal); } catch { /* never throw from the crash guard */ }
  }
}

function onFatal(listener) {
  fatalListeners.add(listener);
}

/** Lifecycle summary for the dashboard and health checks. */
function info() {
  const now = Date.now();
  const boots = state.boots;
  const since = ms => boots.filter(b => b.startedAt >= now - ms && b.id !== bootId).length;
  return {
    bootId,
    startedAt,
    uptimeMs: now - startedAt,
    version,
    restarts24h: since(24 * 60 * 60 * 1000),
    restarts7d: since(7 * 24 * 60 * 60 * 1000),
    previousShutdown,
    uncaughtExceptions: counters.uncaughtException,
    unhandledRejections: counters.unhandledRejection,
    lastFatal,
    recentFatal: state.fatal.slice(-10).reverse(),
    recentBoots: boots.slice(-10).reverse().map(b => ({
      startedAt: b.startedAt, endedAt: b.endedAt, clean: b.clean, signal: b.signal,
      version: b.version, current: b.id === bootId, lastAliveAt: b.lastAliveAt,
    })),
    tracking: Boolean(current),
  };
}

module.exports = { start, markShutdown, recordFatal, onFatal, info, bootId, startedAt };
