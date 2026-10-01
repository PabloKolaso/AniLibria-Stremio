/**
 * Logs — "What happened for a specific request or error?"
 *   Requests: the stream request log with filters (kept in the URL), paging,
 *             a details drawer with actions, and CSV export. New entries are
 *             announced, never inserted under the reader's cursor.
 *   Console:  the server console, fetched incrementally, with level and text
 *             filters, pause, clear and download.
 */

import { h, mount, highlight } from '../lib/dom.js';
import { api, downloadUrl } from '../lib/api.js';
import { num, ms, dateTime, utc, hour } from '../lib/format.js';
import { CATEGORY, METHOD, reasonLabel } from '../lib/labels.js';
import {
  card, segmented, table, pill, relTime, ext, extButton, imdbLink, malLink, anilistLink, loading, errorState,
  actionButton, toast, openDrawer, drawerSection, kv,
} from '../lib/ui.js';

const FILTER_KEYS = ['q', 'scope', 'category', 'reason', 'method', 'source', 'slow', 'from', 'to'];

/** An ISO timestamp as the local "YYYY-MM-DDTHH:MM" a datetime-local input expects. */
function toLocalInput(iso) {
  const d = new Date(iso);
  if (!iso || Number.isNaN(d.getTime())) return '';
  return new Date(d.getTime() - d.getTimezoneOffset() * 60_000).toISOString().slice(0, 16);
}

function categoryPill(category) {
  const c = CATEGORY[category];
  return pill(c?.label || category || '—', c?.tone || 'neutral', c?.help);
}

function methodText(method) {
  if (!method) return '—';
  const m = METHOD[method];
  return h('span', { title: m?.help, class: m?.confidence === 'low' ? 'warn-text' : undefined }, m?.label || method);
}

function idCell(e) {
  return h('div', null,
    h('div', { class: 'mono wrap-anywhere' }, e.id),
    h('div', { class: 'cell-sub' }, e.source === 'catalog' ? 'addon catalog' : 'IMDB', e.type ? ` · ${e.type}` : ''));
}

// ─── Resolve result (drawer and admin tester share this) ─────────────────────

export function resolveResult(r) {
  return h('div', { class: 'stack' },
    h('div', { class: 'row' },
      categoryPill(r.category),
      h('span', { class: 'strong' }, reasonLabel(r.reason)),
      h('span', { class: 'subtle small' }, `${ms(r.durationMs)} · ${r.parsed.id}`)),
    kv([
      ['Title', r.title || '—'],
      ['Method', methodText(r.method)],
      ['Release', r.release ? h('span', null, r.release.url ? ext(r.release.url, r.release.name || `#${r.release.id}`) : (r.release.name || `#${r.release.id}`),
        ` · #${r.release.id}`, r.release.latestEpisode !== null && r.release.latestEpisode !== undefined ? ` · latest ep ${r.release.latestEpisode}` : '',
        r.release.live ? ' · still dubbing' : '') : '—'],
      ['Streams', r.streams.length ? h('div', { class: 'row tight' }, r.streams.map(s => (s.url ? ext(s.url, s.quality) : s.quality))) : 'none'],
      ['Plan', r.details?.planMode ? `${r.details.planMode}${r.details.attempts?.length ? ` · ${r.details.attempts.length} attempt(s)` : ''}` : '—'],
      r.details?.attempts?.length > 0 && ['Attempts', h('div', { class: 'stack', style: { gap: '2px' } }, r.details.attempts.map(a => h('div', { class: 'small' },
        [a.mal && `MAL ${a.mal}`, a.anilist && `AniList ${a.anilist}`, a.type, a.tvdbSeason !== null ? `TVDB S${a.tvdbSeason}` : null,
          `→ episode ${a.episode ?? '?'} (${a.numbering})`, a.franchiseSeason ? `franchise season ${a.franchiseSeason}` : null].filter(Boolean).join(' · '))))],
      r.details?.examined?.length > 0 && ['Releases tried', h('div', { class: 'stack', style: { gap: '2px' } }, r.details.examined.map(x => h('div', { class: 'small' },
        `#${x.releaseId} · episode ${x.target ?? '?'} (${x.numbering})`,
        x.latestEpisode !== undefined ? ` · latest ${x.latestEpisode ?? '—'}` : '',
        x.found ? ' · found' : x.blocked ? ' · blocked' : x.missing ? ' · release missing' : x.noHls ? ' · no HLS' : x.error ? ` · ${x.error}` : ' · not found')))],
      r.error && ['Error', h('span', { class: 'bad-text' }, r.error)],
      ['Resolver cache', r.cacheCleared ? `${r.cacheCleared} cached match(es) cleared before testing` : 'bypassed'],
    ]),
    r.mapping?.length > 0 && drawerSection('ID mapping (Fribb)', mappingTable(r.mapping)),
    drawerSection(`Log lines during the test (${r.logs.length})`, r.logs.length ? h('pre', { class: 'logs' }, r.logs.join('\n')) : h('div', { class: 'subtle' }, 'none')));
}

