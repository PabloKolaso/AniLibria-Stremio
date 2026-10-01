/**
 * Overview — "Is everything working?"
 * Health banner, component health, 24 h KPIs, recent problems, top anime.
 */

import { h, mount } from '../lib/dom.js';
import { api } from '../lib/api.js';
import { num, pct, ms, delta, utc, date } from '../lib/format.js';
import { STATUS_LABEL } from '../lib/labels.js';
import {
  card, body, statusDot, relTime, segmented, empty, errorState, loading, poster, ext, actionButton,
} from '../lib/ui.js';

const GROUPS = [
  { id: 'providers', title: 'Upstream providers' },
  { id: 'data', title: 'Data & catalogs' },
  { id: 'service', title: 'Service' },
];

function banner(health) {
  return h('div', { class: ['banner', health.status], role: 'status' },
    h('span', { class: 'banner-icon', 'aria-hidden': 'true' }),
    h('div', { class: 'banner-text' }, health.banner),
    h('span', { class: 'banner-meta' }, 'checked ', relTime(health.at)));
}

function tile(c) {
  return h('div', { class: ['tile', c.status], title: c.summary },
    h('div', { class: 'tile-head' },
      statusDot(c.status),
      h('span', { class: 'tile-name' }, c.name),
      h('span', { class: 'tile-status' }, STATUS_LABEL[c.status])),
    h('div', { class: 'tile-summary' }, c.summary));
}

function healthStrip(health) {
  return h('div', { class: 'stack' }, GROUPS.map(g => {
    const items = health.components.filter(c => c.group === g.id);
    if (items.length === 0) return null;
    return h('div', { class: 'stack' },
      h('div', { class: 'tile-group-title' }, g.title),
      h('div', { class: 'grid grid-tiles' }, items.map(tile)));
  }));
}

function deltaEl(cur, prev, opts) {
  const d = delta(cur, prev, opts);
  return d ? h('span', { class: ['delta', d.tone], title: 'Compared with the previous 24 hours' }, d.text) : null;
}

function kpi({ label, value, unit, deltaNode, sub, hint }) {
  return h('div', { class: 'card kpi', title: hint },
    h('div', { class: 'kpi-label' }, label),
    h('div', { class: 'row tight' }, h('div', { class: 'kpi-value' }, value, unit && h('span', { class: 'unit' }, unit)), deltaNode),
    h('div', { class: 'kpi-sub' }, sub));
}

function kpis(data) {
  const { current: c, previous: p, users: u } = data.kpis;
  return h('div', { class: 'grid grid-kpi' },
    kpi({
      label: 'Anime requests · 24h',
      value: num(c.requests),
      deltaNode: deltaEl(c.requests, p.requests),
      sub: [h('strong', null, num(c.found)), ' found · ', num(c.passThrough), ' non-anime passed through'],
      hint: 'Stream requests for anime (IMDB IDs in the anime mapping, or this addon’s catalog items) in the current hour and the 23 before. Non-anime requests are counted separately.',
    }),
    kpi({
      label: 'Users · 24h',
      value: num(u.day),
      deltaNode: deltaEl(u.day, u.dayPrev),
      sub: [h('strong', null, num(u.now)), ' active now (15 min) · ', h('strong', null, num(u.month)), ' in 30 days'],
      hint: 'Distinct hashed IP addresses with anime usage (anime stream, catalog or meta requests). An estimate: shared IPs count once, changing IPs count several times.',
    }),
    kpi({
      label: 'Error rate · 24h',
      value: pct(c.errorRate),
      deltaNode: deltaEl(c.errorRate, p.errorRate, { higherIsBetter: false, ratio: true }),
      sub: `${num(c.errors)} errors in ${num(c.classified)} anime requests`,
      hint: 'Anime requests the addon could not answer (timeouts, upstream failures, bugs) ÷ anime requests. "Not on AniLibria" is not an error.',
    }),
    kpi({
      label: 'Coverage · 24h',
      value: pct(c.coverage),
      deltaNode: deltaEl(c.coverage, p.coverage, { ratio: true }),
      sub: `${num(c.found)} found · ${num(c.notOnAnilibria)} not on AniLibria · ${num(c.episodeMissing)} episode missing`,
      hint: 'Found ÷ (anime requests − errors): the share of answerable anime requests that got streams.',
    }),
    kpi({
      label: 'Latency p95 · 24h',
      value: ms(c.p95),
      deltaNode: deltaEl(c.p95, p.p95, { higherIsBetter: false }),
      sub: `p50 ${ms(c.p50)} · anime stream requests (estimated)`,
      hint: 'Response time of anime stream requests, estimated from a latency histogram (accurate to about one bucket).',
    }));
}

