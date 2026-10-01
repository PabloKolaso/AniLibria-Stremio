/**
 * Admin — "How can I test, refresh or diagnose the addon?"
 * Resolve tester, background jobs and caches, process/lifecycle/provider
 * details, read-only configuration with security notes, and sessions.
 */

import { h, mount } from '../lib/dom.js';
import { api } from '../lib/api.js';
import { num, pct, ms, bytes, duration, dateTime, utc } from '../lib/format.js';
import {
  card, body, segmented, table, pill, relTime, kv, empty, loading, errorState, actionButton, toast,
  meter, sparkline, statusPill,
} from '../lib/ui.js';
import { resolveResult } from './logs.js';

const VIEWS = [
  { value: 'resolve', label: 'Resolve tester' },
  { value: 'jobs', label: 'Jobs & caches' },
  { value: 'system', label: 'System' },
  { value: 'config', label: 'Configuration' },
  { value: 'sessions', label: 'Sessions' },
];

// ─── Resolve tester ──────────────────────────────────────────────────────────

function resolveView(slot, ctx, history) {
  const input = h('input', { class: 'input', type: 'text', placeholder: 'tt0388629:1:5 · anilibria:9660:8 · or paste a Stremio / IMDB URL', value: ctx.params.get('input') || '', 'aria-label': 'ID or URL' });
  const type = h('select', { class: 'select', 'aria-label': 'Type' },
    [['', 'Auto'], ['series', 'Series'], ['movie', 'Movie']].map(([v, t]) => h('option', { value: v, selected: (ctx.params.get('type') || '') === v }, t)));
  const season = h('input', { class: 'input', type: 'number', min: 0, max: 9999, placeholder: 'from ID', 'aria-label': 'Season', style: { width: '110px' } });
  const episode = h('input', { class: 'input', type: 'number', min: 0, max: 99999, placeholder: 'from ID', 'aria-label': 'Episode', style: { width: '110px' } });
  const result = h('div');
  const historyEl = h('div');

  const drawHistory = () => mount(historyEl, history.length > 0 && card({
    title: 'Earlier tests (this browser tab)',
    body: h('div', { class: 'card-body flush' }, table({
      rows: history,
      columns: [
        { label: 'When', className: 'nowrap', render: r => relTime(r.at) },
        { label: 'Request', render: r => h('span', { class: 'mono' }, r.result.parsed.id) },
        { label: 'Result', render: r => h('span', null, r.result.category === 'found' ? pill('Found', 'ok') : pill(r.result.reason, r.result.category === 'error' ? 'bad' : 'neutral')) },
        { label: 'Title', render: r => r.result.title || '—' },
        { label: '', render: r => h('button', { class: 'btn btn-sm', type: 'button', onClick: () => show(r.result) }, 'Show') },
      ],
    })),
  }));

  const show = r => mount(result, card({ title: `Result for ${r.parsed.id}`, sub: `type ${r.parsed.type}`, body: body(resolveResult(r)) }));

  const run = async () => {
    ctx.setParams({ input: input.value.trim() || null, type: type.value || null });
    mount(result, card({ body: loading('Resolving… (bypasses the resolver cache; up to 20 s)') }));
    try {
      const res = await api.post('/resolve', {
        input: input.value, type: type.value || undefined,
        season: season.value === '' ? undefined : season.value,
        episode: episode.value === '' ? undefined : episode.value,
      });
      show(res.result);
      history.unshift({ at: Date.now(), result: res.result });
      history.splice(8);
      drawHistory();
    } catch (err) {
      mount(result, card({ body: errorState(err) }));
    }
  };

  const form = h('form', { class: 'toolbar', onSubmit: ev => { ev.preventDefault(); runBtn.click(); } },
    h('label', { class: 'field grow' }, h('span', null, 'IMDB ID, Stremio ID or URL'), input),
    h('label', { class: 'field' }, h('span', null, 'Type'), type),
    h('label', { class: 'field' }, h('span', null, 'Season'), season),
    h('label', { class: 'field' }, h('span', null, 'Episode'), episode));
  const runBtn = actionButton({ label: 'Resolve', variant: 'primary', small: false, busyLabel: 'Resolving…', run });
  form.append(runBtn);

  mount(slot, h('div', { class: 'stack' },
    card({
      title: 'Resolve tester',
      sub: 'Runs the real stream lookup for one request and shows every step. Does not count in statistics.',
      body: body(form, h('div', { class: 'help' },
        h('p', null, 'Examples: ', h('span', { class: 'mono' }, 'tt0388629:1:5'), ' (season 1 episode 5), ', h('span', { class: 'mono' }, 'tt5311514'), ' (movie, choose Type), ',
          h('span', { class: 'mono' }, 'anilibria:9660:8'), ' (catalog item), or a stremio:// / web.stremio.com / imdb.com link. Season and episode fields override the ones in the ID.'))),
    }),
    result,
    historyEl));
  drawHistory();
  if (input.value.trim()) runBtn.click();
}

