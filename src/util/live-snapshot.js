/**
 * A periodically refreshed value with stale-while-revalidate semantics.
 *
 *  - Readers get the last good value immediately; an expired value triggers
 *    a background refresh (only one runs at a time).
 *  - The very first read waits (bounded) for the initial load.
 *  - A failed refresh keeps the last good value and is retried after a
 *    short backoff, so an upstream outage never empties a catalog.
 */

const { withTimeout } = require('./timeout');

class LiveSnapshot {
  /**
   * @param {{ name: string, ttlMs: number, load: () => Promise<any>,
   *           retryAfterMs?: number, firstLoadWaitMs?: number,
   *           onError?: (err: Error) => void }} opts
   */
  constructor({ name, ttlMs, load, retryAfterMs = 15_000, firstLoadWaitMs = 15_000, onError = null }) {
    this.name = name;
    this.ttlMs = ttlMs;
    this.load = load;
    this.retryAfterMs = retryAfterMs;
    this.firstLoadWaitMs = firstLoadWaitMs;
    this.onError = onError;
    this.value = null;
    this.updatedAt = 0;
    this.lastAttemptAt = 0;
    this.lastFailureAt = 0;
    this.lastDurationMs = null;
    this.lastError = null;
    this.refreshing = null;
    this.timer = null;
    this.intervalMs = null;
  }

  get isStale() {
    return this.value === null || Date.now() - this.updatedAt >= this.ttlMs;
  }

  /** Run a refresh now (joins the one in progress). Never rejects. */
  refresh() {
    if (this.refreshing) return this.refreshing;
    this.lastAttemptAt = Date.now();
    this.refreshing = (async () => {
      const started = Date.now();
      try {
        const value = await this.load(this.value);
        this.value = value;
        this.updatedAt = Date.now();
        if (this.lastError) console.log(`[${this.name}] Recovered.`);
        this.lastError = null;
      } catch (err) {
        this.lastError = err;
        this.lastFailureAt = Date.now();
        const keeping = this.value === null
          ? 'no previous data'
          : `keeping data from ${Math.round((Date.now() - this.updatedAt) / 1000)}s ago`;
        console.warn(`[${this.name}] Refresh failed (${keeping}): ${err.message}`);
        if (this.onError) {
          try { this.onError(err); } catch { /* reporting must not break refreshes */ }
        }
      } finally {
        this.lastDurationMs = Date.now() - started;
        this.refreshing = null;
      }
      return this.value;
    })();
    return this.refreshing;
  }

  /**
   * Current value (null until the first successful load). Triggers a
   * background refresh when stale; waits only when nothing is loaded yet.
   */
  async get() {
    const backoff = this.lastError ? this.retryAfterMs : 0;
    if (this.isStale && Date.now() - this.lastAttemptAt >= backoff) this.refresh();
    if (this.value === null && this.refreshing) {
      await withTimeout(this.refreshing, this.firstLoadWaitMs).catch(() => {});
    }
    return this.value;
  }

  /** Refresh now and then every `intervalMs` in the background. */
  start(intervalMs = this.ttlMs) {
    this.refresh();
    if (!this.timer) {
      this.intervalMs = intervalMs;
      this.timer = setInterval(() => this.refresh(), intervalMs);
      this.timer.unref();
    }
  }

  stop() {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  info() {
    return {
      count: Array.isArray(this.value) ? this.value.length : null,
      updatedAt: this.updatedAt || null,
      stale: this.isStale,
      lastError: this.lastError ? this.lastError.message : null,
      lastAttemptAt: this.lastAttemptAt || null,
      lastFailureAt: this.lastFailureAt || null,
      lastDurationMs: this.lastDurationMs,
      refreshing: Boolean(this.refreshing),
      ttlMs: this.ttlMs,
      intervalMs: this.timer ? this.intervalMs : null,
      nextRefreshAt: this.timer && this.lastAttemptAt ? this.lastAttemptAt + this.intervalMs : null,
    };
  }
}

module.exports = LiveSnapshot;
