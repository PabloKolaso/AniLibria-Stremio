/**
 * Runtime configuration, read once from environment variables.
 *
 * Every value has a safe default so `npm start` works with no configuration.
 */

const path = require('path');

/** Strip trailing slashes and reject anything that is not an http(s) URL. */
function parseUrl(name, value, fallback) {
  if (!value) return fallback;
  try {
    const url = new URL(value);
    if (url.protocol !== 'http:' && url.protocol !== 'https:') throw new Error('unsupported protocol');
    return url.toString().replace(/\/+$/, '');
  } catch (err) {
    console.warn(`[config] Ignoring invalid ${name}="${value}" (${err.message})`);
    return fallback;
  }
}

/**
 * Express "trust proxy" setting. Accepts true/false, a hop count, or a
 * comma-separated list of addresses/subnets (passed through to Express).
 */
function parseTrustProxy(value) {
  if (value === undefined || value === '') return true;
  const v = String(value).trim().toLowerCase();
  if (v === 'true') return true;
  if (v === 'false') return false;
  if (/^\d+$/.test(v)) return parseInt(v, 10);
  return value;
}

function parseBool(value, fallback = false) {
  if (value === undefined || value === '') return fallback;
  return /^(1|true|yes|on)$/i.test(String(value).trim());
}

function parsePort(value) {
  const port = parseInt(value, 10);
  return Number.isInteger(port) && port > 0 && port < 65536 ? port : 7000;
}

const port = parsePort(process.env.PORT);

const config = Object.freeze({
  port,
  /** Public base URL of this deployment; enables keep-alive pings and Stremio publishing. */
  publicUrl: parseUrl('PUBLIC_URL', process.env.PUBLIC_URL, ''),
  /** Canonical addon URL advertised on the install page and to the Stremio catalog. */
  addonUrl: parseUrl('ADDON_URL', process.env.ADDON_URL, 'https://anilibria-stremio.online'),
  /** Directory for persisted state (stats, logs, caches, dashboard auth). */
  dataDir: path.resolve(process.env.DATA_DIR || path.join(__dirname, '..', 'data')),
  trustProxy: parseTrustProxy(process.env.TRUST_PROXY),
  anilibriaApiUrl: parseUrl('ANILIBRIA_API_URL', process.env.ANILIBRIA_API_URL, 'https://anilibria.top/api/v1'),
  dashboardPassword: process.env.DASHBOARD_PASSWORD || '',
  ntfyTopic: process.env.NTFY_TOPIC || '',
  /** Send admin alerts (provider outages, stale catalogs, error spikes, crashes) to NTFY_TOPIC. */
  ntfyAlerts: parseBool(process.env.NTFY_ALERTS),
  nodeEnv: process.env.NODE_ENV || 'development',
});

module.exports = config;
