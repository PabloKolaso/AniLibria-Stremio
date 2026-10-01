/**
 * Logs: "what happened for a specific request or error?" — the stream
 * request log (filters, paging, details, CSV) and the server console.
 */

const express        = require('express');
const requestLog     = require('../../telemetry/request-log');
const missing        = require('../../telemetry/missing');
const matches        = require('../../telemetry/matches');
const overrides      = require('../../overrides');
const consoleCapture = require('../../monitoring/console');
const { diagnose, DiagnoseError } = require('../../monitoring/diagnose');
const mapping        = require('../../mapping/cache');
const catalogIndex   = require('../../mapping/anilibria-catalog');
const anilibria      = require('../../api/anilibria');
const { planTargets } = require('../../bridge/targets');
const { meta }       = require('./meta');
const { str, int, oneOf, time } = require('./params');

const CATEGORIES = ['found', 'not_on_anilibria', 'episode_missing', 'unsupported', 'blocked', 'error', 'pass_through', 'unclassified'];
const REASONS = [
  'found', 'not_anime', 'not_on_anilibria', 'episode_not_found', 'special_season', 'release_missing',
  'blocked', 'timeout', 'lookup_failed', 'release_fetch_failed', 'mapping_unavailable', 'plan_failed', 'unexpected',
];
const METHODS = ['mal', 'alias', 'search', 'fuse', 'pinned', 'direct'];

/** Request-log filters from query parameters (shared by the list, the CSV and "new entries"). */
function filtersFrom(query) {
  const slow = int(query.slow, undefined, { min: 1, max: 60_000 });
  return {
    scope: oneOf(query.scope, ['anime', 'pass', 'all'], 'anime'),
    category: oneOf(query.category, CATEGORIES),
    outcome: oneOf(query.outcome, ['success', 'not_found', 'error']), // v1 links
    reason: oneOf(query.reason, REASONS),
    method: oneOf(query.method, METHODS),
    source: oneOf(query.source, ['imdb', 'catalog']),
    minMs: slow,
    from: time(query.from),
    to: time(query.to, true),
    q: str(query.q || query.search, 100) || undefined,
  };
}

// ─── CSV export ──────────────────────────────────────────────────────────────

/** Quote a CSV field and neutralize spreadsheet formula injection. */
function csvField(value) {
  let s = String(value ?? '');
  if (/^[=+\-@\t\r]/.test(s)) s = `'${s}`;
  return `"${s.replace(/"/g, '""')}"`;
}

function formatDate(ts) {
  const date = new Date(ts);
  return Number.isFinite(date.getTime()) ? date.toISOString().replace('T', ' ').slice(0, 19) : '';
}

const CSV_COLUMNS = [
  ['Timestamp (UTC)', e => formatDate(e.ts)],
  ['Stremio ID', e => e.id],
  ['Source', e => e.source],
  ['Type', e => e.type],
  ['IMDB ID', e => e.imdbId],
  ['Title', e => e.title],
  ['Category', e => e.category],
  ['Outcome', e => e.outcome],
  ['Reason', e => e.reason],
  ['Method', e => e.method],
  ['AniLibria Release', e => e.releaseId],
  ['Response Time (ms)', e => e.ms],
  ['Streams', e => e.streams],
  ['Error', e => e.error],
];

function exportCsv(req, res) {
  const { rows } = requestLog.query({ ...filtersFrom(req.query), limit: 50_000 });
  const header = CSV_COLUMNS.map(([name]) => csvField(name)).join(',');
  const body = rows.map(e => CSV_COLUMNS.map(([, get]) => csvField(get(e))).join(',')).join('\n');
  res.setHeader('Content-Type', 'text/csv; charset=utf-8');
  res.setHeader('Content-Disposition', 'attachment; filename="anilibria-requests.csv"');
  res.setHeader('Cache-Control', 'no-store');
  res.send(`${header}\n${body}`);
}

// ─── Request details ─────────────────────────────────────────────────────────

function releaseInfo(releaseId) {
  if (!releaseId) return null;
  const indexed = catalogIndex.peek()?.byId.get(releaseId);
  const cached = anilibria.peekRelease(releaseId);
  const alias = indexed?.alias || cached?.alias || null;
  return {
    id: releaseId,
    name: indexed?.en || cached?.name?.english || cached?.name?.main || null,
    nameRu: indexed?.ru || cached?.name?.main || null,
    year: indexed?.year ?? cached?.year ?? null,
    ids: indexed?.ids || [],
    alias,
    url: anilibria.releaseUrl(alias),
  };
}

