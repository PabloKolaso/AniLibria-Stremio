/**
 * UTC time bucketing shared by the telemetry modules.
 */

const MINUTE_MS = 60 * 1000;
const HOUR_MS   = 60 * MINUTE_MS;
const DAY_MS    = 24 * HOUR_MS;

/** Hours since the epoch (UTC hour bucket index). */
function hourIndex(ts = Date.now()) {
  return Math.floor(ts / HOUR_MS);
}

/** Days since the epoch (UTC day bucket index). */
function dayIndex(ts = Date.now()) {
  return Math.floor(ts / DAY_MS);
}

/** "2026-03-11T14" for a timestamp (UTC). */
function hourKey(ts = Date.now()) {
  return new Date(ts).toISOString().slice(0, 13);
}

/** "2026-03-11" for a timestamp (UTC). */
function dayKey(ts = Date.now()) {
  return new Date(ts).toISOString().slice(0, 10);
}

/** Timestamp of the start of an hour key ("2026-03-11T14"). */
function hourKeyToTs(key) {
  return Date.parse(`${key}:00:00.000Z`);
}

/** Timestamp of the start of a day key ("2026-03-11"). */
function dayKeyToTs(key) {
  return Date.parse(`${key}T00:00:00.000Z`);
}

module.exports = { MINUTE_MS, HOUR_MS, DAY_MS, hourIndex, dayIndex, hourKey, dayKey, hourKeyToTs, dayKeyToTs };
