/**
 * Upstream provider telemetry.
 *
 * api/http.js reports every attempt (including retries) here. Counters are
 * aggregated per service in memory: per-minute buckets for the last hour,
 * per-hour buckets for the last day, and the latency of the most recent
 * attempts. Nothing is persisted — provider health describes the present,
 * and a restart starts a new observation window.
 *
 * An attempt fails when the provider could not give a usable answer:
 * timeout, network error, HTTP 5xx, HTTP 429 (rate limited) or an invalid
 * body. A well-formed "not found" (404) or AniLibria's geo-block answer
 * (403/451) is a successful response.
 */

const MINUTES = 60;
const HOURS = 24;
const LATENCY_SAMPLES = 200;

/** Display names for the `service` labels used by the API clients. */
const SERVICE_NAMES = { 'Stremio publish': 'Stremio API' };
/** Calls that are not about an upstream provider. */
const IGNORED_SERVICES = new Set(['keepalive']);

const FAILURE_KINDS = ['timeout', 'network', 'http5xx', 'http429', 'http4xx', 'parse'];

const services = new Map();

function newService(name) {
  return {
    name,
    since: Date.now(),
    calls: 0,
    ok: 0,
    notFound: 0,
    failures: Object.fromEntries(FAILURE_KINDS.map(k => [k, 0])),
    skipped: 0,
    lastSkip: null,         // { at, reason }
    consecutiveFailures: 0,
    lastSuccessAt: null,
    lastFailureAt: null,
    lastError: null,        // { at, kind, message, path }
    latencies: [],          // ring of the last LATENCY_SAMPLES attempt durations
    latencyPos: 0,
    minutes: [],            // [{ index, calls, failures }] (last MINUTES)
    hours: [],              // [{ index, calls, failures }] (last HOURS)
  };
}

function serviceFor(label) {
  const name = SERVICE_NAMES[label] || label || 'unknown';
  let svc = services.get(name);
  if (!svc) services.set(name, (svc = newService(name)));
  return svc;
}

/** Failure kind of an HttpError, or null when the provider answered properly. */
function classify(err) {
  if (!err) return null;
  switch (err.code) {
    case 'TIMEOUT': return 'timeout';
    case 'NETWORK': return 'network';
    case 'PARSE': return 'parse';
    case 'HTTP': {
      const status = err.status;
      if (status === 429) return 'http429';
      if (status >= 500) return 'http5xx';
      if (status === 404 || status === 403 || status === 451) return null;
      return 'http4xx';
    }
    default: return 'network';
  }
}

function bump(list, index, failed, keep) {
  let bucket = list[list.length - 1];
  if (!bucket || bucket.index !== index) {
    bucket = { index, calls: 0, failures: 0 };
    list.push(bucket);
    while (list.length > keep) list.shift();
  }
  bucket.calls++;
  if (failed) bucket.failures++;
}

/**
 * Record one attempt.
 * @param {string} service - the client's service label ("AniLibria", …)
 * @param {{ ms: number, error?: Error, path?: string }} attempt
 */
function record(service, { ms, error = null, path = null }) {
  if (IGNORED_SERVICES.has(service)) return;
  const svc = serviceFor(service);
  const now = Date.now();
  const kind = classify(error);

  svc.calls++;
  if (svc.latencies.length < LATENCY_SAMPLES) svc.latencies.push(ms);
  else svc.latencies[svc.latencyPos] = ms;
  svc.latencyPos = (svc.latencyPos + 1) % LATENCY_SAMPLES;

  bump(svc.minutes, Math.floor(now / 60_000), Boolean(kind), MINUTES);
  bump(svc.hours, Math.floor(now / 3_600_000), Boolean(kind), HOURS);

  if (kind) {
    svc.failures[kind]++;
    svc.consecutiveFailures++;
    svc.lastFailureAt = now;
    svc.lastError = { at: now, kind, message: error.message, path };
  } else {
    svc.ok++;
    if (error && error.status === 404) svc.notFound++;
    svc.consecutiveFailures = 0;
    svc.lastSuccessAt = now;
  }
}

/** A call that was not made (e.g. AniList rate-limit cooldown). */
function recordSkip(service, reason) {
  const svc = serviceFor(service);
  svc.skipped++;
  svc.lastSkip = { at: Date.now(), reason };
}

function percentile(sorted, p) {
  if (sorted.length === 0) return null;
  const idx = Math.min(sorted.length - 1, Math.max(0, Math.ceil(p * sorted.length) - 1));
  return sorted[idx];
}

function windowTotals(list, fromIndex) {
  let calls = 0;
  let failures = 0;
  for (const b of list) {
    if (b.index >= fromIndex) {
      calls += b.calls;
      failures += b.failures;
    }
  }
  return { calls, failures, failureRate: calls > 0 ? failures / calls : null };
}

/** Snapshot of one service (see list()). */
function describe(svc, now = Date.now()) {
  const minute = Math.floor(now / 60_000);
  const hour = Math.floor(now / 3_600_000);
  const sorted = [...svc.latencies].sort((a, b) => a - b);
  const totalFailures = FAILURE_KINDS.reduce((sum, k) => sum + svc.failures[k], 0);
  return {
    name: svc.name,
    since: svc.since,
    calls: svc.calls,
    ok: svc.ok,
    notFound: svc.notFound,
    failed: totalFailures,
    failures: { ...svc.failures },
    skipped: svc.skipped,
    lastSkip: svc.lastSkip,
    consecutiveFailures: svc.consecutiveFailures,
    lastSuccessAt: svc.lastSuccessAt,
    lastFailureAt: svc.lastFailureAt,
    lastError: svc.lastError,
    last15m: windowTotals(svc.minutes, minute - 14),
    last60m: windowTotals(svc.minutes, minute - 59),
    last24h: windowTotals(svc.hours, hour - 23),
    latency: { p50: percentile(sorted, 0.5), p95: percentile(sorted, 0.95), samples: sorted.length },
    lastCallAt: Math.max(svc.lastSuccessAt || 0, svc.lastFailureAt || 0) || null,
  };
}

/** Every service seen since startup, most used first. */
function list() {
  const now = Date.now();
  return [...services.values()].map(svc => describe(svc, now)).sort((a, b) => b.calls - a.calls);
}

/** One service by display name (null when never called). */
function get(name) {
  const svc = services.get(name);
  return svc ? describe(svc) : null;
}

/** Forget everything (tests). */
function reset() {
  services.clear();
}

module.exports = { record, recordSkip, classify, list, get, reset, FAILURE_KINDS };
