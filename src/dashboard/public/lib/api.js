/**
 * Dashboard API client.
 *
 * Emits events the app shell listens to:
 *   'meta'  — every response's meta block (health, boot ID for restart detection)
 *   'auth'  — the session expired (HTTP 401)
 */

const listeners = { meta: new Set(), auth: new Set() };

export class ApiError extends Error {
  constructor(message, status, body = null) {
    super(message);
    this.status = status;
    this.body = body;
  }
}

export function onApi(event, fn) {
  listeners[event].add(fn);
  return () => listeners[event].delete(fn);
}

function emit(event, payload) {
  for (const fn of listeners[event]) {
    try { fn(payload); } catch (err) { console.error(err); }
  }
}

function buildUrl(path, params) {
  const url = new URL(`/dashboard/api${path}`, location.origin);
  if (params) {
    for (const [k, v] of Object.entries(params)) {
      if (v !== undefined && v !== null && v !== '') url.searchParams.set(k, String(v));
    }
  }
  return url;
}

async function request(method, path, { params, body } = {}) {
  let res;
  try {
    res = await fetch(buildUrl(path, params), {
      method,
      credentials: 'same-origin',
      cache: 'no-store',
      headers: {
        Accept: 'application/json',
        ...(method !== 'GET' ? { 'Content-Type': 'application/json', 'X-Dashboard-Request': '1' } : {}),
      },
      body: body !== undefined ? JSON.stringify(body) : undefined,
    });
  } catch (err) {
    throw new ApiError('Cannot reach the server', 0);
  }
  if (res.status === 401) {
    emit('auth');
    throw new ApiError('Session expired — sign in again', 401);
  }
  let data = null;
  try { data = await res.json(); } catch { /* non-JSON error page */ }
  if (data?.meta) emit('meta', data.meta);
  if (!res.ok) {
    const message = data?.error || `Request failed (HTTP ${res.status})`;
    throw new ApiError(message, res.status, data);
  }
  return data;
}

export const api = {
  get: (path, params) => request('GET', path, { params }),
  post: (path, body, params) => request('POST', path, { body: body ?? {}, params }),
  del: (path) => request('DELETE', path),
};

/** URL for a download (CSV, JSON, console log) with the current filters. */
export function downloadUrl(path, params) {
  const url = path.startsWith('/dashboard/') ? new URL(path, location.origin) : buildUrl(path);
  if (params) for (const [k, v] of Object.entries(params)) if (v !== undefined && v !== null && v !== '') url.searchParams.set(k, String(v));
  return url.pathname + url.search;
}
