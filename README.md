<div align="center">

<img src="assets/logo.jpg" alt="AniLibria" width="120" />

# AniLibria for Stremio

*Russian anime dubs, directly inside Stremio.*

[![Node.js](https://img.shields.io/badge/node-%3E%3D20-brightgreen?logo=node.js&logoColor=white)](https://nodejs.org)
[![Stremio Addon](https://img.shields.io/badge/stremio-addon-7B5EA7)](https://stremio.com)
[![License: MIT](https://img.shields.io/badge/license-MIT-blue)](LICENSE)
[![Deploy: Koyeb](https://img.shields.io/badge/deploy-Koyeb-121212?logo=koyeb&logoColor=white)](https://koyeb.com)
[![Stremio Addons](https://img.shields.io/badge/stremio--addons.net-install-7B5EA7)](https://stremio-addons.net/addons/anilibria)

**[English](#english) · [Русский](#русский)**

<br>

[![Install in Stremio](https://img.shields.io/badge/%E2%96%B6%20Install%20in%20Stremio-CC3333?style=for-the-badge&logo=data:image/svg+xml;base64,PHN2ZyB4bWxucz0iaHR0cDovL3d3dy53My5vcmcvMjAwMC9zdmciIHZpZXdCb3g9IjAgMCAyNCAyNCI+PHBhdGggZmlsbD0id2hpdGUiIGQ9Ik04IDV2MTRsMTEtN3oiLz48L3N2Zz4=)](https://anilibria-stremio.online)
&nbsp;
[![Install Page](https://img.shields.io/badge/Install%20Page-anilibria--stremio.online-7B5EA7?style=for-the-badge)](https://anilibria-stremio.online)
&nbsp;
[![Buy Me a Coffee](https://img.shields.io/badge/Buy%20Me%20a%20Coffee-FFDD00?style=for-the-badge&logo=buymeacoffee&logoColor=black)](https://buymeacoffee.com/anilibriastremio)

</div>

---

<a name="english"></a>

## What It Does

Watch Russian-dubbed anime in Stremio without leaving the app or managing a separate catalog. The addon bridges Stremio's IMDB-based library to AniLibria's HLS CDN, injecting **480p / 720p / 1080p** stream options for any title available in AniLibria's library.

---

## Features

| Feature | Detail |
|---|---|
| Multi-quality HLS | 480p · 720p · 1080p per episode |
| Live catalogs | **AniLibria – Releasing** and **Trending Anime – AniLibria**, updated automatically (see below) |
| Season-aware matching | Each Stremio season/episode maps to the exact AniLibria release by MyAnimeList ID |
| Long runners | One Piece, Naruto Shippuden, Bleach… use absolute episode numbers |
| Binge-watch support | Auto-plays the next episode in the quality you picked (`bingeGroup`) |
| Geo-block detection | Shows a readable message instead of a dead spinner |
| Reinstall notice | Outdated installs get a tap-to-reinstall entry on anime titles (see [Updating](#updating)) |
| Fast cold starts | ID mapping and AniList data cached on disk; AniLibria catalog indexed at boot |
| Admin dashboard | `/dashboard` (password protected) — health monitoring, traffic, catalogs, missing titles, logs, admin tools |

---

## How It Works

Every stream request follows this resolution pipeline:

```
Stremio  ──▶  IMDB ID + season + episode  (e.g. tt9335498:2:3)
                │
                ▼
         Fribb anime-list          IMDB → every MAL / AniList entry of the show,
                │                  each with its TVDB season + episode offset
                ▼
         Season targeting          S2E3 → the entry for season 2, local episode 3
                │                  (single-entry long runners → absolute episode)
                ▼
         AniLibria catalog index   MAL ID → release (exact; year cross-checked
                │                  against AniList)
                │   fallback for releases without IDs:
                │   exact alias → Fuse.js fuzzy (same-season and ID guards)
                ▼
         Episode HLS URLs   (480p / 720p / 1080p)
                │
                ▼
            Stremio Player
```

AniLibria tags almost every release with its MyAnimeList ID, so most lookups are exact.
Title matching is only a fallback, and it never accepts a release that AniLibria tags as a
different anime — so an unavailable show returns no streams instead of the wrong one.

---

## Install

**Hosted on Koyeb** — no setup needed. Open the manifest URL in any browser and Stremio will prompt you to install:

```
https://anilibria-stremio.online/manifest.json
```

Or visit the addon directory and click **Install**:
**[stremio-addons.net/addons/anilibria](https://stremio-addons.net/addons/anilibria)**

Or click **+ Add addon** in Stremio → Addons and paste the URL.

---

## Usage

1. Browse any anime in Stremio (via Cinemeta or any catalog addon), or open one of the addon's catalogs
2. Open any episode
3. In the stream picker, select **AniLibria 1080p / 720p / 480p**
4. Enjoy the Russian dub

The last entry in the list, **☕ Support**, opens the project's
[Buy Me a Coffee page](https://buymeacoffee.com/anilibriastremio). It only appears when streams were
found and is never picked by auto-play.

---

<a name="updating"></a>

## Updating

Fixes to matching, new episodes and catalog changes reach every install immediately — they run on
the server. The manifest is different: Stremio stores it at install time and never refreshes it,
so new catalogs or resources only reach you after a reinstall.

If your install is too old for the current release (today: anything before **v3.0.0**, which added
the catalogs), anime titles show **⚠️ AniLibria — Update available — tap to reinstall** at the top
of the stream list. Reinstall from the same URL, `https://anilibria-stremio.online/manifest.json`:
Stremio then updates the existing install in place instead of adding a second copy. Non-anime titles
never show the notice.

Stremio does not tell an addon which manifest a client has, so the addon infers it: the version of
the manifest the client last fetched, or at least 3.0.0 once it opens a catalog (only 3.0.0+
manifests declare catalogs). Clients are identified by the same salted IP hash as the usage
statistics and forgotten after 90 days without requests.

---

## Catalogs

Both catalogs appear on the Stremio home screen and in Discover. **Every title in them has a
playable AniLibria dub** — the catalog, the episode list and the streams all come from the same
AniLibria release (item IDs are `anilibria:<releaseId>`).

| Catalog | Source | Refresh |
|---|---|---|
| **AniLibria – Releasing** | Releases AniLibria is dubbing right now (`production_statuses=IS_IN_PRODUCTION`), most recently updated first | every 60 s |
| **Trending Anime – AniLibria** | AniList's live trending ranking (`TRENDING_DESC`, top 100), kept only when the anime matches an AniLibria release by MyAnimeList ID (or exact title and year) **and** that release has playable episodes | every 5 min |

New episodes: AniLibria has no push notifications, so the addon polls its update feed
(`/anime/releases/latest`) every minute and refetches only the releases that changed. A new
episode shows up in the catalog, episode list and streams within about a minute — and a stream
request for an episode we have not seen yet rechecks AniLibria immediately. Nothing requires a
restart. If AniLibria or AniList is unreachable, the last verified lists stay in place; unverified
titles are never shown.

---

## Self-Hosting

**Requirements:** Node.js ≥ 20

```bash
git clone https://github.com/PabloKolaso/stremio-anilibria-addon.git
cd stremio-anilibria-addon
npm install
npm start
# Addon available at http://localhost:7000/manifest.json

npm run dev           # restart on file changes
npm test              # unit + integration tests (offline)
npm run check-anime   # resolve AniList's 2000 most popular anime, report what is (not) found
```

### Environment Variables

| Variable | Default | Purpose |
|---|---|---|
| `PORT` | `7000` | HTTP listen port |
| `PUBLIC_URL` | — | Public base URL of this deployment (e.g. `https://your-app.koyeb.app`). Enables the keep-alive self-ping and Stremio catalog registration |
| `ADDON_URL` | `https://anilibria-stremio.online` | Canonical addon URL shown on the install page and registered with Stremio. Set it for your own instance |
| `DASHBOARD_PASSWORD` | — | Dashboard password (recommended on cloud hosts). If unset, one is generated on first run and saved to `data/dashboard-password.txt` |
| `NTFY_TOPIC` | — | Optional [ntfy.sh](https://ntfy.sh) topic that receives the generated password (and alerts, see below) |
| `NTFY_ALERTS` | `false` | `true` sends admin alerts to `NTFY_TOPIC`: provider outages, stale catalogs, error-rate spikes, crashes, a mapping that stops refreshing |
| `TRUST_PROXY` | `true` | Express `trust proxy` setting (`true`, `false`, hop count, or subnet list). Use the number of proxies in front of the app when known |
| `DATA_DIR` | `./data` | Where stats, logs and caches are persisted |
| `ANILIBRIA_API_URL` | `https://anilibria.top/api/v1` | AniLibria API base URL (in case the domain changes) |
| `GIT_COMMIT` | — | Commit reported by `/version`. Read automatically from `KOYEB_GIT_SHA` or `RENDER_GIT_COMMIT` when the platform sets them |

### Deploy to Koyeb (free tier)

1. Fork this repository
2. Create a new **Web Service** on [koyeb.com](https://koyeb.com) pointing to your fork
3. Koyeb auto-detects Node.js — build: `npm install`, run: `npm start`
4. Add env vars: `PUBLIC_URL` = `https://your-app-name.koyeb.app`, `ADDON_URL` = the same URL, and `DASHBOARD_PASSWORD`

A `render.yaml` blueprint is also included for [Render](https://render.com). Render's free tier
sleeps after 15 minutes without traffic; with `PUBLIC_URL` set, the addon pings itself every
12 minutes to stay awake.

### Endpoints

| Path | Purpose |
|---|---|
| `/` | Install page |
| `/manifest.json` | Addon manifest — the URL to install |
| `/health` | Liveness: version, uptime, mapping and index readiness, catalog status |
| `/version` | Deployed `version`, `minSupported` install version, `commit`, `startedAt` |
| `/dashboard` | Admin panel (password protected) |
| `/debug/resolve/{imdbId}` | Re-resolve one ID (dashboard login required, see below) |

The addon routes are also served under `/v/{version}/` (e.g. `/v/3.0.0/manifest.json`). These are
not handed out: Stremio would install a tagged URL as a second copy of the addon.

### Releasing a New Version

1. Bump `version` in `package.json` — it is shown in the manifest, the install page, `/health` and `/version`
2. Bump `MIN_SUPPORTED_MANIFEST_VERSION` in `src/install-version.js` **only** if the manifest changed in a
   way existing installs cannot pick up (new resources, catalogs, types or ID prefixes). Every install
   below it gets the reinstall notice, so leave it alone for server-side changes

---

## Dashboard

An admin panel is available at `/dashboard`. It is password protected (see `DASHBOARD_PASSWORD`);
sessions last 7 days, survive restarts (only token hashes are stored) and end when the password
changes. Failed logins are rate-limited. Works on phones.

| Page | Answers |
|---|---|
| **Overview** | Is everything working? Health banner, status of every provider (AniLibria, AniList, Cinemeta, Fribb, Stremio API) and data source, 24 h KPIs (anime requests, users, error rate, coverage, p95 latency), grouped recent problems, top anime |
| **Traffic** | How is the addon used and performing? 24 h / 7 d / 30 d / 90 d: requests by outcome, latency, unique users, resource mix, resolver match methods, outcome reasons, requests by installed version (share of outdated installs) — each compared with the previous period |
| **Content** | What data is available and updating? Releasing and Trending catalogs with the reason every title is (not) listed, recent AniLibria updates, index and mapping status, low-confidence matches to approve/reject, coverage report |
| **Missing titles** | What cannot be resolved, and why? Not on AniLibria · missing from the ID mapping · episode not found (with a likely cause) · not dubbed yet · now available · ignored |
| **Logs** | What happened for one request? Filterable request log with details drawer and "re-resolve now", CSV export; live server console |
| **Admin** | Resolve tester, background jobs and cache controls (with server-side cooldowns), process/restart/crash details, configuration, sessions |

Stremio asks every stream addon about every title a user opens, so most requests are for
non-anime titles. These are counted separately ("non-anime pass-through") and never mixed into
the anime metrics or the missing-titles list.

## Debug Endpoint

`/debug/resolve/{imdbId}?season=1&episode=1` (dashboard login required) re-resolves an ID,
bypassing caches, and returns the outcome, the AniLibria release and the log lines of the lookup —
useful for reporting missing anime or incorrect matches. Add `type=movie` for movies. The
dashboard's **Admin → Resolve tester** shows the same with every step, and also accepts catalog IDs
(`anilibria:9660:8`) and pasted Stremio/IMDB links.

---

## Project Structure

```
src/
  index.js              — Server entry point (boot, background jobs, graceful shutdown)
  app.js                — Express app: protocol routes, install page, health, dashboard
  stremio.js            — Stremio addon protocol (manifest + resource routes)
  manifest.js           — Addon manifest
  install-version.js    — Installed manifest versions, reinstall notice
  config.js             — Environment variables
  handlers/
    streams.js          — Stream handler (IMDB and catalog IDs)
    catalog.js          — Catalog handler (paging)
    meta.js             — Metadata for catalog items
  catalogs/
    releasing.js        — "Releasing" catalog + AniLibria update poller
    trending.js         — "Trending" catalog (AniList → AniLibria)
    updates.js          — Recent AniLibria updates feed (new episodes/releases)
    meta.js             — Stremio metadata built from AniLibria releases
  bridge/
    resolver.js         — IMDB → anime entry → AniLibria release
    targets.js          — Season/episode → mapping entry selection
    episodes.js         — Episode selection inside a release
    matching.js         — ID and title match validation
    franchise.js        — Franchise-order fallback for unmapped seasons
  mapping/
    cache.js            — Fribb IMDB ↔ MAL/AniList mapping (disk-cached)
    anilibria-catalog.js — AniLibria catalog index (MAL ID, alias, fuzzy)
    availability.js     — Which AniLibria releases are playable (bulk-checked)
    coverage.js         — How much of AniLibria's catalog the addon can reach
  api/
    http.js             — fetch wrapper: timeouts, retries, typed errors
    anilibria.js        — AniLibria REST API v1 client
    anilist.js          — AniList GraphQL client (disk-cached)
    cinemeta.js         — Cinemeta client (titles, season sizes)
  telemetry/              — request log, hourly traffic, users, client versions, top titles, missing titles, match review
  monitoring/             — provider health, process metrics, lifecycle, problems, jobs, alerts
  dashboard/              — dashboard routes and JSON API; public/ holds the browser app (ES modules)
  util/                   — JSON stores, append-only logs, TTL cache, timeouts
  overrides.js, auth.js, debug.js, install-page.js
scripts/check-anime.js  — bulk check of popular anime against the resolver
test/                   — node:test suites (npm test)
```

---

## Stack

| Library | Role |
|---|---|
| `express` 5 + `cors` + `compression` | HTTP server and Stremio addon protocol |
| [`fuse.js`](https://fusejs.io) | Fuzzy title matching (fallback) |
| [`semver`](https://github.com/npm/node-semver) | Installed manifest version checks |
| Node.js `fetch` | HTTP client |
| [Fribb `anime-list-mini.json`](https://github.com/Fribb/anime-lists) | IMDB → MAL/AniList mapping with TVDB seasons |
| [AniList GraphQL](https://anilist.gitbook.io/anilist-apiv2-docs) | Canonical titles and release years |
| [Cinemeta](https://v3-cinemeta.strem.io) | Season sizes for absolute episode numbering |
| [AniLibria REST API v1](https://anilibria.top) | Catalog and HLS stream source |

---

## Limitations

- **Russian dub only** — AniLibria does not offer original audio or subtitles
- Anime not present in AniLibria's library return 0 streams (expected behavior)
- Specials in Stremio's "season 0" are not mapped
- Some titles may be geo-restricted by AniLibria independent of this addon
- Hosted on the **free tier** of Koyeb — always running, no cold starts

---

## Support

The addon is free and has no ads. If it is useful to you, you can support its development and
hosting on Buy Me a Coffee:

[![Buy Me a Coffee](https://img.shields.io/badge/Buy%20Me%20a%20Coffee-FFDD00?style=for-the-badge&logo=buymeacoffee&logoColor=black)](https://buymeacoffee.com/anilibriastremio)

---

## License

Copyright (c) 2025-2026 **Matvei Stupachenko**

This project is licensed under the [MIT License](LICENSE). You are free to use, modify, and distribute this software, provided the original copyright notice is retained in all copies.

**Third-Party API Notice:** This addon uses the [AniLibria](https://anilibria.top) public REST API, the [AniList](https://anilist.co) GraphQL API, and the [Fribb anime-lists](https://github.com/Fribb/anime-lists) mapping dataset. It is an independent, unofficial project and is not affiliated with, endorsed by, or sponsored by AniLibria, AniList, or Fribb. All content accessed through these APIs remains the property of its respective copyright holders.

---
---

<a name="русский"></a>

<div align="center">

# AniLibria для Stremio

*Русская озвучка аниме прямо в Stremio.*

**[English](#english) · [Русский](#русский)**

</div>

---

## Что это

Аддон добавляет русскоязычные озвучки аниме от [AniLibria](https://anilibria.top) прямо в Stremio — без отдельного каталога и лишних приложений. Для любого тайтла из библиотеки AniLibria в плеере появятся варианты качества **480p / 720p / 1080p**.

---

## Возможности

| Функция | Описание |
|---|---|
| Несколько качеств HLS | 480p · 720p · 1080p для каждой серии |
| Живые каталоги | **AniLibria – Releasing** и **Trending Anime – AniLibria** обновляются автоматически (см. ниже) |
| Учёт сезонов | Каждый сезон/серия Stremio сопоставляется с нужным релизом AniLibria по ID MyAnimeList |
| Длинные сериалы | One Piece, Naruto Shippuden, Bleach… — сквозная нумерация серий |
| Авто-следующая серия | `bingeGroup` сохраняет выбранное качество при переходе к следующей серии |
| Определение геоблока | Понятное сообщение вместо зависшей загрузки |
| Напоминание о переустановке | Устаревшие установки видят на аниме пункт «нажмите, чтобы переустановить» (см. [Обновление](#обновление)) |
| Быстрый холодный старт | Маппинг ID и данные AniList кэшируются на диске; каталог AniLibria индексируется при запуске |
| Панель управления | `/dashboard` (защищена паролем) — мониторинг, трафик, каталоги, ненайденные тайтлы, логи, инструменты администратора |

---

## Как это работает

```
Stremio  ──▶  IMDB ID + сезон + серия  (напр. tt9335498:2:3)
                │
                ▼
         Fribb anime-list          IMDB → все записи MAL / AniList тайтла,
                │                  у каждой — сезон TVDB и смещение серий
                ▼
         Выбор сезона              S2E3 → запись 2-го сезона, серия 3
                │                  (длинные сериалы → сквозной номер серии)
                ▼
         Индекс каталога AniLibria MAL ID → релиз (точно; год сверяется с AniList)
                │   запасной вариант для релизов без ID:
                │   точный алиас → нечёткий поиск Fuse.js (с проверкой сезона и ID)
                ▼
         HLS-ссылки на серии   (480p / 720p / 1080p)
                │
                ▼
            Плеер Stremio
```

Почти каждый релиз AniLibria помечен ID MyAnimeList, поэтому большинство сопоставлений точные.
Поиск по названию — лишь запасной вариант, и он никогда не принимает релиз, который AniLibria
помечает как другое аниме: недоступный тайтл вернёт 0 стримов, а не чужие серии.

---

## Подключить в Stremio

Аддон размещён на Koyeb — ничего устанавливать не нужно. Откройте ссылку на манифест в браузере и Stremio предложит установить аддон:

```
https://anilibria-stremio.online/manifest.json
```

Или найдите аддон в каталоге и нажмите **Установить**:
**[stremio-addons.net/addons/anilibria](https://stremio-addons.net/addons/anilibria)**

Или нажмите **+ Add addon** в Stremio → Addons и вставьте URL.

---

## Использование

1. Откройте любое аниме в Stremio (через Cinemeta, другой каталог-аддон или каталоги этого аддона)
2. Выберите любую серию
3. В списке источников выберите **AniLibria 1080p / 720p / 480p**
4. Смотрите с русской озвучкой

Последний пункт списка, **☕ Support**, открывает
[страницу проекта на Buy Me a Coffee](https://buymeacoffee.com/anilibriastremio). Он появляется только
когда стримы найдены, и автовоспроизведение его никогда не выбирает.

---

<a name="обновление"></a>

## Обновление

Исправления сопоставления, новые серии и изменения каталогов доходят до всех установок сразу — они
работают на сервере. С манифестом иначе: Stremio сохраняет его при установке и больше не обновляет,
поэтому новые каталоги и ресурсы появятся только после переустановки.

Если установка слишком старая для текущей версии (сейчас — всё до **v3.0.0**, где появились каталоги),
на аниме в начале списка стримов появляется **⚠️ AniLibria — Доступно обновление — нажмите, чтобы
переустановить**. Переустановите аддон по тому же адресу, `https://anilibria-stremio.online/manifest.json`:
тогда Stremio обновит существующую установку, а не добавит вторую копию. На не-аниме это напоминание
не показывается.

Stremio не сообщает аддону, какой манифест у клиента, поэтому аддон определяет это сам: по версии
манифеста, который клиент загрузил последним, или как минимум 3.0.0, если клиент открывает каталог
(каталоги объявлены только в манифестах 3.0.0+). Клиенты различаются по тому же солёному хэшу IP, что
и в статистике, и забываются через 90 дней без запросов.

---

## Каталоги

Оба каталога видны на главной странице Stremio и в разделе «Обзор». **У каждого тайтла в них есть
озвучка AniLibria, которую можно посмотреть**: каталог, список серий и стримы берутся из одного и
того же релиза AniLibria (ID элементов — `anilibria:<releaseId>`).

| Каталог | Источник | Обновление |
|---|---|---|
| **AniLibria – Releasing** | Релизы, которые AniLibria озвучивает сейчас (`production_statuses=IS_IN_PRODUCTION`), сначала недавно обновлённые | каждые 60 с |
| **Trending Anime – AniLibria** | Живой рейтинг трендов AniList (`TRENDING_DESC`, топ-100); остаются только тайтлы, совпавшие с релизом AniLibria по ID MyAnimeList (или по точному названию и году), **и** только если у релиза есть серии | каждые 5 мин |

Новые серии: у AniLibria нет push-уведомлений, поэтому аддон раз в минуту опрашивает ленту
обновлений (`/anime/releases/latest`) и заново загружает только изменившиеся релизы. Новая серия
появляется в каталоге, списке серий и стримах примерно за минуту, а запрос серии, которой ещё нет в
кэше, сразу перепроверяется в AniLibria. Перезапуск не нужен. Если AniLibria или AniList недоступны,
остаются последние проверенные списки; непроверенные тайтлы не показываются никогда.

---

## Самостоятельный запуск

**Требования:** Node.js ≥ 20

```bash
git clone https://github.com/PabloKolaso/stremio-anilibria-addon.git
cd stremio-anilibria-addon
npm install
npm start
# Аддон доступен по адресу http://localhost:7000/manifest.json

npm run dev           # перезапуск при изменении файлов
npm test              # модульные и интеграционные тесты (без сети)
npm run check-anime   # проверить 2000 самых популярных аниме AniList: что найдено, а что нет
```

### Переменные окружения

| Переменная | По умолчанию | Назначение |
|---|---|---|
| `PORT` | `7000` | Порт HTTP-сервера |
| `PUBLIC_URL` | — | Публичный URL этого развёртывания (напр. `https://your-app.koyeb.app`). Включает самопинг и регистрацию в каталоге Stremio |
| `ADDON_URL` | `https://anilibria-stremio.online` | Основной URL аддона для страницы установки и регистрации в Stremio. Укажите для своего экземпляра |
| `DASHBOARD_PASSWORD` | — | Пароль панели (рекомендуется для облака). Если не задан, генерируется при первом запуске и сохраняется в `data/dashboard-password.txt` |
| `NTFY_TOPIC` | — | Необязательный топик [ntfy.sh](https://ntfy.sh) для отправки сгенерированного пароля (и оповещений) |
| `NTFY_ALERTS` | `false` | `true` — отправлять в `NTFY_TOPIC` оповещения: сбои провайдеров, устаревшие каталоги, всплески ошибок, падения, устаревший маппинг |
| `TRUST_PROXY` | `true` | Настройка Express `trust proxy` (`true`, `false`, число прокси или список подсетей) |
| `DATA_DIR` | `./data` | Каталог для статистики, логов и кэшей |
| `ANILIBRIA_API_URL` | `https://anilibria.top/api/v1` | Базовый URL API AniLibria (на случай смены домена) |
| `GIT_COMMIT` | — | Коммит, который показывает `/version`. Берётся автоматически из `KOYEB_GIT_SHA` или `RENDER_GIT_COMMIT`, если платформа их задаёт |

### Деплой на Koyeb (бесплатный тариф)

1. Форкнуть репозиторий
2. Создать новый **Web Service** на [koyeb.com](https://koyeb.com), указав форк
3. Koyeb автоматически определяет Node.js — сборка: `npm install`, запуск: `npm start`
4. Добавить переменные окружения: `PUBLIC_URL` = `https://your-app-name.koyeb.app`, `ADDON_URL` = тот же URL и `DASHBOARD_PASSWORD`

Для [Render](https://render.com) в репозитории есть `render.yaml`. Бесплатный тариф Render засыпает
через 15 минут без запросов; если задан `PUBLIC_URL`, аддон пингует себя каждые 12 минут.

### Адреса

| Путь | Назначение |
|---|---|
| `/` | Страница установки |
| `/manifest.json` | Манифест аддона — адрес для установки |
| `/health` | Проверка работы: версия, аптайм, готовность маппинга и индекса, состояние каталогов |
| `/version` | Развёрнутая `version`, минимальная поддерживаемая версия установки `minSupported`, `commit`, `startedAt` |
| `/dashboard` | Панель управления (по паролю) |
| `/debug/resolve/{imdbId}` | Повторное определение одного ID (нужен вход в панель, см. ниже) |

Маршруты аддона доступны и с префиксом `/v/{version}/` (напр. `/v/3.0.0/manifest.json`). Эти адреса
не раздаются: Stremio установил бы такой URL как вторую копию аддона.

### Выпуск новой версии

1. Поднять `version` в `package.json` — она видна в манифесте, на странице установки, в `/health` и `/version`
2. Поднимать `MIN_SUPPORTED_MANIFEST_VERSION` в `src/install-version.js` **только** если манифест изменился так,
   что существующие установки этого не получат (новые ресурсы, каталоги, типы или префиксы ID). Все установки
   ниже этой версии увидят напоминание о переустановке, поэтому для серверных изменений её не трогайте

---

## Панель управления

Панель администратора доступна по адресу `/dashboard`. Она защищена паролем (см. `DASHBOARD_PASSWORD`);
сессия действует 7 дней и переживает перезапуск (хранятся только хэши токенов), смена пароля завершает
все сессии. Число неудачных попыток входа ограничено. Панель работает и на телефоне.

- **Overview** — всё ли работает: статус провайдеров и данных, показатели за 24 ч, сгруппированные проблемы, топ аниме
- **Traffic** — исходы запросов, задержка, пользователи, ресурсы, методы сопоставления и запросы по установленной версии (доля устаревших установок) со сравнением с прошлым периодом
- **Content** — каталоги Releasing и Trending с причинами исключения, обновления AniLibria, индекс и маппинг, неточные совпадения, покрытие
- **Missing titles** — нет на AniLibria, нет в маппинге, серия не найдена, ещё не озвучено, уже доступно, скрыто
- **Logs** — журнал запросов с фильтрами и подробностями, экспорт CSV; консоль сервера
- **Admin** — проверка запроса, фоновые задачи и кэши, процесс и перезапуски, конфигурация, сессии

## Диагностика

`/debug/resolve/{imdbId}?season=1&episode=1` (нужен вход в панель) заново определяет ID в обход кэшей
и возвращает результат, релиз AniLibria и строки лога — помогает разбирать отсутствующие тайтлы
или неверные совпадения. Для фильмов добавьте `type=movie`. То же самое, с подробностями каждого шага,
показывает **Admin → Resolve tester** в панели; он также принимает ID каталогов (`anilibria:9660:8`)
и вставленные ссылки Stremio/IMDB.

---

## Структура проекта

```
src/
  index.js              — Точка входа (запуск, фоновые задачи, корректное завершение)
  app.js                — Express: маршруты протокола, страница установки, health, панель
  stremio.js            — Протокол аддонов Stremio (манифест и ресурсы)
  manifest.js           — Манифест аддона
  install-version.js    — Установленные версии манифеста, напоминание о переустановке
  config.js             — Переменные окружения
  handlers/
    streams.js          — Обработчик стримов (IMDB и ID каталогов)
    catalog.js          — Обработчик каталогов (постраничный вывод)
    meta.js             — Метаданные элементов каталогов
  catalogs/
    releasing.js        — Каталог «Releasing» + опрос обновлений AniLibria
    trending.js         — Каталог «Trending» (AniList → AniLibria)
    updates.js          — Лента последних обновлений AniLibria (новые серии и релизы)
    meta.js             — Метаданные Stremio из релизов AniLibria
  bridge/
    resolver.js         — IMDB → запись аниме → релиз AniLibria
    targets.js          — Выбор записи по сезону/серии
    episodes.js         — Выбор серии внутри релиза
    matching.js         — Проверка совпадений по ID и названиям
    franchise.js        — Запасной выбор сезона по порядку франшизы
  mapping/
    cache.js            — Маппинг Fribb IMDB ↔ MAL/AniList (кэш на диске)
    anilibria-catalog.js — Индекс каталога AniLibria (MAL ID, алиас, нечёткий поиск)
    availability.js     — Какие релизы AniLibria можно посмотреть (пакетная проверка)
    coverage.js         — Какую часть каталога AniLibria аддон может найти
  api/
    http.js             — Обёртка над fetch: таймауты, повторы, типизированные ошибки
    anilibria.js        — Клиент AniLibria REST API v1
    anilist.js          — Клиент AniList GraphQL (кэш на диске)
    cinemeta.js         — Клиент Cinemeta (названия, размеры сезонов)
  telemetry/              — журнал запросов, почасовая статистика, пользователи, версии клиентов, топ, отсутствующие тайтлы
  monitoring/             — здоровье провайдеров, метрики процесса, перезапуски, проблемы, задачи, оповещения
  dashboard/              — маршруты и JSON API панели; public/ — браузерное приложение (ES-модули)
  util/                   — JSON-хранилища, журналы, TTL-кэш, таймауты
  overrides.js, auth.js, debug.js, install-page.js
scripts/check-anime.js  — массовая проверка популярных аниме через резолвер
test/                   — тесты node:test (npm test)
```

---

## Используемые API

| API | Назначение |
|---|---|
| `anilibria.top/api/v1/` | Каталог аниме + HLS-ссылки |
| Fribb `anime-list-mini.json` | Маппинг IMDB ↔ MAL / AniList с сезонами TVDB |
| `graphql.anilist.co` | Канонические названия и годы выхода |
| Cinemeta | Размеры сезонов для сквозной нумерации серий |

---

## Ограничения

- **Только русская озвучка** — AniLibria не предоставляет оригинальный звук или субтитры
- Аниме, не вышедшее на AniLibria, возвращает 0 стримов (ожидаемое поведение)
- Спецвыпуски из «нулевого сезона» Stremio не сопоставляются
- Некоторые тайтлы могут быть геоблокированы на стороне AniLibria
- Сервер на **бесплатном тарифе** Koyeb — всегда работает, без засыпания

---

## Поддержать проект

Аддон бесплатный и без рекламы. Если он вам полезен, вы можете поддержать разработку и хостинг
на Buy Me a Coffee:

[![Buy Me a Coffee](https://img.shields.io/badge/Buy%20Me%20a%20Coffee-FFDD00?style=for-the-badge&logo=buymeacoffee&logoColor=black)](https://buymeacoffee.com/anilibriastremio)

---

## Лицензия

Copyright (c) 2025-2026 **Matvei Stupachenko**

Проект распространяется по лицензии [MIT](LICENSE). Разрешается свободное использование, изменение и распространение программного обеспечения при условии сохранения оригинального уведомления об авторских правах.

**Уведомление о сторонних API:** Этот аддон использует публичный REST API [AniLibria](https://anilibria.top), GraphQL API [AniList](https://anilist.co) и набор данных [Fribb anime-lists](https://github.com/Fribb/anime-lists). Проект является независимым и не связан с AniLibria, AniList или Fribb, не одобрен и не спонсируется ими. Все материалы, доступные через эти API, остаются собственностью их правообладателей.