// ─── Jobs & caches ───────────────────────────────────────────────────────────

function jobsView(d, refresh) {
  const jobRows = d.jobs.map(j => ({ ...j }));
  const titleInput = h('input', { class: 'input', type: 'text', placeholder: 'tt0388629 or anilibria:9660', 'aria-label': 'Title ID' });
  const releaseInput = h('input', { class: 'input', type: 'number', min: 1, placeholder: '9660', 'aria-label': 'Release ID', style: { width: '140px' } });
  return h('div', { class: 'stack' },
    card({
      title: 'Background jobs',
      sub: 'Manual actions have a server-side cooldown so they cannot hammer upstream APIs',
      body: h('div', { class: 'card-body flush' }, table({
        rows: jobRows,
        columns: [
          { label: 'Job', render: j => h('div', null, h('div', { class: 'cell-title' }, j.label), j.description && h('div', { class: 'cell-sub' }, j.description)) },
          { label: 'Schedule', render: j => j.schedule || '—' },
          {
            label: 'Last run', render: j => (j.lastRunAt
              ? h('div', null, relTime(j.lastRunAt), j.lastDurationMs !== null && h('div', { class: 'cell-sub' }, `took ${ms(j.lastDurationMs)} · ${num(j.runs)} run(s)`))
              : h('span', { class: 'subtle' }, j.running ? 'running…' : 'not run since start')),
          },
          {
            label: 'Result', render: j => (j.lastOk === null ? '—' : h('div', null, j.lastOk ? pill('OK', 'ok') : pill('Failed', 'bad'),
              (j.lastMessage || j.lastError) && h('div', { class: j.lastOk ? 'cell-sub' : 'cell-err' }, j.lastOk ? j.lastMessage : j.lastError))),
          },
          {
            label: '', className: 'actions', render: j => j.manual && h('div', null,
              actionButton({
                label: j.running ? 'Running…' : 'Run now',
                disabled: j.running || j.cooldownRemainingMs > 0,
                confirm: j.confirm ? 'Confirm?' : undefined,
                title: j.confirm || (j.cooldownRemainingMs > 0 ? `Available again in ${duration(j.cooldownRemainingMs)}` : `Cooldown ${duration(j.cooldownMs)} after each run`),
                run: async () => {
                  const r = await api.post(`/admin/jobs/${j.id}`);
                  toast(`${j.label}: ${r.message || 'done'} (${ms(r.durationMs)})`, { type: 'success' });
                  refresh();
                },
              }),
              j.cooldownRemainingMs > 0 && h('div', { class: 'cell-sub' }, `cooldown ${duration(j.cooldownRemainingMs)}`)),
          },
        ],
      })),
    }),
    h('div', { class: 'grid grid-2' },
      card({
        title: 'Clear one title',
        sub: 'Forget the cached match for an IMDB ID (or refetch a catalog release) — the next request resolves it again',
        body: body(h('form', {
          class: 'toolbar',
          onSubmit: async ev => {
            ev.preventDefault();
            try {
              const r = await api.post('/admin/cache/clear-title', { id: titleInput.value.trim() });
              toast(r.message, { type: 'success' });
            } catch (err) { toast(err.message, { type: 'error' }); }
          },
        }, h('label', { class: 'field grow' }, h('span', null, 'IMDB or catalog ID'), titleInput), h('button', { class: 'btn', type: 'submit' }, 'Clear'))),
      }),
      card({
        title: 'Invalidate one release',
        sub: 'Drop the cached copy and availability of an AniLibria release; it is refetched on next use',
        body: body(h('form', {
          class: 'toolbar',
          onSubmit: async ev => {
            ev.preventDefault();
            try {
              const r = await api.post('/admin/cache/invalidate-release', { releaseId: Number(releaseInput.value) });
              toast(r.message, { type: 'success' });
            } catch (err) { toast(err.message, { type: 'error' }); }
          },
        }, h('label', { class: 'field' }, h('span', null, 'AniLibria release ID'), releaseInput), h('button', { class: 'btn', type: 'submit' }, 'Invalidate'))),
      })),
    card({
      title: 'Caches',
      sub: d.resolverLastCleared ? ['Resolver cache last cleared ', relTime(d.resolverLastCleared.at), ` (${d.resolverLastCleared.reason})`] : 'In memory; counters since start',
      body: h('div', { class: 'card-body flush' }, table({
        rows: d.caches,
        columns: [
          { label: 'Cache', render: c => h('div', null, h('div', { class: 'cell-title' }, c.name), c.description && h('div', { class: 'cell-sub' }, c.description)) },
          { label: 'Entries', className: 'num', render: c => h('div', null, num(c.size), h('div', { class: 'cell-sub' }, `max ${num(c.max)}`)) },
          { label: 'Hit rate', className: 'num', render: c => h('div', null, c.hitRate === null ? '—' : pct(c.hitRate), h('div', { class: 'cell-sub' }, `${num(c.hits)} hits · ${num(c.misses)} misses`)) },
          { label: 'Default TTL', className: 'num', render: c => duration(c.ttlMs) },
          { label: 'Last cleared', render: c => (c.lastClearedAt ? relTime(c.lastClearedAt) : '—') },
        ],
      })),
    }),
    card({
      title: 'Data files',
      sub: `Missing-title checks: ${num(d.enrichment.queued)} queued, ${num(d.enrichment.processed)} done since start (${num(d.enrichment.anime)} found to be anime)`,
      body: h('div', { class: 'card-body flush' }, table({
        rows: d.persistence,
        columns: [
          { label: 'Store', render: s => h('div', null, h('div', null, s.label), h('div', { class: 'cell-sub mono' }, s.file)) },
          { label: 'Size', className: 'num', render: s => bytes(s.bytes) },
          { label: 'Last saved', render: s => (s.lastSavedAt ? relTime(s.lastSavedAt) : h('span', { class: 'subtle' }, s.pending ? 'pending' : 'not since start')) },
          { label: 'Status', render: s => (s.lastError && (!s.lastSavedAt || s.lastErrorAt > s.lastSavedAt) ? h('span', { class: 'bad-text' }, s.lastError) : pill('OK', 'ok')) },
        ],
      })),
    }));
}

