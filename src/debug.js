/**
 * Debug module — live log capture and diagnostic HTTP routes.
 *
 * Must be required FIRST in index.js so console is patched before
 * any other module logs anything.
 */

const { Router } = require('express');
const resolver = require('./bridge/resolver');

// ─── Log capture ─────────────────────────────────────────────────────────────

const MAX_LOGS = 300;
const logBuffer = [];

function capture(level, original) {
  return function (...args) {
    const line = `[${new Date().toISOString()}] [${level}] ${args.map(a =>
      typeof a === 'object' ? JSON.stringify(a) : String(a)
    ).join(' ')}`;
    logBuffer.push(line);
    if (logBuffer.length > MAX_LOGS) logBuffer.shift();
    original.apply(console, args);
  };
}

console.log   = capture('LOG',   console.log);
console.warn  = capture('WARN',  console.warn);
console.error = capture('ERROR', console.error);

function getLogs() {
  return logBuffer.slice();
}

// ─── HTML helpers ─────────────────────────────────────────────────────────────

function colorLine(line) {
  if (line.includes('[ERROR]')) return `<span style="color:#ff5555">${esc(line)}</span>`;
  if (line.includes('[WARN]'))  return `<span style="color:#ffaa00">${esc(line)}</span>`;
  return esc(line);
}

function esc(str) {
  return str.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

// ─── Routes ───────────────────────────────────────────────────────────────────

const router = Router();

/**
 * GET /debug
 * HTML page showing recent server logs, auto-refreshes every 4 seconds.
 * Includes a form to test-resolve an IMDB ID.
 */
router.get('/debug', (req, res) => {
  const lines = getLogs().map(colorLine).join('\n');
  res.setHeader('Content-Type', 'text/html; charset=utf-8');
  res.send(`<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta http-equiv="refresh" content="4">
  <title>Addon Debug</title>
  <style>
    body { background:#111; color:#ddd; font-family:monospace; padding:16px; margin:0 }
    h1 { color:#fff; margin:0 0 12px }
    form { margin-bottom:16px; display:flex; gap:8px; align-items:center }
    input { background:#222; border:1px solid #555; color:#fff; padding:6px 10px;
            font-family:monospace; font-size:14px; width:220px; border-radius:4px }
    button { background:#3a7; border:none; color:#fff; padding:7px 16px;
             font-family:monospace; font-size:14px; cursor:pointer; border-radius:4px }
    button:hover { background:#4b8 }
    pre { background:#1a1a1a; border:1px solid #333; padding:12px; overflow-x:auto;
          font-size:12px; line-height:1.5; white-space:pre-wrap; word-break:break-all }
    .note { color:#888; font-size:12px; margin-bottom:8px }
  </style>
</head>
<body>
  <h1>Stremio AniLibria — Debug</h1>

  <form action="" method="GET" onsubmit="
    var id = document.getElementById('imdb').value.trim();
    if(id) { window.location='/debug/resolve/'+id; return false; }
  ">
    <label style="color:#aaa">Test IMDB ID:</label>
    <input id="imdb" type="text" placeholder="tt13916776" />
    <button type="submit">Resolve</button>
  </form>

  <div class="note">Showing last ${logBuffer.length} of ${MAX_LOGS} log lines. Auto-refreshes every 4s.</div>
  <pre>${lines || '<em style="color:#666">No logs yet...</em>'}</pre>
</body>
</html>`);
});

/**
 * GET /debug/resolve/:imdbId
 * Forces re-resolution of an IMDB ID (bypasses cache) and returns JSON
 * with the resolved Anilibria ID + recent log lines.
 */
router.get('/debug/resolve/:imdbId', async (req, res) => {
  const { imdbId } = req.params;
  const logsBefore = logBuffer.length;

  let anilibriaId = null;
  let error = null;

  try {
    // Force re-resolution by clearing the cache entry
    resolver.clearCache(imdbId);
    anilibriaId = await resolver.resolveImdbToAnilibria(imdbId);
  } catch (err) {
    error = err.message;
  }

  // Grab only the log lines produced during this resolution
  const newLogs = logBuffer.slice(logsBefore);

  res.json({ imdbId, anilibriaId, error, logs: newLogs });
});

/**
 * GET /debug/logs
 * Raw JSON array of all buffered log lines.
 */
router.get('/debug/logs', (req, res) => {
  res.json(getLogs());
});

module.exports = { router, getLogs };