function mappingTable(entries) {
  return table({
    rows: entries,
    columns: [
      { label: 'IDs', render: m => h('span', { class: 'row tight' }, malLink(m.mal) || '—', anilistLink(m.anilist)) },
      { label: 'Type', render: m => m.type || '—' },
      { label: 'TVDB season', render: m => (m.tvdbSeason === null ? 'none (spans show)' : `S${m.tvdbSeason}`) },
      { label: 'Offset', className: 'num', render: m => m.tvdbOffset || 0 },
    ],
  });
}

// ─── Request details drawer ──────────────────────────────────────────────────

async function openDetails(seq, ctx) {
  const drawer = openDrawer({ title: `Request #${seq}` });
  mount(drawer.body, loading());
  let d;
  try {
    d = await api.get(`/logs/${seq}`);
  } catch (err) {
    return mount(drawer.body, errorState(err));
  }
  const e = d.entry;
  drawer.setTitle(e.title || e.id);
  const resultSlot = h('div');
  const imdbId = e.imdbId && encodeURIComponent(e.imdbId);
  const stremioInput = e.id;

  const actions = h('div', { class: 'row tight' },
    actionButton({
      label: 'Re-resolve now', variant: 'primary', busyLabel: 'Resolving…',
      title: 'Run the resolver again for this exact request (bypasses the resolver cache)',
      run: async () => {
        const res = await api.post('/resolve', { input: stremioInput, type: e.type });
        mount(resultSlot, drawerSection('Re-resolve result', resolveResult(res.result)));
      },
    }),
    actionButton({
      label: 'Clear cache', title: e.imdbId ? 'Forget the cached match for this title' : 'Refetch this release on next use',
      run: async () => {
        const res = await api.post('/admin/cache/clear-title', { id: e.imdbId || `anilibria:${e.releaseId}` });
        toast(res.message, { type: 'success' });
      },
    }),
    h('button', { class: 'btn btn-sm', type: 'button', onClick: () => ctx.navigate('admin', { view: 'resolve', input: stremioInput, type: e.type === 'movie' ? 'movie' : null }) }, 'Open in tester'),
    d.release?.url && extButton(d.release.url, 'AniLibria page ↗'),
    d.searchUrl && extButton(d.searchUrl, 'Search AniLibria ↗'),
    e.imdbId && !d.overrides?.notDubbed && e.category !== 'found' && actionButton({
      label: 'Mark not dubbed', run: async () => { await api.post(`/missing/${imdbId}/not-dubbed`); toast('Marked as not dubbed yet', { type: 'success' }); },
    }),
    e.imdbId && !d.overrides?.ignored && e.category !== 'found' && actionButton({
      label: 'Ignore', variant: 'ghost', run: async () => { await api.post(`/missing/${imdbId}/ignore`, { reason: '' }); toast('Ignored in Missing titles', { type: 'success' }); },
    }));

  mount(drawer.body,
    h('div', { class: 'row' }, categoryPill(e.category), e.reason !== 'found' && h('span', { class: 'strong' }, reasonLabel(e.reason))),
    actions,
    resultSlot,
    drawerSection('Request', kv([
      ['Time', h('span', { title: utc(e.ts) }, dateTime(e.ts), ' (', relTime(e.ts), ')')],
      ['Stremio ID', h('span', { class: 'mono' }, e.id)],
      ['Source', e.source === 'catalog' ? "This addon's catalog" : 'IMDB (Cinemeta or another catalog)'],
      ['Type', e.type],
      e.imdbId && ['IMDB', imdbLink(e.imdbId)],
      e.season !== null && ['Season / episode', `S${e.season} E${e.episode}`],
      e.season === null && e.episode !== null && ['Episode', e.episode],
      ['Outcome', `${e.outcome} · ${e.reason || '—'}`],
      ['Method', methodText(e.method)],
      ['Release', d.release ? h('span', null, d.release.url ? ext(d.release.url, d.release.name || `#${d.release.id}`) : (d.release.name || `#${d.release.id}`), ` · #${d.release.id}`, d.release.year ? ` · ${d.release.year}` : '') : '—'],
      ['Streams', num(e.streams)],
      ['Response time', ms(e.ms)],
      e.error && ['Error', h('span', { class: 'bad-text' }, e.error)],
    ])),
    d.mapping.length > 0
      ? drawerSection('ID mapping (Fribb)', mappingTable(d.mapping),
        d.plan && h('p', { class: 'help' }, `Plan for this request: ${d.plan.mode}. `, d.plan.attempts.map(a => `${a.mal ? `MAL ${a.mal}` : `AniList ${a.anilist}`} → episode ${a.episode ?? '?'} (${a.numbering})`).join('; ')))
      : e.imdbId && drawerSection('ID mapping (Fribb)', h('div', { class: 'subtle' }, 'This IMDB ID is not in the anime mapping.')),
    d.match && drawerSection('Low-confidence match', kv([
      ['Requested', d.match.title || d.match.key],
      ['Matched', `${d.match.releaseName || ''} (#${d.match.releaseId})`],
      ['Method', `${METHOD[d.match.method]?.label || d.match.method}${d.match.score !== null ? ` · distance ${d.match.score}` : ''}`],
    ]), h('button', { class: 'btn btn-sm', type: 'button', onClick: () => ctx.navigate('content', { view: 'matches' }) }, 'Review matches')),
    d.missing.length > 0 && drawerSection('Missing titles', h('div', { class: 'stack', style: { gap: '4px' } }, d.missing.map(m => h('div', { class: 'small' },
      `${m.status.replace(/_/g, ' ')}${m.season !== null && m.season !== undefined ? ` (season ${m.season})` : ''} · ${num(m.count)} requests · ${num(m.users)} users`)))),
    d.overrides && (d.overrides.ignored || d.overrides.notDubbed) && drawerSection('Overrides', h('div', { class: 'small' },
      d.overrides.ignored ? `Ignored${d.overrides.ignored.reason ? `: ${d.overrides.ignored.reason}` : ''}. ` : '',
      d.overrides.notDubbed ? 'Marked as not dubbed yet.' : '')));
}

