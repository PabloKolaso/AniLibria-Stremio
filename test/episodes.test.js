const test = require('node:test');
const assert = require('node:assert/strict');
const { findEpisode, hasHls } = require('../src/bridge/episodes');

const eps = (...ordinals) => ordinals.map(ordinal => ({ ordinal, hls_720: `u${ordinal}` }));

test('matches local episode numbers by ordinal', () => {
  assert.equal(findEpisode(eps(1, 2, 3), 2, 'local').ordinal, 2);
  assert.equal(findEpisode(eps(1, 2, 3), 4, 'local'), null);
  // Recap episodes with fractional ordinals do not shift the numbering
  assert.equal(findEpisode(eps(1, 2, 2.5, 3), 3, 'local').ordinal, 3);
});

test('releases continuing a previous cour (13, 14, …) map local N to their Nth episode', () => {
  assert.equal(findEpisode(eps(13, 14, 15, 16), 3, 'local').ordinal, 15);
  assert.equal(findEpisode(eps(13, 14, 15, 16), 5, 'local'), null);
});

test('absolute numbering never falls back to list position', () => {
  // Naruto Shippuden on AniLibria: episodes 370–500. S1E1 must not play episode 370.
  const shippuden = eps(370, 371, 372);
  assert.equal(findEpisode(shippuden, 1, 'absolute'), null);
  assert.equal(findEpisode(shippuden, 371, 'absolute').ordinal, 371);
});

test('movies take the lowest ordinal regardless of API order', () => {
  assert.equal(findEpisode(eps(2, 1), 1, 'first').ordinal, 1);
  assert.deepEqual(findEpisode([{ name: 'no ordinal' }], 1, 'first'), { name: 'no ordinal' });
  assert.equal(findEpisode([], 1, 'first'), null);
});

test('handles missing or malformed episode lists', () => {
  assert.equal(findEpisode(undefined, 1, 'local'), null);
  assert.equal(findEpisode([{ ordinal: '1' }, null], 1, 'local'), null);
});

test('hasHls requires at least one non-empty HLS URL', () => {
  assert.equal(hasHls({ hls_480: 'x' }), true);
  assert.equal(hasHls({ hls_480: '', hls_720: null }), false);
  assert.equal(hasHls(null), false);
});
