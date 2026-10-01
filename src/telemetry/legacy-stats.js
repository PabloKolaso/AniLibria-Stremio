/**
 * One-time migration source: the v1 data/stats.json (and data/logs.json).
 *
 * Earlier versions kept counters, hourly buckets, failed lookups and manual
 * overrides in one file. Each new store imports its part the first time it
 * starts without its own file; afterwards the old files are renamed to
 * *.v1.json so they are never imported twice.
 */

const fs     = require('fs');
const path   = require('path');
const config = require('../config');
const JsonStore = require('../util/json-store');

const STATS_FILE = path.join(config.dataDir, 'stats.json');
const LOGS_FILE  = path.join(config.dataDir, 'logs.json');

let cached;

/** Parsed v1 stats.json, or null when there is none. */
function readStats() {
  if (cached === undefined) {
    const data = JsonStore.read(STATS_FILE);
    cached = data && typeof data === 'object' && !Array.isArray(data) ? data : null;
  }
  return cached;
}

/** Parsed v1 logs.json entries ([] when there are none). */
function readLogs() {
  const data = JsonStore.read(LOGS_FILE);
  return Array.isArray(data) ? data : [];
}

function rename(file) {
  if (!fs.existsSync(file)) return false;
  const target = file.replace(/\.json$/, '.v1.json');
  try {
    fs.renameSync(file, target);
    console.log(`[migration] Imported ${path.basename(file)}; kept as ${path.basename(target)}`);
    return true;
  } catch (err) {
    console.warn(`[migration] Could not rename ${path.basename(file)}: ${err.message}`);
    return false;
  }
}

/** Rename the v1 files once every new store has saved its imported data. */
function retire() {
  rename(STATS_FILE);
  rename(LOGS_FILE);
  cached = null;
}

module.exports = { readStats, readLogs, retire };
