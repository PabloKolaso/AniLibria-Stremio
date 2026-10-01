const test = require('node:test');
const assert = require('node:assert/strict');
const { planTargets } = require('../src/bridge/targets');

const e = (type, mal, tvdbSeason = null, tvdbOffset = 0) => ({ type, mal, anilist: mal, tvdbSeason, tvdbOffset });

// Fribb entries for tt9335498 (Demon Slayer), in file order
const DEMON_SLAYER = [
  e('TV', 38000, 1), e('MOVIE', 40456, 0), e('TV', 47778, 3), e('ONA', 47398, 0, 2),
  e('TV', 49926, 2), e('TV', 51019, 4), e('TV', 55701, 5),
];
// tt2560140 (Attack on Titan): split-cour seasons 3 and 4
const AOT = [
  e('TV', 16498, 1), e('OVA', 18397, 0), e('TV', 25777, 2), e('TV', 35760, 3),
  e('TV', 38524, 3, 12), e('TV', 40028, 4), e('TV', 48583, 4, 16), e('SPECIAL', 51535, 4, 28),
];

const malOf = plan => plan.attempts.map(a => [a.entry.mal, a.episode, a.numbering]);

test('each TVDB season maps to its own anime entry (last Fribb entry no longer wins)', () => {
  assert.deepEqual(malOf(planTargets(DEMON_SLAYER, { type: 'series', season: 1, episode: 1 })), [[38000, 1, 'local']]);
  assert.deepEqual(malOf(planTargets(DEMON_SLAYER, { type: 'series', season: 2, episode: 3 })), [[49926, 3, 'local']]);
  assert.deepEqual(malOf(planTargets(DEMON_SLAYER, { type: 'series', season: 5, episode: 8 })), [[55701, 8, 'local']]);
  assert.equal(planTargets(DEMON_SLAYER, { type: 'series', season: 1, episode: 1 }).mode, 'season');
});

test('split-cour seasons use episode offsets, then fall back to earlier cours', () => {
  // S3E15 → Part 2 (offset 12) local episode 3, then Part 1 with episode 15 (merged release)
  assert.deepEqual(malOf(planTargets(AOT, { type: 'series', season: 3, episode: 15 })), [
    [38524, 3, 'local'], [35760, 15, 'local'],
  ]);
  assert.deepEqual(malOf(planTargets(AOT, { type: 'series', season: 3, episode: 12 })), [[35760, 12, 'local']]);
  // S4E29 → the Final Chapters special (offset 28)
  assert.equal(planTargets(AOT, { type: 'series', season: 4, episode: 29 }).attempts[0].entry.mal, 51535);
});

test('season 0 (specials) is not mapped', () => {
  const plan = planTargets(AOT, { type: 'series', season: 0, episode: 1 });
  assert.equal(plan.mode, 'special');
  assert.deepEqual(plan.attempts, []);
  assert.equal(plan.primary.mal, 16498);
});

test('single-entry long runners use absolute numbering', () => {
  const onePiece = [e('TV', 21)];
  const s1 = planTargets(onePiece, { type: 'series', season: 1, episode: 5 });
  assert.equal(s1.mode, 'absolute');
  assert.deepEqual(malOf(s1), [[21, 5, 'absolute']]);

  // Season > 1 needs per-season counts (filled in by the resolver)
  const s17 = planTargets([e('TV', 1735), e('MOVIE', 10686, 0)], { type: 'series', season: 17, episode: 9 });
  assert.deepEqual(malOf(s17), [[1735, null, 'absolute']]);
  assert.deepEqual(s17.attempts[0].absolute, { season: 17, episode: 9 });
});

test('unknown seasons fall back to franchise order from the first season', () => {
  const overlord = [e('TV', 29803, 1), e('TV', 35073, 2), e('TV', 37675, 3), e('TV', 48895, 4)];
  const plan = planTargets(overlord, { type: 'series', season: 5, episode: 1 });
  assert.equal(plan.mode, 'franchise');
  assert.equal(plan.attempts[0].entry.mal, 29803);
  assert.equal(plan.attempts[0].franchiseSeason, 5);
});

test('movies prefer MOVIE entries and play the first episode', () => {
  const plan = planTargets([e('TV', 1, 1), e('MOVIE', 2, 0)], { type: 'movie', season: null, episode: null });
  assert.equal(plan.mode, 'movie');
  assert.deepEqual(malOf(plan), [[2, 1, 'first']]);
  assert.deepEqual(malOf(planTargets([e('MOVIE', 32281)], { type: 'movie', season: null, episode: null })), [[32281, 1, 'first']]);
});

test('no mapping entries means not an anime', () => {
  assert.equal(planTargets([], { type: 'series', season: 1, episode: 1 }).mode, 'none');
});
