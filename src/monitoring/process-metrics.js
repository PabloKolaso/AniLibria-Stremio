/**
 * Process health metrics for this Node.js process (not the host):
 *
 *  - CPU: share of one CPU core used by this process over the last sample
 *    interval, from process.cpuUsage() deltas.
 *  - Memory: resident set size against the container memory limit
 *    (process.constrainedMemory()) — or the host's total memory when no
 *    container limit is detectable — plus V8 heap use against its limit.
 *  - Event loop: delay percentiles from perf_hooks.monitorEventLoopDelay(),
 *    per one-minute window.
 *  - History: one point per minute for the last 24 hours (in memory).
 */

const os = require('os');
const v8 = require('v8');
const { monitorEventLoopDelay } = require('perf_hooks');

const SAMPLE_MS = 10_000;
/** monitorEventLoopDelay samples every RESOLUTION ms and reports the whole interval; the delay is the excess. */
const LOOP_RESOLUTION_MS = 20;
const HISTORY_MS = 60_000;
const HISTORY_POINTS = 24 * 60;

let loopDelay = null;
let sampleTimer = null;
let historyTimer = null;

let lastCpu = process.cpuUsage();
let lastCpuAt = process.hrtime.bigint();
let cpuPercent = null;        // last SAMPLE_MS window
let minuteCpu = [];           // samples within the current history minute
let lastLoop = null;          // { p50, p99, max } of the last completed minute (ms)
const history = [];           // { t, rss, heapUsed, cpu, loopP99, loopMax }

function sampleCpu() {
  const now = process.hrtime.bigint();
  const usage = process.cpuUsage();
  const elapsedUs = Number(now - lastCpuAt) / 1000;
  if (elapsedUs > 0) {
    const usedUs = (usage.user - lastCpu.user) + (usage.system - lastCpu.system);
    cpuPercent = Math.max(0, (usedUs / elapsedUs) * 100);
    minuteCpu.push(cpuPercent);
  }
  lastCpu = usage;
  lastCpuAt = now;
}

/** Event-loop delay in ms: a sample minus the sampling interval itself. */
function delayMs(ns) {
  return Number.isFinite(ns) ? Math.max(0, ns / 1e6 - LOOP_RESOLUTION_MS) : null;
}

function readLoop() {
  if (!loopDelay || loopDelay.count === 0) return null;
  return {
    p50: delayMs(loopDelay.percentile(50)),
    p99: delayMs(loopDelay.percentile(99)),
    max: delayMs(loopDelay.max),
  };
}

function sampleHistory() {
  sampleCpu();
  lastLoop = readLoop() || lastLoop;
  loopDelay?.reset();
  const mem = process.memoryUsage();
  const cpu = minuteCpu.length > 0 ? minuteCpu.reduce((a, b) => a + b, 0) / minuteCpu.length : cpuPercent;
  minuteCpu = [];
  history.push({
    t: Date.now(),
    rss: mem.rss,
    heapUsed: mem.heapUsed,
    cpu: cpu === null ? null : Math.round(cpu * 10) / 10,
    loopP99: lastLoop ? Math.round(lastLoop.p99 * 10) / 10 : null,
    loopMax: lastLoop ? Math.round(lastLoop.max * 10) / 10 : null,
  });
  if (history.length > HISTORY_POINTS) history.shift();
}

/** Start sampling (idempotent). */
function start() {
  if (sampleTimer) return;
  loopDelay = monitorEventLoopDelay({ resolution: LOOP_RESOLUTION_MS });
  loopDelay.enable();
  sampleTimer = setInterval(sampleCpu, SAMPLE_MS);
  sampleTimer.unref();
  historyTimer = setInterval(sampleHistory, HISTORY_MS);
  historyTimer.unref();
}

function stop() {
  clearInterval(sampleTimer);
  clearInterval(historyTimer);
  sampleTimer = historyTimer = null;
  loopDelay?.disable();
}

/** Memory limit that applies to this process. */
function memoryLimit() {
  const total = os.totalmem();
  const constrained = typeof process.constrainedMemory === 'function' ? process.constrainedMemory() : 0;
  if (Number.isFinite(constrained) && constrained > 0 && constrained < total) {
    return { bytes: constrained, source: 'container' };
  }
  return { bytes: total, source: 'host' };
}

/**
 * History downsampled to `stepMinutes` (max of RSS and loop delay, mean CPU).
 * @param {{ minutes?: number, stepMinutes?: number }} [opts]
 */
function getHistory({ minutes = 24 * 60, stepMinutes = 5 } = {}) {
  const since = Date.now() - minutes * 60_000;
  const points = history.filter(p => p.t >= since);
  const out = [];
  for (let i = 0; i < points.length; i += stepMinutes) {
    const chunk = points.slice(i, i + stepMinutes);
    const cpus = chunk.map(p => p.cpu).filter(v => v !== null);
    const loops = chunk.map(p => p.loopP99).filter(v => v !== null);
    out.push({
      t: chunk[chunk.length - 1].t,
      rss: Math.max(...chunk.map(p => p.rss)),
      cpu: cpus.length ? Math.round((cpus.reduce((a, b) => a + b, 0) / cpus.length) * 10) / 10 : null,
      loopP99: loops.length ? Math.max(...loops) : null,
    });
  }
  return out;
}

/** Current process metrics. */
function snapshot() {
  const mem = process.memoryUsage();
  const heap = v8.getHeapStatistics();
  const limit = memoryLimit();
  const loop = readLoop() || lastLoop;
  return {
    pid: process.pid,
    cpu: {
      percent: cpuPercent === null ? null : Math.round(cpuPercent * 10) / 10,
      sampleSeconds: SAMPLE_MS / 1000,
      cores: typeof os.availableParallelism === 'function' ? os.availableParallelism() : os.cpus().length,
    },
    memory: {
      rss: mem.rss,
      limit: limit.bytes,
      limitSource: limit.source,
      percent: limit.bytes > 0 ? mem.rss / limit.bytes : null,
      heapUsed: mem.heapUsed,
      heapLimit: heap.heap_size_limit,
      external: mem.external,
    },
    eventLoop: loop && {
      p50: Math.round(loop.p50 * 10) / 10,
      p99: Math.round(loop.p99 * 10) / 10,
      max: Math.round(loop.max * 10) / 10,
      windowSeconds: HISTORY_MS / 1000,
    },
    sampling: Boolean(sampleTimer),
  };
}

module.exports = { start, stop, snapshot, getHistory, memoryLimit };
