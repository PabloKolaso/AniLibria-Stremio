# Stremio AniLibria Addon

Provides Russian anime dub streams from [AniLibria](https://anilibria.top) inside Stremio.

## How It Works

```
Stremio asks for streams for "tt0388629 s1e5" (One Piece ep 5)
    → Look up IMDB tt0388629 in Fribb anime-lists → get AniList ID
    → Fetch English/romaji titles from AniList API
    → Fuzzy-match titles against full Anilibria catalog
    → Fetch episode list from Anilibria API
    → Return HLS stream URLs (480p / 720p / 1080p)
```

## Requirements

- [Node.js 18+](https://nodejs.org/)
- Internet access (calls AniLibria, AniList, and Fribb APIs)

## Setup

```bash
# 1. Install dependencies
npm install

# 2. Start the server
npm start
```

The addon will print:
```
Addon running at: http://localhost:7000/manifest.json
```

## Install in Stremio

1. Open Stremio
2. Go to **Addons** → search bar at top → paste:
   ```
   http://localhost:7000/manifest.json
   ```
3. Click **Install**

## Usage

- Browse any anime in Stremio (via Cinemeta or any other catalog addon)
- Open any episode
- In the stream selector you will see **AniLibria 1080p / 720p / 480p** as options
- Select one to play the Russian dub

## Notes

- Streams are **Russian dub only** (this is what AniLibria provides)
- The first time you open an episode it may take a few seconds (title matching)
- Subsequent requests for the same anime are instant (cached)
- The addon pre-warms a title index in the background on startup (~2-3 min)

## Files

```
src/
  index.js              — Server entry point
  manifest.js           — Addon manifest
  mapping/
    cache.js            — Fribb IMDB↔MAL/AniList mapping cache
  api/
    anilibria.js        — AniLibria API v1 client
    anilist.js          — AniList GraphQL client
  bridge/
    resolver.js         — Title matching & ID bridge logic
  handlers/
    streams.js          — Stream handler
```

## APIs Used

| API | Purpose |
|-----|---------|
| `anilibria.top/api/v1/` | Anime search + HLS stream URLs |
| Fribb `anime-list-mini.json` | IMDB ↔ MAL/AniList/AniDB ID mapping |
| `graphql.anilist.co` | Canonical anime titles by AniList ID |
