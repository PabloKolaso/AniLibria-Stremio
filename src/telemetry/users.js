/**
 * Unique user tracker (privacy-preserving).
 *
 * A "user" is a distinct client IP address, identified only by a salted
 * SHA-256 hash (shortened to 16 hex characters; the salt lives in
 * data/salt.key and never leaves the server). Raw IPs are never stored.
 * Several people behind one IP count once; one person on changing IPs
 * counts several times — these are estimates, labelled as such.
 *
 * Only anime usage counts: catalog and meta requests, and stream requests
 * for anime. Non-anime pass-through requests do not.
 *
 *  - days:   UTC day -> hashes   (90 days; unique users per day / 7 d / 30 d)
 *  - hours:  UTC hour -> hashes  (48 hours; rolling 24 h and the 24 h before)
 *  - active: hash -> last seen   (memory only; "active now" = last 15 minutes)
 */

const crypto    = require('crypto');
const fs        = require('fs');
const path      = require('path');
const config    = require('../config');
const JsonStore = require('../util/json-store');
const { DAY_MS, HOUR_MS, dayKey, hourKey } = require('../util/time');

const USERS_FILE = path.join(config.dataDir, 'users.json');
const SALT_FILE  = path.join(config.dataDir, 'salt.key');
const MAX_AGE_DAYS = 90;
const HOURLY_KEEP = 48;
const ACTIVE_WINDOW_MS = 15 * 60 * 1000;
const HASH_LENGTH = 16;

const days = new Map();   // "YYYY-MM-DD" -> Set<hash>
const hours = new Map();  // "YYYY-MM-DDTHH" -> Set<hash>
const active = new Map(); // hash -> last seen (ms)
let salt = '';

const store = new JsonStore(USERS_FILE, {
  serialize: () => {
    prune();
    const toObj = map => Object.fromEntries([...map].map(([k, set]) => [k, [...set]]));
    return { version: 2, days: toObj(days), hours: toObj(hours) };
  },
  debounceMs: 10_000,
  label: 'users',
});

// ─── Initialization ──────────────────────────────────────────────────────────

function loadSets(map, obj, keyRe) {
  if (!obj || typeof obj !== 'object') return;
  for (const [key, hashes] of Object.entries(obj)) {
    if (!keyRe.test(key) || !Array.isArray(hashes)) continue;
    // v1 stored full 64-char hashes: shorten them so they match new entries
    map.set(key, new Set(hashes.filter(h => typeof h === 'string').map(h => h.slice(0, HASH_LENGTH))));
  }
}

function init() {
  try {
    salt = fs.readFileSync(SALT_FILE, 'utf8').trim();
  } catch (err) {
    if (err.code !== 'ENOENT') console.warn('[users] Failed to read salt:', err.message);
  }
  if (!salt) {
    salt = crypto.randomBytes(32).toString('hex');
    try {
      fs.mkdirSync(config.dataDir, { recursive: true });
      fs.writeFileSync(SALT_FILE, salt, { encoding: 'utf8', mode: 0o600 });
    } catch (err) {
      console.warn('[users] Failed to write salt:', err.message);
    }
  }

  const parsed = JsonStore.read(USERS_FILE);
  if (parsed && parsed.version === 2) {
    loadSets(days, parsed.days, /^\d{4}-\d{2}-\d{2}$/);
    loadSets(hours, parsed.hours, /^\d{4}-\d{2}-\d{2}T\d{2}$/);
  } else if (parsed && typeof parsed === 'object') {
    loadSets(days, parsed, /^\d{4}-\d{2}-\d{2}$/); // v1: { day: [hashes] }
    store.schedule();
  }
  prune();
}

init();

// ─── Helpers ─────────────────────────────────────────────────────────────────

function prune(now = Date.now()) {
  const dayCutoff = dayKey(now - MAX_AGE_DAYS * DAY_MS);
  for (const key of days.keys()) if (key < dayCutoff) days.delete(key);
  const hourCutoff = hourKey(now - HOURLY_KEEP * HOUR_MS);
  for (const key of hours.keys()) if (key < hourCutoff) hours.delete(key);
}

function pruneActive(now) {
  for (const [hash, seen] of active) if (now - seen > ACTIVE_WINDOW_MS) active.delete(hash);
}

function addTo(map, key, hash) {
  let set = map.get(key);
  if (!set) map.set(key, (set = new Set()));
  const before = set.size;
  set.add(hash);
  return set.size > before;
}

function normalizeIp(ip) {
  return ip.startsWith('::ffff:') ? ip.slice(7) : ip; // IPv4-mapped IPv6
}

// ─── Core API ────────────────────────────────────────────────────────────────

/** Salted, shortened hash of a client IP (null for a missing IP). */
function hashIp(ip) {
  if (!ip || typeof ip !== 'string') return null;
  return crypto.createHash('sha256').update(salt + normalizeIp(ip)).digest('hex').slice(0, HASH_LENGTH);
}

/**
 * Count an anime-usage request from this IP.
 * @returns {string|null} the user's hash
 */
function recordUser(ip) {
  const hash = hashIp(ip);
  if (!hash) return null;
  const now = Date.now();
  active.set(hash, now);
  if (active.size > 50_000) pruneActive(now);
  const newDay = addTo(days, dayKey(now), hash);
  const newHour = addTo(hours, hourKey(now), hash);
  if (newDay || newHour) store.schedule();
  return hash;
}

function unionSize(map, keys) {
  const union = new Set();
  for (const key of keys) {
    const set = map.get(key);
    if (set) for (const h of set) union.add(h);
  }
  return union.size;
}

function lastHourKeys(count, offset, now) {
  return Array.from({ length: count }, (_, i) => hourKey(now - (offset + i) * HOUR_MS));
}

function lastDayKeys(count, offset, now) {
  return Array.from({ length: count }, (_, i) => dayKey(now - (offset + i) * DAY_MS));
}

/**
 * Unique user counts.
 *   now       — seen in the last 15 minutes (resets on restart)
 *   day       — current UTC hour + previous 23 hours
 *   dayPrev   — the 24 hours before that
 *   week/month — the last 7 / 30 UTC days, including today
 */
function counts(now = Date.now()) {
  pruneActive(now);
  return {
    now: active.size,
    day: unionSize(hours, lastHourKeys(24, 0, now)),
    dayPrev: unionSize(hours, lastHourKeys(24, 24, now)),
    week: unionSize(days, lastDayKeys(7, 0, now)),
    weekPrev: unionSize(days, lastDayKeys(7, 7, now)),
    month: unionSize(days, lastDayKeys(30, 0, now)),
    monthPrev: unionSize(days, lastDayKeys(30, 30, now)),
    quarter: unionSize(days, lastDayKeys(90, 0, now)),
  };
}

/** Unique users per UTC day for the last `n` days (oldest first). */
function dailyCounts(n, now = Date.now()) {
  return lastDayKeys(n, 0, now).reverse().map(key => ({ t: Date.parse(`${key}T00:00:00Z`), users: days.get(key)?.size || 0 }));
}

/** Unique users per UTC hour for the last `n` hours (oldest first, n ≤ 48). */
function hourlyCounts(n, now = Date.now()) {
  return lastHourKeys(Math.min(n, HOURLY_KEEP), 0, now).reverse()
    .map(key => ({ t: Date.parse(`${key}:00:00Z`), users: hours.get(key)?.size || 0 }));
}

module.exports = { hashIp, recordUser, counts, dailyCounts, hourlyCounts, flush: () => store.flush() };