// ─── System ──────────────────────────────────────────────────────────────────

function providerStatus(p) {
  const recent = p.last15m;
  if (p.consecutiveFailures >= 3) return 'down';
  if (recent.calls >= 4 && recent.failureRate >= 0.25) return 'degraded';
  if (recent.failures > 0) return 'warning';
  return recent.calls > 0 ? 'healthy' : 'idle';
}

function systemView(d) {
  const p = d.process;
  const life = d.lifecycle;
  const hist = d.processHistory;
  const memStatus = p.memory.percent >= 0.95 ? 'down' : p.memory.percent >= 0.85 ? 'warning' : 'ok';
  const loopStatus = p.eventLoop && p.eventLoop.p99 >= 1000 ? 'down' : p.eventLoop && p.eventLoop.p99 >= 250 ? 'warning' : 'ok';
  const prev = life.previousShutdown;

  const processCard = card({
    title: 'Process',
    sub: `PID ${p.pid} · sampled every ${p.cpu.sampleSeconds} s; history every minute (in memory)`,
    body: body(h('div', { class: 'stack' },
      h('div', null,
        h('div', { class: 'row' }, h('span', { class: 'strong' }, 'Memory (RSS)'), h('span', { class: 'spacer' }),
          `${bytes(p.memory.rss)} of ${bytes(p.memory.limit)} ${p.memory.limitSource === 'container' ? 'container limit' : 'host memory (no container limit detected)'} · ${pct(p.memory.percent)}`),
        meter(p.memory.percent, memStatus),
        hist.length > 1 && sparkline(hist.map(x => x.rss), { limit: p.memory.limitSource === 'container' ? p.memory.limit : null, label: 'RSS over the last 24 hours' }),
        h('div', { class: 'help' }, `V8 heap ${bytes(p.memory.heapUsed)} of ${bytes(p.memory.heapLimit)} limit · last 24 h peak RSS ${bytes(Math.max(0, ...hist.map(x => x.rss)))}`)),
      h('div', null,
        h('div', { class: 'row' }, h('span', { class: 'strong' }, 'CPU (this process)'), h('span', { class: 'spacer' }),
          p.cpu.percent === null ? 'measuring…' : `${p.cpu.percent}% of one core (last ${p.cpu.sampleSeconds} s) · ${p.cpu.cores} cores available`),
        hist.length > 1 && sparkline(hist.map(x => x.cpu ?? 0), { max: 100, label: 'CPU over the last 24 hours' })),
      h('div', null,
        h('div', { class: 'row' }, h('span', { class: 'strong' }, 'Event loop delay'), h('span', { class: 'spacer' }),
          p.eventLoop ? h('span', { class: loopStatus === 'ok' ? undefined : 'warn-text' }, `p50 ${ms(p.eventLoop.p50)} · p99 ${ms(p.eventLoop.p99)} · max ${ms(p.eventLoop.max)} (per minute)`) : 'measuring…'),
        hist.length > 1 && sparkline(hist.map(x => x.loopP99 ?? 0), { label: 'Event loop p99 over the last 24 hours' }),
        h('div', { class: 'help' }, 'Time the server was busy before it could handle a request. Above ~250 ms, requests queue up.')))),
  });

  const lifecycleCard = card({
    title: 'Restarts & crashes',
    body: body(kv([
      ['Started', h('span', { title: utc(life.startedAt) }, dateTime(life.startedAt), ` (up ${duration(life.uptimeMs)})`)],
      ['Restarts', `${num(life.restarts24h)} in 24 h · ${num(life.restarts7d)} in 7 days`],
      ['Previous run', prev
        ? (prev.clean ? pill(`Clean shutdown${prev.signal ? ` (${prev.signal})` : ''}`, 'ok')
          : h('span', null, pill('Abnormal end', 'bad'), ' last heartbeat ', prev.lastAliveAt ? relTime(prev.lastAliveAt) : 'unknown', ' — killed, out of memory or crashed'))
        : 'no earlier run recorded'],
      ['Uncaught exceptions', life.uncaughtExceptions > 0 ? h('span', { class: 'bad-text' }, num(life.uncaughtExceptions)) : '0'],
      ['Unhandled rejections', life.unhandledRejections > 0 ? h('span', { class: 'bad-text' }, num(life.unhandledRejections)) : '0'],
      ['Last crash-level error', life.lastFatal
        ? h('details', { class: 'more' }, h('summary', null, `${life.lastFatal.kind}: ${life.lastFatal.message} (`, relTime(life.lastFatal.at), ')'), h('pre', { class: 'logs' }, life.lastFatal.stack || 'no stack'))
        : 'none since start'],
    ]),
    life.recentBoots.length > 1 && h('details', { class: 'more' }, h('summary', null, 'Recent boots'), table({
      rows: life.recentBoots,
      columns: [
        { label: 'Started', render: b => h('span', { title: utc(b.startedAt) }, dateTime(b.startedAt)) },
        { label: 'Version', render: b => b.version || '—' },
        { label: 'Ended', render: b => (b.current ? pill('running', 'info') : b.clean ? `clean${b.signal ? ` (${b.signal})` : ''}` : h('span', { class: 'bad-text' }, 'abnormal')) },
      ],
    }))),
  });

  const providersCard = card({
    title: 'Upstream providers',
    sub: 'Every HTTP attempt (retries included) since the server started. 404 and geo-block answers count as successful responses.',
    body: h('div', { class: 'card-body flush' }, d.providers.length === 0 ? empty('No upstream calls yet.') : table({
      rows: d.providers,
      columns: [
        { label: 'Provider', render: x => h('div', { class: 'row tight' }, statusPill(providerStatus(x), x.name)) },
        { label: 'Calls', className: 'num', render: x => h('div', null, num(x.calls), h('div', { class: 'cell-sub' }, `${num(x.last15m.calls)} in 15 min`)) },
        {
          label: 'Failures', render: x => h('div', null,
            x.failed === 0 ? '0' : h('span', { class: 'bad-text' }, `${num(x.failed)} (${pct(x.failed / x.calls)})`),
            x.failed > 0 && h('div', { class: 'cell-sub' }, Object.entries(x.failures).filter(([, n]) => n > 0).map(([k, n]) => `${{ timeout: 'timeout', network: 'network', http5xx: 'HTTP 5xx', http429: 'HTTP 429', http4xx: 'HTTP 4xx', parse: 'bad response' }[k]} ${n}`).join(' · ')),
            x.skipped > 0 && h('div', { class: 'cell-sub' }, `${num(x.skipped)} skipped (${x.lastSkip?.reason})`)),
        },
        { label: 'Latency', className: 'num', render: x => h('div', null, `p50 ${ms(x.latency.p50)}`, h('div', { class: 'cell-sub' }, `p95 ${ms(x.latency.p95)} · last ${x.latency.samples}`)) },
        { label: 'Last success', render: x => (x.lastSuccessAt ? relTime(x.lastSuccessAt) : '—') },
        {
          label: 'Last failure', render: x => (x.lastError ? h('div', null, relTime(x.lastError.at), h('div', { class: 'cell-err' }, x.lastError.message)) : '—'),
        },
      ],
    })),
  });

  const a = d.alerts;
  const alertsCard = card({
    title: 'Alerts (ntfy)',
    sub: a.enabled ? 'Enabled' : a.ntfyConfigured ? 'Disabled — set NTFY_ALERTS=true to enable' : 'Disabled — set NTFY_TOPIC and NTFY_ALERTS=true to enable',
    body: body(
      h('p', { class: 'help' }, `Sent when a condition lasts: provider down ${a.rules.providerDownMinutes} min, Releasing older than ${a.rules.releasingStaleMinutes} min, Trending older than ${a.rules.trendingStaleMinutes} min, error rate ≥ ${pct(a.rules.errorRate.threshold, 0)} over ${a.rules.errorRate.windowMinutes} min (≥ ${a.rules.errorRate.minRequests} requests), mapping older than ${a.rules.mappingStaleHours} h, abnormal restart, crash. Reminders every ${a.rules.remindHours} h; at most ${a.rules.maxPerHour} per hour.`),
      a.active.length > 0 && h('div', null, h('div', { class: 'strong' }, 'Active conditions'), a.active.map(c => h('div', { class: 'small' }, `${c.title} — since `, relTime(c.since), c.notifiedAt ? ' (notified)' : ' (waiting to confirm)'))),
      a.history.length === 0 ? h('div', { class: 'subtle small' }, 'No alerts since start.') : table({
        rows: a.history,
        columns: [
          { label: 'When', render: x => relTime(x.at) },
          { label: 'Alert', render: x => h('div', null, h('div', null, x.title), h('div', { class: 'cell-sub' }, x.message)) },
          { label: 'Delivery', render: x => (x.delivered ? pill('Sent', 'ok') : pill(x.suppressed || 'Failed', x.suppressed ? 'neutral' : 'bad')) },
        ],
      })),
  });

  return h('div', { class: 'stack' }, h('div', { class: 'grid grid-2' }, processCard, lifecycleCard), providersCard, alertsCard);
}

