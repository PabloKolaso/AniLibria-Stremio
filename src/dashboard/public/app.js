/**
 * Dashboard app shell: navigation between pages, the header's live status
 * (version, uptime, connection state), notices and the shared ticker.
 *
 * Pages live in pages/*.js and export mount(root, ctx) → { destroy? }.
 * The URL (?tab=…&…) is the source of truth, so every view can be
 * bookmarked and the browser's back button works.
 */

import { h, mount } from './lib/dom.js';
import { ago, duration } from './lib/format.js';
import { liveState, onLive, setTask, refreshNow, setPaused } from './lib/live.js';
import { tickRelativeTimes, closeDrawer, toast } from './lib/ui.js';
import { api } from './lib/api.js';

import overview from './pages/overview.js';
import traffic from './pages/traffic.js';
import content from './pages/content.js';
import missing from './pages/missing.js';
import logs from './pages/logs.js';
import admin from './pages/admin.js';

const PAGES = { overview, traffic, content, missing, logs, admin };

/** Tabs of the previous dashboard version (bookmarks keep working). */
const LEGACY_TABS = {
  analytics: { tab: 'traffic' },
  failed: { tab: 'missing' },
  terminal: { tab: 'logs', view: 'console' },
};

const main = document.getElementById('main');
let current = null; // { id, instance }

// ─── Routing ─────────────────────────────────────────────────────────────────

function currentParams() {
  const params = new URLSearchParams(location.search);
  const legacy = LEGACY_TABS[params.get('tab')];
  if (legacy) {
    params.set('tab', legacy.tab);
    if (legacy.view) params.set('view', legacy.view);
    history.replaceState(null, '', `/dashboard?${params}`);
  }
  if (!PAGES[params.get('tab')]) params.set('tab', 'overview');
  return params;
}

/**
 * Update the URL parameters of the current page.
 * @param {Record<string, string|number|null|undefined>} patch - null/'' removes a parameter
 * @param {{ push?: boolean }} [opts]
 */
function setParams(patch, { push = false } = {}) {
  const params = new URLSearchParams(location.search);
  for (const [k, v] of Object.entries(patch)) {
    if (v === null || v === undefined || v === '') params.delete(k);
    else params.set(k, String(v));
  }
  const url = `/dashboard?${params}`;
  if (push) history.pushState(null, '', url);
  else history.replaceState(null, '', url);
}

function markNav(tab) {
  for (const a of document.querySelectorAll('.nav-tab')) {
    if (a.dataset.tab === tab) {
      a.setAttribute('aria-current', 'page');
      a.scrollIntoView({ block: 'nearest', inline: 'nearest' });
    } else {
      a.removeAttribute('aria-current');
    }
  }
}

function render() {
  const params = currentParams();
  const tab = params.get('tab');
  closeDrawer();
  if (current?.instance?.destroy) current.instance.destroy();
  setTask(null);
  markNav(tab);
  const label = document.querySelector(`.nav-tab[data-tab="${tab}"]`)?.textContent || tab;
  document.title = `${label} · AniLibria Dashboard`;
  mount(main);
  const ctx = {
    params,
    setParams,
    navigate,
    setTask,
    refresh: refreshNow,
    setPaused,
  };
  current = { id: tab, instance: PAGES[tab].mount(main, ctx) || {} };
}

/** Navigate to another page (or the same page with other parameters). */
function navigate(tab, extra = {}) {
  const params = new URLSearchParams({ tab });
  for (const [k, v] of Object.entries(extra)) if (v !== null && v !== undefined && v !== '') params.set(k, String(v));
  history.pushState(null, '', `/dashboard?${params}`);
  render();
  main.focus({ preventScroll: true });
  window.scrollTo(0, 0);
}

document.addEventListener('click', ev => {
  const link = ev.target.closest('a[data-tab]');
  if (!link || ev.ctrlKey || ev.metaKey || ev.shiftKey || ev.button !== 0) return;
  ev.preventDefault();
  navigate(link.dataset.tab);
});

window.addEventListener('popstate', render);

// ─── Header: version, uptime, live state ─────────────────────────────────────

const liveChip = document.getElementById('hdr-live');
const liveText = liveChip.querySelector('.live-text');
const uptimeChip = document.getElementById('hdr-uptime');
const versionChip = document.getElementById('hdr-version');
const bannerSlot = document.getElementById('banner-slot');
let restartToastFor = null;

function liveLabel(s, now) {
  const updated = s.lastOkAt ? `updated ${ago(s.lastOkAt, now)}` : 'no data yet';
  if (s.status === 'expired') return ['expired', 'Session expired'];
  if (s.status === 'lost') {
    const retry = s.retryAt ? Math.max(0, Math.ceil((s.retryAt - now) / 1000)) : null;
    return ['lost', `Connection lost${retry !== null ? ` · retry in ${retry}s` : ''}`];
  }
  if (s.status === 'connecting') return ['connecting', 'Connecting…'];
  if (s.restartedAt && now - s.restartedAt < 120_000) return ['restarted', `Server restarted ${ago(s.restartedAt, now)}`];
  if (s.paused) return ['paused', `Paused · ${updated}`];
  if (s.lastOkAt && now - s.lastOkAt > s.interval * 2.5 + 5000) return ['stale', `Stale · ${updated}`];
  return ['live', `Live · ${updated}`];
}

function renderNotice(s) {
  if (s.status === 'expired') {
    const next = encodeURIComponent(location.pathname + location.search);
    mount(bannerSlot, h('div', { class: 'notice notice-down', role: 'alert' },
      h('div', { class: 'notice-inner' },
        h('span', { class: 'grow' }, 'Your dashboard session expired (or the server was restarted with a new password). The data shown is no longer updating.'),
        h('a', { class: 'btn btn-primary btn-sm', href: `/dashboard/login?next=${next}` }, 'Sign in again'))));
  } else if (s.status === 'lost' && s.failures >= 2) {
    mount(bannerSlot, h('div', { class: 'notice notice-warn', role: 'status' },
      h('div', { class: 'notice-inner' },
        h('span', { class: 'grow' }, `Cannot reach the server (${s.error || 'network error'}). Showing data from ${s.lastOkAt ? ago(s.lastOkAt) : 'before'} — retrying automatically.`),
        h('button', { class: 'btn btn-sm', type: 'button', onClick: () => refreshNow() }, 'Retry now'))));
  } else if (bannerSlot.firstChild) {
    bannerSlot.replaceChildren();
  }
}

function tick() {
  const now = Date.now();
  const s = liveState();
  const [state, text] = liveLabel(s, now);
  liveChip.dataset.state = state;
  liveText.textContent = text;
  if (s.meta) {
    uptimeChip.textContent = `up ${duration(now - s.meta.startedAt)}`;
    uptimeChip.title = `Server started ${new Date(s.meta.startedAt).toLocaleString()}`;
    versionChip.textContent = `v${s.meta.version}`;
  }
  tickRelativeTimes(now);
}

onLive(s => {
  tick();
  renderNotice(s);
  if (s.restartedAt && s.restartedAt !== restartToastFor) {
    restartToastFor = s.restartedAt;
    toast('The server restarted — uptime and in-memory counters were reset.', { type: 'warning' });
  }
});

setInterval(tick, 1000);

// Keep the session check alive on pages that do not poll (and detect expiry quickly)
setInterval(() => {
  if (!document.hidden && liveState().status !== 'expired' && liveState().paused) api.get('/status').catch(() => {});
}, 60_000);

render();
