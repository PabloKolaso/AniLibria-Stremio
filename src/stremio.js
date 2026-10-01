/**
 * Stremio addon protocol over HTTP.
 *
 * Implements the transport that stremio-addon-sdk's getRouter() provided:
 *   GET /manifest.json
 *   GET /{resource}/{type}/{id}.json
 *   GET /{resource}/{type}/{id}/{extra}.json   (extra = "search=foo&skip=100")
 *
 * Handler results are sent as JSON; cacheMaxAge / staleRevalidate /
 * staleError (seconds) become a Cache-Control header, as in the SDK.
 * Handlers also receive the client IP (for privacy-preserving usage
 * statistics), and an optional onRequest hook sees every request's outcome.
 * https://github.com/Stremio/stremio-addon-sdk/blob/master/docs/protocol.md
 */

const express     = require('express');
const querystring = require('querystring');

const RESOURCE_PATH_RE = /^\/([^/]+)\/([^/]+)\/([^/]+?)(?:\/([^/]*))?\.json$/;

const CACHE_DIRECTIVES = [
  ['cacheMaxAge', 'max-age'],
  ['staleRevalidate', 'stale-while-revalidate'],
  ['staleError', 'stale-if-error'],
];

function sendJson(res, status, body) {
  res.status(status);
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  res.end(typeof body === 'string' ? body : JSON.stringify(body));
}

function cacheControl(resp) {
  const directives = CACHE_DIRECTIVES
    .filter(([prop]) => Number.isInteger(resp[prop]) && resp[prop] >= 0)
    .map(([prop, directive]) => `${directive}=${resp[prop]}`);
  return directives.length > 0 ? `${directives.join(', ')}, public` : null;
}

function decodeSegment(segment) {
  try {
    return decodeURIComponent(segment);
  } catch {
    return null;
  }
}

/**
 * @param {object} manifest
 * @param {Record<string, (args: { type: string, id: string, extra: object, ip: string|null }) => Promise<object>>} handlers
 *        resource name -> handler
 * @param {{ onRequest?: (info: { resource: string, type?: string, id?: string, ok: boolean,
 *           ms: number, ip: string|null }) => void }} [opts]
 * @returns {express.Router}
 */
function createAddonRouter(manifest, handlers, { onRequest = null } = {}) {
  const router = express.Router();
  const manifestJson = JSON.stringify(manifest);

  const declared = new Set(manifest.resources.map(r => (typeof r === 'string' ? r : r.name)));
  if (manifest.catalogs?.length) declared.add('catalog');
  for (const resource of declared) {
    if (typeof handlers[resource] !== 'function') throw new Error(`No handler defined for declared resource "${resource}"`);
  }

  const report = info => {
    if (!onRequest) return;
    try { onRequest(info); } catch (err) { console.error('[addon] onRequest hook failed:', err); }
  };

  router.get('/manifest.json', (req, res) => {
    sendJson(res, 200, manifestJson);
    report({ resource: 'manifest', ok: true, ms: 0, ip: req.ip || null });
  });

  router.get(RESOURCE_PATH_RE, async (req, res, next) => {
    const match = RESOURCE_PATH_RE.exec(req.path);
    if (!match) return next();
    const [, rawResource, rawType, rawId, rawExtra] = match;

    const resource = decodeSegment(rawResource);
    if (!resource || !declared.has(resource)) return next();

    const type = decodeSegment(rawType);
    const id = decodeSegment(rawId);
    if (type === null || id === null) return sendJson(res, 400, { err: 'bad request' });

    // Parse extra from the raw segment so encoded "&" inside values survive
    const extra = rawExtra ? querystring.parse(rawExtra) : {};

    const started = Date.now();
    const ip = req.ip || null;
    let resp;
    try {
      resp = await handlers[resource]({ type, id, extra, config: {}, ip });
    } catch (err) {
      console.error(`[addon] ${resource} handler failed for ${type}/${id}:`, err);
      report({ resource, type, id, ok: false, ms: Date.now() - started, ip });
      return sendJson(res, 500, { err: 'handler error' });
    }
    if (!resp || typeof resp !== 'object') {
      console.error(`[addon] ${resource} handler returned no object for ${type}/${id}`);
      report({ resource, type, id, ok: false, ms: Date.now() - started, ip });
      return sendJson(res, 500, { err: 'handler error' });
    }
    report({ resource, type, id, ok: true, ms: Date.now() - started, ip });

    const cache = cacheControl(resp);
    if (cache) res.setHeader('Cache-Control', cache);
    if (resp.redirect) return res.redirect(307, resp.redirect);
    sendJson(res, 200, resp);
  });

  return router;
}

module.exports = { createAddonRouter };