// ─── Configuration ───────────────────────────────────────────────────────────

function configView(d) {
  const c = d.config;
  const s = d.system;
  const jobLine = (enabled, job) => (!enabled ? h('span', { class: 'subtle' }, 'disabled (PUBLIC_URL not set)')
    : !job || job.runs === 0 ? 'enabled · not run yet'
      : h('span', null, job.lastOk ? pill('OK', 'ok') : pill('Failed', 'bad'), ' ', relTime(job.lastRunAt), job.lastOk ? '' : ` — ${job.lastError}`));
  return h('div', { class: 'stack' },
    d.security.length > 0 && card({
      title: 'Security notes',
      body: h('div', { class: 'card-body flush' }, h('ul', { class: 'list' }, d.security.map(n => h('li', null,
        pill(n.level === 'warning' ? 'Warning' : 'Note', n.level === 'warning' ? 'warn' : 'info'), h('div', { class: 'grow' }, n.message))))),
    }),
    h('div', { class: 'grid grid-2' },
      card({
        title: 'Addon',
        body: body(kv([
          ['Version', s.version],
          ['Node.js', s.node],
          ['Platform', s.platform],
          ['Started', h('span', { title: utc(s.startedAt) }, dateTime(s.startedAt))],
          ['Statistics since', s.stats.oldestBucket || s.stats.createdAt ? dateTime(s.stats.oldestBucket || s.stats.createdAt) : '—'],
          ['Outcome tracking since', dateTime(s.stats.detailedSince)],
          ['Retention', `${s.stats.retentionDays} days of hourly statistics`],
        ])),
      }),
      card({
        title: 'Environment',
        sub: 'Read-only. Secrets (password, ntfy topic) are never shown.',
        body: body(kv([
          ['PORT', c.port],
          ['NODE_ENV', c.nodeEnv],
          ['PUBLIC_URL', c.publicUrl || h('span', { class: 'subtle' }, 'not set')],
          ['ADDON_URL', c.addonUrl],
          ['TRUST_PROXY', String(c.trustProxy)],
          ['ANILIBRIA_API_URL', c.anilibriaApiUrl],
          ['DATA_DIR', h('span', { class: 'mono' }, c.dataDir)],
          ['Dashboard password', c.passwordSource === 'env' ? 'DASHBOARD_PASSWORD (environment)' : 'generated, stored hashed in data/auth.json'],
          ['ntfy', c.ntfyConfigured ? 'NTFY_TOPIC set' : 'not configured'],
          ['Alerts', c.alertsEnabled ? 'enabled (NTFY_ALERTS)' : 'disabled'],
        ])),
      })),
    card({
      title: 'Background integrations',
      body: body(kv([
        ['Keep-alive ping', jobLine(c.keepalive.enabled, c.keepalive.job)],
        ['Stremio catalog registration', jobLine(c.stremioPublish.enabled, c.stremioPublish.job)],
      ])),
    }),
    card({
      title: 'Data directory',
      sub: 'Everything below survives a normal restart. If your host wipes the disk on redeploy, all of it resets (see Missing titles → Export overrides).',
      body: h('div', { class: 'card-body flush' }, table({
        rows: s.dataFiles,
        empty: 'No files yet',
        columns: [
          { label: 'File', render: f => h('span', { class: 'mono' }, f.name) },
          { label: 'Size', className: 'num', render: f => bytes(f.bytes) },
          { label: 'Modified', render: f => relTime(f.modifiedAt) },
        ],
      })),
    }));
}

