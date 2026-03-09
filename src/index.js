/**
 * Stremio AniLibria Addon — Entry Point
 */

// Must be first — patches console before any other module logs
const { router: debugRouter } = require('./debug');

const { addonBuilder, getRouter } = require('stremio-addon-sdk');
const express = require('express');
const cors    = require('cors');

const manifest          = require('./manifest');
const mappingCache      = require('./mapping/cache');
const { streamHandler } = require('./handlers/streams');
const { warmup }        = require('./bridge/resolver');

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

// Build the addon
const builder = new addonBuilder(manifest);
builder.defineStreamHandler(streamHandler);

async function start() {
  console.log('=== Stremio AniLibria Addon ===');

  // Load the Fribb IMDB mapping (required for all lookups)
  try {
    await mappingCache.load();
  } catch (err) {
    console.error('[boot] Fribb mapping failed to load:', err.message);
    console.warn('[boot] Retrying mapping load in 30 seconds...');
    setTimeout(() => mappingCache.load().catch(console.error), 30_000);
  }

  // Start the HTTP server
  const addonInterface = builder.getInterface();
  const app = express();
  app.use(cors());
  app.use('/', getRouter(addonInterface));
  app.use('/', debugRouter);
  app.listen(PORT);

  const host = process.env.RENDER_EXTERNAL_URL || `http://localhost:${PORT}`;
  console.log(`\nAddon running at: ${host}/manifest.json`);
  console.log(`Debug page:       ${host}/debug`);
  console.log('Install in Stremio by opening the manifest URL above.\n');

  // Pre-warm the Anilibria title index in the background
  warmup();
}

start().catch(err => {
  console.error('[boot] Fatal startup error:', err);
  process.exit(1);
});
