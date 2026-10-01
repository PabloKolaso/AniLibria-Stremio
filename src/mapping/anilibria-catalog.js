/**
 * In-memory index of the full AniLibria release catalog.
 *
 *  - byMal:   MAL/Shikimori ID -> releases   (exact matching, primary path)
 *  - byAlias: URL alias -> release           (exact title matching)
 *  - fuse:    fuzzy title search             (last-resort fallback)
 *
 * The catalog (~2k releases, 50 per page) is rebuilt in the background every
 * couple of hours; lookups always use the last good index, so requests never
 * wait for a refresh. Between rebuilds, upsert() adds releases the update
 * poller sees for the first time (catalogs/releasing.js).
 */

const Fuse      = require('fuse.js');
const anilibria = require('../api/anilibria');
const { summarizeRelease } = require('../bridge/matching');
const { withTimeout } = require('../util/timeout');

const PAGE_SIZE         = 50;
const PAGE_CONCURRENCY  = 4;
const REFRESH_INTERVAL_MS = 2 * 60 * 60 * 1000;
const RETRY_INTERVAL_MS   = 5 * 60 * 1000;
/** An index older than this (e.g. refreshes keep failing) is no longer trusted to be complete. */
const FRESH_MAX_AGE_MS    = 6 * 60 * 60 * 1000;
const FUSE_THRESHOLD      = 0.25;

let current     = null;   // last good index
let building    = null;   // in-flight build promise
let lastAttempt = 0;
let refreshTimer = null;
const rebuildListeners = new Set();
// Build history for the dashboard
const buildStats = { lastDurationMs: null, pagesFailed: 0, lastError: null, upserts: 0, lastUpsertAt: null, lastUpsertCount: 0 };

class CatalogIndex {
  /**
   * @param {object[]} releases - raw catalog entries
   * @param {boolean} complete - every catalog page was fetched
   * @param {number} [builtAt] - when the underlying full catalog was fetched
   */
  constructor(releases, complete, builtAt = Date.now()) {
    this.builtAt = builtAt;
    this.complete = complete;
    this.sources = new Map(); // id -> minimal raw release (to rebuild on upsert)
    this.byId = new Map();
    this.byMal = new Map();
    this.byAlias = new Map();
    this.withIds = 0; // releases carrying a MAL/Shikimori ID

    for (const raw of releases) {
      if (!raw || typeof raw.id !== 'number' || this.byId.has(raw.id)) continue;
      const release = summarizeRelease(raw);
      this.sources.set(release.id, minimalRelease(raw));
      this.byId.set(release.id, release);
      if (release.alias) this.byAlias.set(release.alias, release);
      if (release.ids.length > 0) this.withIds++;
      // Index under both the Shikimori and the MAL ID: when they differ, the
      // release either spans both entries or one ID is mislabelled — the
      // resolver's year check tells these apart.
      for (const malId of release.ids) {
        const list = this.byMal.get(malId) || [];
        list.push(release);
        this.byMal.set(malId, list);
      }
    }
    // Duplicates (re-dubs, mislabelled seasons): prefer the original release first.
    for (const list of this.byMal.values()) list.sort((a, b) => a.id - b.id);

    this.fuse = new Fuse([...this.byId.values()], {
      keys: [
        { name: 'en',         weight: 2   },
        { name: 'aliasWords', weight: 1.5 },  // "one piece" matches "One Piece"
        { name: 'alias',      weight: 1   },
        { name: 'alt',        weight: 1   },
        { name: 'ru',         weight: 0.5 },
      ],
      threshold: FUSE_THRESHOLD,
      includeScore: true,
    });
  }

  get size() {
    return this.byId.size;
  }

  /** True when the index is complete and recent enough to prove a release does NOT exist. */
  get isFresh() {
    return this.complete && Date.now() - this.builtAt < FRESH_MAX_AGE_MS;
  }

  findByMal(malId) {
    return this.byMal.get(malId) || [];
  }

  findByAlias(alias) {
    return this.byAlias.get(alias) || null;
  }

  /** Fuzzy search; returns [{ item, score }] with score < threshold (lower is better). */
  search(title, limit = 3) {
    return this.fuse.search(title, { limit }).filter(r => r.score < FUSE_THRESHOLD);
  }
}

/** The fields summarizeRelease() needs, so an index can be rebuilt cheaply. */
function minimalRelease(raw) {
  return {
    id: raw.id,
    alias: raw.alias,
    year: raw.year,
    type: raw.type ? { value: raw.type.value } : null,
    name: raw.name ? { english: raw.name.english, main: raw.name.main, alternative: raw.name.alternative } : null,
    mal: raw.mal ? { id: raw.mal.id } : null,
    shikimori: raw.shikimori ? { id: raw.shikimori.id } : null,
  };
}

function notifyRebuild() {
  for (const listener of rebuildListeners) {
    try { listener(current); } catch (err) { console.warn('[catalog] Rebuild listener failed:', err.message); }
  }
}

/**
 * Add new releases (or releases whose identifying data changed) to the
 * current index without refetching the whole catalog.
 * @param {object[]} releases - raw release objects
 * @returns {number} how many releases were added or updated
 */
