/**
 * Traffic — "How is the addon being used and performing?"
 * Outcomes, latency, users, resource mix, installed versions and resolver methods per range,
 * each compared with the previous period of the same length.
 */

import { h, mount } from '../lib/dom.js';
import { api } from '../lib/api.js';
import { num, pct, ms, delta, hour, dayHour, date, utc } from '../lib/format.js';
import { CATEGORY, METHOD, RESOURCE, reasonLabel } from '../lib/labels.js';
import { card, body, segmented, loading, errorState, breakdown, table } from '../lib/ui.js';
import { renderChart, barDataset, lineDataset, chartsAvailable } from '../lib/charts.js';

const RANGES = [
  { value: '24h', label: '24 hours' },
  { value: '7d', label: '7 days' },
  { value: '30d', label: '30 days' },
  { value: '90d', label: '90 days' },
];

const OUTCOME_SERIES = [
  { key: 'found', ...CATEGORY.found },
  { key: 'not_on_anilibria', ...CATEGORY.not_on_anilibria },
  { key: 'episode_missing', ...CATEGORY.episode_missing },
  { key: 'blocked_unsupported', label: 'Blocked / unsupported', color: '#8a8aa3' },
  { key: 'error', ...CATEGORY.error },
  { key: 'unclassified', ...CATEGORY.unclassified },
];

const RESOURCE_COLORS = { stream: '#72a8ff', catalog: '#3ecf8e', meta: '#a08cff', manifest: '#f2b33d' };
const ERROR_REASONS = new Set(['timeout', 'lookup_failed', 'release_fetch_failed', 'mapping_unavailable', 'plan_failed', 'unexpected']);

function labelFor(t, stepHours) {
  if (stepHours === 1) return hour(t);
  if (stepHours < 24) return dayHour(t);
  return date(t);
}

function summaryItem(label, cur, prev, format, opts, hint) {
  const d = prev === null || prev === undefined ? null : delta(cur, prev, opts);
  return h('div', { class: 'card kpi', title: hint },
    h('div', { class: 'kpi-label' }, label),
    h('div', { class: 'row tight' }, h('div', { class: 'kpi-value' }, format(cur)), d && h('span', { class: ['delta', d.tone] }, d.text)),
    h('div', { class: 'kpi-sub' }, prev === null || prev === undefined ? 'no previous period' : `previous: ${format(prev)}`));
}

function summary(data) {
  const c = data.series.current;
  const p = data.series.previous;
  const u = data.users;
  return h('div', { class: 'grid grid-kpi-6' },
    summaryItem('Anime requests', c.requests, p?.requests, num, {}, 'Anime stream requests in the period'),
    summaryItem('Coverage', c.coverage, p?.coverage, pct, { ratio: true }, 'Found ÷ (anime requests − errors)'),
    summaryItem('Error rate', c.errorRate, p?.errorRate, pct, { ratio: true, higherIsBetter: false }, 'Errors ÷ classified anime requests'),
    summaryItem('Latency p95', c.p95, p?.p95, ms, { higherIsBetter: false }, 'Estimated from the latency histogram of anime stream requests'),
    summaryItem('Users', u.current, u.previous, num, {}, `Distinct hashed IPs with anime usage, ${u.window}`),
    summaryItem('Non-anime pass-through', c.passThrough, p?.passThrough, num, { higherIsBetter: true }, 'Stream requests for IMDB IDs outside the anime mapping (answered with no streams)'));
}

function methodItems(methods) {
  return Object.entries(methods || {})
    .sort((a, b) => b[1] - a[1])
    .map(([m, count]) => ({
      label: METHOD[m]?.label || m,
      value: count,
      color: METHOD[m]?.confidence === 'low' ? '#f2b33d' : '#3ecf8e',
      hint: METHOD[m]?.help,
    }));
}

function methodsCard(series) {
  const cur = series.current.methods || {};
  const total = Object.values(cur).reduce((a, b) => a + b, 0);
  const low = (cur.fuse || 0) + (cur.search || 0);
  const prevMethods = series.previous?.methods || {};
  const prevTotal = Object.values(prevMethods).reduce((a, b) => a + b, 0);
  const prevLow = (prevMethods.fuse || 0) + (prevMethods.search || 0);
  const lowShare = total > 0 ? low / total : null;
  return card({
    title: 'Resolver match methods',
    sub: 'How found requests were matched to an AniLibria release',
    body: body(
      breakdown(methodItems(cur)),
      total > 0 && h('p', { class: 'help' },
        h('span', { class: ['pill', lowShare > 0.05 ? 'warn' : 'ok'] }, `${pct(lowShare)} low-confidence`),
        ` title-based matches (search/fuzzy)${prevTotal > 0 ? `; previous period ${pct(prevLow / prevTotal)}` : ''}. `,
        low > 0 && h('a', { href: '/dashboard?tab=content&view=matches', 'data-nav': 'content:matches' }, 'Review them'))),
  });
}

