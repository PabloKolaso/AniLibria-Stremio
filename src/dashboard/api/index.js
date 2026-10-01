/**
 * Dashboard JSON API (/dashboard/api/*).
 *
 * Every route requires a dashboard session. Every response has a `meta`
 * block (boot ID, version, start time, overall health) that the browser
 * uses for the header's live status and to detect server restarts.
 * State-changing requests must carry the X-Dashboard-Request header — a
 * cross-site form cannot set it (defence in depth next to SameSite=Strict).
 */

const express = require('express');
const { requireAuthApi } = require('../../auth');

const router = express.Router();

router.use(requireAuthApi);
router.use((req, res, next) => {
  res.setHeader('Cache-Control', 'no-store');
  if (req.method !== 'GET' && req.method !== 'HEAD' && req.get('x-dashboard-request') !== '1') {
    return res.status(403).json({ error: 'missing X-Dashboard-Request header' });
  }
  next();
});

require('./overview').register(router);
require('./traffic').register(router);
require('./content').register(router);
require('./missing').register(router);
require('./logs').register(router);
require('./admin').register(router);

router.use((req, res) => res.status(404).json({ error: 'not found' }));

module.exports = router;
