/**
 * Background job registry.
 *
 * Two kinds of jobs are tracked:
 *  - manual actions the dashboard can trigger (refresh a catalog, rebuild
 *    the index, …). Cooldowns are enforced here, on the server, so repeated
 *    clicks can never hammer an upstream API;
 *  - passive jobs (keep-alive ping, Stremio catalog registration) that
 *    report their outcome with report().
 */

class JobError extends Error {
  constructor(message, status, retryAfterMs = 0) {
    super(message);
    this.status = status;
    this.retryAfterMs = retryAfterMs;
  }
}

const jobs = new Map();

function blankState() {
  return {
    running: false, runs: 0, lastRunAt: null, lastFinishedAt: null, lastDurationMs: null,
    lastOk: null, lastMessage: null, lastError: null, lastErrorAt: null, cooldownUntil: 0,
  };
}

/**
 * Register a job.
 * @param {string} id
 * @param {{ label: string, description?: string, schedule?: string,
 *           cooldownMs?: number, confirm?: string, run?: () => Promise<string|void> }} def
 *   run — omitted for passive jobs; confirm — confirmation text for expensive actions
 */
function define(id, def) {
  const existing = jobs.get(id);
  jobs.set(id, { id, cooldownMs: 0, ...def, state: existing ? existing.state : blankState() });
}

/**
 * Run a manual job now.
 * @returns {Promise<{ message: string|null, durationMs: number }>}
 * @throws {JobError} unknown job (404), already running or cooling down (429)
 */
async function trigger(id) {
  const job = jobs.get(id);
  if (!job || typeof job.run !== 'function') throw new JobError('unknown job', 404);
  const now = Date.now();
  if (job.state.running) throw new JobError('already running', 429);
  if (now < job.state.cooldownUntil) {
    throw new JobError('cooling down', 429, job.state.cooldownUntil - now);
  }
  job.state.running = true;
  job.state.runs++;
  job.state.lastRunAt = now;
  job.state.cooldownUntil = now + job.cooldownMs;
  try {
    const message = (await job.run()) || null;
    finish(job, { ok: true, message });
    return { message, durationMs: job.state.lastDurationMs };
  } catch (err) {
    finish(job, { ok: false, message: err.message });
    throw err;
  } finally {
    job.state.running = false;
  }
}

function finish(job, { ok, message }) {
  const now = Date.now();
  job.state.lastFinishedAt = now;
  job.state.lastDurationMs = job.state.lastRunAt ? now - job.state.lastRunAt : null;
  job.state.lastOk = ok;
  job.state.lastMessage = message || null;
  if (!ok) {
    job.state.lastError = message || 'failed';
    job.state.lastErrorAt = now;
  }
}

/** Report the outcome of a passive job run. */
function report(id, { ok, message = null, durationMs = null }) {
  const job = jobs.get(id);
  if (!job) return;
  job.state.runs++;
  job.state.lastRunAt = Date.now() - (durationMs || 0);
  finish(job, { ok, message });
}

/** Every job with its state. */
function list() {
  const now = Date.now();
  return [...jobs.values()].map(job => ({
    id: job.id,
    label: job.label,
    description: job.description || null,
    schedule: job.schedule || null,
    manual: typeof job.run === 'function',
    confirm: job.confirm || null,
    cooldownMs: job.cooldownMs,
    ...job.state,
    cooldownRemainingMs: Math.max(0, job.state.cooldownUntil - now),
  }));
}

function get(id) {
  return list().find(j => j.id === id) || null;
}

module.exports = { define, trigger, report, list, get, JobError };