function reasonsCard(series) {
  const cur = series.current.reasons || {};
  const prev = series.previous?.reasons || {};
  const rows = Object.keys({ ...cur, ...prev })
    .map(reason => ({ reason, count: cur[reason] || 0, prev: prev[reason] ?? null }))
    .sort((a, b) => b.count - a.count);
  return card({
    title: 'Outcome reasons',
    sub: 'Every stream request, including non-anime pass-through',
    body: h('div', { class: 'card-body flush' }, table({
      rows,
      empty: 'No requests in this period',
      columns: [
        { label: 'Reason', render: r => h('div', null, h('div', null, reasonLabel(r.reason)), h('div', { class: 'cell-sub mono' }, r.reason)) },
        { label: 'Requests', className: 'num', render: r => num(r.count) },
        { label: 'Previous', className: 'num', render: r => (r.prev === null ? '—' : num(r.prev)) },
        {
          label: 'Change', className: 'num', render: r => {
            const d = delta(r.count, r.prev, { higherIsBetter: r.reason === 'found' });
            // Volume changes are neutral; only errors growing (or found shrinking) is bad news
            const tone = r.reason === 'found' || ERROR_REASONS.has(r.reason) ? d?.tone : 'flat';
            return d ? h('span', { class: ['delta', tone] }, d.text) : '—';
          },
        },
      ],
    })),
  });
}

function installsCard(installs) {
  const { rows, current, minSupported, legacy } = installs;
  const total = rows.reduce((a, r) => a + r.requests, 0);
  const outdated = rows.filter(r => r.outdated).reduce((a, r) => a + r.requests, 0);
  const label = v => (v === legacy ? 'Legacy / unknown' : v === 'other' ? 'Other' : `v${v}${v === current ? ' (current)' : ''}`);
  return card({
    title: 'Requests by installed version',
    sub: 'Stream, catalog and meta requests, by the manifest version the client is known to have',
    body: body(
      breakdown(rows.map(r => ({
        label: label(r.version),
        value: r.requests,
        color: r.outdated ? '#f2b33d' : r.version === 'other' ? '#8a8aa3' : '#3ecf8e',
        hint: r.outdated ? 'Sees the reinstall notice in Stremio' : undefined,
      }))),
      total > 0 && h('p', { class: 'help' },
        h('span', { class: ['pill', outdated > 0 ? 'warn' : 'ok'] }, `${pct(outdated / total)} outdated`),
        ` Clients below v${minSupported}, or not seen fetching the manifest or a catalog since they (re)installed, see the reinstall notice on anime titles.`)),
  });
}

function catalogsNote(series) {
  const cats = series.current.catalogs || {};
  const errors = series.current.resourceErrors || {};
  const errorTotal = Object.values(errors).reduce((a, b) => a + b, 0);
  return h('p', { class: 'help' },
    `Catalog requests: Releasing ${num(cats['anilibria-releasing'] || 0)} · Trending ${num(cats['anilibria-trending'] || 0)}. `,
    errorTotal > 0
      ? h('span', { class: 'bad-text' }, `Handler failures (HTTP 500): ${Object.entries(errors).map(([r, n]) => `${RESOURCE[r] || r} ${num(n)}`).join(', ')}.`)
      : 'No handler failures.');
}

