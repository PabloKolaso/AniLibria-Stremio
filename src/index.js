/**
 * Stremio AniLibria Addon — Entry Point
 */

// Must be first — patches console before any other module logs
require('./monitoring/console');

const { once }  = require('events');
const config    = require('./config');
const http      = require('./api/http');
const anilist   = require('./api/anilist');
const mapping   = require('./mapping/cache');
const catalog   = require('./mapping/anilibria-catalog');
const resolver  = require('./bridge/resolver');
const releasing = require('./catalogs/releasing');
const trending  = require('./catalogs/trending');
const requestLog = require('./telemetry/request-log');
const missing    = require('./telemetry/missing');
const legacy     = require('./telemetry/legacy-stats');
const lifecycle  = require('./monitoring/lifecycle');
const processMetrics = require('./monitoring/process-metrics');
const alerts     = require('./monitoring/alerts');
const jobs       = require('./monitoring/jobs');
const JsonStore  = require('./util/json-store');
const { isFirstRun: authIsFirstRun } = require('./auth');
const { createApp } = require('./app');

const KEEPALIVE_INTERVAL_MS = 12 * 60 * 1000; // Render free tier spins down after 15 min idle
const SHUTDOWN_TIMEOUT_MS   = 5000;

// ─── Crash guards ────────────────────────────────────────────────────────────
// Keep serving after an unexpected error in a background task; log it loudly
// and record it (dashboard, alerts).
process.on('uncaughtException', err => {
  console.error('[uncaughtException]', err);
  lifecycle.recordFatal('uncaughtException', err);
});

process.on('unhandledRejection', reason => {
  console.error('[unhandledRejection]', reason);
  lifecycle.recordFatal('unhandledRejection', reason);
});
// ─────────────────────────────────────────────────────────────────────────────

/** Background jobs the dashboard can see (passive) or trigger (manual). */
function defineJobs() {
  jobs.define('keepalive', {
    label: 'Keep-alive ping',
    description: 'Self-ping of PUBLIC_URL/health so free hosting tiers do not spin the service down',
    schedule: config.publicUrl ? 'every 12 min' : 'disabled (PUBLIC_URL not set)',
  });
  jobs.define('stremio-publish', {
    label: 'Stremio catalog registration',
    description: 'Registers the manifest with the Stremio Community addon catalog',
    schedule: config.publicUrl ? 'at startup' : 'disabled (PUBLIC_URL not set)',
  });
  jobs.define('refresh-releasing', {
    label: 'Refresh Releasing catalog',
    description: 'Poll AniLibria for in-production releases and new episodes now',
    schedule: 'every 60 s',
    cooldownMs: 30_000,
    run: async () => {
      const items = await releasing.refresh();
      const info = releasing.info();
      if (info.lastError && info.lastFailureAt >= info.lastAttemptAt) throw new Error(info.lastError);
      return `${items?.length ?? 0} titles listed`;
    },
  });
  jobs.define('refresh-trending', {
    label: 'Refresh Trending catalog',
    description: 'Fetch AniList trending (2 requests) and re-match against AniLibria',
    schedule: 'every 5 min',
    cooldownMs: 60_000,
    run: async () => {
      const items = await trending.refresh();
      const info = trending.info();
      if (info.lastError && info.lastFailureAt >= info.lastAttemptAt) throw new Error(info.lastError);
      return `${items?.length ?? 0} titles listed`;
    },
  });
  jobs.define('rebuild-index', {
    label: 'Rebuild AniLibria index',
    description: 'Re-download the full AniLibria catalog (about 40 API pages)',
    schedule: 'every 2 h',
    cooldownMs: 10 * 60_000,
    confirm: 'Downloads the whole AniLibria catalog (~40 requests). Continue?',
    run: async () => {
      const index = await catalog.rebuild();
      return `${index.size} releases indexed${index.complete ? '' : ' (incomplete)'}`;
    },
  });
  jobs.define('refresh-mapping', {
    label: 'Re-download ID mapping',
    description: 'Download the Fribb IMDB ↔ MAL/AniList mapping from GitHub',
    schedule: 'every 24 h',
    cooldownMs: 30 * 60_000,
    confirm: 'Downloads the Fribb mapping from GitHub (several MB). Continue?',
    run: async () => {
      await mapping.forceRefresh();
      return `${mapping.getInfo().imdbIds} IMDB IDs mapped`;
    },
  });
  jobs.define('clear-resolver', {
    label: 'Clear resolver cache',
    description: 'Forget every memoized anime → release match; the next requests re-resolve (more upstream calls)',
    schedule: 'cleared automatically when the index changes',
    cooldownMs: 30_000,
    confirm: 'Every anime will be re-resolved on its next request. Continue?',
    run: async () => `${resolver.clearAll()} cached matches cleared`,
  });
  jobs.define('recheck-missing', {
    label: 'Re-check missing titles',
    description: 'Look for missing titles that are now available (offline, against the local index)',
    schedule: 'hourly and after index/mapping updates',
    cooldownMs: 30_000,
    run: async () => {
      const r = missing.recheck();
      return `${r.checked} checked, ${r.available} newly available`;
    },
  });
}

