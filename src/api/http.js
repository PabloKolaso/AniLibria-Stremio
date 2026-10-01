/**
 * Shared HTTP client built on the native fetch API.
 *
 * Adds what every upstream call needs: a hard timeout covering the whole
 * request (headers + body), bounded retries with exponential backoff for
 * transient failures, a consistent User-Agent, errors that say which
 * service and endpoint failed, and per-attempt provider telemetry for the
 * dashboard (monitoring/providers.js).
 */

const { version } = require('../../package.json');
const providers = require('../monitoring/providers');

const USER_AGENT = `stremio-anilibria-addon/${version}`;

class HttpError extends Error {
  /**
   * @param {string} message
   * @param {{ code: 'TIMEOUT'|'NETWORK'|'HTTP'|'PARSE'|'UNAVAILABLE', status?: number, service?: string, retryAfter?: string|null, cause?: Error }} info
   */
  constructor(message, { code, status = null, service = null, retryAfter = null, cause } = {}) {
    super(message, cause ? { cause } : undefined);
    this.name = 'HttpError';
    this.code = code;
    this.status = status;
    this.service = service;
    this.retryAfter = retryAfter;
  }
}

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

function isTransient(err) {
  return err instanceof HttpError &&
    (err.code === 'TIMEOUT' || err.code === 'NETWORK' || (err.status !== null && err.status >= 500));
}

function isAbort(err) {
  return err && (err.name === 'TimeoutError' || err.name === 'AbortError');
}

async function attempt(url, { method, headers, body, timeout, service, responseType }) {
  const label = `${service} ${method} ${new URL(url).pathname}`;
  const signal = AbortSignal.timeout(timeout);

  let res;
  try {
    res = await fetch(url, {
      method,
      headers: { 'User-Agent': USER_AGENT, Accept: 'application/json', ...headers },
      body,
      signal,
    });
  } catch (err) {
    if (isAbort(err)) throw new HttpError(`${label} timed out after ${timeout}ms`, { code: 'TIMEOUT', service });
    const reason = err.cause?.code || err.cause?.message || err.message;
    throw new HttpError(`${label} network error: ${reason}`, { code: 'NETWORK', service, cause: err });
  }

  if (!res.ok) {
    res.body?.cancel().catch(() => {}); // release the socket
    throw new HttpError(`${label} failed: HTTP ${res.status}`, {
      code: 'HTTP',
      status: res.status,
      service,
      retryAfter: res.headers.get('retry-after'),
    });
  }

  let text;
  try {
    text = await res.text();
  } catch (err) {
    if (isAbort(err)) throw new HttpError(`${label} timed out after ${timeout}ms`, { code: 'TIMEOUT', service });
    throw new HttpError(`${label} network error while reading body: ${err.message}`, { code: 'NETWORK', service, cause: err });
  }

  if (responseType === 'text') return text;
  try {
    return JSON.parse(text);
  } catch {
    throw new HttpError(`${label} returned invalid JSON`, { code: 'PARSE', status: res.status, service });
  }
}

/**
 * Perform an HTTP request and return the parsed body.
 *
 * @param {string} url
 * @param {{ method?: string, headers?: object, body?: string, timeout?: number,
 *           retries?: number, retryDelayMs?: number, service?: string,
 *           responseType?: 'json'|'text' }} [opts]
 * @throws {HttpError}
 */
async function request(url, opts = {}) {
  const {
    method = 'GET',
    headers = {},
    body,
    timeout = 10_000,
    retries = 0,
    retryDelayMs = 300,
    service = new URL(url).host,
    responseType = 'json',
  } = opts;

  const path = new URL(url).pathname;
  for (let i = 0; ; i++) {
    const started = Date.now();
    try {
      const result = await attempt(url, { method, headers, body, timeout, service, responseType });
      providers.record(service, { ms: Date.now() - started, path });
      return result;
    } catch (err) {
      providers.record(service, { ms: Date.now() - started, error: err, path });
      if (i >= retries || !isTransient(err)) throw err;
      await sleep(retryDelayMs * 2 ** i);
    }
  }
}

function getJson(url, opts) {
  return request(url, { ...opts, method: 'GET' });
}

function postJson(url, payload, opts = {}) {
  return request(url, {
    ...opts,
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...opts.headers },
    body: JSON.stringify(payload),
  });
}

/** Short, non-sensitive description of a failure, safe to show to end users. */
function describeError(err) {
  if (err instanceof HttpError) {
    if (err.code === 'TIMEOUT') return 'upstream timeout';
    if (err.code === 'HTTP') return `upstream HTTP ${err.status}`;
    if (err.code === 'PARSE') return 'invalid upstream response';
    if (err.code === 'UNAVAILABLE') return 'service temporarily unavailable';
    return 'network error';
  }
  return 'internal error';
}

module.exports = { request, getJson, postJson, HttpError, describeError, USER_AGENT };