export default {
  mount(root, ctx) {
    let range = RANGES.some(r => r.value === ctx.params.get('range')) ? ctx.params.get('range') : '24h';
    let showPass = ctx.params.get('pass') === '1';
    let lastData = null;

    const controls = h('div', { class: 'row' });
    const summaryEl = h('div');
    const outcomeBox = h('div', { class: 'chart-box tall' });
    const latencyBox = h('div', { class: 'chart-box' });
    const usersBox = h('div', { class: 'chart-box' });
    const resourceBox = h('div', { class: 'chart-box' });
    const outcomeLegend = h('div');
    const usersSub = h('span');
    const detailsEl = h('div', { class: 'stack' });
    const methodsSlot = h('div', { class: 'methods-slot' });
    const notesEl = h('div');

    const drawControls = () => mount(controls,
      segmented({
        options: RANGES, value: range, label: 'Range',
        onChange: v => {
          range = v;
          ctx.setParams({ range: v === '24h' ? null : v });
          drawControls();
          ctx.refresh();
        },
      }),
      h('label', { class: 'check' },
        h('input', {
          type: 'checkbox', checked: showPass,
          onChange: ev => {
            showPass = ev.target.checked;
            ctx.setParams({ pass: showPass ? '1' : null });
            if (lastData) draw(lastData);
          },
        }),
        'Show non-anime pass-through'));

    const view = h('div', { class: 'stack' },
      h('div', { class: 'page-head' },
        h('div', null, h('h1', { class: 'page-title' }, 'Traffic'), h('div', { class: 'page-desc' }, 'Usage and performance of anime stream lookups, compared with the previous period')),
        controls),
      summaryEl,
      card({ title: 'Requests by outcome', sub: 'Anime stream requests; "Not on AniLibria" is not an error', body: body(outcomeBox, outcomeLegend) }),
      h('div', { class: 'grid grid-charts' },
        card({ title: 'Latency', sub: 'Anime stream requests, estimated p50 / p95', body: body(latencyBox) }),
        card({ title: 'Unique users', sub: usersSub, body: body(usersBox) }),
        card({ title: 'Requests by resource', sub: 'Every addon protocol request', body: body(resourceBox, notesEl) }),
        methodsSlot),
      detailsEl);

    mount(root, view);
    drawControls();
    mount(summaryEl, loading());

    function draw(data) {
      lastData = data;
      const s = data.series;
      const labels = s.points.map(p => labelFor(p.t, s.stepHours));
      mount(summaryEl, summary(data));

      const outcomeData = key => s.points.map(p => (key === 'blocked_unsupported' ? p.outcomes.blocked + p.outcomes.unsupported : p.outcomes[key]));
      const datasets = OUTCOME_SERIES
        .filter(o => o.key !== 'unclassified' || s.points.some(p => p.outcomes.unclassified > 0))
        .map(o => barDataset(o.label, outcomeData(o.key), o.color));
      if (showPass) datasets.push(barDataset(CATEGORY.pass_through.label, s.points.map(p => p.passThrough), CATEGORY.pass_through.color));
      renderChart(outcomeBox, { type: 'bar', labels, datasets, stacked: true, legend: true, ariaLabel: 'Requests by outcome' });
      mount(outcomeLegend, h('p', { class: 'help' },
        `Found ${num(s.current.found)} · not on AniLibria ${num(s.current.notOnAnilibria)} · episode missing ${num(s.current.episodeMissing)} · blocked ${num(s.current.blocked)} · unsupported ${num(s.current.unsupported)} · errors ${num(s.current.errors)}`,
        s.current.unclassified > 0 ? ` · unclassified (before outcome tracking) ${num(s.current.unclassified)}` : '',
        !chartsAvailable() ? '' : '. Click a legend item to hide a series.'));

      renderChart(latencyBox, {
        type: 'line', labels, legend: true, yFormat: v => ms(v), tooltipFormat: v => ms(v), ariaLabel: 'Latency',
        datasets: [lineDataset('p50', s.points.map(p => p.p50), '#72a8ff'), lineDataset('p95', s.points.map(p => p.p95), '#f2b33d')],
      });

      const u = data.users;
      usersSub.textContent = `Distinct hashed IPs with anime usage, per ${u.granularity}${u.granularity === 'day' ? ' (UTC)' : ''}`;
      renderChart(usersBox, {
        type: 'bar', ariaLabel: 'Unique users',
        labels: u.points.map(p => (u.granularity === 'hour' ? hour(p.t) : date(p.t))),
        datasets: [barDataset('Users', u.points.map(p => p.users), '#a08cff')],
      });

      renderChart(resourceBox, {
        type: 'bar', labels, stacked: true, legend: true, ariaLabel: 'Requests by resource',
        datasets: Object.keys(RESOURCE_COLORS).map(r => barDataset(RESOURCE[r], s.points.map(p => p.resources[r]), RESOURCE_COLORS[r])),
      });
      mount(notesEl, catalogsNote(s));

      mount(methodsSlot, methodsCard(s));
      mount(detailsEl, installsCard(data.installs), reasonsCard(s),
        h('p', { class: 'help', title: utc(data.since.createdAt) },
          `Ranges are aligned to UTC (${s.stepHours === 1 ? 'hours' : s.stepHours === 6 ? '6-hour blocks' : 'days'}); the last point is the current, partial one. Data is kept for ${data.since.retentionDays} days.`,
          s.previous ? '' : ' No data exists for the previous period yet.'));
    }

    view.addEventListener('click', ev => {
      const a = ev.target.closest('a[data-nav]');
      if (!a || ev.ctrlKey || ev.metaKey) return;
      ev.preventDefault();
      ctx.navigate('content', { view: 'matches' });
    });

    ctx.setTask({
      interval: 60_000,
      load: async () => {
        try {
          const data = await api.get('/traffic', { range });
          if (data.range === range) draw(data);
        } catch (err) {
          if (!lastData) mount(summaryEl, errorState(err, () => ctx.refresh()));
          throw err;
        }
      },
    });
    return {};
  },
};

