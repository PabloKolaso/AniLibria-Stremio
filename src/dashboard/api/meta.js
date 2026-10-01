/**
 * The `meta` block included in every dashboard API response.
 */

const lifecycle = require('../../monitoring/lifecycle');
const health    = require('../../monitoring/health');
const { version } = require('../../../package.json');

function meta() {
  const h = health.current();
  return {
    bootId: lifecycle.bootId,
    version,
    startedAt: lifecycle.startedAt,
    serverTime: Date.now(),
    health: { status: h.status, banner: h.banner },
  };
}

module.exports = { meta };
