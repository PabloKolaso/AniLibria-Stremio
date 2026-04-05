/**
 * Unique User Tracker
 *
 * Counts unique addon users via SHA-256 hashed IPs.
 * A random salt is generated once and persisted to data/salt.key.
 * Daily sets of hashed IPs are stored in data/users.json (90-day retention).
 */

const crypto = require('crypto');
const fs     = require('fs');
const path   = require('path');

const DATA_DIR   = path.resolve(__dirname, '../data');
const USERS_FILE = path.join(DATA_DIR, 'users.json');
const TEMP_FILE  = path.join(DATA_DIR, 'users.tmp.json');
const SALT_FILE  = path.join(DATA_DIR, 'salt.key');
const MAX_AGE_DAYS = 90;

// In-memory: Map<"YYYY-MM-DD", Set<hash>>
let dailyUsers = new Map();
let salt = '';
let flushTimer = null;

// ─── Initialization ──────────────────────────────────────────────────────────

function init() {
  fs.mkdirSync(DATA_DIR, { recursive: true });

  // Load or generate salt
  try {
    if (fs.existsSync(SALT_FILE)) {
      salt = fs.readFileSync(SALT_FILE, 'utf8').trim();
    }
  } catch (err) {
    console.warn('[users] Failed to read salt:', err.message);
  }
  if (!salt) {
    salt = crypto.randomBytes(32).toString('hex');
    try {
      fs.writeFileSync(SALT_FILE, salt, 'utf8');
    } catch (err) {
      console.warn('[users] Failed to write salt:', err.message);
    }
  }

  // Load persisted user data
  try {
    if (fs.existsSync(USERS_FILE)) {
      const raw = fs.readFileSync(USERS_FILE, 'utf8');
      const parsed = JSON.parse(raw);
      if (parsed && typeof parsed === 'object') {
        for (const [day, hashes] of Object.entries(parsed)) {
          if (Array.isArray(hashes)) {
            dailyUsers.set(day, new Set(hashes));
          }
        }
      }
    }
  } catch (err) {
    console.warn('[users] Failed to load users from disk:', err.message);
    dailyUsers = new Map();
  }

  pruneOldDays();
}

init();

// ─── Helpers ─────────────────────────────────────────────────────────────────

function hashIP(ip) {
  return crypto.createHash('sha256').update(salt + ip).digest('hex');
}

function todayKey() {
  return new Date().toISOString().slice(0, 10);
}

function pruneOldDays() {
  const cutoff = new Date();
  cutoff.setDate(cutoff.getDate() - MAX_AGE_DAYS);
  const cutoffKey = cutoff.toISOString().slice(0, 10);
  for (const key of dailyUsers.keys()) {
    if (key < cutoffKey) dailyUsers.delete(key);
  }
}

// ─── Core API ────────────────────────────────────────────────────────────────

/**
 * Record a user visit by IP address.
 * The IP is hashed before storage — no raw IPs are persisted.
 */
function recordUser(ip) {
  if (!ip) return;
  // Normalize IPv4-mapped IPv6 (e.g. "::ffff:1.2.3.4" → "1.2.3.4")
  let normalized = ip;
  if (normalized.startsWith('::ffff:')) normalized = normalized.slice(7);

  const hash = hashIP(normalized);
  const key = todayKey();

  let set = dailyUsers.get(key);
  if (!set) {
    set = new Set();
    dailyUsers.set(key, set);
  }

  const sizeBefore = set.size;
  set.add(hash);
  // Only flush if this is a genuinely new user for today
  if (set.size > sizeBefore) scheduleDebouncedFlush();
}

/**
 * Get unique user counts.
 * @returns {{ today: number, week: number, month: number }}
 */
function getUserCounts() {
  pruneOldDays();
  const now = new Date();

  const todaySet = dailyUsers.get(todayKey());
  const today = todaySet ? todaySet.size : 0;

  const week  = countUnique(7, now);
  const month = countUnique(30, now);

  return { today, week, month };
}

/**
 * Get unique user count per day as a plain object (for chart use).
 * @returns {{ [day: string]: number }} e.g. { "2026-04-05": 12, ... }
 */
function getDailyUserCounts() {
  pruneOldDays();
  const result = {};
  for (const [day, set] of dailyUsers.entries()) {
    result[day] = set.size;
  }
  return result;
}

/**
 * Count unique users over the last N days (union of daily sets).
 */
function countUnique(days, now) {
  const union = new Set();
  for (let i = 0; i < days; i++) {
    const d = new Date(now);
    d.setDate(d.getDate() - i);
    const key = d.toISOString().slice(0, 10);
    const set = dailyUsers.get(key);
    if (set) set.forEach(h => union.add(h));
  }
  return union.size;
}

// ─── Disk persistence ────────────────────────────────────────────────────────

function scheduleDebouncedFlush() {
  if (flushTimer) return;
  flushTimer = setTimeout(() => {
    flushTimer = null;
    flush();
  }, 5000);
}

/** Write user data to disk atomically. */
function flush() {
  pruneOldDays();
  try {
    fs.mkdirSync(DATA_DIR, { recursive: true });
    const obj = {};
    for (const [key, set] of dailyUsers.entries()) {
      obj[key] = [...set];
    }
    fs.writeFileSync(TEMP_FILE, JSON.stringify(obj), 'utf8');
    fs.renameSync(TEMP_FILE, USERS_FILE);
  } catch (err) {
    console.warn('[users] Failed to flush:', err.message);
  }
}

module.exports = { recordUser, getUserCounts, getDailyUserCounts, flush };