// ─── Requests view ───────────────────────────────────────────────────────────

function requestsView(root, ctx) {
  const params = ctx.params;
  const filters = Object.fromEntries(FILTER_KEYS.map(k => [k, params.get(k) || '']));
  if (!filters.q && params.get('search')) filters.q = params.get('search'); // v1 links
  if (!filters.category && params.get('outcome')) filters.category = { success: 'found', error: 'error' }[params.get('outcome')] || '';
  const state = { rows: [], matched: 0, nextBefore: null, latestSeq: 0, newCount: 0, paused: false, facets: null, retention: null, loaded: false };

  const tableSlot = h('div', null, loading());
  const info = h('div', { class: 'row small subtle' });
  const newBar = h('div');
  const loadMoreSlot = h('div');
  const toolbar = h('div', { class: 'toolbar' });

  const query = extra => ({ ...Object.fromEntries(Object.entries(filters).filter(([, v]) => v)), ...extra });

  const applyFilters = () => {
    ctx.setParams({ ...Object.fromEntries(FILTER_KEYS.map(k => [k, filters[k] || null])), search: null, outcome: null });
    load(true).catch(() => {});
  };

  let searchTimer = null;
  const select = (key, label, options) => h('label', { class: 'field' }, h('span', null, label),
    h('select', {
      class: 'select', 'aria-label': label,
      onChange: ev => { filters[key] = ev.target.value; applyFilters(); },
    }, options.map(([value, text]) => h('option', { value, selected: (filters[key] || '') === value }, text))));

  function drawToolbar() {
    const f = state.facets;
    const searchInput = h('input', { class: 'input', type: 'search', placeholder: 'ID, title, release, error…', value: filters.q, 'aria-label': 'Search' });
    searchInput.addEventListener('input', () => {
      clearTimeout(searchTimer);
      searchTimer = setTimeout(() => { filters.q = searchInput.value.trim(); applyFilters(); }, 350);
    });
    const dt = (key, label) => {
      const input = h('input', { class: 'input', type: 'datetime-local', value: toLocalInput(filters[key]), 'aria-label': label });
      input.addEventListener('change', () => {
        filters[key] = input.value ? new Date(input.value).toISOString() : '';
        applyFilters();
      });
      return h('label', { class: 'field' }, h('span', null, label), input);
    };
    mount(toolbar,
      h('label', { class: 'field grow' }, h('span', null, 'Search'), searchInput),
      select('scope', 'Requests', [['', 'Anime'], ['pass', 'Non-anime pass-through'], ['all', 'All']]),
      select('category', 'Outcome', [['', 'Any'], ...((f?.categories) || Object.keys(CATEGORY)).map(c => [c, CATEGORY[c]?.label || c])]),
      select('reason', 'Reason', [['', 'Any'], ...((f?.reasons) || []).map(r => [r, reasonLabel(r)])]),
      select('method', 'Method', [['', 'Any'], ...((f?.methods) || []).map(m => [m, METHOD[m]?.label || m])]),
      select('source', 'Source', [['', 'Any'], ['imdb', 'IMDB'], ['catalog', 'Addon catalog']]),
      select('slow', 'Slower than', [['', 'Any'], ['1000', '1 s'], ['3000', '3 s'], ['10000', '10 s']]),
      dt('from', 'From'),
      dt('to', 'To'),
      h('div', { class: 'row tight' },
        h('button', {
          class: 'btn btn-sm', type: 'button',
          onClick: () => { for (const k of FILTER_KEYS) filters[k] = ''; drawToolbar(); applyFilters(); },
        }, 'Reset'),
        h('a', { class: 'btn btn-sm', href: downloadUrl('/dashboard/export/csv', query()), title: 'All matching entries as CSV' }, 'Export CSV')));
  }

  function drawInfo() {
    const r = state.retention;
    mount(info,
      h('span', null, `Showing ${num(state.rows.length)} of ${num(state.matched)} matching`),
      r && h('span', { title: 'Older entries are dropped automatically' },
        ` · kept ${r.maxAgeDays} days, up to ${num(r.limits.anime)} anime + ${num(r.limits.passThrough)} non-anime entries`),
      r?.oldestTs && h('span', null, ' · oldest ', relTime(r.oldestTs)),
      h('span', { class: 'spacer' }),
      h('label', { class: 'check' },
        h('input', { type: 'checkbox', checked: state.paused, onChange: ev => { state.paused = ev.target.checked; ctx.setPaused(state.paused); } }),
        'Pause live updates'));
  }

  function drawNewBar() {
    if (state.newCount <= 0) return mount(newBar);
    mount(newBar, h('div', { class: 'new-bar' },
      h('button', { class: 'btn btn-sm', type: 'button', onClick: () => load(true).catch(() => {}) },
        `${num(state.newCount)} new ${state.newCount === 1 ? 'request' : 'requests'} — show`)));
  }

  const columns = [
    { label: 'Time', className: 'nowrap', render: e => h('div', { title: utc(e.ts) }, hour(e.ts), h('div', { class: 'cell-sub' }, relTime(e.ts))) },
    { label: 'Request', render: idCell },
    { label: 'Title', render: e => h('div', { class: 'cell-title' }, e.title || h('span', { class: 'subtle' }, '—')) },
    {
      label: 'Outcome', render: e => h('div', null, categoryPill(e.category),
        h('div', { class: 'cell-sub' }, reasonLabel(e.reason)),
        e.error && h('div', { class: 'cell-err' }, e.error)),
    },
    { label: 'Method', render: e => methodText(e.method) },
    { label: 'Release', className: 'nowrap', render: e => (e.releaseId ? `#${e.releaseId}` : '—') },
    { label: 'Response', className: 'num', render: e => h('span', { class: e.ms >= 3000 ? 'warn-text' : undefined }, ms(e.ms)) },
  ];

  function drawTable() {
    mount(tableSlot, table({
      rows: state.rows,
      columns,
      empty: 'No requests match these filters.',
      onRowClick: e => openDetails(e.seq, ctx),
    }));
    mount(loadMoreSlot, state.nextBefore && h('div', { class: 'pager' },
      h('span', { class: 'info' }, `${num(state.matched - state.rows.length)} older matching entries`),
      h('div', { class: 'buttons' }, actionButton({ label: 'Load older', run: () => loadOlder() }))));
  }

  async function load(reset) {
    if (!reset && state.loaded) {
      // Live check: only count what is new; rows never move under the reader
      const r = await api.get('/logs', query({ after: state.latestSeq }));
      state.newCount = r.newCount;
      drawNewBar();
      return;
    }
    const r = await api.get('/logs', query({ limit: 100 }));
    Object.assign(state, { rows: r.rows, matched: r.matched, nextBefore: r.nextBefore, latestSeq: r.latestSeq, newCount: 0, retention: r.retention, loaded: true });
    if (!state.facets) {
      state.facets = r.facets;
      drawToolbar();
    }
    drawInfo();
    drawNewBar();
    drawTable();
  }

  async function loadOlder() {
    const r = await api.get('/logs', query({ before: state.nextBefore, limit: 100 }));
    state.rows = state.rows.concat(r.rows);
    state.nextBefore = r.nextBefore;
    drawInfo();
    drawTable();
  }

  drawToolbar();
  mount(root, card({
    title: 'Stream requests',
    sub: 'Click a row for details, mapping and actions',
    body: h('div', { class: 'card-body flush' },
      h('div', { class: 'card-body stack' }, toolbar, info),
      newBar, tableSlot, loadMoreSlot),
  }));

  ctx.setTask({
    interval: 15_000,
    load: async () => {
      try {
        await load(!state.loaded);
      } catch (err) {
        if (!state.loaded) mount(tableSlot, errorState(err, () => ctx.refresh()));
        throw err;
      }
    },
  });
  return { destroy: () => clearTimeout(searchTimer) };
}

