/**
 * Express application: Stremio protocol routes, install page, health check,
 * admin dashboard and debug routes.
 */

const path        = require('path');
const { STATUS_CODES } = require('http');
const express     = require('express');
const cors        = require('cors');
const compression = require('compression');

const config   = require('./config');
const manifest = require('./manifest');
const mapping  = require('./mapping/cache');
const resolver = require('./bridge/resolver');
const traffic  = require('./telemetry/traffic');
const users    = require('./telemetry/users');
const releasing = require('./catalogs/releasing');
const trending  = require('./catalogs/trending');
const { createAddonRouter } = require('./stremio');
const { streamHandler }     = require('./handlers/streams');
const { catalogHandler }    = require('./handlers/catalog');
const { metaHandler }       = require('./handlers/meta');
const { router: debugRouter } = require('./debug');
const dashboardRouter   = require('./dashboard');
const renderInstallPage = require('./install-page');
const { version } = require('../package.json');

const LOGO_FILE = path.resolve(__dirname, '../assets/logo.jpg');

function securityHeaders(req, res, next) {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options', 'DENY');
  res.setHeader('Referrer-Policy', 'same-origin');
  next();
}

/**
 * Usage statistics for every addon protocol request. Catalog and meta
 * requests are anime usage by definition; stream requests count their
 * users themselves, once they know whether the title is an anime.
 */
function recordAddonRequest({ resource, id, ok, ip }) {
  traffic.recordResource({ resource, catalogId: resource === 'catalog' ? id : null, ok });
  if ((resource === 'catalog' || resource === 'meta') && ip) users.recordUser(ip);
}

// Express recognizes error handlers by their four parameters, so `next` must stay.
function errorHandler(err, req, res, next) {
  const raw = err.status || err.statusCode;
  const status = Number.isInteger(raw) && raw >= 400 && raw < 600 ? raw : 500;
  if (status >= 500) console.error(`[http] ${req.method} ${req.path} failed:`, err);
  if (res.headersSent) return res.destroy();
  // Client errors (bad encoding, oversized body, invalid JSON) get a generic, non-sensitive message
  const message = status >= 500 ? 'internal error' : (err.expose && err.message) || STATUS_CODES[status] || 'bad request';
  res.status(status).json({ error: message });
}

const DEFAULT_HANDLERS = { stream: streamHandler, catalog: catalogHandler, meta: metaHandler };

function publicSnapshotInfo(info) {
  return { count: info.count, updatedAt: info.updatedAt, stale: info.stale, lastError: info.lastError };
}

/**
 * @param {{ handlers?: Record<string, Function> }} [opts] - override addon handlers (tests)
 */
function createApp({ handlers: overrides = {} } = {}) {
  const handlers = { ...DEFAULT_HANDLERS, ...overrides };
  const app = express();
  app.set('trust proxy', config.trustProxy);
  app.disable('x-powered-by');

  app.use(cors());
  app.use(compression());
  app.use(securityHeaders);

  app.get('/logo.jpg', (req, res) => {
    res.sendFile(LOGO_FILE, { maxAge: '1d' });
  });

  // Liveness/readiness information
  app.get('/health', (req, res) => {
    res.json({
      status: 'ok',
      version,
      uptime: Math.round(process.uptime()),
      mappingLoaded: mapping.getMappingSize() > 0,
      indexReady: resolver.isIndexReady(),
      catalogs: { releasing: publicSnapshotInfo(releasing.info()), trending: publicSnapshotInfo(trending.info()) },
    });
  });

  // Public install page at root (static for the process lifetime)
  const installPage = renderInstallPage();
  app.get('/', (req, res) => {
    res.setHeader('Content-Type', 'text/html; charset=utf-8');
    res.send(installPage);
  });

  app.use(dashboardRouter);
  app.use(createAddonRouter(manifest, handlers, { onRequest: recordAddonRequest }));
  app.use(debugRouter);
  app.use(errorHandler);

  return app;
}

module.exports = { createApp };
