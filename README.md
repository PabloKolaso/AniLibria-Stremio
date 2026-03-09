# Stremio AniLibria Addon

> **EN** | [**RU**](#stremio-anilibria-addon-ru)

A Stremio addon that injects Russian anime dub streams from [AniLibria](https://anilibria.top) directly into Stremio's player.

---

## How It Works

```
Stremio requests streams for an IMDB ID (e.g. tt0388629)
    → IMDB ID is mapped to AniList ID via Fribb anime-lists
    → English / Romaji titles are fetched from AniList API
    → Titles are matched against the full AniLibria catalog
    → Episode list is fetched from AniLibria API
    → HLS stream URLs are returned (480p / 720p / 1080p)
```

## Install in Stremio

The addon is hosted on Render — no setup needed.

1. Open **Stremio**
2. Go to **Addons** → paste into the search bar:
   ```
   https://stremio-anilibria-addon.onrender.com/manifest.json
   ```
3. Click **Install**

## Usage

- Browse any anime in Stremio (via Cinemeta or any other catalog addon)
- Open any episode
- In the stream selector, choose **AniLibria 1080p / 720p / 480p**
- Enjoy the Russian dub

## Notes

- Streams are **Russian dub only** — that's what AniLibria provides
- First request for a new anime may take a few seconds (title matching)
- Subsequent requests for the same anime are instant (result is cached)
- A full title index is pre-loaded in the background on startup (~2–3 min)
- Hosted on the **free tier** of Render — the server may spin down after inactivity; first request could be slow

## Self-Hosting / Local Development

```bash
# Install dependencies
npm install

# Start the server
npm start
```

The addon will be available at:
```
http://localhost:7000/manifest.json
```

## Project Structure

```
src/
  index.js              — Server entry point
  manifest.js           — Addon manifest
  mapping/
    cache.js            — Fribb IMDB ↔ AniList mapping cache
  api/
    anilibria.js        — AniLibria API v1 client
    anilist.js          — AniList GraphQL client
  bridge/
    resolver.js         — Title matching & ID bridge
  handlers/
    streams.js          — Stream handler
```

## APIs Used

| API | Purpose |
|-----|---------|
| `anilibria.top/api/v1/` | Anime search + HLS stream URLs |
| Fribb `anime-list-mini.json` | IMDB ↔ MAL / AniList / AniDB ID mapping |
| `graphql.anilist.co` | Canonical anime titles by AniList ID |

---
---

# Stremio AniLibria Addon <sup>RU</sup>

> [**EN**](#stremio-anilibria-addon) | **RU**

Аддон для Stremio, который добавляет русскоязычные озвучки аниме от [AniLibria](https://anilibria.top) прямо в плеер.

---

## Как это работает

```
Stremio запрашивает стримы по IMDB ID (например tt0388629)
    → IMDB ID сопоставляется с AniList ID через Fribb anime-lists
    → Английское / ромадзи название тайтла запрашивается из AniList API
    → Название сравнивается с каталогом AniLibria
    → Список серий загружается через AniLibria API
    → Возвращаются HLS-ссылки на стримы (480p / 720p / 1080p)
```

## Подключить в Stremio

Аддон размещён на Render — ничего устанавливать не нужно.

1. Открыть **Stremio**
2. Перейти в **Addons** → вставить в строку поиска:
   ```
   https://stremio-anilibria-addon.onrender.com/manifest.json
   ```
3. Нажать **Install**

## Использование

- Откройте любое аниме в Stremio (через Cinemeta или другой каталог-аддон)
- Выберите любую серию
- В списке источников появятся варианты **AniLibria 1080p / 720p / 480p**
- Выберите нужное качество и наслаждайтесь русской озвучкой

## Примечания

- Стримы только на **русском** — это то, что предоставляет AniLibria
- Первый запрос к новому тайтлу может занять несколько секунд (поиск по названию)
- Повторные запросы к тому же тайтлу мгновенны (кэш)
- При запуске сервера в фоне загружается полный индекс тайтлов (~2–3 мин)
- Сервер размещён на **бесплатном тарифе** Render — после простоя он может уснуть; первый запрос может быть медленным

## Самостоятельный запуск / Локальная разработка

```bash
# Установить зависимости
npm install

# Запустить сервер
npm start
```

Аддон будет доступен по адресу:
```
http://localhost:7000/manifest.json
```

## Структура проекта

```
src/
  index.js              — Точка входа сервера
  manifest.js           — Манифест аддона
  mapping/
    cache.js            — Кэш маппинга Fribb IMDB ↔ AniList
  api/
    anilibria.js        — Клиент AniLibria API v1
    anilist.js          — Клиент AniList GraphQL
  bridge/
    resolver.js         — Сопоставление названий и ID
  handlers/
    streams.js          — Обработчик стримов
```

## Используемые API

| API | Назначение |
|-----|-----------|
| `anilibria.top/api/v1/` | Поиск аниме + HLS-ссылки |
| Fribb `anime-list-mini.json` | Маппинг IMDB ↔ MAL / AniList / AniDB |
| `graphql.anilist.co` | Канонические названия тайтлов по AniList ID |
