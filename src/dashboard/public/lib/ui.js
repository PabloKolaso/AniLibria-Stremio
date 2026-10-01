/**
 * Shared UI components: cards, status, tables, segmented controls, toasts,
 * the details drawer, action buttons with busy/confirm states, sparklines.
 */

import { h, svg, mount } from './dom.js';
import { ago, utc, num } from './format.js';
import { STATUS_LABEL } from './labels.js';

// ─── Basic building blocks ───────────────────────────────────────────────────

export function card({ title, sub, actions, body, foot, className, id }) {
  return h('section', { class: ['card', className], id },
    (title || actions) && h('div', { class: 'card-head' },
      h('div', null, title && h('h2', { class: 'card-title' }, title), sub && h('div', { class: 'card-sub' }, sub)),
      actions && h('div', { class: 'card-actions' }, actions)),
    body,
    foot && h('div', { class: 'card-foot' }, foot));
}

export function body(...children) {
  return h('div', { class: 'card-body' }, ...children);
}

export function statusDot(status) {
  return h('span', { class: ['status-dot', status], title: STATUS_LABEL[status] || status, 'aria-hidden': 'true' });
}

export function statusPill(status, text) {
  return h('span', { class: ['pill', status] }, statusDot(status), text || STATUS_LABEL[status] || status);
}

export function pill(text, tone = 'neutral', title) {
  return h('span', { class: ['pill', tone], title }, text);
}

/** A relative time that the app's ticker keeps up to date. */
export function relTime(ts, { prefix = '', title } = {}) {
  return h('time', { 'data-ts': ts || '', 'data-prefix': prefix, title: title || (ts ? utc(ts) : ''), datetime: ts ? new Date(ts).toISOString() : undefined },
    ts ? `${prefix}${ago(ts)}` : 'never');
}

/** Refresh every relTime element in the document. */
export function tickRelativeTimes(now = Date.now()) {
  for (const el of document.querySelectorAll('time[data-ts]')) {
    const ts = Number(el.dataset.ts);
    if (ts) el.textContent = `${el.dataset.prefix || ''}${ago(ts, now)}`;
  }
}

export function kv(rows) {
  return h('dl', { class: 'kv' }, rows.filter(Boolean).flatMap(([k, v]) => [h('dt', null, k), h('dd', null, v ?? '—')]));
}

export function ext(href, text, title, className) {
  if (!href) return text;
  return h('a', { href, target: '_blank', rel: 'noopener noreferrer', title, class: className }, text);
}

/** An external link styled as a small button. */
export function extButton(href, text, title) {
  return ext(href, text, title, 'btn btn-sm btn-ghost');
}

export function imdbLink(imdbId) {
  return imdbId ? ext(`https://www.imdb.com/title/${encodeURIComponent(imdbId)}/`, imdbId) : '—';
}

export function malLink(mal) {
  return mal ? ext(`https://myanimelist.net/anime/${mal}`, `MAL ${mal}`) : null;
}

export function anilistLink(id) {
  return id ? ext(`https://anilist.co/anime/${id}`, `AniList ${id}`) : null;
}

export function poster(src, { large = false, alt = '' } = {}) {
  const placeholder = () => h('span', { class: ['poster', large && 'lg'], 'aria-hidden': 'true' });
  if (!src) return placeholder();
  const img = h('img', { class: ['poster', large && 'lg'], src, alt, loading: 'lazy', referrerpolicy: 'no-referrer' });
  img.addEventListener('error', () => img.replaceWith(placeholder()), { once: true });
  return img;
}

export function meter(ratio, status = 'ok') {
  const bar = h('span');
  bar.style.width = `${Math.max(0, Math.min(1, ratio || 0)) * 100}%`;
  return h('div', { class: ['meter', status], role: 'img', 'aria-label': `${Math.round((ratio || 0) * 100)}%` }, bar);
}

// ─── States ──────────────────────────────────────────────────────────────────

export function empty(text) {
  return h('div', { class: 'state' }, text);
}

export function loading(text = 'Loading…') {
  return h('div', { class: 'state state-loading' }, text);
}

export function errorState(err, retry) {
  return h('div', { class: 'state state-error' },
    h('div', null, err?.message || String(err)),
    retry && h('button', { class: 'btn btn-sm', type: 'button', onClick: retry }, 'Retry'));
}

// ─── Segmented control ───────────────────────────────────────────────────────

/**
 * @param {{ options: Array<{ value: string, label: string, count?: number }>,
 *           value: string, onChange: (v: string) => void, label?: string }} opts
 */