// ─── Sessions ────────────────────────────────────────────────────────────────

function sessionsView(d, refresh) {
  const others = d.sessions.filter(s => !s.current).length;
  return card({
    title: 'Dashboard sessions',
    sub: 'Only hashes of session tokens are stored. Sessions survive restarts and expire after 7 days; changing the password signs everyone out.',
    actions: actionButton({
      label: 'Sign out other sessions', confirm: 'Confirm?', disabled: others === 0, variant: 'danger',
      run: async () => {
        const r = await api.post('/sessions/revoke-others');
        toast(`${r.revoked} session(s) signed out`, { type: 'success' });
        refresh();
      },
    }),
    body: h('div', { class: 'card-body flush' }, table({
      rows: d.sessions,
      columns: [
        { label: 'Client', render: s => h('div', { class: 'row tight' }, s.client || 'Unknown browser', s.current && pill('This session', 'info')) },
        { label: 'Signed in', render: s => relTime(s.createdAt) },
        { label: 'Last active', render: s => (s.lastSeenAt ? relTime(s.lastSeenAt) : '—') },
        { label: 'Expires', render: s => h('span', { title: utc(s.expiresAt) }, dateTime(s.expiresAt)) },
        {
          label: '', className: 'actions', render: s => !s.current && actionButton({
            label: 'Sign out', variant: 'ghost',
            run: async () => { await api.post(`/sessions/${s.id}/revoke`); toast('Session signed out', { type: 'success' }); refresh(); },
          }),
        },
      ],
    })),
  });
}

