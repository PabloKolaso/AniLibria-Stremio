/**
 * Dashboard — Express Router + HTML Templates
 *
 * Serves /dashboard with 4 tabs: Overview, Analytics, Logs, Failed Lookups.
 * Server-rendered HTML with Chart.js from CDN for analytics charts.
 */

const { Router } = require('express');
const logger = require('./logger');
const stats  = require('./stats');
const users  = require('./users');
const { getLogs: getConsoleLogs } = require('./debug');
const { getCacheStats } = require('./bridge/resolver');

const router = Router();

const IMDB_RE = /^tt\d{7,10}$/;

// Parse form bodies for the login POST and JSON for API endpoints
router.use(require('express').urlencoded({ extended: false }));
router.use(require('express').json());

// ─── HTML Helpers ────────────────────────────────────────────────────────────

function esc(str) {
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function formatBytes(bytes) {
  if (bytes < 1024) return bytes + ' B';
  if (bytes < 1024 * 1024) return (bytes / 1024).toFixed(1) + ' KB';
  if (bytes < 1024 * 1024 * 1024) return (bytes / (1024 * 1024)).toFixed(1) + ' MB';
  return (bytes / (1024 * 1024 * 1024)).toFixed(2) + ' GB';
}

function formatUptime(seconds) {
  const d = Math.floor(seconds / 86400);
  const h = Math.floor((seconds % 86400) / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  if (d > 0) return `${d}d ${h}h ${m}m`;
  if (h > 0) return `${h}h ${m}m`;
  return `${m}m`;
}

function formatDate(ts) {
  return new Date(ts).toISOString().replace('T', ' ').slice(0, 19);
}

// ─── Shell (shared layout) ───────────────────────────────────────────────────

function renderShell(activeTab, bodyHtml) {
  const tabs = [
    { id: 'overview',  label: 'Overview' },
    { id: 'analytics', label: 'Analytics' },
    { id: 'logs',      label: 'Logs' },
    { id: 'failed',    label: 'Failed Lookups' },
    { id: 'terminal',  label: 'Terminal' },
  ];

  const tabLinks = tabs.map(t =>
    `<a href="/dashboard?tab=${t.id}" class="tab${t.id === activeTab ? ' active' : ''}">${t.label}</a>`
  ).join('');

  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <title>AniLibria Dashboard</title>
  <style>
    *, *::before, *::after { box-sizing: border-box; margin: 0; padding: 0 }
    body { background: #080810; color: #e0e0e0; font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif; padding: 0; min-height: 100vh }
    body::before {
      content: '';
      position: fixed;
      inset: 0;
      background:
        radial-gradient(ellipse 80% 60% at 20% 10%, rgba(120, 40, 140, 0.12) 0%, transparent 60%),
        radial-gradient(ellipse 60% 50% at 80% 80%, rgba(180, 30, 30, 0.10) 0%, transparent 55%),
        radial-gradient(ellipse 50% 40% at 50% 50%, rgba(40, 20, 80, 0.08) 0%, transparent 70%);
      pointer-events: none;
      z-index: 0;
    }

    /* Header — glassmorphic */
    .header { background: rgba(14, 14, 26, 0.8); backdrop-filter: blur(12px); -webkit-backdrop-filter: blur(12px); border-bottom: 1px solid rgba(26, 26, 46, 0.8); padding: 14px 24px; display: flex; align-items: center; gap: 24px; position: sticky; top: 0; z-index: 100 }
    .header h1 { color: #fff; font-size: 17px; white-space: nowrap; display: flex; align-items: center; gap: 10px; font-weight: 700 }
    .header-logo { width: 28px; height: 28px; border-radius: 7px; border: 1px solid #1a1a2e }
    .tabs { display: flex; gap: 4px }
    .tab { color: #666; text-decoration: none; padding: 8px 18px; border-radius: 8px; font-size: 13px; font-weight: 500; transition: all 0.25s ease }
    .tab:hover { color: #ccc; background: rgba(255, 255, 255, 0.05) }
    .tab.active { color: #fff; background: linear-gradient(135deg, #cc3333 0%, #991a1a 100%); box-shadow: 0 2px 12px rgba(204, 51, 51, 0.3) }
    .logout-btn { margin-left: auto; color: #555; text-decoration: none; font-size: 12px; padding: 6px 14px; border: 1px solid #1a1a2e; border-radius: 8px; transition: all 0.25s }
    .logout-btn:hover { color: #ccc; border-color: #333; background: rgba(255,255,255,0.03) }
    .content { padding: 24px; max-width: 1200px; margin: 0 auto; position: relative; z-index: 1; animation: fadeIn 0.2s ease }
    @keyframes fadeIn { from { opacity: 0; transform: translateY(4px) } to { opacity: 1; transform: translateY(0) } }

    /* Cards */
    .cards { display: grid; grid-template-columns: repeat(auto-fit, minmax(200px, 1fr)); gap: 16px; margin-bottom: 24px }
    .card { background: #0e0e1a; border: 1px solid #1a1a2e; border-radius: 14px; padding: 20px; position: relative; overflow: hidden; transition: transform 0.2s ease, box-shadow 0.2s ease, border-color 0.2s ease }
    .card::before { content: ''; position: absolute; top: 0; left: 0; right: 0; height: 2px; background: linear-gradient(to right, #cc3333, #7b3fa0); opacity: 0.6 }
    .card:hover { transform: translateY(-2px); box-shadow: 0 8px 24px rgba(0, 0, 0, 0.3), 0 0 0 1px rgba(204, 51, 51, 0.1); border-color: #252535 }
    .card .label { color: #666; font-size: 11px; text-transform: uppercase; letter-spacing: 1.2px; margin-bottom: 6px; font-weight: 600 }
    .card .value { color: #fff; font-size: 30px; font-weight: 700; letter-spacing: -0.5px }
    .card .sub { color: #444; font-size: 11px; margin-top: 6px }

    /* Progress bars */
    .bar-wrap { background: #111125; border-radius: 6px; height: 6px; margin-top: 8px; overflow: hidden }
    .bar-fill { height: 100%; border-radius: 6px; transition: width 0.5s ease }
    .bar-green { background: linear-gradient(90deg, #2a8a5a, #3dcc7a) }
    .bar-blue { background: linear-gradient(90deg, #3a5aaa, #5a8add) }
    .bar-orange { background: linear-gradient(90deg, #aa6633, #ddaa55) }

    /* Tables */
    table { width: 100%; border-collapse: separate; border-spacing: 0; font-size: 13px }
    th { text-align: left; color: #555; font-weight: 600; padding: 10px 14px; border-bottom: 1px solid #1a1a2e; font-size: 11px; text-transform: uppercase; letter-spacing: 0.8px; background: rgba(14, 14, 26, 0.5) }
    th:first-child { border-radius: 8px 0 0 0 }
    th:last-child { border-radius: 0 8px 0 0 }
    td { padding: 10px 14px; border-bottom: 1px solid rgba(26, 26, 46, 0.5); vertical-align: top }
    tr:hover td { background: rgba(204, 51, 51, 0.03) }
    tbody tr:nth-child(even) td { background: rgba(14, 14, 26, 0.3) }
    tbody tr:nth-child(even):hover td { background: rgba(204, 51, 51, 0.05) }
    .table-wrap { background: #0e0e1a; border: 1px solid #1a1a2e; border-radius: 12px; overflow: hidden }
    .badge { display: inline-block; padding: 3px 10px; border-radius: 6px; font-size: 11px; font-weight: 600; letter-spacing: 0.3px }
    .badge-success { background: linear-gradient(135deg, #0f2a1a, #1a3a2a); color: #3dcc7a; border: 1px solid #1a3a2a }
    .badge-fail { background: linear-gradient(135deg, #2a0f0f, #3a1a1a); color: #cc5555; border: 1px solid #3a1a1a }
    .badge-error { background: linear-gradient(135deg, #2a1a0a, #3a2a1a); color: #cc8833; border: 1px solid #3a2a1a }
    .badge-method { background: linear-gradient(135deg, #0f1a2a, #1a2a3a); color: #5588cc; border: 1px solid #1a2a3a }
    .badge-anime { background: linear-gradient(135deg, #0f2a1a, #1a3a2a); color: #3dcc7a; border: 1px solid #1a3a2a }
    .badge-not-anime { background: linear-gradient(135deg, #15151f, #1e1e2a); color: #555; border: 1px solid #1e1e2a }
    a.imdb-link { color: #5588cc; text-decoration: none; transition: color 0.2s }
    a.imdb-link:hover { color: #77aaee; text-decoration: underline }

    /* Filters */
    .filters { display: flex; gap: 10px; margin-bottom: 16px; flex-wrap: wrap; align-items: center }
    .filters input, .filters select { background: #0f0f18; border: 1px solid #22223a; color: #ccc; padding: 8px 12px; border-radius: 8px; font-size: 13px; transition: border-color 0.2s }
    .filters input:focus, .filters select:focus { outline: none; border-color: #444 }
    .filters button { background: linear-gradient(135deg, #cc3333 0%, #991a1a 100%); border: none; color: #fff; padding: 8px 20px; border-radius: 8px; cursor: pointer; font-size: 13px; font-weight: 600; transition: transform 0.15s, box-shadow 0.15s }
    .filters button:hover { transform: translateY(-1px); box-shadow: 0 4px 16px rgba(204, 51, 51, 0.3) }
    .filters .btn-secondary { background: #0f0f18; border: 1px solid #22223a; color: #888 }
    .filters .btn-secondary:hover { color: #ccc; border-color: #444; background: #16162a; box-shadow: none; transform: none }

    /* Charts */
    .chart-grid { display: grid; grid-template-columns: 1fr 1fr; gap: 20px; margin-bottom: 24px }
    .chart-box { background: #0e0e1a; border: 1px solid #1a1a2e; border-radius: 14px; padding: 20px; position: relative; overflow: hidden; box-shadow: 0 4px 20px rgba(0, 0, 0, 0.2) }
    .chart-box::before { content: ''; position: absolute; top: 0; left: 0; right: 0; height: 2px; background: linear-gradient(to right, #cc3333, #7b3fa0); opacity: 0.4 }
    .chart-box h3 { color: #888; font-size: 13px; margin-bottom: 12px; font-weight: 600; letter-spacing: 0.3px }
    canvas { max-height: 250px }

    /* Top anime */
    .top-list { list-style: none }
    .top-list li { padding: 10px 4px; border-bottom: 1px solid rgba(26, 26, 46, 0.4); display: flex; justify-content: space-between; transition: all 0.15s; border-radius: 4px }
    .top-list li:hover { background: rgba(204, 51, 51, 0.03); padding-left: 8px }
    .top-list li:last-child { border: none }
    .top-count { color: #cc3333; font-weight: 700 }

    /* Section titles */
    .section-title { color: #888; font-size: 13px; font-weight: 600; margin-bottom: 12px; padding-bottom: 8px; border-bottom: 1px solid rgba(26, 26, 46, 0.6); letter-spacing: 0.3px }

    /* Terminal */
    .terminal-wrap { background: #08080f; border: 1px solid #1a1a2e; border-radius: 12px; overflow: hidden }
    .terminal-titlebar { background: #0e0e1a; border-bottom: 1px solid #1a1a2e; padding: 10px 16px; display: flex; align-items: center; gap: 8px }
    .terminal-dot { width: 10px; height: 10px; border-radius: 50% }
    .terminal-dot.red { background: #cc3333 }
    .terminal-dot.yellow { background: #ccaa33 }
    .terminal-dot.green { background: #33cc77 }
    .terminal-title { color: #555; font-size: 12px; font-family: 'SF Mono', 'Fira Code', 'Consolas', monospace; margin-left: 8px }
    .terminal-body { padding: 16px; font-size: 12px; font-family: 'SF Mono', 'Fira Code', 'Consolas', 'Menlo', monospace; overflow: auto; max-height: 70vh; white-space: pre-wrap; word-break: break-all; line-height: 1.6; color: #aaa; position: relative }
    .terminal-body::after { content: ''; position: absolute; inset: 0; background: repeating-linear-gradient(0deg, transparent, transparent 2px, rgba(0,0,0,0.03) 2px, rgba(0,0,0,0.03) 4px); pointer-events: none }
    .term-btn { background: #0f0f18; border: 1px solid #22223a; color: #666; padding: 5px 14px; border-radius: 6px; cursor: pointer; font-size: 12px; transition: all 0.2s }
    .term-btn:hover { color: #ccc; border-color: #444; background: #16162a }

    /* KPI hero cards */
    .kpi-grid { display: grid; grid-template-columns: repeat(4, 1fr); gap: 16px; margin-bottom: 20px }
    .kpi-card { background: #0e0e1a; border: 1px solid #1a1a2e; border-radius: 14px; padding: 22px 22px 18px; position: relative; overflow: hidden; transition: all 0.2s }
    .kpi-card:hover { border-color: #252535; transform: translateY(-1px) }
    .kpi-icon { font-size: 1.2rem; margin-bottom: 10px; line-height: 1; opacity: 0.8 }
    .kpi-value { color: #fff; font-size: 2.4rem; font-weight: 800; letter-spacing: -1.5px; line-height: 1 }
    .kpi-label { color: #555; font-size: 11px; font-weight: 700; text-transform: uppercase; letter-spacing: 1.3px; margin-bottom: 8px }
    .kpi-sub { color: #444; font-size: 12px; margin-top: 8px }
    .kpi-accent { position: absolute; bottom: 0; left: 0; right: 0; height: 2px }

    /* Live sessions pulse dot */
    .live-dot { display: inline-block; width: 8px; height: 8px; border-radius: 50%; margin-right: 5px; background: #333; vertical-align: middle }
    .live-dot.active { background: #3dcc7a; animation: live-pulse 2s ease-in-out infinite }
    @keyframes live-pulse { 0%,100% { box-shadow: 0 0 0 0 rgba(61,204,122,0.5) } 50% { box-shadow: 0 0 0 6px rgba(61,204,122,0) } }

    /* Info panels */
    .info-grid { display: grid; grid-template-columns: repeat(3, 1fr); gap: 16px; margin-bottom: 20px }
    .info-panel { background: #0e0e1a; border: 1px solid #1a1a2e; border-radius: 14px; padding: 18px 20px }
    .info-panel-title { color: #555; font-size: 11px; font-weight: 700; text-transform: uppercase; letter-spacing: 1.3px; margin-bottom: 14px; display: flex; align-items: center; gap: 8px }
    .info-panel-title::after { content: ''; flex: 1; height: 1px; background: rgba(26,26,46,0.8) }
    .info-row { display: flex; justify-content: space-between; align-items: center; padding: 8px 0; border-bottom: 1px solid rgba(26,26,46,0.4) }
    .info-row:last-child { border: none; padding-bottom: 0 }
    .info-row-label { color: #555; font-size: 12px }
    .info-row-value { color: #ddd; font-size: 13px; font-weight: 600 }
    .info-row-value.accent-green { color: #3dcc7a }
    .info-row-value.accent-amber { color: #ccaa33 }
    .info-row-value.accent-red { color: #cc5555 }

    /* Mini inline bar for cache rate */
    .mini-bar-wrap { background: #111125; border-radius: 3px; height: 4px; width: 56px; display: inline-block; vertical-align: middle; overflow: hidden; margin-left: 8px }
    .mini-bar-fill { height: 100%; border-radius: 3px; background: linear-gradient(90deg, #cc3333, #7b3fa0) }

    /* Bottom 60/40 grid */
    .bottom-grid { display: grid; grid-template-columns: 3fr 2fr; gap: 16px }

    /* Custom scrollbar */
    ::-webkit-scrollbar { width: 8px; height: 8px }
    ::-webkit-scrollbar-track { background: #080810 }
    ::-webkit-scrollbar-thumb { background: #1a1a2e; border-radius: 4px }
    ::-webkit-scrollbar-thumb:hover { background: #2a2a3e }
    ::selection { background: rgba(204, 51, 51, 0.3); color: #fff }

    @media (max-width: 900px) {
      .kpi-grid { grid-template-columns: repeat(2, 1fr) }
      .info-grid { grid-template-columns: 1fr }
      .bottom-grid { grid-template-columns: 1fr }
    }

    @media (max-width: 768px) {
      .chart-grid { grid-template-columns: 1fr }
      .cards { grid-template-columns: repeat(2, 1fr) }
      .header { flex-direction: column; gap: 12px }
      table thead { display: none }
      table tbody tr { display: block; margin-bottom: 12px; background: #0e0e1a; border: 1px solid #1a1a2e; border-radius: 12px; padding: 12px }
      table tbody tr:hover td { background: transparent }
      table tbody td { display: block; padding: 4px 0; border: none; font-size: 13px }
      table tbody td::before { content: attr(data-label); color: #555; font-size: 11px; text-transform: uppercase; letter-spacing: 0.5px; display: block; margin-bottom: 2px }
    }
  </style>
</head>
<body>
  <div class="header">
    <h1><img src="/logo.jpg" alt="" class="header-logo">AniLibria Dashboard</h1>
    <div class="tabs">${tabLinks}</div>
  </div>
  <div class="content">${bodyHtml}</div>
</body>
</html>`;
}

// ─── Tab 1: Overview ─────────────────────────────────────────────────────────

function renderOverview() {
  const s = stats.getStats();
  const sys = stats.getSystemStats();
  const allLogs = logger.getAllLogs();
  const topAnime = stats.getTopAnime(allLogs, 5);

  const uc = users.getUserCounts();
  const cache = getCacheStats();
  const ramPercent = sys.totalMem > 0 ? ((sys.rssBytes / sys.totalMem) * 100).toFixed(1) : 0;

  const successRateNum = parseFloat(s.successRate) || 0;
  const successAccent = successRateNum >= 90 ? 'accent-green' : successRateNum >= 70 ? 'accent-amber' : 'accent-red';
  const liveDotClass = s.liveSessions > 0 ? 'live-dot active' : 'live-dot';
  const heapPct = sys.heapTotal > 0 ? ((sys.heapUsed / sys.heapTotal) * 100).toFixed(1) : 0;

  let topHtml = '<div style="color:#555;font-size:13px;padding:16px 0">No requests recorded yet</div>';
  if (topAnime.length > 0) {
    topHtml = '<ul class="top-list">' + topAnime.map((a, i) =>
      `<li><span style="display:flex;align-items:center;gap:10px"><span style="color:#333;font-size:11px;font-weight:700;min-width:18px">#${i + 1}</span><span style="color:#ccc">${esc(a.title)}</span></span><span class="top-count">${a.count} req</span></li>`
    ).join('') + '</ul>';
  }

  return `
    <!-- Row 1: Hero KPIs -->
    <div class="kpi-grid">
      <div class="kpi-card">
        <div class="kpi-label">Requests Today</div>
        <div class="kpi-value" data-stat="todayRequests">${s.todayRequests}</div>
        <div class="kpi-sub" data-stat-sub="todayRequestsSub">this week: <span data-stat="weekRequests">${s.weekRequests}</span></div>
        <div class="kpi-accent" style="background:linear-gradient(90deg,#3dcc7a,#2a8a5a)"></div>
      </div>
      <div class="kpi-card">
        <div class="kpi-label">Users This Month</div>
        <div class="kpi-value" data-stat="usersMonth">${uc.month}</div>
        <div class="kpi-sub">today: <span data-stat="usersToday">${uc.today}</span> &nbsp;&bull;&nbsp; week: <span data-stat="usersWeek">${uc.week}</span></div>
        <div class="kpi-accent" style="background:linear-gradient(90deg,#5a8add,#3a5aaa)"></div>
      </div>
      <div class="kpi-card">
        <div class="kpi-label">Success Rate</div>
        <div class="kpi-value ${successAccent}" data-stat="successRate">${s.successRate}%</div>
        <div class="kpi-sub" data-stat-sub="successRateSub">${s.counters.animeSuccess} / ${s.counters.animeRequests} anime lookups</div>
        <div class="kpi-accent" style="background:linear-gradient(90deg,#cc3333,#7b3fa0)"></div>
      </div>
      <div class="kpi-card">
        <div class="kpi-label">Live Sessions</div>
        <div class="kpi-value" style="display:flex;align-items:center;gap:10px">
          <span class="${liveDotClass}" id="liveDot"></span>
          <span data-stat="liveSessions">${s.liveSessions}</span>
        </div>
        <div class="kpi-sub">total: <span data-stat="totalSessions">${s.counters.totalSessions}</span> all time</div>
        <div class="kpi-accent" style="background:linear-gradient(90deg,#cc8833,#7b3f0a)"></div>
      </div>
    </div>

    <!-- Row 2: Info Panels -->
    <div class="info-grid">
      <div class="info-panel">
        <div class="info-panel-title">Traffic</div>
        <div class="info-row">
          <span class="info-row-label">Today</span>
          <span class="info-row-value" data-stat="todayRequests">${s.todayRequests}</span>
        </div>
        <div class="info-row">
          <span class="info-row-label">This Week</span>
          <span class="info-row-value" data-stat="weekRequests">${s.weekRequests}</span>
        </div>
        <div class="info-row">
          <span class="info-row-label">This Month</span>
          <span class="info-row-value" data-stat="monthRequests">${s.monthRequests}</span>
        </div>
        <div class="info-row">
          <span class="info-row-label">Anime Found</span>
          <span class="info-row-value accent-green" data-stat="animeSuccess">${s.counters.animeSuccess}</span>
        </div>
        <div class="info-row">
          <span class="info-row-label">Bandwidth</span>
          <span class="info-row-value" data-stat="bandwidth">${formatBytes(stats.getTotalBandwidth())}</span>
        </div>
      </div>
      <div class="info-panel">
        <div class="info-panel-title">Users</div>
        <div class="info-row">
          <span class="info-row-label">Today</span>
          <span class="info-row-value" data-stat="usersToday">${uc.today}</span>
        </div>
        <div class="info-row">
          <span class="info-row-label">This Week</span>
          <span class="info-row-value" data-stat="usersWeek">${uc.week}</span>
        </div>
        <div class="info-row">
          <span class="info-row-label">This Month</span>
          <span class="info-row-value" data-stat="usersMonth">${uc.month}</span>
        </div>
        <div class="info-row">
          <span class="info-row-label">Total Sessions</span>
          <span class="info-row-value" data-stat="totalSessions">${s.counters.totalSessions}</span>
        </div>
        <div class="info-row">
          <span class="info-row-label">Active Now</span>
          <span class="info-row-value" data-stat="liveSessions">${s.liveSessions}</span>
        </div>
      </div>
      <div class="info-panel">
        <div class="info-panel-title">Performance</div>
        <div class="info-row">
          <span class="info-row-label">Cache Hit Rate</span>
          <span class="info-row-value">
            <span data-stat="cacheHitRate">${cache.hitRate}%</span>
            <span class="mini-bar-wrap"><span class="mini-bar-fill" id="cacheBar" style="width:${Math.min(cache.hitRate, 100)}%"></span></span>
          </span>
        </div>
        <div class="info-row">
          <span class="info-row-label">Cache</span>
          <span class="info-row-value" style="font-size:12px" data-stat-sub="cacheHitSub">${cache.hits} hits / ${cache.misses} misses</span>
        </div>
        <div class="info-row">
          <span class="info-row-label">Cached Titles</span>
          <span class="info-row-value" data-stat-sub="cacheSizeVal">${cache.cacheSize}</span>
        </div>
        <div class="info-row">
          <span class="info-row-label">Uptime</span>
          <span class="info-row-value" data-stat="uptime">${formatUptime(sys.uptime)}</span>
        </div>
        <div class="info-row">
          <span class="info-row-label">Platform</span>
          <span class="info-row-value" style="font-size:12px;color:#555">${sys.nodeVersion} / ${sys.platform}</span>
        </div>
      </div>
    </div>

    <!-- Row 3: Top Anime + System Resources -->
    <div class="bottom-grid">
      <div class="card">
        <div class="section-title">Top 5 Anime</div>
        <div id="topAnimeList">${topHtml}</div>
      </div>
      <div class="card">
        <div class="section-title">System Resources</div>
        <div style="margin-bottom:16px">
          <div style="display:flex;justify-content:space-between;font-size:12px;color:#555;margin-bottom:6px">
            <span>RAM</span><span data-stat="ramLabel">${formatBytes(sys.rssBytes)} / ${formatBytes(sys.totalMem)} (${ramPercent}%)</span>
          </div>
          <div class="bar-wrap"><div class="bar-fill bar-green" data-stat-bar="ram" style="width:${Math.min(ramPercent, 100)}%"></div></div>
        </div>
        <div style="margin-bottom:16px">
          <div style="display:flex;justify-content:space-between;font-size:12px;color:#555;margin-bottom:6px">
            <span>Heap</span><span data-stat="heapLabel">${formatBytes(sys.heapUsed)} / ${formatBytes(sys.heapTotal)}</span>
          </div>
          <div class="bar-wrap"><div class="bar-fill bar-blue" data-stat-bar="heap" style="width:${heapPct}%"></div></div>
        </div>
        <div>
          <div style="display:flex;justify-content:space-between;font-size:12px;color:#555;margin-bottom:6px">
            <span>CPU</span><span data-stat="cpuLabel">${sys.cpuUsage}%</span>
          </div>
          <div class="bar-wrap"><div class="bar-fill bar-orange" data-stat-bar="cpu" style="width:${Math.min(sys.cpuUsage, 100)}%"></div></div>
        </div>
      </div>
    </div>
    <script>
      function _fmtBytes(b) {
        if (b < 1024) return b + ' B';
        if (b < 1048576) return (b / 1024).toFixed(1) + ' KB';
        if (b < 1073741824) return (b / 1048576).toFixed(1) + ' MB';
        return (b / 1073741824).toFixed(2) + ' GB';
      }
      function _fmtUptime(s) {
        var d = Math.floor(s / 86400), h = Math.floor((s % 86400) / 3600), m = Math.floor((s % 3600) / 60);
        if (d > 0) return d + 'd ' + h + 'h ' + m + 'm';
        if (h > 0) return h + 'h ' + m + 'm';
        return m + 'm';
      }
      setInterval(function() {
        fetch('/dashboard/api/stats', { credentials: 'same-origin' })
          .then(function(r) { return r.ok ? r.json() : null; })
          .then(function(d) {
            if (!d) return;
            var map = {
              todayRequests: d.todayRequests,
              weekRequests: d.weekRequests,
              monthRequests: d.monthRequests,
              usersToday: d.users ? d.users.today : '-',
              usersWeek: d.users ? d.users.week : '-',
              usersMonth: d.users ? d.users.month : '-',
              liveSessions: d.liveSessions,
              totalSessions: d.counters.totalSessions,
              animeSuccess: d.counters.animeSuccess,
              successRate: d.successRate + '%',
              uptime: _fmtUptime(d.system.uptime),
              bandwidth: _fmtBytes(d.totalBandwidthBytes || 0),
              cacheHitRate: (d.resolverCache ? d.resolverCache.hitRate : 0) + '%',
            };
            for (var k in map) {
              var els = document.querySelectorAll('[data-stat="' + k + '"]');
              els.forEach(function(el) { el.textContent = map[k]; });
            }
            // Success rate color
            var srEl = document.querySelector('[data-stat="successRate"]');
            if (srEl) {
              var rate = parseFloat(d.successRate) || 0;
              srEl.className = rate >= 90 ? 'kpi-value accent-green' : rate >= 70 ? 'kpi-value accent-amber' : 'kpi-value accent-red';
            }
            // Live dot
            var dot = document.getElementById('liveDot');
            if (dot) dot.className = d.liveSessions > 0 ? 'live-dot active' : 'live-dot';
            // Sub labels
            var sub = document.querySelector('[data-stat-sub="successRateSub"]');
            if (sub) sub.textContent = d.counters.animeSuccess + ' / ' + d.counters.animeRequests + ' anime lookups';
            if (d.resolverCache) {
              var cacheSub = document.querySelector('[data-stat-sub="cacheHitSub"]');
              if (cacheSub) cacheSub.textContent = d.resolverCache.hits + ' hits / ' + d.resolverCache.misses + ' misses';
              var cacheSize = document.querySelector('[data-stat-sub="cacheSizeVal"]');
              if (cacheSize) cacheSize.textContent = d.resolverCache.cacheSize;
              var cacheBar = document.getElementById('cacheBar');
              if (cacheBar) cacheBar.style.width = Math.min(d.resolverCache.hitRate, 100) + '%';
            }
            // System resources
            var ramPct = d.system.totalMem > 0 ? ((d.system.rssBytes / d.system.totalMem) * 100).toFixed(1) : 0;
            var heapPct = d.system.heapTotal > 0 ? ((d.system.heapUsed / d.system.heapTotal) * 100).toFixed(1) : 0;
            var ramEl = document.querySelector('[data-stat="ramLabel"]');
            if (ramEl) ramEl.textContent = _fmtBytes(d.system.rssBytes) + ' / ' + _fmtBytes(d.system.totalMem) + ' (' + ramPct + '%)';
            var heapEl = document.querySelector('[data-stat="heapLabel"]');
            if (heapEl) heapEl.textContent = _fmtBytes(d.system.heapUsed) + ' / ' + _fmtBytes(d.system.heapTotal);
            var cpuEl = document.querySelector('[data-stat="cpuLabel"]');
            if (cpuEl) cpuEl.textContent = d.system.cpuUsage + '%';
            var ramBar = document.querySelector('[data-stat-bar="ram"]');
            if (ramBar) ramBar.style.width = Math.min(ramPct, 100) + '%';
            var heapBar = document.querySelector('[data-stat-bar="heap"]');
            if (heapBar) heapBar.style.width = Math.min(heapPct, 100) + '%';
            var cpuBar = document.querySelector('[data-stat-bar="cpu"]');
            if (cpuBar) cpuBar.style.width = Math.min(d.system.cpuUsage, 100) + '%';
          })
          .catch(function() {});
      }, 30000);

      // Top 5 Anime — refresh every 60s
      function _escHtml(s) {
        return String(s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
      }
      setInterval(function() {
        fetch('/dashboard/api/overview', { credentials: 'same-origin' })
          .then(function(r) { return r.ok ? r.json() : null; })
          .then(function(d) {
            if (!d) return;
            var el = document.getElementById('topAnimeList');
            if (!el) return;
            if (!d.topAnime || d.topAnime.length === 0) {
              el.innerHTML = '<div style="color:#555;font-size:13px;padding:16px 0">No requests recorded yet</div>';
            } else {
              el.innerHTML = '<ul class="top-list">' + d.topAnime.map(function(a, i) {
                return '<li><span style="display:flex;align-items:center;gap:10px"><span style="color:#333;font-size:11px;font-weight:700;min-width:18px">#' + (i+1) + '</span><span style="color:#ccc">' + _escHtml(a.title) + '</span></span><span class="top-count">' + a.count + ' req</span></li>';
              }).join('') + '</ul>';
            }
          })
          .catch(function() {});
      }, 60000);
    </script>`;
}

// ─── Tab 2: Analytics ────────────────────────────────────────────────────────

function renderAnalytics() {
  const buckets = stats.getHourlyBuckets();
  const bwBuckets = stats.getBandwidthBuckets();
  const now = new Date();

  // Anime-only hourly buckets derived from logs
  const animeBuckets = {};
  for (const e of logger.getAllLogs()) {
    if (e.isAnime === true) {
      const key = new Date(e.ts).toISOString().slice(0, 13);
      animeBuckets[key] = (animeBuckets[key] || 0) + 1;
    }
  }

  // Today: last 24h hourly
  const todayLabels = [];
  const todayData = [];
  const todayBwData = [];
  const todayAnimeData = [];
  for (let i = 23; i >= 0; i--) {
    const d = new Date(now.getTime() - i * 3600000);
    const key = d.toISOString().slice(0, 13);
    todayLabels.push(String(d.getUTCHours()).padStart(2, '0') + ':00');
    todayData.push(buckets[key] || 0);
    todayBwData.push(bwBuckets[key] || 0);
    todayAnimeData.push(animeBuckets[key] || 0);
  }

  // Week: last 7 days daily
  const weekLabels = [];
  const weekData = [];
  const weekBwData = [];
  const weekAnimeData = [];
  for (let i = 6; i >= 0; i--) {
    const d = new Date(now.getTime() - i * 86400000);
    const dayKey = d.toISOString().slice(0, 10);
    weekLabels.push(dayKey.slice(5));
    let total = 0, bwTotal = 0, animeTotal = 0;
    for (let h = 0; h < 24; h++) {
      const hk = dayKey + 'T' + String(h).padStart(2, '0');
      total += buckets[hk] || 0;
      bwTotal += bwBuckets[hk] || 0;
      animeTotal += animeBuckets[hk] || 0;
    }
    weekData.push(total);
    weekBwData.push(bwTotal);
    weekAnimeData.push(animeTotal);
  }

  // Month: last 30 days daily
  const monthLabels = [];
  const monthData = [];
  const monthBwData = [];
  const monthAnimeData = [];
  for (let i = 29; i >= 0; i--) {
    const d = new Date(now.getTime() - i * 86400000);
    const dayKey = d.toISOString().slice(0, 10);
    monthLabels.push(dayKey.slice(5));
    let total = 0, bwTotal = 0, animeTotal = 0;
    for (let h = 0; h < 24; h++) {
      const hk = dayKey + 'T' + String(h).padStart(2, '0');
      total += buckets[hk] || 0;
      bwTotal += bwBuckets[hk] || 0;
      animeTotal += animeBuckets[hk] || 0;
    }
    monthData.push(total);
    monthBwData.push(bwTotal);
    monthAnimeData.push(animeTotal);
  }

  return `
    <style>
      .period-btns { display:flex; gap:6px; margin-bottom:16px }
      .period-btn { background:#0f0f18; border:1px solid #22223a; color:#666; padding:8px 22px; border-radius:8px; cursor:pointer; font-size:13px; font-weight:500; transition:all 0.25s }
      .period-btn:hover { color:#ccc; border-color:#333; background:#16162a }
      .period-btn.active { background:linear-gradient(135deg, #cc3333 0%, #991a1a 100%); color:#fff; border-color:transparent; box-shadow:0 2px 12px rgba(204, 51, 51, 0.3) }
    </style>
    <div style="display:flex;align-items:center;gap:16px;margin-bottom:16px;flex-wrap:wrap">
      <div class="period-btns" style="margin-bottom:0">
        <button class="period-btn active" onclick="switchPeriod('today',this)">Today</button>
        <button class="period-btn" onclick="switchPeriod('week',this)">Week</button>
        <button class="period-btn" onclick="switchPeriod('month',this)">Month</button>
      </div>
      <label style="display:flex;align-items:center;gap:6px;color:#666;font-size:13px;cursor:pointer;user-select:none">
        <input type="checkbox" id="showAnime" style="accent-color:#cc3333;width:14px;height:14px;cursor:pointer"> Show anime requests
      </label>
    </div>
    <div class="chart-box" style="max-width:100%">
      <h3 id="chartTitle">Requests per Hour (Last 24h)</h3>
      <canvas id="mainChart" style="max-height:400px"></canvas>
    </div>
    <div class="chart-box" style="max-width:100%; margin-top:20px">
      <h3 id="bwChartTitle">Bandwidth per Hour (Last 24h)</h3>
      <canvas id="bwChart" style="max-height:400px"></canvas>
    </div>
    <script src="https://cdn.jsdelivr.net/npm/chart.js"></script>
    <script>
      function _fmtBytesChart(b) {
        if (b < 1024) return b + ' B';
        if (b < 1048576) return (b / 1024).toFixed(1) + ' KB';
        if (b < 1073741824) return (b / 1048576).toFixed(1) + ' MB';
        return (b / 1073741824).toFixed(2) + ' GB';
      }

      const DATA = {
        today: {
          labels:    ${JSON.stringify(todayLabels)},
          data:      ${JSON.stringify(todayData)},
          bwData:    ${JSON.stringify(todayBwData)},
          animeData: ${JSON.stringify(todayAnimeData)},
          type:    'bar',
          color:   'rgba(51,170,119,0.6)',
          bwColor: 'rgba(68,119,170,0.6)',
          title:   'Requests per Hour (Last 24h)',
          bwTitle: 'Bandwidth per Hour (Last 24h)'
        },
        week: {
          labels:    ${JSON.stringify(weekLabels)},
          data:      ${JSON.stringify(weekData)},
          bwData:    ${JSON.stringify(weekBwData)},
          animeData: ${JSON.stringify(weekAnimeData)},
          type:    'line',
          color:   '#3a7',
          bwColor: '#47a',
          title:   'Requests per Day (Last 7 Days)',
          bwTitle: 'Bandwidth per Day (Last 7 Days)'
        },
        month: {
          labels:    ${JSON.stringify(monthLabels)},
          data:      ${JSON.stringify(monthData)},
          bwData:    ${JSON.stringify(monthBwData)},
          animeData: ${JSON.stringify(monthAnimeData)},
          type:    'line',
          color:   '#47a',
          bwColor: '#a73',
          title:   'Requests per Day (Last 30 Days)',
          bwTitle: 'Bandwidth per Day (Last 30 Days)'
        }
      };

      const scaleOpts = {
        x: { ticks: { color: '#555', maxRotation: 45 }, grid: { color: '#111125' } },
        y: { ticks: { color: '#555' }, grid: { color: '#111125' }, beginAtZero: true }
      };

      const bwScaleOpts = {
        x: { ticks: { color: '#555', maxRotation: 45 }, grid: { color: '#111125' } },
        y: { ticks: { color: '#555', callback: function(v) { return _fmtBytesChart(v); } }, grid: { color: '#111125' }, beginAtZero: true }
      };

      let chart = null;
      let bwChart = null;
      let currentPeriod = 'today';

      function buildChart(canvasId, period, isBw) {
        const d = DATA[period];
        const isBar = d.type === 'bar';
        const values = isBw ? d.bwData : d.data;
        const clr = isBw ? d.bwColor : d.color;
        const showAnime = document.getElementById('showAnime').checked;

        const mainDataset = isBar
          ? { label: 'Total', data: values, backgroundColor: clr, borderRadius: 3 }
          : { label: 'Total', data: values, borderColor: clr, backgroundColor: clr.replace(')', ',0.1)').replace('rgb', 'rgba'), fill: true, tension: 0.3 };

        const datasets = [mainDataset];

        if (showAnime && !isBw) {
          const animeDataset = isBar
            ? { label: 'Anime', data: d.animeData, backgroundColor: 'rgba(255,180,50,0.7)', borderRadius: 3 }
            : { label: 'Anime', data: d.animeData, borderColor: '#fa3', backgroundColor: 'rgba(255,180,50,0.1)', fill: true, tension: 0.3 };
          datasets.push(animeDataset);
        }

        const scales = isBw ? bwScaleOpts : scaleOpts;
        const tooltipCb = isBw ? { callbacks: { label: function(ctx) { return _fmtBytesChart(ctx.parsed.y); } } } : {};
        const legendDisplay = showAnime && !isBw;

        return new Chart(document.getElementById(canvasId), {
          type: d.type,
          data: { labels: d.labels, datasets: datasets },
          options: {
            responsive: true,
            maintainAspectRatio: true,
            plugins: {
              legend: { display: legendDisplay, labels: { color: '#888', boxWidth: 12, padding: 10 } },
              tooltip: tooltipCb
            },
            scales: scales
          }
        });
      }

      function switchPeriod(period, btn) {
        currentPeriod = period;
        document.querySelectorAll('.period-btn').forEach(b => b.classList.remove('active'));
        btn.classList.add('active');
        document.getElementById('chartTitle').textContent = DATA[period].title;
        document.getElementById('bwChartTitle').textContent = DATA[period].bwTitle;
        if (chart) chart.destroy();
        if (bwChart) bwChart.destroy();
        chart = buildChart('mainChart', period, false);
        bwChart = buildChart('bwChart', period, true);
      }

      document.getElementById('showAnime').addEventListener('change', function() {
        if (chart) chart.destroy();
        if (bwChart) bwChart.destroy();
        chart = buildChart('mainChart', currentPeriod, false);
        bwChart = buildChart('bwChart', currentPeriod, true);
      });

      chart = buildChart('mainChart', 'today', false);
      bwChart = buildChart('bwChart', 'today', true);

      // Live data refresh — every 60s
      function _buildAnalyticsData(buckets, bwBuckets, animeBuckets) {
        var now = new Date();
        var tL = [], tD = [], tBw = [], tAn = [];
        for (var i = 23; i >= 0; i--) {
          var d = new Date(now.getTime() - i * 3600000);
          var key = d.toISOString().slice(0, 13);
          tL.push(String(d.getUTCHours()).padStart(2, '0') + ':00');
          tD.push(buckets[key] || 0); tBw.push(bwBuckets[key] || 0); tAn.push(animeBuckets[key] || 0);
        }
        var wL = [], wD = [], wBw = [], wAn = [];
        for (var i = 6; i >= 0; i--) {
          var d = new Date(now.getTime() - i * 86400000);
          var dayKey = d.toISOString().slice(0, 10);
          wL.push(dayKey.slice(5));
          var t = 0, b = 0, a = 0;
          for (var h = 0; h < 24; h++) { var hk = dayKey + 'T' + String(h).padStart(2, '0'); t += buckets[hk]||0; b += bwBuckets[hk]||0; a += animeBuckets[hk]||0; }
          wD.push(t); wBw.push(b); wAn.push(a);
        }
        var mL = [], mD = [], mBw = [], mAn = [];
        for (var i = 29; i >= 0; i--) {
          var d = new Date(now.getTime() - i * 86400000);
          var dayKey = d.toISOString().slice(0, 10);
          mL.push(dayKey.slice(5));
          var t = 0, b = 0, a = 0;
          for (var h = 0; h < 24; h++) { var hk = dayKey + 'T' + String(h).padStart(2, '0'); t += buckets[hk]||0; b += bwBuckets[hk]||0; a += animeBuckets[hk]||0; }
          mD.push(t); mBw.push(b); mAn.push(a);
        }
        return {
          today: { labels: tL, data: tD, bwData: tBw, animeData: tAn },
          week:  { labels: wL, data: wD, bwData: wBw, animeData: wAn },
          month: { labels: mL, data: mD, bwData: mBw, animeData: mAn }
        };
      }

      setInterval(function() {
        fetch('/dashboard/api/analytics', { credentials: 'same-origin' })
          .then(function(r) { return r.ok ? r.json() : null; })
          .then(function(d) {
            if (!d) return;
            var nd = _buildAnalyticsData(d.buckets, d.bwBuckets, d.animeBuckets);
            ['today', 'week', 'month'].forEach(function(p) {
              DATA[p].labels    = nd[p].labels;
              DATA[p].data      = nd[p].data;
              DATA[p].bwData    = nd[p].bwData;
              DATA[p].animeData = nd[p].animeData;
            });
            if (chart)   chart.destroy();
            if (bwChart) bwChart.destroy();
            chart   = buildChart('mainChart', currentPeriod, false);
            bwChart = buildChart('bwChart',   currentPeriod, true);
          })
          .catch(function() {});
      }, 60000);
    </script>`;
}

// ─── Tab 3: Logs ─────────────────────────────────────────────────────────────

function renderLogs(query) {
  const animeFilter = query.anime === 'true' ? true : query.anime === 'false' ? false : undefined;
  const filters = {
    from:    query.from ? new Date(query.from).getTime() : undefined,
    to:      query.to   ? new Date(query.to).getTime() + 86400000 : undefined, // end of day
    outcome: query.outcome || undefined,
    isAnime: animeFilter,
    search:  query.search || undefined,
    limit:   200,
  };

  const logs = logger.getLogs(filters);

  const outcomeOptions = ['', 'success', 'not_found', 'error'].map(v =>
    `<option value="${v}"${query.outcome === v ? ' selected' : ''}>${v || 'All'}</option>`
  ).join('');

  const animeOptions = [
    { value: '', label: 'All' },
    { value: 'true', label: 'Anime' },
    { value: 'false', label: 'Not Anime' },
  ].map(o =>
    `<option value="${o.value}"${query.anime === o.value ? ' selected' : ''}>${o.label}</option>`
  ).join('');

  let tableRows = '';
  if (logs.length === 0) {
    tableRows = '<tr><td colspan="9" style="text-align:center;color:#666;padding:24px">No logs found</td></tr>';
  } else {
    tableRows = logs.map(e => {
      const badgeClass = e.outcome === 'success' ? 'badge-success' :
                         e.outcome === 'not_found' ? 'badge-fail' : 'badge-error';
      const animeBadge = e.isAnime === true
        ? '<span class="badge badge-anime">Anime</span>'
        : e.isAnime === false
          ? '<span class="badge badge-not-anime">Not Anime</span>'
          : '<span style="color:#555">?</span>';
      const parts = (e.stremioId || '').split(':');
      const epLabel = parts.length >= 3
        ? `S${String(parseInt(parts[1], 10)).padStart(2, '0')}E${String(parseInt(parts[2], 10)).padStart(2, '0')}`
        : '-';
      return `<tr>
        <td data-label="Time" style="white-space:nowrap">${formatDate(e.ts)}</td>
        <td data-label="IMDB ID">${e.imdbId ? `<a class="imdb-link" href="https://www.imdb.com/title/${esc(e.imdbId)}/" target="_blank" rel="noopener">${esc(e.imdbId)}</a>` : '-'}</td>
        <td data-label="Title">${esc(e.title || '-')}</td>
        <td data-label="Episode">${epLabel}</td>
        <td data-label="Anime?">${animeBadge}</td>
        <td data-label="Outcome"><span class="badge ${badgeClass}">${esc(e.outcome)}</span></td>
        <td data-label="Method">${e.method ? `<span class="badge badge-method">${esc(e.method)}</span>` : '-'}</td>
        <td data-label="Response">${e.responseTimeMs}ms</td>
        <td data-label="Streams">${e.streamCount}</td>
      </tr>`;
    }).join('');
  }

  // Build CSV export URL with same filters
  const csvParams = new URLSearchParams();
  if (query.from) csvParams.set('from', query.from);
  if (query.to)   csvParams.set('to', query.to);
  if (query.outcome) csvParams.set('outcome', query.outcome);
  if (query.anime)   csvParams.set('anime', query.anime);
  if (query.search)  csvParams.set('search', query.search);
  const csvUrl = '/dashboard/export/csv' + (csvParams.toString() ? '?' + csvParams.toString() : '');

  return `
    <form class="filters" method="GET" action="/dashboard">
      <input type="hidden" name="tab" value="logs">
      <input type="date" name="from" value="${esc(query.from || '')}" placeholder="From">
      <input type="date" name="to" value="${esc(query.to || '')}" placeholder="To">
      <select name="outcome">${outcomeOptions}</select>
      <select name="anime">${animeOptions}</select>
      <input type="text" name="search" value="${esc(query.search || '')}" placeholder="Search title or IMDB ID">
      <button type="submit">Filter</button>
      <a href="${csvUrl}" class="filters" style="text-decoration:none"><button type="button" class="btn-secondary">Export CSV</button></a>
    </form>
    <div id="logsCount" style="color:#555;font-size:12px;margin-bottom:8px">Showing ${logs.length} entries (max 200, newest first)</div>
    <div class="table-wrap" style="overflow-x:auto">
      <table>
        <thead>
          <tr><th>Time</th><th>IMDB ID</th><th>Title</th><th>Episode</th><th>Anime?</th><th>Outcome</th><th>Method</th><th>Time</th><th>Streams</th></tr>
        </thead>
        <tbody id="logsTbody">${tableRows}</tbody>
      </table>
    </div>
    <script>
      (function() {
        function _esc(s) { return String(s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;'); }
        function _fmtDate(ts) { return new Date(ts).toISOString().replace('T',' ').slice(0,19); }
        function _buildLogRow(e) {
          var bc = e.outcome === 'success' ? 'badge-success' : e.outcome === 'not_found' ? 'badge-fail' : 'badge-error';
          var ab = e.isAnime === true ? '<span class="badge badge-anime">Anime</span>'
                 : e.isAnime === false ? '<span class="badge badge-not-anime">Not Anime</span>'
                 : '<span style="color:#555">?</span>';
          var parts = (e.stremioId || '').split(':');
          var ep = parts.length >= 3
            ? 'S' + String(parseInt(parts[1],10)).padStart(2,'0') + 'E' + String(parseInt(parts[2],10)).padStart(2,'0')
            : '-';
          var imdb = e.imdbId
            ? '<a class="imdb-link" href="https://www.imdb.com/title/' + _esc(e.imdbId) + '/" target="_blank" rel="noopener">' + _esc(e.imdbId) + '</a>'
            : '-';
          return '<tr>'
            + '<td data-label="Time" style="white-space:nowrap">' + _fmtDate(e.ts) + '</td>'
            + '<td data-label="IMDB ID">' + imdb + '</td>'
            + '<td data-label="Title">' + _esc(e.title || '-') + '</td>'
            + '<td data-label="Episode">' + ep + '</td>'
            + '<td data-label="Anime?">' + ab + '</td>'
            + '<td data-label="Outcome"><span class="badge ' + bc + '">' + _esc(e.outcome) + '</span></td>'
            + '<td data-label="Method">' + (e.method ? '<span class="badge badge-method">' + _esc(e.method) + '</span>' : '-') + '</td>'
            + '<td data-label="Response">' + e.responseTimeMs + 'ms</td>'
            + '<td data-label="Streams">' + e.streamCount + '</td>'
            + '</tr>';
        }
        var params = new URLSearchParams(window.location.search);
        params.delete('tab');
        setInterval(function() {
          fetch('/dashboard/api/logs?' + params.toString(), { credentials: 'same-origin' })
            .then(function(r) { return r.ok ? r.json() : null; })
            .then(function(rows) {
              if (!rows) return;
              var tbody = document.getElementById('logsTbody');
              var count = document.getElementById('logsCount');
              if (!tbody) return;
              if (rows.length === 0) {
                tbody.innerHTML = '<tr><td colspan="9" style="text-align:center;color:#666;padding:24px">No logs found</td></tr>';
              } else {
                tbody.innerHTML = rows.map(_buildLogRow).join('');
              }
              if (count) count.textContent = 'Showing ' + rows.length + ' entries (max 200, newest first)';
            })
            .catch(function() {});
        }, 15000);
      })();
    </script>`;
}

// ─── Tab 4: Failed Lookups ───────────────────────────────────────────────────

function renderFailedLookups(query = {}) {
  const allFailed = stats.getFailedLookups();
  const ignored   = stats.getIgnoredLookups();
  const notDubbed = stats.getNotDubbedLookups();

  let active          = allFailed.filter(e => !ignored[e.imdbId] && !notDubbed[e.imdbId]);
  const ignoredList   = allFailed.filter(e => ignored[e.imdbId]);
  const notDubbedList = allFailed.filter(e => notDubbed[e.imdbId]);

  // Apply anime filter
  if (query.anime === 'true')  active = active.filter(e => e.isAnime === true);
  if (query.anime === 'false') active = active.filter(e => e.isAnime === false);

  function animeBadge(e) {
    return e.isAnime === true
      ? '<span class="badge badge-anime">Anime</span>'
      : e.isAnime === false
        ? '<span class="badge badge-not-anime">Not Anime</span>'
        : '<span style="color:#555">?</span>';
  }

  let activeRows = '';
  if (active.length === 0) {
    activeRows = '<tr><td colspan="6" style="text-align:center;color:#666;padding:24px">No failed lookups recorded</td></tr>';
  } else {
    activeRows = active.map(e =>
      `<tr data-imdbid="${esc(e.imdbId)}">
        <td>${e.title ? esc(e.title) : '<span style="color:#555">-</span>'}</td>
        <td><a class="imdb-link" href="https://www.imdb.com/title/${esc(e.imdbId)}/" target="_blank" rel="noopener">${esc(e.imdbId)}</a></td>
        <td style="text-align:center">${animeBadge(e)}</td>
        <td style="text-align:center">${e.count}</td>
        <td style="white-space:nowrap">${formatDate(e.lastSeen)}</td>
        <td style="white-space:nowrap">
          <button class="ignore-btn" data-action="show-ignore">Ignore</button>
          <button class="not-dubbed-btn" data-action="do-not-dubbed">Not Dubbed Yet</button>
          ${e.isAnime === false ? '<button class="quick-ignore-btn" data-action="quick-ignore">Ignore (Not Anime)</button>' : ''}
          <div class="ignore-form" style="display:none">
            <input type="text" class="ignore-reason" placeholder="Reason for ignoring..." style="width:160px">
            <button class="ignore-confirm" data-action="do-ignore">Confirm</button>
            <button class="ignore-cancel" data-action="hide-ignore">Cancel</button>
          </div>
        </td>
      </tr>`
    ).join('');
  }

  let ignoredRows = '';
  if (ignoredList.length > 0) {
    ignoredRows = ignoredList.map(e => {
      const info = ignored[e.imdbId];
      return `<tr data-imdbid="${esc(e.imdbId)}">
        <td>${e.title ? esc(e.title) : '<span style="color:#555">-</span>'}</td>
        <td><a class="imdb-link" href="https://www.imdb.com/title/${esc(e.imdbId)}/" target="_blank" rel="noopener">${esc(e.imdbId)}</a></td>
        <td style="text-align:center">${animeBadge(e)}</td>
        <td style="text-align:center">${e.count}</td>
        <td>${info.reason ? esc(info.reason) : '<span style="color:#555">-</span>'}</td>
        <td style="white-space:nowrap">${formatDate(info.ignoredAt)}</td>
        <td><button class="unignore-btn" data-action="do-unignore">Un-ignore</button></td>
      </tr>`;
    }).join('');
  }

  let notDubbedRows = '';
  if (notDubbedList.length > 0) {
    notDubbedRows = notDubbedList.map(e => {
      const info = notDubbed[e.imdbId];
      return `<tr data-imdbid="${esc(e.imdbId)}">
        <td>${e.title ? esc(e.title) : '<span style="color:#555">-</span>'}</td>
        <td><a class="imdb-link" href="https://www.imdb.com/title/${esc(e.imdbId)}/" target="_blank" rel="noopener">${esc(e.imdbId)}</a></td>
        <td style="text-align:center">${e.count}</td>
        <td style="white-space:nowrap">${formatDate(info.markedAt)}</td>
        <td><button class="unignore-btn" data-action="do-unmark-dubbed">Un-mark</button></td>
      </tr>`;
    }).join('');
  }

  const notDubbedSection = notDubbedList.length > 0 ? `
    <details style="margin-top:20px">
      <summary style="cursor:pointer;color:#cc8833;font-size:13px;margin-bottom:8px;font-weight:500">Not Dubbed Yet (${notDubbedList.length})</summary>
      <div class="table-wrap" style="overflow-x:auto;margin-top:8px">
        <table>
          <thead>
            <tr><th>Title</th><th>IMDB ID</th><th>Times Requested</th><th>Marked At</th><th></th></tr>
          </thead>
          <tbody>${notDubbedRows}</tbody>
        </table>
      </div>
    </details>` : '';

  const ignoredSection = ignoredList.length > 0 ? `
    <details style="margin-top:20px">
      <summary style="cursor:pointer;color:#666;font-size:13px;margin-bottom:8px;font-weight:500">Ignored (${ignoredList.length})</summary>
      <div class="table-wrap" style="overflow-x:auto;margin-top:8px">
        <table>
          <thead>
            <tr><th>Title</th><th>IMDB ID</th><th>Anime?</th><th>Times Requested</th><th>Reason</th><th>Ignored At</th><th></th></tr>
          </thead>
          <tbody>${ignoredRows}</tbody>
        </table>
      </div>
    </details>` : '';

  const animeOptions = [
    { value: 'all',   label: 'All' },
    { value: 'true',  label: 'Anime' },
    { value: 'false', label: 'Not Anime' },
  ].map(o => `<option value="${o.value}"${(query.anime || 'all') === o.value ? ' selected' : ''}>${o.label}</option>`).join('');

  return `
    <style>
      .ignore-btn { background:#0f0f18; border:1px solid #22223a; color:#666; padding:5px 12px; border-radius:6px; cursor:pointer; font-size:12px; transition:all 0.2s }
      .ignore-btn:hover { color:#ccc; border-color:#444; background:#16162a }
      .ignore-form { display:flex; gap:6px; align-items:center; margin-top:4px }
      .ignore-form input { background:#0f0f18; border:1px solid #22223a; color:#ddd; padding:5px 10px; border-radius:6px; font-size:12px }
      .ignore-form input:focus { outline:none; border-color:#444 }
      .ignore-confirm { background:linear-gradient(135deg, #cc8833, #aa6622); border:none; color:#fff; padding:5px 12px; border-radius:6px; cursor:pointer; font-size:12px; font-weight:600 }
      .ignore-confirm:hover { box-shadow:0 2px 10px rgba(204,136,51,0.3) }
      .ignore-cancel { background:#0f0f18; border:1px solid #22223a; color:#666; padding:5px 12px; border-radius:6px; cursor:pointer; font-size:12px }
      .ignore-cancel:hover { color:#ccc; border-color:#444 }
      .unignore-btn { background:linear-gradient(135deg, #0f2a1a, #1a3a2a); border:1px solid #1a3a2a; color:#3dcc7a; padding:5px 12px; border-radius:6px; cursor:pointer; font-size:12px; transition:all 0.2s }
      .unignore-btn:hover { background:#2a4a3a; box-shadow:0 2px 10px rgba(61,204,122,0.15) }
      .quick-ignore-btn { background:#0f0f18; border:1px solid #22223a; color:#666; padding:5px 12px; border-radius:6px; cursor:pointer; font-size:12px; margin-left:4px; transition:all 0.2s }
      .quick-ignore-btn:hover { color:#ccc; border-color:#444; background:#16162a }
      .not-dubbed-btn { background:#1a1408; border:1px solid #3a2a10; color:#cc8833; padding:5px 12px; border-radius:6px; cursor:pointer; font-size:12px; margin-left:4px; transition:all 0.2s }
      .not-dubbed-btn:hover { background:#2a2010; border-color:#5a4a20 }
      .override-toolbar { display:flex; gap:8px; margin-bottom:12px }
      .override-toolbar button { background:#0f0f18; border:1px solid #22223a; color:#5a8acc; padding:7px 16px; border-radius:8px; cursor:pointer; font-size:12px; transition:all 0.2s }
      .override-toolbar button:hover { background:#16162a; border-color:#333; color:#88aadd }
    </style>
    <div style="color:#555;font-size:12px;margin-bottom:8px">
      Titles that users requested but weren't found in AniLibria. Sorted by most requested.
    </div>
    <div class="override-toolbar">
      <button onclick="window.location='/debug/export'">Export Overrides</button>
      <button onclick="document.getElementById('import-file').click()">Import Overrides</button>
      <button id="enrich-btn" onclick="(function(btn){
        btn.disabled=true;btn.textContent='Fetching...';
        fetch('/dashboard/api/enrich-titles',{method:'POST',credentials:'same-origin'})
          .then(function(r){return r.json()})
          .then(function(d){btn.textContent='Enriched '+d.enriched+' titles';setTimeout(function(){btn.disabled=false;btn.textContent='Fetch Missing Titles'},3000)})
          .catch(function(e){btn.textContent='Error';setTimeout(function(){btn.disabled=false;btn.textContent='Fetch Missing Titles'},3000)});
      })(this)">Fetch Missing Titles</button>
      <input type="file" id="import-file" accept=".json" style="display:none" onchange="(function(input){
        if(!input.files[0])return;
        var reader=new FileReader();
        reader.onload=function(){
          try{var data=JSON.parse(reader.result)}catch(e){return alert('Invalid JSON file')}
          fetch('/debug/import',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(data)})
            .then(function(r){return r.json()})
            .then(function(d){if(d.ok){alert('Imported '+d.imported.ignored+' ignored + '+d.imported.notDubbed+' not-dubbed entries');location.reload()}else{alert('Import failed: '+(d.error||'unknown'))}})
            .catch(function(e){alert('Import error: '+e.message)});
        };
        reader.readAsText(input.files[0]);
        input.value='';
      })(this)">
    </div>
    <form class="filters" method="GET" action="/dashboard" style="margin-bottom:12px">
      <input type="hidden" name="tab" value="failed">
      <select name="anime">${animeOptions}</select>
      <button type="submit">Filter</button>
    </form>
    <div class="table-wrap" style="overflow-x:auto">
      <table>
        <thead>
          <tr><th>Title</th><th>IMDB ID</th><th>Anime?</th><th>Times Requested</th><th>Last Requested</th><th></th></tr>
        </thead>
        <tbody>${activeRows}</tbody>
      </table>
    </div>
    ${notDubbedSection}
    ${ignoredSection}
    <script>
      document.addEventListener('click', function(e) {
        var btn = e.target.closest('[data-action]');
        if (!btn) return;
        var row = btn.closest('tr[data-imdbid]');
        if (!row) return;
        var id = row.dataset.imdbid;
        var action = btn.dataset.action;

        if (action === 'show-ignore') {
          btn.style.display = 'none';
          row.querySelector('.ignore-form').style.display = 'flex';
          row.querySelector('.ignore-reason').focus();

        } else if (action === 'hide-ignore') {
          row.querySelector('.ignore-form').style.display = 'none';
          row.querySelector('.ignore-btn').style.display = '';

        } else if (action === 'do-ignore') {
          var reason = row.querySelector('.ignore-reason').value;
          fetch('/dashboard/api/failed/' + encodeURIComponent(id) + '/ignore', {
            method: 'POST',
            credentials: 'same-origin',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ reason: reason })
          }).then(function(r) {
            if (r.ok) row.style.display = 'none';
          });

        } else if (action === 'do-unignore') {
          fetch('/dashboard/api/failed/' + encodeURIComponent(id) + '/ignore', {
            method: 'DELETE',
            credentials: 'same-origin'
          }).then(function(r) {
            if (r.ok) location.reload();
          });

        } else if (action === 'quick-ignore') {
          fetch('/dashboard/api/failed/' + encodeURIComponent(id) + '/ignore', {
            method: 'POST',
            credentials: 'same-origin',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ reason: 'Not Anime' })
          }).then(function(r) {
            if (r.ok) row.style.display = 'none';
          });

        } else if (action === 'do-not-dubbed') {
          fetch('/dashboard/api/failed/' + encodeURIComponent(id) + '/not-dubbed', {
            method: 'POST',
            credentials: 'same-origin'
          }).then(function(r) {
            if (r.ok) row.style.display = 'none';
          });

        } else if (action === 'do-unmark-dubbed') {
          fetch('/dashboard/api/failed/' + encodeURIComponent(id) + '/not-dubbed', {
            method: 'DELETE',
            credentials: 'same-origin'
          }).then(function(r) {
            if (r.ok) location.reload();
          });
        }
      });

      // Live data refresh — every 30s
      (function() {
        function _esc(s) { return String(s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;'); }
        function _fmtDate(ts) { return new Date(ts).toISOString().replace('T',' ').slice(0,19); }
        function _animeBadge(e) {
          return e.isAnime === true  ? '<span class="badge badge-anime">Anime</span>'
               : e.isAnime === false ? '<span class="badge badge-not-anime">Not Anime</span>'
               : '<span style="color:#555">?</span>';
        }
        function _buildFailedRow(e) {
          var qi = e.isAnime === false
            ? '<button class="quick-ignore-btn" data-action="quick-ignore">Ignore (Not Anime)</button>'
            : '';
          return '<tr data-imdbid="' + _esc(e.imdbId) + '">'
            + '<td>' + (e.title ? _esc(e.title) : '<span style="color:#555">-</span>') + '</td>'
            + '<td><a class="imdb-link" href="https://www.imdb.com/title/' + _esc(e.imdbId) + '/" target="_blank" rel="noopener">' + _esc(e.imdbId) + '</a></td>'
            + '<td style="text-align:center">' + _animeBadge(e) + '</td>'
            + '<td style="text-align:center">' + e.count + '</td>'
            + '<td style="white-space:nowrap">' + _fmtDate(e.lastSeen) + '</td>'
            + '<td style="white-space:nowrap">'
            +   '<button class="ignore-btn" data-action="show-ignore">Ignore</button>'
            +   '<button class="not-dubbed-btn" data-action="do-not-dubbed">Not Dubbed Yet</button>'
            +   qi
            +   '<div class="ignore-form" style="display:none">'
            +     '<input type="text" class="ignore-reason" placeholder="Reason for ignoring..." style="width:160px">'
            +     '<button class="ignore-confirm" data-action="do-ignore">Confirm</button>'
            +     '<button class="ignore-cancel" data-action="hide-ignore">Cancel</button>'
            +   '</div>'
            + '</td>'
            + '</tr>';
        }
        var animeParam = new URLSearchParams(window.location.search).get('anime') || 'all';
        var activeTbody = document.querySelector('table tbody');
        setInterval(function() {
          if (document.querySelector('.ignore-form[style*="flex"]')) return; // user mid-action
          fetch('/dashboard/api/failed-lookups', { credentials: 'same-origin' })
            .then(function(r) { return r.ok ? r.json() : null; })
            .then(function(d) {
              if (!d || !activeTbody) return;
              var active = d.allFailed.filter(function(e) { return !d.ignored[e.imdbId] && !d.notDubbed[e.imdbId]; });
              if (animeParam === 'true')  active = active.filter(function(e) { return e.isAnime === true; });
              if (animeParam === 'false') active = active.filter(function(e) { return e.isAnime === false; });
              if (active.length === 0) {
                activeTbody.innerHTML = '<tr><td colspan="6" style="text-align:center;color:#666;padding:24px">No failed lookups recorded</td></tr>';
              } else {
                activeTbody.innerHTML = active.map(_buildFailedRow).join('');
              }
            })
            .catch(function() {});
        }, 30000);
      })();
    </script>`;
}

// ─── Login page ──────────────────────────────────────────────────────────────

function renderLoginPage(error) {
  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <title>Dashboard Login</title>
  <style>
    *, *::before, *::after { box-sizing: border-box; margin: 0; padding: 0 }
    body { background: #080810; color: #e0e0e0; font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif; display: flex; align-items: center; justify-content: center; min-height: 100vh }
    body::before {
      content: '';
      position: fixed;
      inset: 0;
      background:
        radial-gradient(ellipse 80% 60% at 20% 10%, rgba(120, 40, 140, 0.12) 0%, transparent 60%),
        radial-gradient(ellipse 60% 50% at 80% 80%, rgba(180, 30, 30, 0.10) 0%, transparent 55%),
        radial-gradient(ellipse 50% 40% at 50% 50%, rgba(40, 20, 80, 0.08) 0%, transparent 70%);
      pointer-events: none;
      z-index: 0;
    }
    .box { background: #0e0e1a; border: 1px solid #1a1a2e; border-radius: 16px; padding: 40px 44px; width: 100%; max-width: 380px; position: relative; z-index: 1; box-shadow: 0 8px 32px rgba(0, 0, 0, 0.4) }
    .login-logo { display: block; margin: 0 auto 20px; width: 56px; height: 56px; border-radius: 14px; border: 1px solid #1a1a2e }
    h1 { color: #fff; font-size: 18px; margin-bottom: 24px; text-align: center; font-weight: 700 }
    label { display: block; color: #555; font-size: 11px; text-transform: uppercase; letter-spacing: 1.2px; margin-bottom: 6px; font-weight: 600 }
    input[type=password] { width: 100%; background: #0a0a14; border: 1px solid #22223a; color: #ddd; padding: 11px 14px; border-radius: 9px; font-size: 14px; outline: none; transition: border-color 0.25s, box-shadow 0.25s }
    input[type=password]:focus { border-color: #cc3333; box-shadow: 0 0 0 3px rgba(204, 51, 51, 0.1) }
    button { width: 100%; margin-top: 20px; background: linear-gradient(135deg, #cc3333 0%, #991a1a 100%); border: none; color: #fff; padding: 12px; border-radius: 9px; font-size: 14px; cursor: pointer; font-weight: 600; transition: transform 0.15s, box-shadow 0.15s }
    button:hover { transform: translateY(-1px); box-shadow: 0 4px 20px rgba(204, 51, 51, 0.4) }
    .error { background: linear-gradient(135deg, #2a0f0f, #3a1a1a); border: 1px solid #5a2a2a; color: #cc6666; border-radius: 9px; padding: 10px 14px; font-size: 13px; margin-bottom: 18px; text-align: center }
  </style>
</head>
<body>
  <div class="box">
    <img src="/logo.jpg" alt="AniLibria" class="login-logo">
    <h1>AniLibria Dashboard</h1>
    ${error ? `<div class="error">${esc(error)}</div>` : ''}
    <form method="POST" action="/dashboard/login">
      <label for="pw">Password</label>
      <input type="password" id="pw" name="password" autofocus autocomplete="current-password">
      <button type="submit">Sign in</button>
    </form>
  </div>
</body>
</html>`;
}

// ─── Tab 5: Terminal ──────────────────────────────────────────────────────────

function renderTerminal() {
  const lines = getConsoleLogs();

  function colorLine(line) {
    const e = esc(line);
    if (line.includes('[ERROR]')) return `<span style="color:#ff5555">${e}</span>`;
    if (line.includes('[WARN]'))  return `<span style="color:#ffaa00">${e}</span>`;
    return `<span style="color:#aaa">${e}</span>`;
  }

  const html = lines.map(colorLine).join('\n');

  return `
    <div style="display:flex;align-items:center;gap:12px;margin-bottom:12px">
      <span style="color:#555;font-size:12px" id="termCount">${lines.length} lines buffered (max 300)</span>
      <button class="term-btn" onclick="clearTerm()">Clear</button>
      <span style="color:#444;font-size:11px">Auto-refresh: 5s</span>
    </div>
    <div class="terminal-wrap">
      <div class="terminal-titlebar">
        <span class="terminal-dot red"></span>
        <span class="terminal-dot yellow"></span>
        <span class="terminal-dot green"></span>
        <span class="terminal-title">console output</span>
      </div>
      <pre id="termPre" class="terminal-body">${html}</pre>
    </div>
    <script>
      var termPre = document.getElementById('termPre');
      var termCount = document.getElementById('termCount');
      termPre.scrollTop = termPre.scrollHeight;

      function escHtml(s) {
        return s.replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;');
      }
      function colorLine(line) {
        var e = escHtml(line);
        if (line.indexOf('[ERROR]') !== -1) return '<span style="color:#ff5555">' + e + '</span>';
        if (line.indexOf('[WARN]')  !== -1) return '<span style="color:#ffaa00">' + e + '</span>';
        return '<span style="color:#aaa">' + e + '</span>';
      }

      var cleared = false;
      function clearTerm() { cleared = true; termPre.innerHTML = ''; termCount.textContent = '0 lines buffered (max 300)'; }

      setInterval(function() {
        if (cleared) return;
        fetch('/debug/logs')
          .then(function(r) { return r.ok ? r.json() : null; })
          .then(function(lines) {
            if (!lines) return;
            termPre.innerHTML = lines.map(colorLine).join('\\n');
            termCount.textContent = lines.length + ' lines buffered (max 300)';
            termPre.scrollTop = termPre.scrollHeight;
          })
          .catch(function() {});
      }, 5000);
    </script>`;
}

// ─── API Routes ─────────────────────────────────────────────────────────────

/** GET /dashboard/api/stats — JSON stats for real-time polling */
router.get('/dashboard/api/stats', (req, res) => {
  const s = stats.getStats();
  const sys = stats.getSystemStats();
  const uc = users.getUserCounts();
  // Omit nodeVersion, platform, freeMem — not needed by the polling script
  // and exposing runtime version enables targeted CVE attacks
  const { nodeVersion: _nv, platform: _pl, freeMem: _fm, ...safeSystem } = sys;
  res.json({
    counters: s.counters,
    todayRequests: s.todayRequests,
    weekRequests: s.weekRequests,
    monthRequests: s.monthRequests,
    sessionsToday: s.sessionsToday,
    liveSessions: s.liveSessions,
    successRate: s.successRate,
    totalBandwidthBytes: stats.getTotalBandwidth(),
    users: uc,
    system: safeSystem,
    resolverCache: getCacheStats(),
  });
});

/** POST /dashboard/api/failed/:imdbId/ignore — Ignore a failed lookup */
router.post('/dashboard/api/failed/:imdbId/ignore', (req, res) => {
  if (!IMDB_RE.test(req.params.imdbId)) return res.status(400).json({ error: 'invalid imdbId' });
  const reason = ((req.body && req.body.reason) || '').slice(0, 500);
  stats.ignoreLookup(req.params.imdbId, reason);
  res.json({ ok: true });
});

/** DELETE /dashboard/api/failed/:imdbId/ignore — Un-ignore a failed lookup */
router.delete('/dashboard/api/failed/:imdbId/ignore', (req, res) => {
  if (!IMDB_RE.test(req.params.imdbId)) return res.status(400).json({ error: 'invalid imdbId' });
  stats.unignoreLookup(req.params.imdbId);
  res.json({ ok: true });
});

/** POST /dashboard/api/failed/:imdbId/not-dubbed — Mark as not dubbed yet */
router.post('/dashboard/api/failed/:imdbId/not-dubbed', (req, res) => {
  if (!IMDB_RE.test(req.params.imdbId)) return res.status(400).json({ error: 'invalid imdbId' });
  stats.markNotDubbed(req.params.imdbId);
  res.json({ ok: true });
});

/** DELETE /dashboard/api/failed/:imdbId/not-dubbed — Remove not-dubbed mark */
router.delete('/dashboard/api/failed/:imdbId/not-dubbed', (req, res) => {
  if (!IMDB_RE.test(req.params.imdbId)) return res.status(400).json({ error: 'invalid imdbId' });
  stats.unmarkNotDubbed(req.params.imdbId);
  res.json({ ok: true });
});

/** GET /dashboard/api/overview — top anime for live polling */
router.get('/dashboard/api/overview', (req, res) => {
  const allLogs = logger.getAllLogs();
  res.json({ topAnime: stats.getTopAnime(allLogs, 5) });
});

/** GET /dashboard/api/analytics — raw hourly buckets for live chart refresh */
router.get('/dashboard/api/analytics', (req, res) => {
  const buckets   = stats.getHourlyBuckets();
  const bwBuckets = stats.getBandwidthBuckets();
  const animeBuckets = {};
  for (const e of logger.getAllLogs()) {
    if (e.isAnime === true) {
      const key = new Date(e.ts).toISOString().slice(0, 13);
      animeBuckets[key] = (animeBuckets[key] || 0) + 1;
    }
  }
  res.json({ buckets, bwBuckets, animeBuckets });
});

/** GET /dashboard/api/logs — filtered log entries for live table refresh */
router.get('/dashboard/api/logs', (req, res) => {
  const animeFilter = req.query.anime === 'true' ? true : req.query.anime === 'false' ? false : undefined;
  const filters = {
    from:    req.query.from ? new Date(req.query.from).getTime() : undefined,
    to:      req.query.to   ? new Date(req.query.to).getTime() + 86400000 : undefined,
    outcome: req.query.outcome || undefined,
    isAnime: animeFilter,
    search:  req.query.search || undefined,
    limit:   200,
  };
  res.json(logger.getLogs(filters));
});

/** POST /dashboard/api/enrich-titles — trigger Cinemeta backfill for missing titles */
let enrichCooldown = 0;
router.post('/dashboard/api/enrich-titles', (req, res) => {
  const now = Date.now();
  if (now < enrichCooldown) {
    return res.json({ enriched: 0, message: 'Cooldown active, try again later' });
  }
  enrichCooldown = now + 60_000; // 60s cooldown
  const cinemeta = require('./api/cinemeta');
  cinemeta.backfillMissingTitles(
    stats.getFailedLookups(),
    (imdbId, info) => stats.updateFailedLookup(imdbId, info),
    { cap: 50, delayMs: 300 },
  ).then(count => {
    res.json({ enriched: count });
  }).catch(err => {
    res.status(500).json({ enriched: 0, error: err.message });
  });
});

/** GET /dashboard/api/failed-lookups — failed lookup data for live table refresh */
router.get('/dashboard/api/failed-lookups', (req, res) => {
  res.json({
    allFailed: stats.getFailedLookups(),
    ignored:   stats.getIgnoredLookups(),
    notDubbed: stats.getNotDubbedLookups(),
  });
});

// ─── Routes ──────────────────────────────────────────────────────────────────

/**
 * GET /dashboard
 * Main dashboard page with tab routing via ?tab= query param.
 */
router.get('/dashboard', (req, res) => {
  const tab = req.query.tab || 'overview';
  let body;

  switch (tab) {
    case 'analytics':
      body = renderAnalytics();
      break;
    case 'logs':
      body = renderLogs(req.query);
      break;
    case 'failed':
      body = renderFailedLookups(req.query);
      break;
    case 'terminal':
      body = renderTerminal();
      break;
    case 'overview':
    default:
      body = renderOverview();
      break;
  }

  res.setHeader('Content-Type', 'text/html; charset=utf-8');
  res.send(renderShell(tab, body));
});

/**
 * GET /dashboard/export/csv
 * Export filtered logs as CSV download.
 */
router.get('/dashboard/export/csv', (req, res) => {
  const filters = {
    from:    req.query.from ? new Date(req.query.from).getTime() : undefined,
    to:      req.query.to   ? new Date(req.query.to).getTime() + 86400000 : undefined,
    outcome: req.query.outcome || undefined,
    isAnime: req.query.anime === 'true' ? true : req.query.anime === 'false' ? false : undefined,
    search:  req.query.search || undefined,
  };

  const logs = logger.getLogs(filters);

  const header = 'Timestamp,IMDB ID,Title,Episode,Type,Outcome,Method,Response Time (ms),Streams,Error\n';
  const rows = logs.map(e => {
    const parts = (e.stremioId || '').split(':');
    const epLabel = parts.length >= 3
      ? `S${String(parseInt(parts[1], 10)).padStart(2, '0')}E${String(parseInt(parts[2], 10)).padStart(2, '0')}`
      : '';
    const fields = [
      formatDate(e.ts),
      e.imdbId || '',
      '"' + (e.title || '').replace(/"/g, '""') + '"',
      epLabel,
      e.type || '',
      e.outcome || '',
      e.method || '',
      e.responseTimeMs || 0,
      e.streamCount || 0,
      '"' + (e.error || '').replace(/"/g, '""') + '"',
    ];
    return fields.join(',');
  }).join('\n');

  res.setHeader('Content-Type', 'text/csv; charset=utf-8');
  res.setHeader('Content-Disposition', 'attachment; filename="anilibria-logs.csv"');
  res.send(header + rows);
});

module.exports = router;