export function segmented({ options, value, onChange, label }) {
  return h('div', { class: 'seg', role: 'group', 'aria-label': label },
    options.map(o => h('button', {
      type: 'button',
      'aria-pressed': String(o.value === value),
      onClick: () => o.value !== value && onChange(o.value),
      title: o.title,
    }, o.label, o.count !== undefined && h('span', { class: 'count' }, num(o.count)))));
}

// ─── Tables ──────────────────────────────────────────────────────────────────

/**
 * Responsive table: every cell carries its column name, so on small
 * screens rows turn into labelled cards.
 * @param {{ columns: Array<{ label: string, render: (row) => any, className?: string }>,
 *           rows: object[], empty?: string, onRowClick?: (row, tr) => void,
 *           rowClass?: (row) => string|null, caption?: string }} opts
 */
export function table({ columns, rows, empty: emptyText = 'Nothing to show', onRowClick, rowClass, caption }) {
  if (!rows || rows.length === 0) return empty(emptyText);
  const tbody = h('tbody', null, rows.map(row => {
    const tr = h('tr', { class: [onRowClick && 'clickable', rowClass?.(row)], tabindex: onRowClick ? '0' : undefined },
      columns.map(col => h('td', { class: col.className, 'data-label': col.label }, col.render(row))));
    if (onRowClick) {
      tr.addEventListener('click', ev => {
        if (ev.target.closest('a, button, input, select, label')) return;
        onRowClick(row, tr);
      });
      tr.addEventListener('keydown', ev => {
        if (ev.key === 'Enter' && ev.target === tr) onRowClick(row, tr);
      });
    }
    return tr;
  }));
  return h('div', { class: 'table-wrap' },
    h('table', { class: 'table responsive' },
      caption && h('caption', { class: 'subtle', hidden: true }, caption),
      h('thead', null, h('tr', null, columns.map(col => h('th', { class: col.className, scope: 'col' }, col.label)))),
      tbody));
}

export function pager({ page, totalPages, total, pageSize, onPage }) {
  const from = total === 0 ? 0 : (page - 1) * pageSize + 1;
  const to = Math.min(page * pageSize, total);
  return h('div', { class: 'pager' },
    h('span', { class: 'info' }, `${num(from)}–${num(to)} of ${num(total)}`),
    h('div', { class: 'buttons' },
      h('button', { class: 'btn btn-sm', type: 'button', disabled: page <= 1, onClick: () => onPage(page - 1) }, '‹ Prev'),
      h('span', { class: 'subtle small' }, `Page ${page} / ${totalPages}`),
      h('button', { class: 'btn btn-sm', type: 'button', disabled: page >= totalPages, onClick: () => onPage(page + 1) }, 'Next ›')));
}

// ─── Buttons with feedback ───────────────────────────────────────────────────

/**
 * A button that runs an async action with a busy state; errors become
 * toasts. `confirm` turns it into a two-step button ("Click again to confirm").
 * @param {{ label: string, run: () => Promise<any>, variant?: string, small?: boolean,
 *           confirm?: string|boolean, busyLabel?: string, title?: string, disabled?: boolean }} opts
 */
export function actionButton({ label, run, variant, small = true, confirm, busyLabel, title, disabled }) {
  const btn = h('button', { class: ['btn', small && 'btn-sm', variant && `btn-${variant}`], type: 'button', title, disabled });
  const setLabel = (text, busy = false) => mount(btn, busy && h('span', { class: 'spinner', 'aria-hidden': 'true' }), text);
  setLabel(label);
  let armed = null;
  btn.addEventListener('click', async () => {
    if (btn.disabled) return;
    if (confirm && !armed) {
      btn.classList.add('btn-confirm');
      setLabel(typeof confirm === 'string' && confirm.length <= 24 ? confirm : 'Confirm?');
      if (typeof confirm === 'string' && confirm.length > 24) btn.title = confirm;
      armed = setTimeout(() => {
        armed = null;
        btn.classList.remove('btn-confirm');
        setLabel(label);
      }, 4000);
      return;
    }
    clearTimeout(armed);
    armed = null;
    btn.classList.remove('btn-confirm');
    btn.disabled = true;
    btn.setAttribute('aria-busy', 'true');
    setLabel(busyLabel || label, true);
    try {
      await run();
    } catch (err) {
      toast(err?.message || String(err), { type: 'error' });
    } finally {
      if (btn.isConnected) {
        btn.disabled = Boolean(disabled);
        btn.removeAttribute('aria-busy');
        setLabel(label);
      }
    }
  });
  return btn;
}

// ─── Toasts ──────────────────────────────────────────────────────────────────

/**
 * @param {string} message
 * @param {{ type?: 'success'|'error'|'info'|'warning', action?: { label: string, run: () => any }, timeout?: number }} [opts]
 */