async function start() {
  console.log('=== Stremio AniLibria Addon ===');
  const host = config.publicUrl || `http://localhost:${config.port}`;

  lifecycle.start();
  processMetrics.start();
  anilist.loadCache();
  defineJobs();

  const app = createApp();
  const server = app.listen(config.port);
  // Longer than typical load-balancer idle timeouts, so proxies never reuse a closed socket
  server.keepAliveTimeout = 65_000;
  server.headersTimeout = 66_000;
  await Promise.race([
    once(server, 'listening'),
    once(server, 'error').then(([err]) => { throw err; }),
  ]);

  requestLog.start();

  console.log(`\nAddon running at: ${host}/manifest.json`);
  console.log(`Dashboard:        ${host}/dashboard`);
  console.log(`Health check:     ${host}/health`);
  console.log('Install in Stremio by opening the manifest URL above.\n');

  if (config.dashboardPassword) {
    console.log('Dashboard password: set via DASHBOARD_PASSWORD env var');
  } else if (authIsFirstRun()) {
    const ntfyNote = config.ntfyTopic ? ` and sent to ntfy.sh/${config.ntfyTopic}` : '';
    console.log(`Dashboard password saved to: data/dashboard-password.txt${ntfyNote}`);
  } else {
    console.log('Dashboard password: loaded from data/auth.json');
  }

  // Load the IMDB ↔ anime mapping (disk cache first, GitHub refresh in background)
  // and build the AniLibria catalog index. Stream requests arriving before
  // these are ready wait briefly for them.
  mapping.init().catch(err => console.error('[mapping] Initialization failed:', err.message));
  resolver.warmup();

  // Live catalogs: AniLibria update poller (every minute) and AniList trending (every 5 minutes)
  releasing.start();
  trending.start();

  // Missing titles: classify imported entries, fetch titles, recheck hourly
  missing.start();
  alerts.start();

  // Imported v1 statistics are saved in their new stores: retire the old files
  setTimeout(() => {
    JsonStore.flushAll().then(() => legacy.retire()).catch(err => console.warn('[migration]', err.message));
  }, 15_000).unref();

  // Self-ping keep-alive to prevent free-tier spin-down
  let pingTimer = null;
  if (config.publicUrl) {
    pingTimer = setInterval(() => {
      const started = Date.now();
      http.request(`${config.publicUrl}/health`, { service: 'keepalive', timeout: 10_000, responseType: 'text' })
        .then(() => {
          jobs.report('keepalive', { ok: true, message: 'Ping OK', durationMs: Date.now() - started });
          console.log('[keepalive] Ping OK');
        })
        .catch(err => {
          jobs.report('keepalive', { ok: false, message: err.message, durationMs: Date.now() - started });
          console.warn('[keepalive] Ping failed:', err.message);
        });
    }, KEEPALIVE_INTERVAL_MS);
    pingTimer.unref();
    console.log('[keepalive] Self-ping enabled (every 12 min)');

    // Register with the Stremio Community Addons catalog
    const started = Date.now();
    http.postJson('https://api.strem.io/api/addonPublish', {
      transportUrl: `${config.addonUrl}/manifest.json`,
      transportName: 'http',
    }, { service: 'Stremio publish', timeout: 15_000 })
      .then(r => {
        jobs.report('stremio-publish', { ok: true, message: JSON.stringify(r).slice(0, 200), durationMs: Date.now() - started });
        console.log('[publish] Registered with Stremio Community:', JSON.stringify(r));
      })
      .catch(err => {
        jobs.report('stremio-publish', { ok: false, message: err.message, durationMs: Date.now() - started });
        console.warn('[publish] Failed to register with Stremio:', err.message);
      });
  }

  // Graceful shutdown: stop accepting connections, persist state, exit
  let shuttingDown = false;
  async function shutdown(signal) {
    if (shuttingDown) return;
    shuttingDown = true;
    console.log(`[shutdown] ${signal} received, closing server...`);
    setTimeout(() => process.exit(0), SHUTDOWN_TIMEOUT_MS).unref();

    if (pingTimer) clearInterval(pingTimer);
    requestLog.stop();
    catalog.stop();
    releasing.stop();
    trending.stop();
    missing.stop();
    alerts.stop();
    processMetrics.stop();

    const closed = new Promise(resolve => server.close(resolve));
    server.closeIdleConnections?.();
    await Promise.all([
      closed,
      lifecycle.markShutdown(signal).catch(() => {}),
      JsonStore.flushAll().catch(err => console.warn('[shutdown] Failed to save state:', err.message)),
    ]);
    console.log('[shutdown] Server closed, state saved.');
    process.exit(0);
  }
  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('SIGINT', () => shutdown('SIGINT'));
}

start().catch(err => {
  console.error('[boot] Fatal startup error:', err);
  process.exit(1);
});
