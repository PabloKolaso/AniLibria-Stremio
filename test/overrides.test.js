const fs = require('fs');
const os = require('os');
const path = require('path');
process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'anilibria-overrides-'));

// A v1 stats.json with overrides and failed lookups, as left by the previous version
fs.writeFileSync(path.join(process.env.DATA_DIR, 'stats.json'), JSON.stringify({
  counters: { totalRequests: 10 },
  hourlyBuckets: { '2020-01-01T00': 5 },
  failedLookups: {
    tt0000001: { title: 'Old Anime', isAnime: true, count: 4, lastSeen: Date.now() - 1000 },
    tt0000002: { title: 'Some Movie', isAnime: false, count: 9, lastSeen: Date.now() - 1000 },
    tt0000003: { title: 'Ignored Movie', isAnime: false, count: 1, lastSeen: Date.now() - 1000 },
  },
  ignoredLookups: { tt0000003: { reason: 'Not Anime', ignoredAt: 1700000000000 } },
  notDubbedLookups: { tt0000004: { markedAt: 1700000000001 } },
}));

const test = require('node:test');
const assert = require('node:assert/strict');
const overrides = require('../src/overrides');
const missing = require('../src/telemetry/missing');

test('v1 overrides are imported from stats.json', () => {
  assert.equal(overrides.getIgnored('tt0000003').reason, 'Not Anime');
  assert.equal(overrides.getNotDubbed('tt0000004').markedAt, 1700000000001);
});

test('v1 failed lookups keep only anime and overridden titles', () => {
  const all = missing.CATEGORIES.flatMap(category => missing.list({ category }).rows);
  const ids = all.map(r => r.imdbId);
  assert.ok(ids.includes('tt0000001'), 'confirmed anime is kept');
  assert.equal(ids.includes('tt0000002'), false, 'non-anime noise is dropped');
  assert.ok(ids.includes('tt0000003'), 'ignored title is kept with its info');
  assert.equal(all.find(r => r.imdbId === 'tt0000003').status, 'ignored');
  assert.equal(all.find(r => r.imdbId === 'tt0000004').status, 'not_dubbed');
});

test('importAll sanitizes values, rejects non-IMDB keys and previews without applying', () => {
  const payload = JSON.parse('{"ignoredLookups":{"tt0111161":{"reason":{"nested":true},"ignoredAt":"never"},"__proto__":{"polluted":true},"x":{}},"notDubbedLookups":{"tt2560140":42,"tt9335498":{"markedAt":1700000000000}},"matchDecisions":{"mal:123":{"releaseId":9,"decision":"reject"},"mal:x":{},"al:5":{"releaseId":-1,"decision":"approve"}}}');

  const preview = overrides.importAll(payload, { dryRun: true });
  assert.deepEqual(preview, { ignored: 1, notDubbed: 2, matchDecisions: 1, added: 4, replaced: 0, unchanged: 0 });
  assert.equal(overrides.getIgnored('tt0111161'), null, 'dry run changes nothing');

  const counts = overrides.importAll(payload);
  assert.equal(counts.added, 4);
  assert.equal({}.polluted, undefined);
  const exported = overrides.exportAll();
  assert.equal(exported.ignoredLookups.tt0111161.reason, '');
  assert.ok(Number.isFinite(exported.ignoredLookups.tt0111161.ignoredAt));
  assert.equal(exported.notDubbedLookups.tt9335498.markedAt, 1700000000000);
  assert.deepEqual(overrides.getMatchDecision('mal:123'), { releaseId: 9, decision: 'reject', at: exported.matchDecisions['mal:123'].at });
  assert.equal(overrides.getMatchDecision('al:5'), null);
  assert.equal(overrides.importAll(null).added, 0);

  assert.equal(overrides.importAll(payload, { dryRun: true }).unchanged, 4);
});

test('match decisions validate keys and notify listeners', () => {
  const events = [];
  overrides.onChange(e => events.push(e));
  assert.equal(overrides.setMatchDecision('bogus', { releaseId: 1, decision: 'approve' }), false);
  assert.equal(overrides.setMatchDecision('al:77', { releaseId: 0, decision: 'approve' }), false);
  assert.equal(overrides.setMatchDecision('al:77', { releaseId: 5, decision: 'approve' }), true);
  assert.equal(overrides.clearMatchDecision('al:77'), true);
  assert.deepEqual(events.map(e => [e.type, e.key]), [['match', 'al:77'], ['match', 'al:77']]);
});
