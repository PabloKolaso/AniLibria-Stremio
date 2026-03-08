const manifest = {
  id: 'community.anilibria.stremio',
  version: '1.0.0',
  name: 'AniLibria',
  description: 'Russian anime dub streams from AniLibria. Shows stream options for anime series and movies.',
  logo: 'https://anilibria.top/assets/img/logo.png',
  resources: ['stream'],
  types: ['series', 'movie'],
  // Only trigger for IMDB-prefixed IDs (tt...)
  idPrefixes: ['tt'],
  catalogs: [],
  behaviorHints: {
    adult: false,
    p2p: false,
  },
};

module.exports = manifest;