function problemsCard(data, reload) {
  const list = data.problems;
  const content = list.length === 0
    ? empty('No problems in the last 24 hours.')
    : h('ul', { class: 'list' }, list.map(p => h('li', null,
      statusDot(p.level === 'warning' ? 'warning' : 'down'),
      h('div', { class: 'grow problem' },
        h('div', { class: 'problem-title' },
          p.title,
          h('span', { class: 'count-badge', title: 'Occurrences' }, `×${num(p.count)}`),
          p.active && h('span', { class: 'pill warn' }, 'active')),
        h('div', { class: 'problem-msg' }, p.message),
        h('div', { class: 'cell-sub' }, 'last ', relTime(p.lastAt), p.count > 1 ? [' · first ', relTime(p.firstAt)] : null, ` · ${p.source}`)),
      actionButton({
        label: 'Dismiss', variant: 'ghost', title: 'Hide this problem until it happens again',
        run: async () => {
          await api.post('/problems/dismiss', { key: p.key });
          reload();
        },
      }))));
  return card({
    title: 'Recent problems',
    sub: 'Grouped; last 24 hours. Kept across restarts.',
    actions: [
      data.problemsOlder > 0 && h('span', { class: 'subtle small' }, `${num(data.problemsOlder)} older`),
      h('a', { class: 'btn btn-sm', href: '/dashboard?tab=logs&view=console&level=error', 'data-tab-link': 'logs' }, 'Console errors'),
    ],
    body: h('div', { class: 'card-body flush' }, content),
  });
}

function topCard(data, onDays) {
  const { days, rows } = data.top;
  const content = rows.length === 0
    ? empty(`No anime watched in the last ${days} days.`)
    : h('ul', { class: 'list' }, rows.map((r, i) => h('li', null,
      h('span', { class: 'rank' }, i + 1),
      poster(r.poster),
      h('div', { class: 'grow' },
        h('div', { class: 'cell-title' }, r.url ? ext(r.url, r.name || `Release ${r.releaseId}`) : (r.name || `Release ${r.releaseId}`)),
        h('div', { class: 'cell-sub' }, `${num(r.users)} ${r.users === 1 ? 'user' : 'users'} · ${num(r.requests)} stream requests · AniLibria #${r.releaseId}`)),
      h('span', { class: 'meta' }, relTime(r.lastAt)))));
  return card({
    title: 'Top anime',
    sub: 'By unique users; Cinemeta and catalog requests merged per AniLibria release',
    actions: segmented({ options: [{ value: '7', label: '7 days' }, { value: '30', label: '30 days' }], value: String(days), onChange: v => onDays(Number(v)), label: 'Period' }),
    body: h('div', { class: 'card-body flush' }, content),
  });
}

function sinceNote(since) {
  const parts = [`Request statistics since ${date(since.oldestBucket || since.createdAt)}`];
  if (since.detailedSince && since.oldestBucket && since.detailedSince > since.oldestBucket + 3_600_000) {
    parts.push(`outcome breakdown since ${date(since.detailedSince)} (older requests are unclassified)`);
  }
  parts.push(`kept for ${since.retentionDays} days`);
  return h('p', { class: 'help', title: utc(since.createdAt) }, `${parts.join(' · ')}.`);
}

export default {
  mount(root, ctx) {
    let topDays = Number(ctx.params.get('top')) === 30 ? 30 : 7;
    const view = h('div', { class: 'stack' }, loading());
    mount(root, view);

    let lastData = null;
    const draw = data => {
      lastData = data;
      mount(view,
        banner(data.health),
        kpis(data),
        card({ title: 'Component health', sub: 'Providers are judged on their recent calls; data on its age and completeness', body: body(healthStrip(data.health)) }),
        h('div', { class: 'grid grid-3-2' },
          problemsCard(data, () => ctx.refresh()),
          topCard(data, days => {
            topDays = days;
            ctx.setParams({ top: days === 30 ? 30 : null });
            ctx.refresh();
          })),
        sinceNote(data.since));
    };

    ctx.setTask({
      interval: 15_000,
      load: async () => {
        try {
          draw(await api.get('/overview', { top: topDays }));
        } catch (err) {
          // With data on screen the header reports the failure; only an empty page shows it here
          if (!lastData) mount(view, errorState(err, () => ctx.refresh()));
          throw err;
        }
      },
    });

    // "Console errors" link keeps the SPA navigation
    view.addEventListener('click', ev => {
      const a = ev.target.closest('a[data-tab-link]');
      if (!a || ev.ctrlKey || ev.metaKey) return;
      ev.preventDefault();
      ctx.navigate('logs', { view: 'console', level: 'error' });
    });
    return {};
  },
};
