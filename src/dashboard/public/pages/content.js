/**
 * Content — "What anime/catalog data is currently available and updating?"
 * Releasing and Trending catalogs with diagnostics, recent AniLibria
 * updates, index and mapping status, low-confidence matches, coverage.
 */

import { h, mount } from '../lib/dom.js';
import { api } from '../lib/api.js';
import { num, pct, ms, duration } from '../lib/format.js';
import { METHOD, TRENDING_REASON, RELEASING_REASON, UPDATE_EVENT } from '../lib/labels.js';
import {
  card, body, segmented, table, pill, poster, ext, relTime, kv, empty, loading, errorState,
  actionButton, toast, malLink, anilistLink, imdbLink, statusPill,
} from '../lib/ui.js';

const VIEWS = [
  { value: 'releasing', label: 'Releasing' },
  { value: 'trending', label: 'Trending' },
  { value: 'updates', label: 'Recent updates' },
  { value: 'data', label: 'Index & mapping' },
  { value: 'matches', label: 'Low-confidence matches' },
  { value: 'coverage', label: 'Coverage' },
];

function refreshLine(info, everyText) {
  return h('div', { class: 'row small subtle' },
    info.updatedAt ? ['Updated ', relTime(info.updatedAt)] : 'Not loaded yet',
    ` · refreshes ${everyText}`,
    info.nextRefreshAt && info.nextRefreshAt > Date.now() ? [' · next ', relTime(info.nextRefreshAt)] : null,
    info.lastDurationMs !== null && info.lastDurationMs !== undefined ? ` · last run ${ms(info.lastDurationMs)}` : null,
    info.lastError && h('span', { class: 'pill bad' }, 'Refresh failing'),
    info.lastError && h('span', { class: 'bad-text' }, info.lastError, info.lastFailureAt ? [' (', relTime(info.lastFailureAt), ')'] : null));
}

async function runJob(id, done) {
  const r = await api.post(`/admin/jobs/${id}`);
  toast(`${r.job?.label || id}: ${r.message || 'done'}`, { type: 'success' });
  done?.();
}

// ─── Releasing ───────────────────────────────────────────────────────────────

function releasingView(data, state, redraw, refresh) {
  const { info, diagnostics: d } = data.releasing;
  if (!d) return card({ title: 'Releasing catalog', body: body(refreshLine(info, 'every 60 s'), empty(info.lastError ? `Not loaded: ${info.lastError}` : 'Waiting for the first successful poll…')) });
  const filter = state.relFilter || 'all';
  const rows = d.releases.filter(r => filter === 'all' || (filter === 'playable' ? r.playable : !r.playable));
  return card({
    title: `${num(d.playable)} of ${num(d.inProduction)} releases AniLibria is dubbing are playable`,
    sub: 'The "AniLibria – Releasing" catalog lists the playable ones, most recently updated first',
    actions: [
      segmented({
        options: [
          { value: 'all', label: 'All', count: d.releases.length },
          { value: 'playable', label: 'Playable', count: d.playable },
          { value: 'not', label: 'Not playable', count: d.inProduction - d.playable },
        ],
        value: filter, label: 'Filter',
        onChange: v => { state.relFilter = v; redraw(); },
      }),
      actionButton({ label: 'Refresh now', run: () => runJob('refresh-releasing', refresh) }),
    ],
    body: h('div', { class: 'card-body flush' },
      h('div', { class: 'card-body' }, refreshLine(info, 'every 60 s')),
      table({
        rows,
        empty: 'Nothing matches this filter',
        columns: [
          {
            label: 'Anime', render: r => h('div', { class: 'title-cell' }, poster(r.poster),
              h('div', null, h('div', { class: 'cell-title' }, r.url ? ext(r.url, r.name) : r.name),
                r.nameRu && r.nameRu !== r.name && h('div', { class: 'cell-sub' }, r.nameRu),
                h('div', { class: 'cell-sub' }, `AniLibria #${r.id}${r.type ? ` · ${r.type}` : ''}`))),
          },
          { label: 'Latest episode', className: 'num', render: r => (r.latestEpisode === null ? '—' : `Ep ${num(r.latestEpisode)}`) },
          { label: 'Playable', render: r => (r.playable ? pill(`${num(r.playableCount)} episodes`, 'ok') : pill(RELEASING_REASON[r.reason] || r.reason, 'neutral')) },
          { label: 'Updated', className: 'nowrap', render: r => (r.updatedAt ? relTime(Date.parse(r.updatedAt)) : '—') },
        ],
      })),
  });
}

