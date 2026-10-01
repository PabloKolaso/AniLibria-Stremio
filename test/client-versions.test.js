const fs = require('fs');
const os = require('os');
const path = require('path');
process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'anilibria-clients-'));

const test = require('node:test');
const assert = require('node:assert/strict');
const clientVersions = require('../src/telemetry/client-versions');

const DAY = 24 * 3_600_000;

test('a client is known by the manifest it fetched or the catalogs it requests', () => {
  assert.equal(clientVersions.knownVersion('198.51.100.1'), null, 'never seen: unknown');

  clientVersions.recordManifest('198.51.100.1', '3.0.0');
  assert.equal(clientVersions.knownVersion('198.51.100.1'), '3.0.0');
  assert.equal(clientVersions.knownVersion('::ffff:198.51.100.1'), '3.0.0', 'IPv4-mapped IPv6 is the same client');
  assert.equal(clientVersions.knownVersion('198.51.100.2'), null);

  clientVersions.recordAtLeast('198.51.100.2', clientVersions.CATALOGS_SINCE);
  assert.equal(clientVersions.knownVersion('198.51.100.2'), '3.0.0');

  // Catalog requests never downgrade a newer manifest; a fetched manifest is what the client has
  clientVersions.recordManifest('198.51.100.3', '3.4.0');
  clientVersions.recordAtLeast('198.51.100.3', '3.0.0');
  assert.equal(clientVersions.knownVersion('198.51.100.3'), '3.4.0');
  clientVersions.recordManifest('198.51.100.3', '3.1.0'); // e.g. after a rollback
  assert.equal(clientVersions.knownVersion('198.51.100.3'), '3.1.0');

  clientVersions.recordManifest(null, '3.0.0');
  assert.equal(clientVersions.knownVersion(null), null);
});

test('evidence expires unless the client keeps using the addon', () => {
  const now = Date.now();
  clientVersions.recordManifest('198.51.100.10', '3.0.0', now);
  clientVersions.recordManifest('198.51.100.11', '3.0.0', now);
  assert.equal(clientVersions.knownVersion('198.51.100.10', now + 60 * DAY), '3.0.0', 'still in use: refreshed');
  assert.equal(clientVersions.knownVersion('198.51.100.10', now + 120 * DAY), '3.0.0');
  assert.equal(clientVersions.knownVersion('198.51.100.11', now + 91 * DAY), null, 'unused for 90 days: forgotten');
});

test('known clients survive a restart', async () => {
  clientVersions.recordManifest('198.51.100.20', '3.0.0');
  await clientVersions.flush();
  const file = path.join(process.env.DATA_DIR, 'client-versions.json');
  assert.ok(fs.readFileSync(file, 'utf8').length > 0);
  assert.ok(!fs.readFileSync(file, 'utf8').includes('198.51.100.20'), 'raw IPs are never stored');

  delete require.cache[require.resolve('../src/telemetry/client-versions')];
  const reloaded = require('../src/telemetry/client-versions');
  assert.equal(reloaded.knownVersion('198.51.100.20'), '3.0.0');
});
