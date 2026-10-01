const fs = require('fs');
const os = require('os');
const path = require('path');
process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'anilibria-installs-'));

const test = require('node:test');
const assert = require('node:assert/strict');
const semver = require('semver');
const { version } = require('../package.json');
const installs = require('../src/install-version');

const { MIN_SUPPORTED_MANIFEST_VERSION: MIN, LEGACY } = installs;

test('the minimum supported version is valid and never above the current release', () => {
  assert.equal(installs.parse(MIN), MIN);
  // Otherwise even fresh installs from the install page would be told to reinstall
  assert.ok(semver.lte(MIN, version), `MIN_SUPPORTED_MANIFEST_VERSION ${MIN} > package version ${version}`);
});

test('parse accepts canonical semver only', () => {
  for (const ok of ['3.0.0', '2.1.0', '10.20.30', '3.1.0-beta.1']) assert.equal(installs.parse(ok), ok);
  for (const bad of ['v3.0.0', '3.0.0+build', '3.0', '3', '', ' 3.0.0', '3.0.0 ', 'legacy', '1.2.3-' + 'a'.repeat(40), null, undefined, 3]) {
    assert.equal(installs.parse(bad), null, String(bad));
  }
});

test('legacy installs and versions below the minimum need a reinstall', () => {
  assert.equal(installs.needsReinstall(LEGACY), true);
  assert.equal(installs.needsReinstall('0.0.1'), true);
  assert.equal(installs.needsReinstall(`${MIN}-beta.1`), true, 'a prerelease precedes its release');
  assert.equal(installs.needsReinstall(MIN), false);
  assert.equal(installs.needsReinstall(version), false);
  assert.equal(installs.needsReinstall('999.0.0'), false, 'newer (e.g. after a rollback) is fine');
  // Not addon requests, or values that never come from the router: no notice, no throw
  for (const none of [null, undefined, '', 'other', 'garbage']) assert.equal(installs.needsReinstall(none), false, String(none));
});

test('the update notice is prepended without touching the original response', () => {
  const original = { streams: [{ url: 'u', behaviorHints: { bingeGroup: 'g' } }], cacheMaxAge: 60 };
  const res = installs.withUpdateNotice(original, LEGACY);
  assert.equal(res.cacheMaxAge, 60);
  assert.equal(res.streams.length, 2);
  assert.deepEqual(res.streams[1], original.streams[0]);
  assert.equal(original.streams.length, 1);

  const notice = res.streams[0];
  assert.equal(notice.name, '⚠️ AniLibria');
  assert.match(notice.description, /Доступно обновление/);
  assert.match(notice.description, /Update available/);
  assert.equal(notice.externalUrl, 'https://anilibria-stremio.online');
  // Never playable, never picked by auto-play of the next episode
  assert.equal(notice.url, undefined);
  assert.equal(notice.behaviorHints, undefined);

  assert.equal(installs.withUpdateNotice(original, version), original);
  assert.deepEqual(installs.withUpdateNotice({ streams: [] }, LEGACY).streams.map(s => s.name), ['⚠️ AniLibria']);
});
