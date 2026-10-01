/**
 * ntfy.sh push notifications (dashboard password on first run, admin alerts).
 *
 * Messages are published as JSON to the ntfy root endpoint, so titles and
 * bodies may contain any characters (anime titles are often Cyrillic or
 * Japanese — HTTP headers could not carry them).
 */

const config = require('../config');
const http   = require('../api/http');

const NTFY_URL = 'https://ntfy.sh/';

function isConfigured() {
  return Boolean(config.ntfyTopic);
}

/**
 * @param {{ title: string, message: string, priority?: 1|2|3|4|5, tags?: string[] }} notification
 * @returns {Promise<boolean>} whether ntfy accepted the message (never throws)
 */
async function send({ title, message, priority = 3, tags = [] }) {
  if (!isConfigured()) return false;
  try {
    await http.postJson(NTFY_URL, { topic: config.ntfyTopic, title, message, priority, tags }, {
      service: 'ntfy', timeout: 10_000, responseType: 'text',
    });
    return true;
  } catch (err) {
    console.warn(`[ntfy] Notification failed: ${err.message}`);
    return false;
  }
}

module.exports = { send, isConfigured };