// ─── Trending ────────────────────────────────────────────────────────────────

function trendingView(data, state, redraw, refresh) {
  const { info, diagnostics: d } = data.trending;
  if (!d) return card({ title: 'Trending catalog', body: body(refreshLine(info, 'every 5 min'), empty(info.lastError ? `Not loaded: ${info.lastError}` : 'Waiting for the first successful refresh…')) });
  const filter = state.trFilter || 'all';
  const reasons = {};
  for (const r of d.rows) if (r.status === 'excluded') reasons[r.reason] = (reasons[r.reason] || 0) + 1;
  const rows = d.rows.filter(r => filter === 'all' || (filter === 'listed' ? r.status === 'listed' : filter === 'excluded' ? r.status === 'excluded' : r.reason === filter));
  return card({
    title: `${num(d.listed)} / ${num(d.total)} trending anime are available with an AniLibria dub`,
    sub: 'AniList trending (top 100), kept only for exact ID/alias matches with playable episodes',
    actions: [
      actionButton({ label: 'Refresh now', run: () => runJob('refresh-trending', refresh), title: 'Fetches AniList trending (2 requests)' }),
    ],
    body: h('div', { class: 'card-body flush' },
      h('div', { class: 'card-body stack' },
        refreshLine(info, 'every 5 min'),
        segmented({
          options: [
            { value: 'all', label: 'All', count: d.rows.length },
            { value: 'listed', label: 'Listed', count: d.listed },
            { value: 'excluded', label: 'Excluded', count: d.rows.length - d.listed },
            ...Object.entries(reasons).sort((a, b) => b[1] - a[1]).map(([reason, count]) => ({ value: reason, label: TRENDING_REASON[reason] || reason, count })),
          ],
          value: filter, label: 'Filter',
          onChange: v => { state.trFilter = v; redraw(); },
        })),
      table({
        rows,
        empty: 'Nothing matches this filter',
        columns: [
          { label: '#', className: 'num', render: r => r.rank },
          {
            label: 'Trending anime', render: r => h('div', { class: 'title-cell' }, poster(r.poster || r.cover),
              h('div', null, h('div', { class: 'cell-title' }, ext(`https://anilist.co/anime/${r.anilistId}`, r.title)),
                h('div', { class: 'cell-sub' }, [r.year, r.malId && `MAL ${r.malId}`].filter(Boolean).join(' · ')))),
          },
          {
            label: 'Status', render: r => (r.status === 'listed'
              ? pill('Listed', 'ok')
              : pill(TRENDING_REASON[r.reason] || r.reason, r.reason === 'untrusted_match' ? 'warn' : 'neutral')),
          },
          {
            label: 'AniLibria release', render: r => (r.releaseId
              ? h('div', null, r.releaseUrl ? ext(r.releaseUrl, r.releaseName || `#${r.releaseId}`) : (r.releaseName || `#${r.releaseId}`),
                r.method && h('div', { class: 'cell-sub' }, METHOD[r.method]?.label || r.method))
              : '—'),
          },
        ],
      })),
  });
}

// ─── Recent updates ──────────────────────────────────────────────────────────

function updateText(e) {
  switch (e.type) {
    case 'episode':
      return e.fromEpisode !== null && e.fromEpisode !== undefined && e.episode - e.fromEpisode > 1
        ? `Episodes ${e.fromEpisode + 1}–${e.episode} added`
        : `Episode ${e.episode} added`;
    case 'release': return 'New release discovered';
    case 'blocked': return 'Now blocked on AniLibria';
    case 'unblocked': return 'No longer blocked';
    default: return e.type;
  }
}

