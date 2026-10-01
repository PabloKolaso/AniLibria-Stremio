/**
 * Live data: a single poller for the current page, and the connection
 * state shown in the header.
 *
 *   connecting → live ⇄ lost (retrying with backoff) ; expired (401) is final
 *   paused     — the page stopped live updates (e.g. while reading logs)
 *   restartedAt — set when the server's boot ID changes
 *
 * Polling stops while the browser tab is hidden and resumes (with an
 * immediate refresh) when it becomes visible again.
 */

import { onApi } from './api.js';

const state = {
  status: 'connecting',
  lastOkAt: null,
  error: null,
  retryAt: null,
  failures: 0,
  interval: 15_000,
  paused: false,
  bootId: null,
  restartedAt: null,
  meta: null,
};
const listeners = new Set();

let task = null;
let timer = null;
let generation = 0;

function notify() {
  for (const fn of listeners) {
    try { fn(state); } catch (err) { console.error(err); }
  }
}

function set(patch) {
  Object.assign(state, patch);
  notify();
}

export function liveState() {
  return state;
}

export function onLive(fn) {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

async function run() {
  clearTimeout(timer);
  timer = null;
  if (!task || state.status === 'expired' || state.paused || document.hidden) return;
  const gen = generation;
  try {
    await task.load();
    if (gen !== generation) return;
    set({ status: 'live', lastOkAt: Date.now(), error: null, retryAt: null, failures: 0 });
    timer = setTimeout(run, task.interval);
  } catch (err) {
    if (gen !== generation) return;
    if (err?.status === 401) {
      set({ status: 'expired' });
      return;
    }
    const failures = state.failures + 1;
    const delay = Math.min(60_000, 5000 * 2 ** (failures - 1));
    set({ status: 'lost', error: err?.message || String(err), retryAt: Date.now() + delay, failures });
    timer = setTimeout(run, delay);
  }
}

/**
 * Poll a page's data.
 * @param {{ load: () => Promise<void>, interval: number } | null} next
 */
export function setTask(next) {
  generation++;
  clearTimeout(timer);
  task = next;
  set({ paused: false, interval: next ? next.interval : state.interval, failures: 0 });
  if (task) run();
}

/** Load now (after a user action or a filter change). */
export function refreshNow() {
  generation++;
  return run();
}

/** Pause or resume live updates for the current page. */
export function setPaused(paused) {
  set({ paused });
  if (paused) clearTimeout(timer);
  else refreshNow();
}

document.addEventListener('visibilitychange', () => {
  if (document.hidden) {
    clearTimeout(timer);
    timer = null;
  } else if (task && !state.paused) {
    refreshNow();
  }
});

onApi('meta', meta => {
  if (state.bootId && meta.bootId !== state.bootId) state.restartedAt = Date.now();
  state.bootId = meta.bootId;
  state.meta = meta;
  if (state.status === 'lost' || state.status === 'connecting') {
    set({ status: 'live', lastOkAt: Date.now(), error: null, failures: 0 });
  } else {
    notify();
  }
});

onApi('auth', () => set({ status: 'expired' }));
