/**
 * Fixed-bucket latency histogram.
 *
 * Hourly buckets store counts per latency range instead of raw samples, so
 * any window (24 h, 30 d, …) can be merged cheaply. Percentiles are
 * estimated by linear interpolation inside the bucket that contains them;
 * with these bounds the estimate is within one bucket width of the truth.
 */

/** Upper bounds (ms) of every bucket but the last, which is "above 20 s". */
const BOUNDS = [25, 50, 100, 150, 200, 300, 400, 500, 750, 1000, 1500, 2000, 3000, 5000, 7500, 10000, 15000, 20000];
const SIZE = BOUNDS.length + 1;

function empty() {
  return new Array(SIZE).fill(0);
}

function bucketIndex(ms) {
  for (let i = 0; i < BOUNDS.length; i++) if (ms <= BOUNDS[i]) return i;
  return BOUNDS.length;
}

/** Count one sample (mutates and returns counts). */
function add(counts, ms) {
  const hist = Array.isArray(counts) && counts.length === SIZE ? counts : empty();
  hist[bucketIndex(Math.max(0, ms))]++;
  return hist;
}

/** Add `source` into `target` (mutates target). */
function merge(target, source) {
  if (!Array.isArray(source) || source.length !== SIZE) return target;
  for (let i = 0; i < SIZE; i++) target[i] += source[i] || 0;
  return target;
}

function total(counts) {
  return counts.reduce((a, b) => a + b, 0);
}

/**
 * Estimated percentile (0 < p < 1) in ms, or null for an empty histogram.
 * Values in the open-ended last bucket are reported as its lower bound.
 */
function percentile(counts, p) {
  const n = total(counts);
  if (n === 0) return null;
  const rank = p * n;
  let seen = 0;
  for (let i = 0; i < SIZE; i++) {
    if (counts[i] === 0) continue;
    if (seen + counts[i] >= rank) {
      const lower = i === 0 ? 0 : BOUNDS[i - 1];
      if (i === BOUNDS.length) return lower;
      const upper = BOUNDS[i];
      const within = (rank - seen) / counts[i];
      return Math.round(lower + (upper - lower) * within);
    }
    seen += counts[i];
  }
  return BOUNDS[BOUNDS.length - 1];
}

module.exports = { BOUNDS, SIZE, empty, add, merge, total, percentile };