function updatesView(data) {
  const list = data.updates;
  return card({
    title: 'Recent AniLibria updates',
    sub: 'Detected by the Releasing poller every minute; newest 100 (30 days)',
    body: h('div', { class: 'card-body flush' }, list.length === 0
      ? empty('No updates detected yet. New episodes and releases appear here within about a minute.')
      : h('ul', { class: 'list' }, list.map(e => h('li', null,
        poster(e.poster),
        h('div', { class: 'grow' },
          h('div', { class: 'cell-title' }, updateText(e)),
          h('div', { class: 'cell-sub' }, e.url ? ext(e.url, e.name) : e.name, ` · AniLibria #${e.releaseId}`)),
        h('div', { class: 'stack', style: { gap: '4px', alignItems: 'flex-end' } },
          pill(UPDATE_EVENT[e.type] || e.type, e.type === 'episode' ? 'ok' : e.type === 'release' ? 'info' : 'warn'),
          h('span', { class: 'meta' }, relTime(e.at))))))),
  });
}

// ─── Index & mapping ─────────────────────────────────────────────────────────

function dataView(data, refresh) {
  const i = data.index;
  const m = data.mapping;
  const indexCard = card({
    title: 'AniLibria catalog index',
    sub: 'Local copy of the whole AniLibria catalog, used to match anime by MAL ID and title',
    actions: actionButton({ label: 'Rebuild now', confirm: 'Rebuild?', title: 'Downloads the whole catalog (~40 requests). 10 min cooldown.', run: () => runJob('rebuild-index', refresh), busyLabel: 'Rebuilding…' }),
    body: body(kv([
      ['Status', statusPill(i.size === 0 ? 'down' : !i.fresh ? 'degraded' : i.complete ? 'healthy' : 'warning',
        i.size === 0 ? 'Not built' : !i.fresh ? 'Stale' : i.complete ? 'Complete' : 'Incomplete')],
      ['Releases', num(i.size)],
      ['With MAL/Shikimori ID', i.size ? `${num(i.withIds)} (${pct(i.withIds / i.size)})` : '—'],
      ['Without external ID', i.size ? `${num(i.withoutIds)} — found by title only` : '—'],
      ['Last full build', i.builtAt ? [relTime(i.builtAt), i.lastDurationMs ? ` · took ${ms(i.lastDurationMs)}` : ''] : 'never'],
      ['Refresh', `every ${duration(i.refreshIntervalMs)}; stale after ${duration(i.freshMaxAgeMs)}`],
      ['Building now', i.building ? 'yes' : 'no'],
      ['Pages failed (last build)', num(i.pagesFailed)],
      ['Added between builds', i.upserts ? [`${num(i.upserts)} updates, last `, relTime(i.lastUpsertAt)] : 'none'],
      ['Last error', i.lastError ? h('span', { class: 'bad-text' }, i.lastError.message, ' (', relTime(i.lastError.at), ')') : 'none'],
    ])),
  });
  const mappingCard = card({
    title: 'Fribb ID mapping',
    sub: 'IMDB ↔ MyAnimeList/AniList with TVDB seasons (github.com/Fribb/anime-lists)',
    actions: actionButton({ label: 'Re-download', confirm: 'Download?', title: 'Downloads the mapping from GitHub. 30 min cooldown.', run: () => runJob('refresh-mapping', refresh), busyLabel: 'Downloading…' }),
    body: body(kv([
      ['Status', statusPill(!m.ready ? 'down' : m.lastError ? 'warning' : 'healthy', !m.ready ? 'Not loaded' : m.lastError ? 'Refresh failing' : 'Loaded')],
      ['IMDB IDs', num(m.imdbIds)],
      ['Anime entries', num(m.entries)],
      ['Downloaded', m.fetchedAt ? relTime(m.fetchedAt) : 'never'],
      ['Loaded from', m.source === 'disk' ? 'disk cache' : m.source === 'download' ? 'GitHub' : '—'],
      ['Refresh', `every ${duration(m.refreshIntervalMs)} (in the background)`],
      ['Last attempt', m.lastAttemptAt ? relTime(m.lastAttemptAt) : '—'],
      ['Last error', m.lastError ? h('span', { class: 'bad-text' }, m.lastError.message, ' (', relTime(m.lastError.at), ')') : 'none'],
    ])),
  });
  return h('div', { class: 'grid grid-2' }, indexCard, mappingCard);
}

// ─── Low-confidence matches ──────────────────────────────────────────────────