function detail(entry) {
  const entries = entry.imdbId ? mapping.getEntriesSync(entry.imdbId) : [];
  let plan = null;
  if (entries.length > 0 && entry.type) {
    const p = planTargets(entries, { type: entry.type, season: entry.season, episode: entry.episode });
    plan = { mode: p.mode, attempts: p.attempts.map(a => ({ mal: a.entry.mal, anilist: a.entry.anilist, type: a.entry.type, tvdbSeason: a.entry.tvdbSeason, tvdbOffset: a.entry.tvdbOffset, episode: a.episode, numbering: a.numbering, franchiseSeason: a.franchiseSeason ?? null })) };
  }
  return {
    entry,
    release: releaseInfo(entry.releaseId),
    mapping: entries,
    plan,
    match: entry.entryKey ? matches.get(entry.entryKey) : null,
    missing: missing.related({ imdbId: entry.imdbId, releaseId: entry.releaseId }),
    overrides: entry.imdbId ? { ignored: overrides.getIgnored(entry.imdbId), notDubbed: overrides.getNotDubbed(entry.imdbId) } : null,
    searchUrl: anilibria.searchUrl(entry.title),
  };
}

// ─── Routes ──────────────────────────────────────────────────────────────────

function register(router) {
  router.get('/logs', (req, res) => {
    const filters = filtersFrom(req.query);
    const after = int(req.query.after, undefined, { min: 0 });
    if (after !== undefined) {
      // How many entries matching the filters arrived since `after` (no rows)
      const { matched } = requestLog.query({ ...filters, after, limit: 1 });
      return res.json({ meta: meta(), newCount: matched, latestSeq: requestLog.latestSeq() });
    }
    const result = requestLog.query({
      ...filters,
      before: int(req.query.before, undefined, { min: 1 }),
      limit: int(req.query.limit, 100, { min: 10, max: 500 }),
    });
    res.json({
      meta: meta(),
      ...result,
      latestSeq: requestLog.latestSeq(),
      retention: requestLog.retention(),
      facets: { categories: CATEGORIES, reasons: REASONS, methods: METHODS },
    });
  });

  router.get('/logs/:seq', (req, res) => {
    const seq = int(req.params.seq, null, { min: 1 });
    const entry = seq && requestLog.get(seq);
    if (!entry) return res.status(404).json({ error: 'log entry not found (expired?)' });
    res.json({ meta: meta(), ...detail(entry) });
  });

  router.get('/mapping/:imdbId', (req, res) => {
    const { imdbId } = req.params;
    if (!/^tt\d{7,10}$/.test(imdbId)) return res.status(400).json({ error: 'invalid imdbId' });
    const entries = mapping.getEntriesSync(imdbId);
    res.json({ meta: meta(), imdbId, ready: mapping.isReady(), entries });
  });

  router.get('/console', (req, res) => {
    const after = int(req.query.after, 0, { min: 0 });
    const lines = consoleCapture.getLines({ after, limit: 1000 });
    res.json({ meta: meta(), lines, lastSeq: consoleCapture.lastSeq(), capacity: consoleCapture.MAX_LINES });
  });

  router.get('/console/download', (req, res) => {
    const text = consoleCapture.getLines().map(consoleCapture.formatLine).join('\n');
    res.setHeader('Content-Type', 'text/plain; charset=utf-8');
    res.setHeader('Content-Disposition', `attachment; filename="anilibria-console-${new Date().toISOString().slice(0, 19).replace(/:/g, '-')}.log"`);
    res.send(`${text}\n`);
  });

  router.post('/resolve', express.json({ limit: '10kb' }), async (req, res) => {
    try {
      const result = await diagnose({
        input: str(req.body?.input, 500),
        type: oneOf(req.body?.type, ['series', 'movie']),
        season: req.body?.season,
        episode: req.body?.episode,
      });
      res.json({ meta: meta(), result });
    } catch (err) {
      if (err instanceof DiagnoseError) return res.status(err.status).json({ error: err.message });
      throw err;
    }
  });
}

module.exports = { register, exportCsv, filtersFrom };
