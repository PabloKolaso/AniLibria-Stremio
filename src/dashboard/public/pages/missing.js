/**
 * Missing titles — "What content cannot currently be resolved, and why?"
 * Categorized by cause, with ignore / not-dubbed / dismiss actions (with
 * undo), links to test each title, and the overrides export/import.
 */

import { h, mount } from '../lib/dom.js';
import { api, downloadUrl } from '../lib/api.js';
import { num, date } from '../lib/format.js';
import { MISSING_CATEGORY, LIKELY_CAUSE } from '../lib/labels.js';
import {
  card, segmented, table, pill, relTime, ext, imdbLink, malLink, anilistLink, loading, errorState,
  actionButton, toast, pager,
} from '../lib/ui.js';

const CATEGORIES = ['not_on_anilibria', 'mapping_gap', 'episode_missing', 'not_dubbed', 'now_available', 'ignored'];
const PAGE_SIZE = 50;

/** Resolve-tester input for a row (its most requested episode). */
function testInput(row) {
  if (row.imdbId) {
    const top = row.requested?.[0]?.label;
    const m = /^S(\d+)E(\d+)$/.exec(top || '');
    if (m) return { input: `${row.imdbId}:${m[1]}:${m[2]}` };
    if (top === 'movie' || row.type === 'movie') return { input: row.imdbId, type: 'movie' };
    return { input: row.imdbId };
  }
  if (row.releaseId) {
    const e = /^E([\d.]+)$/.exec(row.requested?.[0]?.label || '');
    return { input: `anilibria:${row.releaseId}${e ? `:${e[1]}` : ''}` };
  }
  return null;
}

function titleCell(row) {
  return h('div', null,
    h('div', { class: 'cell-title' }, row.title || h('span', { class: 'subtle' }, row.imdbId ? 'Title unknown' : `AniLibria #${row.releaseId}`)),
    h('div', { class: 'cell-sub row tight' },
      row.imdbId ? imdbLink(row.imdbId) : row.releaseUrl ? ext(row.releaseUrl, `AniLibria #${row.releaseId}`) : null,
      row.type && h('span', null, row.type),
      row.season !== null && row.season !== undefined && h('span', null, `season ${row.season}`)));
}

function mappingCell(row) {
  if (!row.mapping || row.mapping.length === 0) return h('span', { class: 'subtle' }, row.category === 'mapping_gap' ? 'not in mapping' : '—');
  return h('div', { class: 'stack', style: { gap: '2px' } }, row.mapping.slice(0, 4).map(m => h('div', { class: 'cell-sub row tight' },
    malLink(m.mal), anilistLink(m.anilist),
    h('span', null, [m.type, m.tvdbSeason !== null ? `TVDB S${m.tvdbSeason}` : 'no season', m.tvdbOffset ? `+${m.tvdbOffset}` : null].filter(Boolean).join(' · ')))),
  row.mapping.length > 4 && h('div', { class: 'cell-sub' }, `+${row.mapping.length - 4} more`));
}

function requestedCell(row) {
  const list = row.requested || [];
  if (list.length === 0) return '—';
  const shown = list.slice(0, 6).map(q => {
    // Show the looked-up episode only when it differs (absolute numbering, cour offsets)
    const requestedEp = Number(/(\d+(?:\.\d+)?)$/.exec(q.label)?.[1]);
    const text = q.target !== null && q.target !== undefined && q.target !== requestedEp ? `${q.label} → ep ${q.target}` : q.label;
    return h('span', { class: 'chip', title: `${q.count} request(s)` }, text, q.count > 1 && h('span', { class: 'subtle' }, `×${q.count}`));
  });
  return h('div', { class: 'row tight' }, shown, list.length > 6 && h('span', { class: 'subtle small' }, `+${list.length - 6}`));
}

function seenCell(row) {
  if (!row.lastSeen) return '—';
  return h('div', { class: 'nowrap' }, relTime(row.lastSeen), h('div', { class: 'cell-sub' }, 'first ', date(row.firstSeen)));
}

function usageCell(row) {
  return h('div', { class: 'nowrap' }, `${num(row.users)}${row.usersOverflow ? '+' : ''} users`, h('div', { class: 'cell-sub' }, `${num(row.count)} requests`));
}