export function toast(message, { type = 'info', action, timeout } = {}) {
  const root = document.getElementById('toasts');
  if (!root) return;
  const el = h('div', { class: ['toast', type], role: type === 'error' ? 'alert' : 'status' },
    h('span', { class: 'msg' }, message));
  const close = () => el.remove();
  if (action) {
    el.append(h('button', {
      class: 'btn btn-sm', type: 'button',
      onClick: async () => {
        close();
        try { await action.run(); } catch (err) { toast(err?.message || String(err), { type: 'error' }); }
      },
    }, action.label));
  }
  el.append(h('button', { class: 'btn btn-sm btn-ghost', type: 'button', 'aria-label': 'Dismiss', onClick: close }, '✕'));
  root.append(el);
  while (root.children.length > 4) root.firstElementChild.remove();
  setTimeout(close, timeout ?? (type === 'error' ? 9000 : action ? 8000 : 4500));
}

// ─── Drawer ──────────────────────────────────────────────────────────────────

let drawerState = null;

export function closeDrawer() {
  if (!drawerState) return;
  const { root, returnFocus, onClose } = drawerState;
  drawerState = null;
  root.replaceChildren();
  document.removeEventListener('keydown', onEscape);
  onClose?.();
  returnFocus?.focus?.();
}

function onEscape(ev) {
  if (ev.key === 'Escape') closeDrawer();
}

/**
 * Open the side drawer.
 * @returns {{ body: HTMLElement, setTitle: (t: string) => void }}
 */
export function openDrawer({ title, onClose }) {
  closeDrawer();
  const root = document.getElementById('drawer-root');
  const titleEl = h('div', { class: 'drawer-title', id: 'drawer-title' }, title);
  const bodyEl = h('div', { class: 'drawer-body' });
  const closeBtn = h('button', { class: 'btn btn-sm', type: 'button', onClick: closeDrawer }, 'Close');
  root.append(
    h('div', { class: 'drawer-backdrop', onClick: closeDrawer }),
    h('aside', { class: 'drawer', role: 'dialog', 'aria-modal': 'true', 'aria-labelledby': 'drawer-title' },
      h('div', { class: 'drawer-head' }, titleEl, closeBtn),
      bodyEl));
  drawerState = { root, returnFocus: document.activeElement, onClose };
  document.addEventListener('keydown', onEscape);
  closeBtn.focus();
  return { body: bodyEl, setTitle: t => { titleEl.textContent = t; } };
}

export function drawerSection(title, ...children) {
  return h('section', { class: 'drawer-section' }, h('h3', null, title), ...children);
}

// ─── Small charts ────────────────────────────────────────────────────────────

/**
 * Inline SVG sparkline.
 * @param {number[]} values
 * @param {{ max?: number, limit?: number|null, label?: string }} [opts] - limit draws a dashed line
 */
export function sparkline(values, { max, limit = null, label = '' } = {}) {
  const w = 300;
  const hgt = 56;
  const clean = values.map(v => (Number.isFinite(v) ? v : 0));
  const top = Math.max(max ?? 0, limit ?? 0, ...clean, 1);
  const x = i => (clean.length <= 1 ? 0 : (i / (clean.length - 1)) * w);
  const y = v => hgt - 2 - (v / top) * (hgt - 6);
  const line = clean.map((v, i) => `${i === 0 ? 'M' : 'L'}${x(i).toFixed(1)},${y(v).toFixed(1)}`).join(' ');
  return svg('svg', { class: 'sparkline', viewBox: `0 0 ${w} ${hgt}`, preserveAspectRatio: 'none', role: 'img', 'aria-label': label },
    clean.length > 1 && svg('path', { class: 'area', d: `${line} L${w},${hgt} L0,${hgt} Z` }),
    clean.length > 1 && svg('path', { class: 'line', d: line }),
    limit !== null && svg('line', { class: 'limit', x1: 0, x2: w, y1: y(limit), y2: y(limit) }));
}

/** Horizontal bar breakdown: [{ label, value, color?, hint? }] */
export function breakdown(items, { format = num, total } = {}) {
  const sum = total ?? items.reduce((a, b) => a + (b.value || 0), 0);
  if (!items.length || sum === 0) return empty('No data for this period');
  return h('div', { class: 'breakdown' }, items.map(item => {
    const bar = h('span');
    bar.style.width = `${(item.value / sum) * 100}%`;
    if (item.color) bar.style.background = item.color;
    return h('div', { class: 'breakdown-row', title: item.hint },
      h('span', { class: 'label' }, item.label),
      h('div', { class: 'bar' }, bar),
      h('span', { class: 'value' }, `${format(item.value)} · ${((item.value / sum) * 100).toFixed(item.value / sum < 0.1 ? 1 : 0)}%`));
  }));
}