function matchesView(state, redraw) {
  const d = state.matches;
  if (!d) return card({ title: 'Low-confidence matches', body: loading() });
  const status = state.matchStatus || 'review';
  const decide = (row, decision) => async () => {
    const res = await api.post('/matches/decision', { key: row.key, releaseId: row.releaseId, decision });
    const undo = res.previous
      ? () => api.post('/matches/decision', { key: row.key, releaseId: res.previous.releaseId, decision: res.previous.decision }).then(state.loadMatches)
      : () => api.post('/matches/decision', { key: row.key, decision: 'clear' }).then(state.loadMatches);
    toast(decision === 'clear' ? 'Decision cleared' : decision === 'approve' ? 'Match approved (pinned)' : 'Match rejected — the resolver will not use this release', { type: 'success', action: { label: 'Undo', run: undo } });
    await state.loadMatches();
  };
  return card({
    title: 'Low-confidence matches',
    sub: 'Anime matched to an AniLibria release by title (search API or fuzzy match) instead of by ID',
    actions: segmented({
      options: [
        { value: 'review', label: 'Needs review', count: d.counts.review },
        { value: 'approved', label: 'Approved', count: d.counts.approved },
        { value: 'rejected', label: 'Rejected', count: d.counts.rejected },
      ],
      value: status, label: 'Status',
      onChange: v => { state.matchStatus = v; state.matches = null; redraw(); state.loadMatches(); },
    }),
    body: h('div', { class: 'card-body flush' },
      h('div', { class: 'card-body help' },
        h('p', null, 'Approve pins the release for that anime (it is then used directly and may appear in Trending). Reject blocks that release for that anime; the resolver tries other candidates. Decisions are stored in the overrides (export/import on Missing titles).')),
      table({
        rows: d.rows,
        empty: status === 'review' ? 'No title-based matches to review.' : 'None.',
        columns: [
          {
            label: 'Requested anime', render: r => h('div', null,
              h('div', { class: 'cell-title' }, r.title || r.key),
              h('div', { class: 'cell-sub row tight' }, r.year, malLink(r.mal), anilistLink(r.anilist)),
              r.imdbIds?.length > 0 && h('div', { class: 'cell-sub' }, 'IMDB: ', r.imdbIds.slice(0, 3).map((id, i) => [i ? ', ' : '', imdbLink(id)]))),
          },
          {
            label: 'Matched release', render: r => h('div', null,
              h('div', { class: 'cell-title' }, r.releaseUrl ? ext(r.releaseUrl, r.releaseName || `#${r.releaseId}`) : (r.releaseName || `#${r.releaseId}`)),
              r.releaseNameRu && h('div', { class: 'cell-sub' }, r.releaseNameRu),
              h('div', { class: 'cell-sub' }, [`#${r.releaseId}`, r.releaseYear, r.releaseIds?.length ? `tagged MAL ${r.releaseIds.join('/')}` : 'no IDs on release'].filter(Boolean).join(' · '))),
          },
          {
            label: 'Method', render: r => h('div', null, pill(METHOD[r.method]?.label || r.method || '—', 'warn'),
              r.score !== null && r.score !== undefined && h('div', { class: 'cell-sub', title: 'Fuse.js distance: 0 = identical, 0.25 = acceptance limit' }, `distance ${r.score}`)),
          },
          { label: 'Used', className: 'nowrap', render: r => h('div', null, `${num(r.requests)} requests`, h('div', { class: 'cell-sub' }, 'last ', relTime(r.lastSeen))) },
          {
            label: '', className: 'actions', render: r => h('div', { class: 'row tight' },
              r.status !== 'approved' && actionButton({ label: 'Approve', run: decide(r, 'approve') }),
              r.status !== 'rejected' && actionButton({ label: 'Reject', variant: 'danger', run: decide(r, 'reject') }),
              r.status !== 'review' && actionButton({ label: 'Clear', variant: 'ghost', run: decide(r, 'clear') })),
          },
        ],
      })),
  });
}

// ─── Coverage ────────────────────────────────────────────────────────────────

