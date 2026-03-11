/**
 * Dashboard — Express Router + HTML Templates
 *
 * Serves /dashboard with 4 tabs: Overview, Analytics, Logs, Failed Lookups.
 * Server-rendered HTML with Chart.js from CDN for analytics charts.
 */

const crypto     = require('crypto');
const { Router } = require('express');
const logger = require('./logger');
const stats  = require('./stats');
const { requireAuth, requireAuthApi, setSessionCookie, clearSessionCookie, isValidSession, DASHBOARD_PASSWORD } = require('./auth');

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
    * { box-sizing: border-box; margin: 0; padding: 0 }
    body { background: #111; color: #ddd; font-family: -apple-system, 'Segoe UI', sans-serif; padding: 0 }
    .header { background: #1a1a1a; border-bottom: 1px solid #333; padding: 16px 24px; display: flex; align-items: center; gap: 24px }
    .header h1 { color: #fff; font-size: 18px; white-space: nowrap }
    .logout-btn { margin-left: auto; color: #666; text-decoration: none; font-size: 13px; padding: 6px 12px; border: 1px solid #333; border-radius: 5px; transition: all 0.2s }
    .logout-btn:hover { color: #ddd; border-color: #555 }
    .tabs { display: flex; gap: 4px }
    .tab { color: #888; text-decoration: none; padding: 8px 16px; border-radius: 6px; font-size: 14px; transition: all 0.2s }
    .tab:hover { color: #ddd; background: #222 }
    .tab.active { color: #fff; background: #333 }
    .content { padding: 24px; max-width: 1200px; margin: 0 auto }

    /* Cards */
    .cards { display: grid; grid-template-columns: repeat(auto-fit, minmax(200px, 1fr)); gap: 16px; margin-bottom: 24px }
    .card { background: #1a1a1a; border: 1px solid #333; border-radius: 8px; padding: 16px }
    .card .label { color: #888; font-size: 12px; text-transform: uppercase; letter-spacing: 1px; margin-bottom: 4px }
    .card .value { color: #fff; font-size: 28px; font-weight: 600 }
    .card .sub { color: #666; font-size: 12px; margin-top: 4px }

    /* Progress bars */
    .bar-wrap { background: #222; border-radius: 4px; height: 8px; margin-top: 8px; overflow: hidden }
    .bar-fill { height: 100%; border-radius: 4px; transition: width 0.3s }
    .bar-green { background: #3a7 }
    .bar-blue { background: #47a }
    .bar-orange { background: #a73 }

    /* Tables */
    table { width: 100%; border-collapse: collapse; font-size: 13px }
    th { text-align: left; color: #888; font-weight: 500; padding: 8px 12px; border-bottom: 1px solid #333; font-size: 12px; text-transform: uppercase; letter-spacing: 0.5px }
    td { padding: 8px 12px; border-bottom: 1px solid #222; vertical-align: top }
    tr:hover td { background: #1a1a1a }
    .badge { display: inline-block; padding: 2px 8px; border-radius: 4px; font-size: 11px; font-weight: 500 }
    .badge-success { background: #1a3a2a; color: #3a7 }
    .badge-fail { background: #3a1a1a; color: #a55 }
    .badge-error { background: #3a2a1a; color: #a73 }
    .badge-method { background: #1a2a3a; color: #47a }
    .badge-anime { background: #1a3a2a; color: #3a7 }
    .badge-not-anime { background: #2a2a2a; color: #666 }
    a.imdb-link { color: #47a; text-decoration: none }
    a.imdb-link:hover { text-decoration: underline }

    /* Filters */
    .filters { display: flex; gap: 12px; margin-bottom: 16px; flex-wrap: wrap; align-items: center }
    .filters input, .filters select { background: #222; border: 1px solid #444; color: #ddd; padding: 6px 10px; border-radius: 4px; font-size: 13px }
    .filters button { background: #3a7; border: none; color: #fff; padding: 7px 16px; border-radius: 4px; cursor: pointer; font-size: 13px }
    .filters button:hover { background: #4b8 }
    .filters .btn-secondary { background: #444 }
    .filters .btn-secondary:hover { background: #555 }

    /* Charts */
    .chart-grid { display: grid; grid-template-columns: 1fr 1fr; gap: 20px; margin-bottom: 24px }
    .chart-box { background: #1a1a1a; border: 1px solid #333; border-radius: 8px; padding: 16px }
    .chart-box h3 { color: #aaa; font-size: 13px; margin-bottom: 12px; font-weight: 500 }
    canvas { max-height: 250px }

    /* Top anime */
    .top-list { list-style: none }
    .top-list li { padding: 8px 0; border-bottom: 1px solid #222; display: flex; justify-content: space-between }
    .top-list li:last-child { border: none }
    .top-count { color: #3a7; font-weight: 600 }

    /* Section titles */
    .section-title { color: #aaa; font-size: 14px; font-weight: 500; margin-bottom: 12px; padding-bottom: 8px; border-bottom: 1px solid #222 }

    @media (max-width: 768px) {
      .chart-grid { grid-template-columns: 1fr }
      .cards { grid-template-columns: repeat(2, 1fr) }
      .header { flex-direction: column; gap: 12px }
      table thead { display: none }
      table tbody tr { display: block; margin-bottom: 12px; background: #1a1a1a; border: 1px solid #333; border-radius: 8px; padding: 12px }
      table tbody tr:hover td { background: transparent }
      table tbody td { display: block; padding: 4px 0; border: none; font-size: 13px }
      table tbody td::before { content: attr(data-label); color: #888; font-size: 11px; text-transform: uppercase; letter-spacing: 0.5px; display: block; margin-bottom: 2px }
    }
  </style>
</head>
<body>
  <div class="header">
    <h1>AniLibria Dashboard</h1>
    <div class="tabs">${tabLinks}</div>
    <a href="/dashboard/logout" class="logout-btn">Logout</a>
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

  const ramPercent = sys.totalMem > 0 ? ((sys.rssBytes / sys.totalMem) * 100).toFixed(1) : 0;

  let topHtml = '<em style="color:#666">No data yet</em>';
  if (topAnime.length > 0) {
    topHtml = '<ul class="top-list">' + topAnime.map((a, i) =>
      `<li><span>${i + 1}. ${esc(a.title)}</span> <span class="top-count">${a.count} req</span></li>`
    ).join('') + '</ul>';
  }

  return `
    <div class="cards">
      <div class="card">
        <div class="label">Today</div>
        <div class="value" data-stat="todayRequests">${s.todayRequests}</div>
        <div class="sub">requests</div>
      </div>
      <div class="card">
        <div class="label">This Week</div>
        <div class="value" data-stat="weekRequests">${s.weekRequests}</div>
        <div class="sub">requests</div>
      </div>
      <div class="card">
        <div class="label">This Month</div>
        <div class="value" data-stat="monthRequests">${s.monthRequests}</div>
        <div class="sub">requests</div>
      </div>
      <div class="card">
        <div class="label">Sessions Today</div>
        <div class="value" data-stat="sessionsToday">${s.sessionsToday}</div>
        <div class="sub">estimated</div>
      </div>
      <div class="card">
        <div class="label">Anime Found</div>
        <div class="value" data-stat="animeSuccess">${s.counters.animeSuccess}</div>
        <div class="sub">successful lookups</div>
      </div>
      <div class="card">
        <div class="label">Success Rate</div>
        <div class="value" data-stat="successRate">${s.successRate}%</div>
        <div class="sub" data-stat-sub="successRateSub">${s.counters.animeSuccess} / ${s.counters.animeRequests} anime</div>
      </div>
      <div class="card">
        <div class="label">Uptime</div>
        <div class="value" data-stat="uptime">${formatUptime(sys.uptime)}</div>
        <div class="sub">${sys.nodeVersion} on ${sys.platform}</div>
      </div>
      <div class="card">
        <div class="label">Bandwidth</div>
        <div class="value" data-stat="bandwidth">${formatBytes(stats.getTotalBandwidth())}</div>
        <div class="sub">total served</div>
      </div>
    </div>

    <div style="display:grid; grid-template-columns: 1fr 1fr; gap: 20px">
      <div class="card">
        <div class="section-title">Top 5 Anime</div>
        ${topHtml}
      </div>
      <div class="card">
        <div class="section-title">System Resources</div>
        <div style="margin-bottom:12px">
          <div style="display:flex; justify-content:space-between; font-size:12px; color:#888; margin-bottom:4px">
            <span>RAM</span><span data-stat="ramLabel">${formatBytes(sys.rssBytes)} / ${formatBytes(sys.totalMem)} (${ramPercent}%)</span>
          </div>
          <div class="bar-wrap"><div class="bar-fill bar-green" data-stat-bar="ram" style="width:${Math.min(ramPercent, 100)}%"></div></div>
        </div>
        <div style="margin-bottom:12px">
          <div style="display:flex; justify-content:space-between; font-size:12px; color:#888; margin-bottom:4px">
            <span>Heap</span><span data-stat="heapLabel">${formatBytes(sys.heapUsed)} / ${formatBytes(sys.heapTotal)}</span>
          </div>
          <div class="bar-wrap"><div class="bar-fill bar-blue" data-stat-bar="heap" style="width:${sys.heapTotal > 0 ? ((sys.heapUsed / sys.heapTotal) * 100).toFixed(1) : 0}%"></div></div>
        </div>
        <div>
          <div style="display:flex; justify-content:space-between; font-size:12px; color:#888; margin-bottom:4px">
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
              sessionsToday: d.sessionsToday,
              animeSuccess: d.counters.animeSuccess,
              successRate: d.successRate + '%',
              uptime: _fmtUptime(d.system.uptime),
              bandwidth: _fmtBytes(d.totalBandwidthBytes || 0),
            };
            for (var k in map) {
              var el = document.querySelector('[data-stat="' + k + '"]');
              if (el) el.textContent = map[k];
            }
            var sub = document.querySelector('[data-stat-sub="successRateSub"]');
            if (sub) sub.textContent = d.counters.animeSuccess + ' / ' + d.counters.animeRequests + ' anime';
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
      .period-btns { display:flex; gap:8px; margin-bottom:16px }
      .period-btn { background:#222; border:1px solid #444; color:#888; padding:7px 20px; border-radius:6px; cursor:pointer; font-size:13px; transition:all 0.2s }
      .period-btn:hover { color:#ddd; border-color:#666 }
      .period-btn.active { background:#333; color:#fff; border-color:#555 }
    </style>
    <div style="display:flex;align-items:center;gap:16px;margin-bottom:16px;flex-wrap:wrap">
      <div class="period-btns" style="margin-bottom:0">
        <button class="period-btn active" onclick="switchPeriod('today',this)">Today</button>
        <button class="period-btn" onclick="switchPeriod('week',this)">Week</button>
        <button class="period-btn" onclick="switchPeriod('month',this)">Month</button>
      </div>
      <label style="display:flex;align-items:center;gap:6px;color:#888;font-size:13px;cursor:pointer;user-select:none">
        <input type="checkbox" id="showAnime" style="accent-color:#3a7;width:14px;height:14px;cursor:pointer"> Show anime requests
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
        x: { ticks: { color: '#666', maxRotation: 45 }, grid: { color: '#222' } },
        y: { ticks: { color: '#666' }, grid: { color: '#222' }, beginAtZero: true }
      };

      const bwScaleOpts = {
        x: { ticks: { color: '#666', maxRotation: 45 }, grid: { color: '#222' } },
        y: { ticks: { color: '#666', callback: function(v) { return _fmtBytesChart(v); } }, grid: { color: '#222' }, beginAtZero: true }
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
    <div style="color:#666;font-size:12px;margin-bottom:8px">Showing ${logs.length} entries (max 200, newest first)</div>
    <div style="overflow-x:auto">
      <table>
        <thead>
          <tr><th>Time</th><th>IMDB ID</th><th>Title</th><th>Episode</th><th>Anime?</th><th>Outcome</th><th>Method</th><th>Time</th><th>Streams</th></tr>
        </thead>
        <tbody>${tableRows}</tbody>
      </table>
    </div>`;
}

// ─── Tab 4: Failed Lookups ───────────────────────────────────────────────────

function renderFailedLookups() {
  const allFailed = stats.getFailedLookups();
  const ignored = stats.getIgnoredLookups();

  const active = allFailed.filter(e => !ignored[e.imdbId]);
  const ignoredList = allFailed.filter(e => ignored[e.imdbId]);

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
        <td>
          <button class="ignore-btn" data-action="show-ignore">Ignore</button>
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

  const ignoredSection = ignoredList.length > 0 ? `
    <details style="margin-top:20px">
      <summary style="cursor:pointer;color:#888;font-size:13px;margin-bottom:8px">Ignored (${ignoredList.length})</summary>
      <div style="overflow-x:auto">
        <table>
          <thead>
            <tr><th>Title</th><th>IMDB ID</th><th>Anime?</th><th>Times Requested</th><th>Reason</th><th>Ignored At</th><th></th></tr>
          </thead>
          <tbody>${ignoredRows}</tbody>
        </table>
      </div>
    </details>` : '';

  return `
    <style>
      .ignore-btn { background:#333; border:1px solid #555; color:#888; padding:4px 10px; border-radius:4px; cursor:pointer; font-size:12px; transition:all 0.2s }
      .ignore-btn:hover { color:#ddd; border-color:#777 }
      .ignore-form { display:flex; gap:6px; align-items:center; margin-top:4px }
      .ignore-form input { background:#222; border:1px solid #444; color:#ddd; padding:4px 8px; border-radius:4px; font-size:12px }
      .ignore-confirm { background:#a73; border:none; color:#fff; padding:4px 10px; border-radius:4px; cursor:pointer; font-size:12px }
      .ignore-confirm:hover { background:#b84 }
      .ignore-cancel { background:#333; border:1px solid #555; color:#888; padding:4px 10px; border-radius:4px; cursor:pointer; font-size:12px }
      .ignore-cancel:hover { color:#ddd }
      .unignore-btn { background:#1a3a2a; border:1px solid #2a5a3a; color:#3a7; padding:4px 10px; border-radius:4px; cursor:pointer; font-size:12px }
      .unignore-btn:hover { background:#2a4a3a }
    </style>
    <div style="color:#666;font-size:12px;margin-bottom:8px">
      Titles that users requested but weren't found in AniLibria. Sorted by most requested.
    </div>
    <div style="overflow-x:auto">
      <table>
        <thead>
          <tr><th>Title</th><th>IMDB ID</th><th>Anime?</th><th>Times Requested</th><th>Last Requested</th><th></th></tr>
        </thead>
        <tbody>${activeRows}</tbody>
      </table>
    </div>
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
        }
      });
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
    * { box-sizing: border-box; margin: 0; padding: 0 }
    body { background: #111; color: #ddd; font-family: -apple-system, 'Segoe UI', sans-serif; display: flex; align-items: center; justify-content: center; min-height: 100vh }
    .box { background: #1a1a1a; border: 1px solid #333; border-radius: 10px; padding: 36px 40px; width: 100%; max-width: 360px }
    h1 { color: #fff; font-size: 18px; margin-bottom: 24px; text-align: center }
    label { display: block; color: #888; font-size: 12px; text-transform: uppercase; letter-spacing: 1px; margin-bottom: 6px }
    input[type=password] { width: 100%; background: #222; border: 1px solid #444; color: #ddd; padding: 10px 12px; border-radius: 6px; font-size: 14px; outline: none; transition: border-color 0.2s }
    input[type=password]:focus { border-color: #3a7 }
    button { width: 100%; margin-top: 18px; background: #3a7; border: none; color: #fff; padding: 11px; border-radius: 6px; font-size: 14px; cursor: pointer; font-weight: 500; transition: background 0.2s }
    button:hover { background: #4b8 }
    .error { background: #3a1a1a; border: 1px solid #5a2a2a; color: #c66; border-radius: 6px; padding: 10px 14px; font-size: 13px; margin-bottom: 18px; text-align: center }
  </style>
</head>
<body>
  <div class="box">
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

// ─── API Routes ─────────────────────────────────────────────────────────────

/** GET /dashboard/api/stats — JSON stats for real-time polling */
router.get('/dashboard/api/stats', requireAuthApi, (req, res) => {
  const s = stats.getStats();
  const sys = stats.getSystemStats();
  // Omit nodeVersion, platform, freeMem — not needed by the polling script
  // and exposing runtime version enables targeted CVE attacks
  const { nodeVersion: _nv, platform: _pl, freeMem: _fm, ...safeSystem } = sys;
  res.json({
    counters: s.counters,
    todayRequests: s.todayRequests,
    weekRequests: s.weekRequests,
    monthRequests: s.monthRequests,
    sessionsToday: s.sessionsToday,
    successRate: s.successRate,
    totalBandwidthBytes: stats.getTotalBandwidth(),
    system: safeSystem,
  });
});

/** POST /dashboard/api/failed/:imdbId/ignore — Ignore a failed lookup */
router.post('/dashboard/api/failed/:imdbId/ignore', requireAuthApi, (req, res) => {
  if (!IMDB_RE.test(req.params.imdbId)) return res.status(400).json({ error: 'invalid imdbId' });
  const reason = ((req.body && req.body.reason) || '').slice(0, 500);
  stats.ignoreLookup(req.params.imdbId, reason);
  res.json({ ok: true });
});

/** DELETE /dashboard/api/failed/:imdbId/ignore — Un-ignore a failed lookup */
router.delete('/dashboard/api/failed/:imdbId/ignore', requireAuthApi, (req, res) => {
  if (!IMDB_RE.test(req.params.imdbId)) return res.status(400).json({ error: 'invalid imdbId' });
  stats.unignoreLookup(req.params.imdbId);
  res.json({ ok: true });
});

// ─── Routes ──────────────────────────────────────────────────────────────────

/** GET /dashboard/login */
router.get('/dashboard/login', (req, res) => {
  if (isValidSession(req)) return res.redirect('/dashboard');
  res.setHeader('Content-Type', 'text/html; charset=utf-8');
  res.send(renderLoginPage(null));
});

/** POST /dashboard/login */
router.post('/dashboard/login', (req, res) => {
  const provided = (req.body && req.body.password) || '';
  // Constant-time comparison — pad to same length to avoid length leak
  const a = Buffer.alloc(64, 0);
  const b = Buffer.alloc(64, 0);
  a.write(provided);
  b.write(DASHBOARD_PASSWORD);
  const match = crypto.timingSafeEqual(a, b) && provided === DASHBOARD_PASSWORD;

  if (!match) {
    res.setHeader('Content-Type', 'text/html; charset=utf-8');
    return res.status(401).send(renderLoginPage('Incorrect password. Try again.'));
  }

  const secure = (process.env.RENDER_EXTERNAL_URL || '').startsWith('https://');
  setSessionCookie(res, secure);
  const next = req.query.next && /^\/[^/]/.test(req.query.next) ? req.query.next : '/dashboard';
  res.redirect(next);
});

/** GET /dashboard/logout */
router.get('/dashboard/logout', (_req, res) => {
  clearSessionCookie(res);
  res.redirect('/dashboard/login');
});

/**
 * GET /dashboard
 * Main dashboard page with tab routing via ?tab= query param.
 */
router.get('/dashboard', requireAuth, (req, res) => {
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
      body = renderFailedLookups();
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
router.get('/dashboard/export/csv', requireAuth, (req, res) => {
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
