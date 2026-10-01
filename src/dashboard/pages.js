/**
 * Server-rendered HTML: the login page and the app shell.
 *
 * Both are static apart from escaped values; no inline scripts or styles
 * (see the Content-Security-Policy in index.js).
 */

const { version } = require('../../package.json');

// Pinned Chart.js build with Subresource Integrity
const CHART_JS_URL = 'https://cdn.jsdelivr.net/npm/chart.js@4.5.1/dist/chart.umd.min.js';
const CHART_JS_SRI = 'sha384-jb8JQMbMoBUzgWatfe6COACi2ljcDdZQ2OxczGA3bGNeWe+6DChMTBJemed7ZnvJ';

const TABS = [
  { id: 'overview', label: 'Overview' },
  { id: 'traffic',  label: 'Traffic' },
  { id: 'content',  label: 'Content' },
  { id: 'missing',  label: 'Missing titles' },
  { id: 'logs',     label: 'Logs' },
  { id: 'admin',    label: 'Admin' },
];

function esc(str) {
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function head(title) {
  const v = encodeURIComponent(version);
  return `<meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">
  <meta name="color-scheme" content="dark">
  <meta name="robots" content="noindex, nofollow">
  <title>${esc(title)}</title>
  <link rel="icon" href="/logo.jpg">
  <link rel="stylesheet" href="/dashboard/assets/dashboard.css?v=${v}">`;
}

/** The single-page app shell; public/app.js renders the pages. */
function renderShell() {
  const v = encodeURIComponent(version);
  const tabs = TABS.map(t => `<a class="nav-tab" href="/dashboard?tab=${t.id}" data-tab="${t.id}">${esc(t.label)}</a>`).join('');
  return `<!DOCTYPE html>
<html lang="en">
<head>
  ${head('AniLibria · Dashboard')}
  <script src="${CHART_JS_URL}" integrity="${CHART_JS_SRI}" crossorigin="anonymous" defer></script>
  <script type="module" src="/dashboard/assets/app.js?v=${v}"></script>
</head>
<body>
  <a class="skip-link" href="#main">Skip to content</a>
  <header class="topbar">
    <div class="topbar-inner">
      <a class="brand" href="/dashboard?tab=overview" data-tab="overview">
        <img src="/logo.jpg" alt="" class="brand-logo" width="28" height="28">
        <span class="brand-name">AniLibria</span>
        <span class="brand-sub">Dashboard</span>
      </a>
      <div class="topbar-meta">
        <span class="chip chip-muted" id="hdr-version" title="Addon version">v${esc(version)}</span>
        <span class="chip chip-muted" id="hdr-uptime" title="Server uptime">up —</span>
        <span class="live-chip" id="hdr-live" role="status" aria-live="polite"><span class="dot"></span><span class="live-text">Connecting…</span></span>
      </div>
      <form class="signout" method="post" action="/dashboard/logout">
        <button type="submit" class="btn btn-ghost btn-sm">Sign out</button>
      </form>
    </div>
    <nav class="nav" aria-label="Dashboard sections">
      <div class="nav-inner">${tabs}</div>
    </nav>
  </header>
  <div id="banner-slot"></div>
  <main id="main" class="page" tabindex="-1">
    <div class="state state-loading">Loading…</div>
  </main>
  <div id="drawer-root"></div>
  <div id="toasts" class="toasts" aria-live="polite" aria-atomic="false"></div>
  <noscript><div class="page"><div class="state">The dashboard needs JavaScript enabled.</div></div></noscript>
</body>
</html>`;
}

function renderLogin(error, next = '/dashboard') {
  return `<!DOCTYPE html>
<html lang="en">
<head>
  ${head('Sign in · AniLibria Dashboard')}
</head>
<body class="login-body">
  <main class="login-box">
    <img src="/logo.jpg" alt="AniLibria" class="login-logo" width="56" height="56">
    <h1>AniLibria Dashboard</h1>
    ${error ? `<div class="login-error" role="alert">${esc(error)}</div>` : ''}
    <form method="POST" action="/dashboard/login">
      <input type="hidden" name="next" value="${esc(next)}">
      <label for="pw">Password</label>
      <input type="password" id="pw" name="password" autofocus autocomplete="current-password" required>
      <button type="submit" class="btn btn-primary btn-block">Sign in</button>
    </form>
  </main>
</body>
</html>`;
}

module.exports = { renderShell, renderLogin, TABS };
