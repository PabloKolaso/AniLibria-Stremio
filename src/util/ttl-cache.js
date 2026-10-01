/**
 * Minimal in-memory cache with per-entry TTL and an LRU size bound.
 *
 * Values are stored by reference (no cloning), so callers must treat
 * cached objects as read-only.
 *
 * Caches created with a `name` register themselves, so the dashboard can
 * list their size and hit rate (TTLCache.list()).
 */

const registry = new Set();

class TTLCache {
  /**
   * @param {{ ttlMs: number, max?: number, name?: string, description?: string }} opts
   */
  constructor({ ttlMs, max = 1000, name = null, description = null }) {
    this.ttlMs = ttlMs;
    this.max = max;
    this.name = name;
    this.description = description;
    this._map = new Map(); // key -> { value, expiresAt }
    this.hits = 0;
    this.misses = 0;
    this.lastClearedAt = null;
    if (name) registry.add(this);
  }

  get size() {
    return this._map.size;
  }

  /** Returns the cached value, or undefined when missing or expired. */
  get(key) {
    const entry = this._map.get(key);
    if (!entry) {
      this.misses++;
      return undefined;
    }
    if (entry.expiresAt <= Date.now()) {
      this._map.delete(key);
      this.misses++;
      return undefined;
    }
    // Refresh recency for LRU eviction
    this._map.delete(key);
    this._map.set(key, entry);
    this.hits++;
    return entry.value;
  }

  has(key) {
    return this.get(key) !== undefined;
  }

  set(key, value, ttlMs = this.ttlMs) {
    this._map.delete(key);
    this._map.set(key, { value, expiresAt: Date.now() + ttlMs });
    while (this._map.size > this.max) {
      this._map.delete(this._map.keys().next().value);
    }
    return this;
  }

  delete(key) {
    return this._map.delete(key);
  }

  clear() {
    this._map.clear();
    this.lastClearedAt = Date.now();
  }

  /** Live (non-expired) entries as [key, value, expiresAt] tuples, oldest first. */
  *entries() {
    const now = Date.now();
    for (const [key, { value, expiresAt }] of this._map) {
      if (expiresAt > now) yield [key, value, expiresAt];
    }
  }

  /** Serialize live entries for persistence. */
  toJSON() {
    const out = [];
    for (const [key, value, expiresAt] of this.entries()) out.push([key, value, expiresAt]);
    return out;
  }

  /** Restore entries produced by toJSON(); expired or malformed rows are skipped. */
  load(rows) {
    if (!Array.isArray(rows)) return 0;
    const now = Date.now();
    let loaded = 0;
    for (const row of rows) {
      if (!Array.isArray(row) || row.length !== 3) continue;
      const [key, value, expiresAt] = row;
      if (typeof expiresAt !== 'number' || expiresAt <= now) continue;
      this._map.delete(key);
      this._map.set(key, { value, expiresAt });
      loaded++;
    }
    while (this._map.size > this.max) {
      this._map.delete(this._map.keys().next().value);
    }
    return loaded;
  }

  /** Size, hit rate and configuration (live entries only). */
  stats() {
    const now = Date.now();
    let live = 0;
    for (const { expiresAt } of this._map.values()) if (expiresAt > now) live++;
    const lookups = this.hits + this.misses;
    return {
      name: this.name,
      description: this.description,
      size: live,
      max: this.max,
      ttlMs: this.ttlMs,
      hits: this.hits,
      misses: this.misses,
      hitRate: lookups > 0 ? this.hits / lookups : null,
      lastClearedAt: this.lastClearedAt,
    };
  }

  /** Statistics of every named cache. */
  static list() {
    return [...registry].map(cache => cache.stats());
  }
}

module.exports = TTLCache;