export default {
  mount(root, ctx) {
    const state = {
      category: CATEGORIES.includes(ctx.params.get('category')) ? ctx.params.get('category') : 'not_on_anilibria',
      page: Math.max(1, Number(ctx.params.get('page')) || 1),
      q: ctx.params.get('q') || '',
      data: null,
      editing: null, // key of the row with an open ignore form
      importPreview: null,
    };

    const tabs = h('div');
    const help = h('p', { class: 'help' });
    const listEl = h('div', null, loading());
    const importEl = h('div');
    const search = h('input', {
      class: 'input', type: 'search', placeholder: 'Search title, IMDB or release ID', value: state.q, 'aria-label': 'Search',
    });
    let searchTimer = null;
    search.addEventListener('input', () => {
      clearTimeout(searchTimer);
      searchTimer = setTimeout(() => {
        state.q = search.value.trim();
        state.page = 1;
        ctx.setParams({ q: state.q || null, page: null });
        ctx.refresh();
      }, 300);
    });

    const fileInput = h('input', { type: 'file', accept: '.json,application/json', hidden: true });
    fileInput.addEventListener('change', async () => {
      const file = fileInput.files[0];
      fileInput.value = '';
      if (!file) return;
      let payload;
      try {
        payload = JSON.parse(await file.text());
      } catch {
        return toast('That file is not valid JSON.', { type: 'error' });
      }
      try {
        const res = await api.post('/overrides/import', payload, { dryRun: 1 });
        state.importPreview = { payload, result: res.result, name: file.name };
        drawImport();
      } catch (err) {
        toast(err.message, { type: 'error' });
      }
    });

    function drawImport() {
      const p = state.importPreview;
      if (!p) return mount(importEl);
      const r = p.result;
      mount(importEl, h('div', { class: 'notice-inner', style: { background: 'var(--info-bg)', borderColor: 'rgba(114,168,255,.35)' } },
        h('div', { class: 'grow' },
          h('strong', null, `Import ${p.name}? `),
          `${num(r.ignored)} ignored, ${num(r.notDubbed)} not-dubbed and ${num(r.matchDecisions)} match decisions — `,
          `${num(r.added)} new, ${num(r.replaced)} replace existing entries, ${num(r.unchanged)} unchanged. Existing entries not in the file are kept.`),
        actionButton({
          label: 'Import', variant: 'primary', small: true,
          run: async () => {
            const res = await api.post('/overrides/import', p.payload);
            state.importPreview = null;
            drawImport();
            toast(`Imported: ${num(res.result.added)} new, ${num(res.result.replaced)} updated.`, { type: 'success' });
            ctx.refresh();
          },
        }),
        h('button', { class: 'btn btn-sm btn-ghost', type: 'button', onClick: () => { state.importPreview = null; drawImport(); } }, 'Cancel')));
    }

    const act = async (fn, message, undo) => {
      await fn();
      toast(message, { type: 'success', action: undo && { label: 'Undo', run: async () => { await undo(); ctx.refresh(); } } });
      ctx.refresh();
    };

    const ignoreForm = row => {
      const input = h('input', { class: 'input', type: 'text', placeholder: 'Reason (optional)', maxlength: 500, 'aria-label': 'Ignore reason' });
      const cancel = () => { state.editing = null; draw(); };
      input.addEventListener('keydown', ev => { if (ev.key === 'Escape') cancel(); if (ev.key === 'Enter') confirmBtn.click(); });
      const confirmBtn = actionButton({
        label: 'Ignore', variant: 'primary',
        run: async () => {
          state.editing = null;
          const id = encodeURIComponent(row.imdbId);
          await act(() => api.post(`/missing/${id}/ignore`, { reason: input.value }), `Ignored ${row.title || row.imdbId}`, () => api.del(`/missing/${id}/ignore`));
        },
      });
      setTimeout(() => input.focus(), 0);
      return h('div', { class: 'row tight' }, input, confirmBtn, h('button', { class: 'btn btn-sm btn-ghost', type: 'button', onClick: cancel }, 'Cancel'));
    };

    const testBtn = row => {
      const t = testInput(row);
      return t && h('button', {
        class: 'btn btn-sm', type: 'button', title: 'Run the resolver for this title now',
        onClick: () => ctx.navigate('admin', { view: 'resolve', input: t.input, type: t.type }),
      }, 'Test now');
    };

    function actions(row) {
      if (state.editing === row.key) return ignoreForm(row);
      const id = row.imdbId && encodeURIComponent(row.imdbId);
      const btns = [testBtn(row)];
      const searchLink = row.searchUrl && ext(row.searchUrl, 'Search AniLibria');
      switch (row.status) {
        case 'not_on_anilibria':
        case 'mapping_gap':
          btns.push(
            actionButton({
              label: 'Not dubbed yet', title: 'Move to "Not dubbed yet"; cleared automatically when it resolves',
              run: () => act(() => api.post(`/missing/${id}/not-dubbed`), 'Marked as not dubbed yet', () => api.del(`/missing/${id}/not-dubbed`)),
            }),
            h('button', { class: 'btn btn-sm btn-ghost', type: 'button', onClick: () => { state.editing = row.key; draw(); } }, 'Ignore…'));
          break;
        case 'episode_missing':
          btns.push(actionButton({
            label: 'Dismiss', variant: 'ghost', title: 'Remove this entry (it returns if requested again)',
            run: () => act(() => api.post('/missing/dismiss', { key: row.key }), 'Dismissed'),
          }));
          break;
        case 'not_dubbed':
          btns.push(actionButton({
            label: 'Un-mark', run: () => act(() => api.del(`/missing/${id}/not-dubbed`), 'Not-dubbed mark removed', () => api.post(`/missing/${id}/not-dubbed`)),
          }));
          break;
        case 'now_available':
          btns.push(actionButton({
            label: 'Dismiss', variant: 'ghost', title: 'Remove from the list',
            run: () => act(() => api.post('/missing/dismiss', { key: row.key }), 'Dismissed'),
          }));
          break;
        case 'ignored':
          btns.push(actionButton({
            label: 'Un-ignore',
            run: () => act(() => api.del(`/missing/${id}/ignore`), 'No longer ignored', () => api.post(`/missing/${id}/ignore`, { reason: row.ignored?.reason || '' })),
          }));
          break;
        default:
      }
      return h('div', { class: 'row tight' }, btns, searchLink);
    }

    function columnsFor(category) {
      const title = { label: 'Title', render: titleCell };
      const usage = { label: 'Usage', render: usageCell };
      const seen = { label: 'Last seen', render: seenCell };
      const act = { label: '', className: 'actions', render: actions };
      switch (category) {
        case 'episode_missing':
          return [
            title,
            { label: 'Requested', render: requestedCell },
            {
              label: 'AniLibria release', render: r => h('div', null,
                r.releaseUrl ? ext(r.releaseUrl, `#${r.releaseId}`) : r.releaseId ? `#${r.releaseId}` : '—',
                h('div', { class: 'cell-sub' }, r.latestEpisode !== null ? `latest ep ${r.latestEpisode}` : 'no episodes', r.live ? ' · still dubbing' : '', r.numbering ? ` · ${r.numbering} numbering` : '')),
            },
            { label: 'Likely cause', render: r => { const c = LIKELY_CAUSE[r.likelyCause]; return c ? pill(c.label, c.tone, c.help) : '—'; } },
            { label: 'Mapping', render: mappingCell },
            usage, seen, act,
          ];
        case 'mapping_gap':
          return [title, { label: 'Requested', render: requestedCell }, usage, seen, act];
        case 'not_dubbed':
          return [title, { label: 'Marked', render: r => (r.notDubbed ? relTime(r.notDubbed.markedAt) : '—') }, { label: 'Mapping', render: mappingCell }, usage, seen, act];
        case 'now_available':
          return [
            title,
            {
              label: 'Available', render: r => h('div', null,
                r.available.confirmed ? pill('Confirmed', 'ok', 'A request succeeded') : pill('Unconfirmed', 'warn', 'Detected offline — use Test now to confirm'),
                h('div', { class: 'cell-sub' }, {
                  request: 'request succeeded', index: 'found in the AniLibria index', mapping: 'now in the ID mapping', release_update: 'release has the episodes now',
                }[r.available.via] || r.available.via, ' · ', relTime(r.available.since))),
            },
            { label: 'Release', render: r => (r.available.releaseId ? (r.releaseUrl ? ext(r.releaseUrl, `#${r.available.releaseId}`) : `#${r.available.releaseId}`) : '—') },
            { label: 'Was', render: r => MISSING_CATEGORY[r.category]?.label || r.category },
            usage, act,
          ];
        case 'ignored':
          return [title, { label: 'Reason', render: r => r.ignored?.reason || h('span', { class: 'subtle' }, '—') }, { label: 'Ignored', render: r => (r.ignored ? relTime(r.ignored.ignoredAt) : '—') }, usage, act];
        default:
          return [title, { label: 'Requested', render: requestedCell }, { label: 'Mapping', render: mappingCell }, usage, seen, act];
      }
    }

    function draw() {
      const d = state.data;
      if (!d) return;
      mount(tabs, segmented({
        options: CATEGORIES.map(c => ({ value: c, label: MISSING_CATEGORY[c].label, count: d.counts[c] })),
        value: state.category, label: 'Category',
        onChange: v => {
          state.category = v;
          state.page = 1;
          state.editing = null;
          ctx.setParams({ category: v === 'not_on_anilibria' ? null : v, page: null });
          ctx.refresh();
          draw();
        },
      }));
      help.textContent = MISSING_CATEGORY[state.category].help;
      if (d.category !== state.category) return mount(listEl, loading());
      const e = d.enrichment;
      mount(listEl, card({
        title: `${MISSING_CATEGORY[state.category].label} · ${num(d.total)}`,
        sub: state.category === 'mapping_gap' && e
          ? `Non-anime IDs are checked on Cinemeta one at a time (${num(e.queued)} queued, ${num(e.checked)} recently checked); only titles Cinemeta lists as Anime appear here.`
          : state.q ? `Filtered by "${state.q}"` : null,
        body: h('div', { class: 'card-body flush' },
          table({
            rows: d.rows,
            columns: columnsFor(state.category),
            empty: state.q ? 'No matches for this search.' : `Nothing in "${MISSING_CATEGORY[state.category].label}".`,
          }),
          d.totalPages > 1 && pager({
            page: d.page, totalPages: d.totalPages, total: d.total, pageSize: d.pageSize,
            onPage: p => { state.page = p; ctx.setParams({ page: p > 1 ? p : null }); ctx.refresh(); },
          })),
      }));
    }

    mount(root, h('div', { class: 'stack' },
      h('div', { class: 'page-head' },
        h('div', null, h('h1', { class: 'page-title' }, 'Missing titles'),
          h('div', { class: 'page-desc' }, 'Anime users asked for that could not be played, grouped by cause. Non-anime titles are never listed.')),
        h('div', { class: 'row' },
          h('a', { class: 'btn btn-sm', href: downloadUrl('/overrides/export'), download: 'overrides.json' }, 'Export overrides'),
          h('button', { class: 'btn btn-sm', type: 'button', onClick: () => fileInput.click() }, 'Import overrides…'),
          fileInput)),
      importEl,
      tabs,
      h('div', { class: 'toolbar' }, h('label', { class: 'field grow' }, h('span', null, 'Search'), search)),
      help,
      listEl,
      h('p', { class: 'help' }, 'Overrides (ignored, not dubbed, match decisions) are stored in data/overrides.json. On hosts that wipe the disk on deploy, export them and commit the file as overrides.json in the project root — it is merged at startup.')));

    ctx.setTask({
      interval: 30_000,
      load: async () => {
        if (state.editing) return; // do not re-render under an open form
        try {
          const data = await api.get('/missing', { category: state.category, page: state.page, q: state.q, pageSize: PAGE_SIZE });
          if (data.category !== state.category) return;
          state.data = data;
          state.page = data.page;
          draw();
        } catch (err) {
          if (!state.data) mount(listEl, errorState(err, () => ctx.refresh()));
          throw err;
        }
      },
    });
    return { destroy: () => clearTimeout(searchTimer) };
  },
};

