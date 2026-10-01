const { version } = require('../package.json');

const manifest = {
  id: 'community.anilibria.stremio',
  version,
  name: 'AniLibria',
  description: `Russian anime dub streams from AniLibria. Shows stream options for anime series and movies, plus live catalogs of what AniLibria is dubbing now and of trending anime available with a Russian dub. This addon logs anonymous usage data to help improve performance and your experience. v${version}`,
  logo: 'https://fandub.wiki/images/thumb/0/06/AniLibria_%D0%9B%D0%BE%D0%B3%D0%BE%D1%82%D0%B8%D0%BF_%D0%BA%D0%BE%D0%BB%D0%BB%D0%B5%D0%BA%D1%82%D0%B8%D0%B2%D0%B0.jpg/200px-AniLibria_%D0%9B%D0%BE%D0%B3%D0%BE%D1%82%D0%B8%D0%BF_%D0%BA%D0%BE%D0%BB%D0%BB%D0%B5%D0%BA%D1%82%D0%B8%D0%B2%D0%B0.jpg',
  resources: [
    'catalog',
    // Metadata only for this addon's own catalog items; IMDB titles use Cinemeta
    { name: 'meta', types: ['series', 'movie'], idPrefixes: ['anilibria:'] },
    // Streams for IMDB IDs (tt...) and for catalog items (anilibria:...)
    { name: 'stream', types: ['series', 'movie'], idPrefixes: ['tt', 'anilibria:'] },
  ],
  types: ['series', 'movie'],
  idPrefixes: ['tt', 'anilibria:'],
  catalogs: [
    { type: 'series', id: 'anilibria-releasing', name: 'AniLibria – Releasing', extra: [{ name: 'skip', isRequired: false }] },
    { type: 'series', id: 'anilibria-trending', name: 'Trending Anime – AniLibria', extra: [{ name: 'skip', isRequired: false }] },
  ],
  behaviorHints: {
    adult: false,
    p2p: false,
  },
  stremioAddonsConfig: {
    issuer: 'https://stremio-addons.net',
    signature: 'eyJhbGciOiJkaXIiLCJlbmMiOiJBMTI4Q0JDLUhTMjU2In0..asLrIRuDIa5l_CpoSgPcFQ.xP4WfZpHYOMGZC80zogUn3DyWj-Ojyl1zVJFObHCRbwBTO3WnX6AvaZJJRml50DbVGlx_qidb3BUU_MgOLW3rjSIuCl5T_x2kaDrrXIp_7QLEoo8Wb0XcZLiKROrwYAo.4reCpQN5TXgFwZmoozT3Aw',
  },
};

module.exports = Object.freeze(manifest);