// ─── Console view ────────────────────────────────────────────────────────────

const MAX_CLIENT_LINES = 2000;
const LEVELS = [
  { value: 'all', label: 'All' },
  { value: 'warn', label: 'Warnings + errors' },
  { value: 'error', label: 'Errors' },
];

function consoleView(root, ctx) {
  const state = {
    lines: [],
    lastSeq: 0,
    clearedSeq: 0,
    level: LEVELS.some(l => l.value === ctx.params.get('level')) ? ctx.params.get('level') : 'all',
    q: ctx.params.get('cq') || '',
    paused: false,
    unseen: 0,
    capacity: null,
  };
  const box = h('div', { class: 'console', role: 'log', 'aria-live': 'off', tabindex: '0' });
  const status = h('div', { class: 'row small subtle' });
  const levelSlot = h('div');
  const jump = h('button', { class: 'btn btn-sm jump', type: 'button', hidden: true, onClick: () => { box.scrollTop = box.scrollHeight; } }, 'Jump to latest');
  const searchInput = h('input', { class: 'input', type: 'search', placeholder: 'Filter text…', value: state.q, 'aria-label': 'Filter console text' });
  let searchTimer = null;
  searchInput.addEventListener('input', () => {
    clearTimeout(searchTimer);
    searchTimer = setTimeout(() => {
      state.q = searchInput.value;
      ctx.setParams({ cq: state.q || null });
      redraw();
    }, 200);
  });

  const visible = line => line.seq > state.clearedSeq
    && (state.level === 'all' || (state.level === 'warn' ? line.level !== 'log' : line.level === 'error'))
    && (!state.q || line.text.toLowerCase().includes(state.q.toLowerCase()));

  const lineEl = line => h('div', { class: ['line', line.level] },
    h('span', { class: 'ts', title: utc(line.ts) }, new Date(line.ts).toLocaleTimeString()),
    highlight(line.text, state.q));

  const atBottom = () => box.scrollHeight - box.scrollTop - box.clientHeight < 24;

  function redraw() {
    const shown = state.lines.filter(visible);
    mount(box, shown.length ? shown.map(lineEl) : h('div', { class: 'subtle' }, state.lines.length ? 'No lines match the filters.' : 'No console output yet.'));
    box.scrollTop = box.scrollHeight;
    state.unseen = 0;
    drawStatus();
  }

  function append(newLines) {
    const follow = atBottom();
    const shown = newLines.filter(visible);
    if (shown.length) {
      if (box.firstChild && box.firstChild.classList?.contains('subtle')) box.replaceChildren();
      box.append(...shown.map(lineEl));
      while (box.childElementCount > MAX_CLIENT_LINES) box.firstElementChild.remove();
    }
    if (follow) box.scrollTop = box.scrollHeight;
    else state.unseen += shown.length;
    drawStatus();
  }

  function drawStatus() {
    jump.hidden = state.unseen === 0 && atBottom();
    jump.textContent = state.unseen > 0 ? `Jump to latest (${state.unseen} new)` : 'Jump to latest';
    mount(status,
      h('span', null, `${num(state.lines.filter(l => l.seq > state.clearedSeq).length)} lines`,
        state.capacity ? ` (server keeps the last ${num(state.capacity)})` : ''),
      state.clearedSeq > 0 && h('span', null, ' · display cleared'),
      state.paused && pill('Paused', 'info'));
  }

  box.addEventListener('scroll', () => {
    if (atBottom()) state.unseen = 0;
    drawStatus();
  });

  const drawLevels = () => mount(levelSlot, segmented({
    options: LEVELS, value: state.level, label: 'Level',
    onChange: v => { state.level = v; ctx.setParams({ level: v === 'all' ? null : v }); drawLevels(); redraw(); },
  }));
  drawLevels();

  const pauseBtn = h('button', { class: 'btn btn-sm', type: 'button' }, 'Pause');
  pauseBtn.addEventListener('click', () => {
    state.paused = !state.paused;
    pauseBtn.textContent = state.paused ? 'Resume' : 'Pause';
    ctx.setPaused(state.paused);
    drawStatus();
  });

  mount(root, card({
    title: 'Server console',
    sub: 'Live output of the addon process (read-only)',
    body: h('div', { class: 'card-body flush' },
      h('div', { class: 'card-body stack' },
        h('div', { class: 'toolbar' },
          levelSlot,
          h('label', { class: 'field grow' }, searchInput),
          h('div', { class: 'row tight' },
            pauseBtn,
            h('button', {
              class: 'btn btn-sm', type: 'button', title: 'Clear the display; new lines keep arriving',
              onClick: () => { state.clearedSeq = state.lastSeq; redraw(); },
            }, 'Clear'),
            h('a', { class: 'btn btn-sm', href: downloadUrl('/console/download') }, 'Download'))),
        status),
      box, jump),
  }));

  ctx.setTask({
    interval: 3000,
    load: async () => {
      const r = await api.get('/console', { after: state.lastSeq });
      state.capacity = r.capacity;
      if (r.lastSeq < state.lastSeq) {
        // The server restarted: its line numbers started over
        state.lines = [];
        state.clearedSeq = 0;
        state.lastSeq = 0;
      }
      const fresh = r.lines.filter(l => l.seq > state.lastSeq);
      const first = state.lastSeq === 0;
      state.lines = state.lines.concat(fresh).slice(-MAX_CLIENT_LINES);
      state.lastSeq = Math.max(state.lastSeq, r.lastSeq);
      if (first) redraw();
      else if (fresh.length) append(fresh);
      else drawStatus();
    },
  });
  return { destroy: () => clearTimeout(searchTimer) };
}

// ─── Page ────────────────────────────────────────────────────────────────────

export default {
  mount(root, ctx) {
    const viewName = ctx.params.get('view') === 'console' ? 'console' : 'requests';
    const slot = h('div');
    mount(root, h('div', { class: 'stack' },
      h('div', { class: 'page-head' },
        h('div', null, h('h1', { class: 'page-title' }, 'Logs'), h('div', { class: 'page-desc' }, 'Individual stream requests and the server console')),
        segmented({
          options: [{ value: 'requests', label: 'Requests' }, { value: 'console', label: 'Server console' }],
          value: viewName, label: 'Log',
          onChange: v => ctx.navigate('logs', v === 'console' ? { view: 'console' } : {}),
        })),
      slot));
    const instance = viewName === 'console' ? consoleView(slot, ctx) : requestsView(slot, ctx);
    return { destroy: () => instance.destroy?.() };
  },
};

