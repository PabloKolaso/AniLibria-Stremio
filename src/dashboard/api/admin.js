/**
 * Admin: "how can I test, refresh or diagnose the addon?" — background
 * jobs and manual actions, caches, providers, process and lifecycle,
 * read-only configuration, security notes, sessions and alerts.
 *
 * No secret is ever returned: no password, token, salt or ntfy topic.
 */

const fs           = require('fs');
const path         = require('path');
const os           = require('os');
const express      = require('express');
const config       = require('../../config');
const auth         = require('../../auth');
const jobs         = require('../../monitoring/jobs');
const providers    = require('../../monitoring/providers');
const processStats = require('../../monitoring/process-metrics');
const lifecycle    = require('../../monitoring/lifecycle');
const alerts       = require('../../monitoring/alerts');
const TTLCache     = require('../../util/ttl-cache');
const JsonStore    = require('../../util/json-store');
const resolver     = require('../../bridge/resolver');
const anilibria    = require('../../api/anilibria');
const availability = require('../../mapping/availability');
const traffic      = require('../../telemetry/traffic');
const missing      = require('../../telemetry/missing');
const overrides    = require('../../overrides');
const { meta }     = require('./meta');
const { str, int } = require('./params');
const { version }  = require('../../../package.json');

const smallJson = express.json({ limit: '10kb' });

// Per-title cache actions are cheap but still rate-limited
const titleActions = [];
function titleActionAllowed() {
  const now = Date.now();
  while (titleActions.length > 0 && now - titleActions[0] > 60_000) titleActions.shift();
  if (titleActions.length >= 30) return false;
  titleActions.push(now);
  return true;
}

function dataFiles() {
  try {
    return fs.readdirSync(config.dataDir, { withFileTypes: true })
      .filter(d => d.isFile())
      .map(d => {
        const stat = fs.statSync(path.join(config.dataDir, d.name));
        return { name: d.name, bytes: stat.size, modifiedAt: stat.mtimeMs };
      })
      .sort((a, b) => b.bytes - a.bytes);
  } catch {
    return [];
  }
}

function isLocalRequest(req) {
  return /^(localhost|127\.0\.0\.1|\[::1\])(:\d+)?$/.test(req.get('host') || '');
}

/** Security notes for the admin (never containing secret values). */
function securityNotes(req) {
  const notes = [];
  const pw = auth.passwordInfo();
  if (pw.passwordFileExists) {
    notes.push({ level: 'warning', message: 'data/dashboard-password.txt still exists. Note the password somewhere safe and delete the file.' });
  }
  if (pw.shortPassword) notes.push({ level: 'warning', message: 'DASHBOARD_PASSWORD is shorter than 12 characters.' });
  if (!req.secure && !isLocalRequest(req)) {
    notes.push({ level: 'warning', message: 'The dashboard is served over plain HTTP, so the session cookie is not marked Secure.' });
  }
  if (config.ntfyAlerts && !config.ntfyTopic) notes.push({ level: 'info', message: 'NTFY_ALERTS is on but NTFY_TOPIC is not set: alerts cannot be delivered.' });
  if (config.trustProxy === true) {
    notes.push({ level: 'info', message: 'TRUST_PROXY=true trusts any X-Forwarded-For header. Set it to the number of proxies in front of the app so client IPs (login rate limits, user counts) cannot be spoofed.' });
  }
  return notes;
}

function register(router) {
  router.get('/admin', (req, res) => {
    const pw = auth.passwordInfo();
    res.json({
      meta: meta(),
      jobs: jobs.list(),
      caches: TTLCache.list(),
      resolverLastCleared: resolver.lastCleared(),
      persistence: JsonStore.statusAll(),
      providers: providers.list(),
      process: processStats.snapshot(),
      processHistory: processStats.getHistory({ minutes: 24 * 60, stepMinutes: 5 }),
      lifecycle: lifecycle.info(),
      enrichment: missing.enrichmentState(),
      overrides: overrides.counts(),
      system: {
        version,
        node: process.version,
        platform: `${os.platform()} ${os.release()} (${os.arch()})`,
        pid: process.pid,
        startedAt: lifecycle.startedAt,
        dataDir: config.dataDir,
        dataFiles: dataFiles(),
        stats: traffic.since(),
      },
      config: {
        port: config.port,
        nodeEnv: config.nodeEnv,
        publicUrl: config.publicUrl || null,
        addonUrl: config.addonUrl,
        trustProxy: config.trustProxy,
        anilibriaApiUrl: config.anilibriaApiUrl,
        dataDir: config.dataDir,
        passwordSource: pw.source,
        ntfyConfigured: Boolean(config.ntfyTopic),
        alertsEnabled: Boolean(config.ntfyTopic && config.ntfyAlerts),
        keepalive: { enabled: Boolean(config.publicUrl), job: jobs.get('keepalive') },
        stremioPublish: { enabled: Boolean(config.publicUrl), job: jobs.get('stremio-publish') },
      },
      security: securityNotes(req),
      sessions: auth.listSessions(req),
      alerts: alerts.info(),
    });
  });

  router.post('/admin/jobs/:id', async (req, res) => {
    try {
      const result = await jobs.trigger(req.params.id);
      res.json({ ok: true, ...result, job: jobs.get(req.params.id) });
    } catch (err) {
      if (err instanceof jobs.JobError) {
        if (err.retryAfterMs) res.setHeader('Retry-After', String(Math.ceil(err.retryAfterMs / 1000)));
        return res.status(err.status).json({ error: err.message, retryAfterMs: err.retryAfterMs, job: jobs.get(req.params.id) });
      }
      res.status(502).json({ error: err.message, job: jobs.get(req.params.id) });
    }
  });

  router.post('/admin/cache/clear-title', smallJson, async (req, res) => {
    const id = str(req.body?.id, 40).trim();
    if (!titleActionAllowed()) return res.status(429).json({ error: 'Too many cache actions; wait a minute' });
    const imdb = /^(tt\d{7,10})/.exec(id);
    const catalog = /^anilibria:(\d{1,7})/.exec(id);
    if (imdb) {
      const cleared = await resolver.clearCache(imdb[1]);
      return res.json({ ok: true, message: `${cleared} cached match(es) cleared for ${imdb[1]}` });
    }
    if (catalog) {
      const releaseId = Number(catalog[1]);
      anilibria.invalidateRelease(releaseId);
      availability.invalidate(releaseId);
      return res.json({ ok: true, message: `Release ${releaseId} will be refetched on next use` });
    }
    res.status(400).json({ error: 'Enter an IMDB ID (tt…) or a catalog ID (anilibria:…)' });
  });

  router.post('/admin/cache/invalidate-release', smallJson, (req, res) => {
    const releaseId = int(req.body?.releaseId, null, { min: 1, max: 9_999_999 });
    if (!releaseId) return res.status(400).json({ error: 'invalid release ID' });
    if (!titleActionAllowed()) return res.status(429).json({ error: 'Too many cache actions; wait a minute' });
    anilibria.invalidateRelease(releaseId);
    availability.invalidate(releaseId);
    res.json({ ok: true, message: `Release ${releaseId} will be refetched on next use` });
  });

  router.post('/sessions/revoke-others', (req, res) => {
    res.json({ ok: true, revoked: auth.revokeOtherSessions(req) });
  });

  router.post('/sessions/:id/revoke', (req, res) => {
    if (!auth.revokeSession(req, req.params.id)) return res.status(404).json({ error: 'session not found' });
    res.json({ ok: true });
  });
}

module.exports = { register };