function coverageView(state) {
  const c = state.coverage;
  if (c === undefined) return card({ title: 'Coverage', body: loading('Computing…') });
  if (c === null) return card({ title: 'Coverage', body: empty('Needs both the AniLibria index and the ID mapping to be loaded.') });
  const k = c.counts;
  const tile = (label, value, sub, tone) => h('div', { class: 'card kpi' },
    h('div', { class: 'kpi-label' }, label),
    h('div', { class: ['kpi-value', tone] }, num(value)),
    h('div', { class: 'kpi-sub' }, sub));
  const releaseRows = rows => table({
    rows, empty: 'None',
    columns: [
      { label: 'Release', render: r => h('div', null, h('div', { class: 'cell-title' }, r.url ? ext(r.url, r.name) : r.name), r.nameRu && r.nameRu !== r.name && h('div', { class: 'cell-sub' }, r.nameRu)) },
      { label: 'Year', className: 'num', render: r => r.year || '—' },
      { label: 'IDs', render: r => (r.ids.length ? h('span', { class: 'row tight' }, r.ids.map(id => malLink(id))) : '—') },
      { label: 'AniLibria', className: 'num', render: r => `#${r.id}` },
    ],
  });
  return h('div', { class: 'stack' },
    h('div', { class: 'grid grid-kpi' },
      tile('AniLibria releases', k.total, `index built ${new Date(c.indexBuiltAt).toLocaleString()}`),
      tile('Reachable from IMDB', k.imdb, `${pct(c.imdbCoverage)} — MAL ID linked to an IMDB ID`, 'ok-text'),
      tile('Only via addon catalogs', k.catalogOnly, 'No IMDB link, listed in Releasing/Trending now'),
      tile('Not reachable', k.unmapped, 'Has a MAL ID, no IMDB link, not listed', k.unmapped > 0 ? 'warn-text' : ''),
      tile('No external ID', k.noIds, `${pct(1 - c.externalIdCoverage)} — only title matching can find these`)),
    h('p', { class: 'help' }, 'Computed offline from the local AniLibria index and the Fribb mapping (no API calls). "Reachable" means a Stremio request can be mapped to the release; single episodes can still fail on numbering.'),
    card({ title: 'Not reachable (newest first)', sub: `Up to ${c.sampleSize}. Adding their IMDB IDs to the Fribb mapping would make them playable from Cinemeta.`, body: h('div', { class: 'card-body flush' }, releaseRows(c.unmapped)) }),
    card({ title: 'Without external IDs (newest first)', sub: `Up to ${c.sampleSize}. AniLibria has no MAL/Shikimori ID on these releases.`, body: h('div', { class: 'card-body flush' }, releaseRows(c.noIds)) }));
}

// ─── Page ────────────────────────────────────────────────────────────────────

export default {
  mount(root, ctx) {
    const state = {
      view: VIEWS.some(v => v.value === ctx.params.get('view')) ? ctx.params.get('view') : 'releasing',
      data: null,
      matches: null,
      matchStatus: 'review',
      coverage: undefined,
    };
    const nav = h('div');
    const content = h('div', { class: 'stack' }, loading());
    mount(root, h('div', { class: 'stack' },
      h('div', { class: 'page-head' },
        h('div', null, h('h1', { class: 'page-title' }, 'Content'), h('div', { class: 'page-desc' }, 'What AniLibria data is available, how it is updating, and how well it maps to Stremio')),
        nav),
      content));

    const redraw = () => {
      mount(nav, segmented({
        options: VIEWS, value: state.view, label: 'Section',
        onChange: v => {
          state.view = v;
          ctx.setParams({ view: v === 'releasing' ? null : v });
          redraw();
          ctx.refresh();
        },
      }));
      if (state.view === 'matches') return mount(content, matchesView(state, redraw));
      if (state.view === 'coverage') return mount(content, coverageView(state));
      if (!state.data) return;
      const d = state.data;
      const view = {
        releasing: () => releasingView(d, state, redraw, ctx.refresh),
        trending: () => trendingView(d, state, redraw, ctx.refresh),
        updates: () => updatesView(d),
        data: () => dataView(d, ctx.refresh),
      }[state.view];
      mount(content, view());
    };

    state.loadMatches = async () => {
      state.matches = await api.get('/matches', { status: state.matchStatus });
      if (state.view === 'matches') redraw();
    };

    ctx.setTask({
      interval: 30_000,
      load: async () => {
        try {
          if (state.view === 'matches') return await state.loadMatches();
          if (state.view === 'coverage') {
            state.coverage = (await api.get('/content/coverage')).coverage;
            return redraw();
          }
          state.data = await api.get('/content');
          redraw();
        } catch (err) {
          if (!state.data && state.view !== 'matches') mount(content, errorState(err, () => ctx.refresh()));
          throw err;
        }
      },
    });
    redraw();
    return {};
  },
};