function upsert(releases) {
  if (!current) return 0; // the first full build will include them
  const sources = new Map(current.sources);
  let changed = 0;
  for (const raw of releases) {
    if (!raw || typeof raw.id !== 'number') continue;
    const next = summarizeRelease(raw);
    const prev = current.byId.get(raw.id);
    if (prev && prev.alias === next.alias && prev.year === next.year && prev.en === next.en &&
        prev.ids.join(',') === next.ids.join(',')) continue;
    sources.set(raw.id, minimalRelease(raw));
    changed++;
  }
  if (changed === 0) return 0;
  current = new CatalogIndex([...sources.values()], current.complete, current.builtAt);
  buildStats.upserts++;
  buildStats.lastUpsertAt = Date.now();
  buildStats.lastUpsertCount = changed;
  console.log(`[catalog] Added/updated ${changed} release(s) between full rebuilds (${current.size} indexed).`);
  notifyRebuild();
  return changed;
}

async function fetchAllReleases() {
  const first = await anilibria.fetchCatalogPage(1, PAGE_SIZE);
  const releases = [...first.items];
  let complete = true;
  let pagesFailed = 0;

  if (first.totalPages) {
    const pages = [];
    for (let p = 2; p <= first.totalPages; p++) pages.push(p);
    const worker = async () => {
      while (pages.length > 0) {
        const page = pages.shift();
        try {
          const { items } = await anilibria.fetchCatalogPage(page, PAGE_SIZE);
          releases.push(...items);
        } catch (err) {
          complete = false;
          pagesFailed++;
          console.warn(`[catalog] Page ${page} failed: ${err.message}`);
        }
      }
    };
    await Promise.all(Array.from({ length: PAGE_CONCURRENCY }, worker));
  } else {
    // No pagination metadata: walk pages until a short one
    let page = 1;
    let items = first.items;
    while (items.length === PAGE_SIZE) {
      page++;
      ({ items } = await anilibria.fetchCatalogPage(page, PAGE_SIZE));
      releases.push(...items);
    }
  }
  return { releases, complete, pagesFailed };
}

/** Build a new index. Concurrent calls share one build. */
function build() {
  if (building) return building;
  lastAttempt = Date.now();
  building = (async () => {
    const started = Date.now();
    const { releases, complete, pagesFailed } = await fetchAllReleases();
    const next = new CatalogIndex(releases, complete);
    buildStats.lastDurationMs = Date.now() - started;
    buildStats.pagesFailed = pagesFailed;

    // Never replace a complete index with a partial one.
    if (current && current.complete && !complete) {
      buildStats.lastError = { at: Date.now(), message: `partial refresh (${pagesFailed} page(s) failed) ignored` };
      console.warn(`[catalog] Partial refresh (${next.size} releases) ignored; keeping previous index.`);
      return current;
    }
    buildStats.lastError = complete ? null : { at: Date.now(), message: `${pagesFailed} page(s) failed; index incomplete` };
    current = next;
    console.log(`[catalog] Indexed ${next.size} AniLibria releases (${next.byMal.size} with MAL IDs${complete ? '' : ', INCOMPLETE'}) in ${Date.now() - started}ms.`);
    notifyRebuild();
    return current;
  })()
    .catch(err => {
      buildStats.lastError = { at: Date.now(), message: err.message };
      throw err;
    })
    .finally(() => { building = null; });
  return building;
}

function refreshIfDue() {
  if (building) return;
  const age = current ? Date.now() - current.builtAt : Infinity;
  const due = !current || !current.complete || age > REFRESH_INTERVAL_MS;
  if (!due || Date.now() - lastAttempt < RETRY_INTERVAL_MS) return;
  build().catch(err => console.warn(`[catalog] Refresh failed: ${err.message}`));
}

/**
 * Get the current index, building it on first use.
 * @param {{ waitMs?: number }} [opts] - how long to wait for a first build
 * @returns {Promise<CatalogIndex|null>} null when no index could be built yet
 */
async function getIndex({ waitMs = 10_000 } = {}) {
  if (current) {
    refreshIfDue();
    return current;
  }
  if (!building && Date.now() - lastAttempt > 30_000) {
    build().catch(err => console.warn(`[catalog] Build failed: ${err.message}`));
  }
  if (building) await withTimeout(building, waitMs).catch(() => {});
  return current;
}

/** Build the index now and keep it fresh in the background. */
function start() {
  build().catch(err => console.warn(`[catalog] Initial build failed: ${err.message}`));
  if (!refreshTimer) {
    refreshTimer = setInterval(refreshIfDue, RETRY_INTERVAL_MS);
    refreshTimer.unref();
  }
}

function stop() {
  if (refreshTimer) clearInterval(refreshTimer);
  refreshTimer = null;
}

/** Register a callback invoked after every successful rebuild. */
function onRebuild(listener) {
  rebuildListeners.add(listener);
}

/** The current index without triggering a build (null when none yet). */
function peek() {
  return current;
}

/** Rebuild the index now (joins a build in progress). */
function rebuild() {
  return build();
}

function getInfo() {
  return {
    size: current?.size || 0,
    builtAt: current?.builtAt || null,
    complete: current?.complete || false,
    fresh: Boolean(current?.isFresh),
    withIds: current?.withIds || 0,
    withoutIds: current ? current.size - current.withIds : 0,
    building: Boolean(building),
    lastAttemptAt: lastAttempt || null,
    refreshIntervalMs: REFRESH_INTERVAL_MS,
    freshMaxAgeMs: FRESH_MAX_AGE_MS,
    ...buildStats,
  };
}

module.exports = { getIndex, peek, rebuild, upsert, start, stop, onRebuild, getInfo, CatalogIndex };