// ─── Page ────────────────────────────────────────────────────────────────────

const history = []; // resolve tests of this tab (kept while navigating)

export default {
  mount(root, ctx) {
    let view = VIEWS.some(v => v.value === ctx.params.get('view')) ? ctx.params.get('view') : 'resolve';
    const nav = h('div');
    const slot = h('div', { class: 'stack' });
    let data = null;

    mount(root, h('div', { class: 'stack' },
      h('div', { class: 'page-head' },
        h('div', null, h('h1', { class: 'page-title' }, 'Admin'), h('div', { class: 'page-desc' }, 'Test, refresh and diagnose the addon')),
        nav),
      slot));

    const drawNav = () => mount(nav, segmented({
      options: VIEWS, value: view, label: 'Section',
      onChange: v => {
        view = v;
        ctx.setParams({ view: v === 'resolve' ? null : v, input: null, type: null });
        drawNav();
        draw(true);
        ctx.refresh();
      },
    }));

    // Do not re-render under the user's hands (armed confirm, running action, focused input)
    const busy = () => Boolean(slot.querySelector('.btn-confirm, [aria-busy="true"]') || (slot.contains(document.activeElement) && document.activeElement.matches('input, select, textarea')));

    function draw(force = false) {
      if (view === 'resolve') {
        if (force || !slot.firstChild) resolveView(slot, ctx, history);
        return;
      }
      if (!data) return mount(slot, loading());
      if (!force && busy()) return;
      const render = { jobs: () => jobsView(data, ctx.refresh), system: () => systemView(data), config: () => configView(data), sessions: () => sessionsView(data, ctx.refresh) }[view];
      mount(slot, render());
    }

    drawNav();
    draw(true);

    ctx.setTask({
      interval: 30_000,
      load: async () => {
        if (view === 'resolve') {
          await api.get('/status');
          return;
        }
        try {
          data = await api.get('/admin');
          draw();
        } catch (err) {
          if (!data) mount(slot, errorState(err, () => ctx.refresh()));
          throw err;
        }
      },
    });
    return {};
  },
};

