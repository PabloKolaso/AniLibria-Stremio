const test = require('node:test');
const assert = require('node:assert/strict');
const m = require('../src/bridge/matching');

test('toAlias builds AniLibria-style slugs', () => {
  assert.equal(m.toAlias('ONE PIECE'), 'one-piece');
  assert.equal(m.toAlias("JoJo's Bizarre Adventure"), 'jojos-bizarre-adventure');
  assert.equal(m.toAlias('HUNTER×HUNTER (2011)'), 'hunter-x-hunter-2011');
  assert.equal(m.toAlias('Pokémon'), 'pokemon');
  assert.equal(m.toAlias('Re:Zero kara Hajimeru'), 're-zero-kara-hajimeru');
  assert.equal(m.toAlias('進撃の巨人'), '');
});

test('aliasCandidates adds year-stripped variants but keeps season suffixes', () => {
  assert.deepEqual(
    m.aliasCandidates(['HUNTER×HUNTER (2011)', 'Hunter x Hunter (2011)', '進撃の巨人']),
    ['hunter-x-hunter-2011', 'hunter-x-hunter'],
  );
  // Stripping "II" would match season 1's release
  assert.deepEqual(m.aliasCandidates(['Overlord II', 'Date A Live II']), ['overlord-ii', 'date-a-live-ii']);
  // Same season number, AniLibria's phrasing
  assert.deepEqual(m.aliasCandidates(['86 EIGHTY-SIX Part 2']), ['86-eighty-six-part-2', '86-eighty-six-2nd-cour']);
  assert.deepEqual(m.aliasCandidates(['Vinland Saga Season 2']), ['vinland-saga-season-2', 'vinland-saga-2nd-season']);
  assert.deepEqual(m.aliasCandidates(['Fate/Zero 2nd Season']), ['fate-zero-2nd-season', 'fate-zero-season-2']);
  assert.deepEqual(m.aliasCandidates(['Show Part 11']), ['show-part-11', 'show-11th-cour']);
});

test('seasonMarker distinguishes seasons and parts', () => {
  const cases = {
    'Date A Live II': 's2',
    "Date A Live (Director's Cut)": 's1',
    'Date A Live 4': 's4',
    'Mob Psycho 100': 's1',
    'Mob Psycho 100 II': 's2',
    'Fate/Zero 2nd Season': 's2',
    'Shingeki no Kyojin Season 3 Part 2': 's3p2',
    '86 EIGHTY-SIX Part 2': 's1p2',
    'Hunter x Hunter (2011)': 's1',
    'Steins;Gate 0': 's0',
  };
  for (const [title, marker] of Object.entries(cases)) assert.equal(m.seasonMarker(title), marker, title);
  assert.equal(m.sameSeason(['Date A Live II', 'Date A Live 2'], "Date A Live (Director's Cut)"), false);
  assert.equal(m.sameSeason(['Maou Gakuin no Futekigousha'], 'Maou Gakuin no Futekigousha: Shijou Saikyou'), true);
});

test('significantWords splits hyphenated words and drops stop words', () => {
  assert.deepEqual(m.significantWords('Kaguya-sama wa Kokurasetai'), ['kaguya', 'sama']);
  assert.deepEqual(m.significantWords('Shingeki no Kyojin'), ['shingeki', 'kyojin']);
});

test('wordsMatch guards against same-first-word false positives', () => {
  const q = m.significantWords('Shingeki no Kyojin');
  assert.equal(m.wordsMatch(q, m.significantWords('Shingeki no Bahamut: Genesis')), false);
  assert.equal(m.wordsMatch(q, m.significantWords('Shingeki no Kyojin Season 2')), true);
  assert.equal(m.wordsMatch(['naruto'], ['boruto']), false);
  assert.equal(m.wordsMatch([], ['x']), false);
});

test('summarizeRelease prefers the Shikimori ID and keeps both IDs', () => {
  // Real AniLibria data: Takagi-san S2 has S1's MAL ID but the correct Shikimori ID
  const s = m.summarizeRelease({
    id: 8407, alias: 'karakai-jouzu-no-takagi-san-2', year: 2019,
    mal: { id: 35860 }, shikimori: { id: 38993 }, name: { english: 'Takagi-san 2' },
  });
  assert.equal(s.malId, 38993);
  assert.deepEqual(s.ids.sort(), [35860, 38993]);
  assert.equal(s.aliasWords, 'karakai jouzu no takagi san 2');

  const bare = m.summarizeRelease({ id: 1, alias: 'x', name: {} });
  assert.equal(bare.malId, null);
  assert.deepEqual(bare.ids, []);
});

test('verdict accepts ID matches and rejects releases tagged as other anime', () => {
  // AoT S1 must not match "Shingeki! Kyojin Chuugakkou" (a different MAL entry)
  const juniorHigh = { ids: [31374], year: 2015 };
  assert.equal(m.verdict(juniorHigh, { mal: 16498, year: 2013 }).ok, false);

  // Exact ID match
  assert.equal(m.verdict({ ids: [38000], year: 2019 }, { mal: 38000, year: 2019 }).ok, true);
  // ID match but wildly different year → AniLibria mislabel (HxH 1999 vs the 2011 dub)
  assert.equal(m.verdict({ ids: [136], year: 2011 }, { mal: 136, year: 1999 }).ok, false);
  // Mislabelled IDs rescued only by exact alias + same year (HxH 2011)
  assert.equal(m.verdict({ ids: [136], year: 2011 }, { mal: 11061, year: 2011 }, { exactAlias: true }).ok, true);
  assert.equal(m.verdict({ ids: [136], year: 2011 }, { mal: 11061, year: 2011 }).ok, false);
  // Releases without IDs are judged on year only
  assert.equal(m.verdict({ ids: [], year: 2020 }, { mal: 1, year: 2021 }).ok, true);
  assert.equal(m.verdict({ ids: [], year: 2010 }, { mal: 1, year: 2021 }).ok, false);
  // Unknown years never disqualify
  assert.equal(m.verdict({ ids: [5], year: null }, { mal: 5, year: 2000 }).ok, true);
});

test('absoluteEpisode sums preceding season sizes', () => {
  const counts = new Map([[1, 32], [2, 21], [3, 18]]);
  assert.equal(m.absoluteEpisode(counts, 1, 7), 7);
  assert.equal(m.absoluteEpisode(null, 1, 7), 7);
  assert.equal(m.absoluteEpisode(counts, 3, 1), 54);
  assert.equal(m.absoluteEpisode(counts, 5, 1), null); // season 4 size unknown
  assert.equal(m.absoluteEpisode(null, 2, 1), null);
});
