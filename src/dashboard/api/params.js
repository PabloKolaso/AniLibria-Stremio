/**
 * Query/body parameter helpers for the dashboard API (strict: anything
 * unexpected becomes the default).
 */

/** A single string ('' when missing or repeated). */
function str(value, max = 200) {
  return typeof value === 'string' ? value.slice(0, max) : '';
}

/** An integer within [min, max], or the fallback. */
function int(value, fallback, { min = 0, max = Number.MAX_SAFE_INTEGER } = {}) {
  const n = typeof value === 'string' && /^-?\d{1,15}$/.test(value) ? Number(value) : typeof value === 'number' ? value : NaN;
  return Number.isInteger(n) && n >= min && n <= max ? n : fallback;
}

/** One of the allowed values, or the fallback. */
function oneOf(value, allowed, fallback = undefined) {
  return typeof value === 'string' && allowed.includes(value) ? value : fallback;
}

/**
 * A timestamp from "YYYY-MM-DD" (start or end of that UTC day) or a full
 * ISO date-time; undefined when invalid.
 */
function time(value, endOfDay = false) {
  const s = str(value, 40);
  if (!s) return undefined;
  if (/^\d{4}-\d{2}-\d{2}$/.test(s)) {
    const ts = Date.parse(`${s}T00:00:00Z`);
    return Number.isFinite(ts) ? (endOfDay ? ts + 86_400_000 - 1 : ts) : undefined;
  }
  const ts = Date.parse(s);
  return Number.isFinite(ts) ? ts : undefined;
}

module.exports = { str, int, oneOf, time };
