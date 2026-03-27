/**
 * Stremio AniLibria Addon — Entry Point
 */

// Must be first — patches console before any other module logs
const { router: debugRouter } = require('./debug');

const { addonBuilder, getRouter } = require('stremio-addon-sdk');
const express = require('express');
const cors    = require('cors');
const path    = require('path');

const axios = require('axios');

const compression        = require('compression');
const manifest          = require('./manifest');
const mappingCache      = require('./mapping/cache');
const { streamHandler } = require('./handlers/streams');
const { warmup, isIndexReady, loadPersistedCache, flushToDisk } = require('./bridge/resolver');
const logger            = require('./logger');
const stats             = require('./stats');
const users             = require('./users');
const dashboardRouter   = require('./dashboard');
const renderInstallPage = require('./install-page');

const PORT = process.env.PORT || 7000;

// ─── Crash guards ────────────────────────────────────────────────────────────
// Prevent the process from dying on unhandled errors.
// Log the error and keep running.
process.on('uncaughtException', err => {
  console.error('[uncaughtException]', err.message, err.stack);
});

process.on('unhandledRejection', (reason) => {
  console.error('[unhandledRejection]', reason);
});
// ─────────────────────────────────────────────────────────────────────────────

async function start() {
  const host = process.env.PUBLIC_URL || `http://localhost:${PORT}`;
  manifest.logo = 'https://fandub.wiki/images/thumb/0/06/AniLibria_%D0%9B%D0%BE%D0%B3%D0%BE%D1%82%D0%B8%D0%BF_%D0%BA%D0%BE%D0%BB%D0%BB%D0%B5%D0%BA%D1%82%D0%B8%D0%B2%D0%B0.jpg/200px-AniLibria_%D0%9B%D0%BE%D0%B3%D0%BE%D1%82%D0%B8%D0%BF_%D0%BA%D0%BE%D0%BB%D0%BB%D0%B5%D0%BA%D1%82%D0%B8%D0%B2%D0%B0.jpg';

  // Build the addon
  const builder = new addonBuilder(manifest);
  builder.defineStreamHandler(streamHandler);
  console.log('=== Stremio AniLibria Addon ===');

  // Load the Fribb IMDB mapping (required for all lookups)
  try {
    await mappingCache.load();
  } catch (err) {
    console.error('[boot] Fribb mapping failed to load:', err.message);
    console.warn('[boot] Retrying mapping load in 30 seconds...');
    setTimeout(() => mappingCache.load().catch(console.error), 30_000);
  }

  // Restore resolver cache from previous run
  loadPersistedCache();

  // Start the HTTP server
  const addonInterface = builder.getInterface();
  const app = express();
  app.set('trust proxy', true);
  app.use(cors());
  app.use(compression());

  // Security headers
  app.use((req, res, next) => {
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('X-Frame-Options', 'DENY');
    next();
  });

  // Bandwidth tracking — capture outbound response sizes
  app.use((req, res, next) => {
    const origEnd = res.end;
    res.end = function(chunk, encoding) {
      origEnd.call(this, chunk, encoding);
      const contentLength = parseInt(res.getHeader('content-length'), 10);
      const chunkSize = (chunk && (typeof chunk === 'string' || Buffer.isBuffer(chunk)))
        ? Buffer.byteLength(chunk)
        : 0;
      const bytes = contentLength || chunkSize;
      if (bytes > 0) stats.recordBandwidth(bytes);
    };
    next();
  });

  // Unique user tracking — capture client IP on stream requests
  app.use((req, res, next) => {
    if (req.method === 'GET' && req.path.startsWith('/stream/')) {
      const ip = req.ip || 'unknown';
      if (ip !== 'unknown') users.recordUser(ip);
    }
    next();
  });

  // Serve local logo
  app.get('/logo.jpg', (req, res) => {
    res.sendFile(path.resolve(__dirname, '../assets/logo.jpg'));
  });

  // Health endpoint (before SDK router so it doesn't intercept)
  app.get('/health', (req, res) => {
    res.json({
      status: 'ok',
      uptime: Math.round(process.uptime()),
      mappingLoaded: mappingCache.getMappingSize() > 0,
      indexReady: isIndexReady(),
    });
  });

  // Public install page at root
  app.get('/', (req, res) => {
    res.setHeader('Content-Type', 'text/html; charset=utf-8');
    res.send(renderInstallPage());
  });

  // Dashboard must be mounted before SDK router so /dashboard isn't intercepted
  app.use('/', dashboardRouter);
  app.use('/', getRouter(addonInterface));
  app.use('/', debugRouter);

  const server = app.listen(PORT);
  // Start logger cleanup interval (prune entries older than 3 days, every hour)
  logger.startCleanupInterval();

  console.log(`\nAddon running at: ${host}/manifest.json`);
  console.log(`Dashboard:        ${host}/dashboard`);
  console.log(`Health check:     ${host}/health`);
  console.log('Install in Stremio by opening the manifest URL above.\n');

  // Self-ping keep-alive to prevent Render free tier spin-down (15 min idle)
  let pingTimer = null;
  if (process.env.PUBLIC_URL) {
    const PING_INTERVAL = 12 * 60 * 1000; // 12 minutes
    pingTimer = setInterval(() => {
      axios.get(`${process.env.PUBLIC_URL}/health`)
        .then(() => console.log('[keepalive] Ping OK'))
        .catch(err => console.warn('[keepalive] Ping failed:', err.message));
    }, PING_INTERVAL);
    console.log('[keepalive] Self-ping enabled (every 12 min)');
  }

  // Register with Stremio Community Addons catalog
  if (process.env.PUBLIC_URL) {
    axios.post('https://api.strem.io/api/addonPublish', {
      transportUrl: 'https://anilibria-stremio.online/manifest.json',
      transportName: 'http',
    })
    .then(r => console.log('[publish] Registered with Stremio Community:', JSON.stringify(r.data)))
    .catch(e => console.warn('[publish] Failed to register with Stremio:', e.message));
  }

  // Graceful shutdown
  process.on('SIGTERM', () => {
    console.log('[shutdown] SIGTERM received, closing server...');
    if (pingTimer) clearInterval(pingTimer);
    logger.stopCleanupInterval();
    logger.flush();
    stats.flush();
    users.flush();
    flushToDisk();
    server.close(() => {
      console.log('[shutdown] Server closed.');
      process.exit(0);
    });
    setTimeout(() => process.exit(0), 5000);
  });

  // Pre-warm the Anilibria title index in the background
  warmup();

  // Prewarm top anime from MAL (background, after Fuse index is ready)
  setTimeout(async () => {
    try {
      const { prewarmTopAnime } = require('./prewarm');
      await prewarmTopAnime({ count: 250 });
    } catch (err) {
      console.warn('[prewarm] Error:', err.message);
    }
  }, 30_000);

  // Backfill missing titles for failed lookups via Cinemeta (rate-limited)
  setTimeout(() => {
    const cinemeta = require('./api/cinemeta');
    cinemeta.backfillMissingTitles(
      stats.getFailedLookups(),
      (imdbId, info) => stats.updateFailedLookup(imdbId, info),
    ).then(count => {
      if (count > 0) console.log(`[cinemeta] Backfilled ${count} missing titles`);
    }).catch(err => console.warn('[cinemeta] Backfill error:', err.message));
  }, 10_000);
}

start().catch(err => {
  console.error('[boot] Fatal startup error:', err);
  process.exit(1);
});
