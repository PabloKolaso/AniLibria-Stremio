const { version } = require('../../package.json');

const manifest = {
  id: 'community.anilibria.stremio',
  version,
  name: 'AniLibria',
  description: 'Russian anime dub streams from AniLibria. Shows stream options for anime series and movies.',
  resources: ['stream'],
  types: ['series', 'movie'],
  // Only trigger for IMDB-prefixed IDs (tt...)
  idPrefixes: ['tt'],
  catalogs: [],
  behaviorHints: {
    adult: false,
    p2p: false,
  },
  stremioAddonsConfig: {
    issuer: 'https://stremio-addons.net',
    signature: 'eyJhbGciOiJkaXIiLCJlbmMiOiJBMTI4Q0JDLUhTMjU2In0..asLrIRuDIa5l_CpoSgPcFQ.xP4WfZpHYOMGZC80zogUn3DyWj-Ojyl1zVJFObHCRbwBTO3WnX6AvaZJJRml50DbVGlx_qidb3BUU_MgOLW3rjSIuCl5T_x2kaDrrXIp_7QLEoo8Wb0XcZLiKROrwYAo.4reCpQN5TXgFwZmoozT3Aw',
  },
};

module.exports = manifest;
