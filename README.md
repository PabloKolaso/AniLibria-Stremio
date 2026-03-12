<div align="center">

<img src="assets/logo.jpg" alt="AniLibria" width="120" />

# AniLibria for Stremio

*Russian anime dubs, directly inside Stremio.*

[![Node.js](https://img.shields.io/badge/node-%3E%3D18-brightgreen?logo=node.js&logoColor=white)](https://nodejs.org)
[![Stremio Addon](https://img.shields.io/badge/stremio-addon-7B5EA7)](https://stremio.com)
[![License: MIT](https://img.shields.io/badge/license-MIT-blue)](LICENSE)
[![Deploy: Render](https://img.shields.io/badge/deploy-Render-46E3B7?logo=render&logoColor=white)](https://render.com)
[![Stremio Addons](https://img.shields.io/badge/stremio--addons.net-install-7B5EA7)](https://stremio-addons.net/addons/anilibria)

**[English](#english) · [Русский](#русский)**

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
| Zero catalog noise | Stream-only addon — no duplicate browse sections |
| 4-step ID resolution | Alias → API search → Fuse.js fuzzy → session-cached |
| Binge-watch support | Auto-plays next episode via `bingeGroup` |
| Geo-block detection | Shows a readable message instead of a dead spinner |
| Fast cold starts | Full AniLibria index pre-warmed on server boot |
| Session caching | Each title resolved once; failed lookups retry after 2 hours |
| Admin dashboard | Password-protected `/dashboard` — Overview, Analytics, Logs, Failed Lookups |

---

## How It Works

Every stream request follows this resolution pipeline:

```
Stremio  ──▶  IMDB ID  (e.g. tt0388629)
                │
                ▼
         Fribb anime-list          IMDB → AniList / MAL / AniDB ID
                │
                ▼
         AniList GraphQL API       AniList ID → English + Rōmaji titles
                │
         ┌──────┴────────────────────────────────────┐
         ▼                                           ▼  fallback chain
  Anilibria alias lookup  →  Anilibria search API  →  Fuse.js index
  /api/v1/releases/{slug}     (word-prefix guard)      (full catalog,
                                                         threshold 0.25)
                │
                ▼
         Episode HLS URLs   (480p / 720p / 1080p)
                │
                ▼
            Stremio Player
```

The alias lookup is instant and exact. The search API and fuzzy index serve as progressively broader fallbacks, each with false-positive guards to prevent wrong matches.

---

## Install

**Hosted on Render** — no setup needed. Open the manifest URL in any browser and Stremio will prompt you to install:

```
https://anilibria-stremio.onrender.com/manifest.json
```

Or visit the addon directory and click **Install**:
**[stremio-addons.net/addons/anilibria](https://stremio-addons.net/addons/anilibria)**

Or click **+ Add addon** in Stremio → Addons and paste the URL.

---

## Usage

1. Browse any anime in Stremio (via Cinemeta or any catalog addon)
2. Open any episode
3. In the stream picker, select **AniLibria 1080p / 720p / 480p**
4. Enjoy the Russian dub

---

## Self-Hosting

**Requirements:** Node.js ≥ 18

```bash
git clone https://github.com/PabloKolaso/stremio-anilibria-addon.git
cd stremio-anilibria-addon
npm install
npm start
# Addon available at http://localhost:7000/manifest.json
```

### Environment Variables

| Variable | Default | Purpose |
|---|---|---|
| `PORT` | `7000` | HTTP listen port |
| `RENDER_EXTERNAL_URL` | — | Public base URL (auto-set on Render) |

### One-Click Deploy to Render

1. Fork this repository
2. Create a new **Web Service** on [render.com](https://render.com) pointing to your fork
3. Set start command: `node src/index.js`
4. Render sets `RENDER_EXTERNAL_URL` automatically — no extra config needed

---

## Dashboard

A password-protected admin panel is available at `/dashboard`. The password is printed to the server log on startup.

- **Overview** — top resolved anime, system resource stats
- **Analytics** — hourly / daily / monthly request and bandwidth charts
- **Logs** — queryable request history with CSV export
- **Failed Lookups** — titles that couldn't be resolved; manage ignored entries

## Debug Panel

A lightweight diagnostics page is available at `/debug`:

- Force-resolve any IMDB ID and trace the full lookup path step by step
- Useful for reporting missing anime or incorrect title matches

---

## Project Structure

```
src/
  index.js          — Server entry point
  manifest.js       — Addon manifest
  mapping/
    cache.js        — Fribb IMDB ↔ AniList mapping cache
  api/
    anilibria.js    — AniLibria REST API v1 client
    anilist.js      — AniList GraphQL client
  bridge/
    resolver.js     — 4-step title matching & ID bridge
  handlers/
    streams.js      — Stream handler
  debug.js          — Live diagnostics router
```

---

## Stack

| Library | Role |
|---|---|
| [`stremio-addon-sdk`](https://github.com/Stremio/stremio-addon-sdk) | Stremio addon protocol |
| `express` + `cors` | HTTP server |
| `axios` | HTTP client |
| [`fuse.js`](https://fusejs.io) | Fuzzy title matching |
| `node-cache` | In-process session cache |
| [Fribb `anime-list-mini.json`](https://github.com/Fribb/anime-lists) | IMDB → AniList/MAL/AniDB mapping |
| [AniList GraphQL](https://anilist.gitbook.io/anilist-apiv2-docs) | Canonical anime title lookup |
| [AniLibria REST API v1](https://anilibria.top) | HLS stream source |

---

## Limitations

- **Russian dub only** — AniLibria does not offer original audio or subtitles
- Anime not present in AniLibria's library return 0 streams (expected behavior)
- Some titles may be geo-restricted by AniLibria independent of this addon
- Hosted on the **free tier** of Render — the server may spin down after inactivity; the first request after a cold start may be slow

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
| Без лишних каталогов | Только стримы — никаких дублирующих разделов просмотра |
| 4-шаговое сопоставление ID | Алиас → поиск по API → нечёткий поиск Fuse.js → кэш |
| Авто-следующая серия | Поддержка `bingeGroup` для автоматического перехода |
| Определение геоблока | Понятное сообщение вместо зависшей загрузки |
| Быстрый холодный старт | Полный индекс AniLibria загружается в фоне при запуске |
| Кэш сессии | Каждый тайтл определяется один раз; повтор через 2 часа при ошибке |
| Панель управления | Защищённый паролем `/dashboard` — Обзор, Аналитика, Логи, Ошибки поиска |

---

## Как это работает

```
Stremio  ──▶  IMDB ID  (напр. tt0388629)
                │
                ▼
         Fribb anime-list          IMDB → AniList / MAL / AniDB ID
                │
                ▼
         AniList GraphQL API       AniList ID → английское + ромадзи название
                │
         ┌──────┴────────────────────────────────────┐
         ▼                                           ▼  цепочка запасных вариантов
  Поиск по алиасу AniLibria  →  Поиск API AniLibria  →  Индекс Fuse.js
  /api/v1/releases/{slug}        (проверка первого слова)  (весь каталог,
                                                            порог 0.25)
                │
                ▼
         HLS-ссылки на серии   (480p / 720p / 1080p)
                │
                ▼
            Плеер Stremio
```

---

## Подключить в Stremio

Аддон размещён на Render — ничего устанавливать не нужно. Откройте ссылку на манифест в браузере и Stremio предложит установить аддон:

```
https://anilibria-stremio.onrender.com/manifest.json
```

Или найдите аддон в каталоге и нажмите **Установить**:
**[stremio-addons.net/addons/anilibria](https://stremio-addons.net/addons/anilibria)**

Или нажмите **+ Add addon** в Stremio → Addons и вставьте URL.

---

## Использование

1. Откройте любое аниме в Stremio (через Cinemeta или другой каталог-аддон)
2. Выберите любую серию
3. В списке источников выберите **AniLibria 1080p / 720p / 480p**
4. Смотрите с русской озвучкой

---

## Самостоятельный запуск

**Требования:** Node.js ≥ 18

```bash
git clone https://github.com/PabloKolaso/stremio-anilibria-addon.git
cd stremio-anilibria-addon
npm install
npm start
# Аддон доступен по адресу http://localhost:7000/manifest.json
```

### Переменные окружения

| Переменная | По умолчанию | Назначение |
|---|---|---|
| `PORT` | `7000` | Порт HTTP-сервера |
| `RENDER_EXTERNAL_URL` | — | Публичный URL (задаётся автоматически на Render) |

### Деплой на Render (бесплатный тариф)

1. Форкнуть репозиторий
2. Создать новый **Web Service** на [render.com](https://render.com), указав форк
3. Команда запуска: `node src/index.js`
4. `RENDER_EXTERNAL_URL` задаётся Render автоматически

---

## Панель управления

Защищённая паролем панель администратора доступна по адресу `/dashboard`. Пароль выводится в лог сервера при запуске.

- **Обзор** — топ найденных тайтлов, статистика ресурсов сервера
- **Аналитика** — графики запросов и трафика по часам / дням / месяцам
- **Логи** — история запросов с фильтрацией и экспортом в CSV
- **Ошибки поиска** — тайтлы, которые не удалось определить; управление игнорируемыми записями

## Диагностика

Лёгкая страница диагностики доступна по адресу `/debug`:

- Принудительное определение любого IMDB ID с трассировкой всех шагов
- Помогает выявить проблемы с отсутствующими тайтлами или неверными совпадениями

---

## Структура проекта

```
src/
  index.js          — Точка входа сервера
  manifest.js       — Манифест аддона
  mapping/
    cache.js        — Кэш маппинга Fribb IMDB ↔ AniList
  api/
    anilibria.js    — Клиент AniLibria REST API v1
    anilist.js      — Клиент AniList GraphQL
  bridge/
    resolver.js     — 4-шаговое сопоставление названий и ID
  handlers/
    streams.js      — Обработчик стримов
  debug.js          — Роутер диагностики
```

---

## Используемые API

| API | Назначение |
|---|---|
| `anilibria.top/api/v1/` | Поиск аниме + HLS-ссылки |
| Fribb `anime-list-mini.json` | Маппинг IMDB ↔ MAL / AniList / AniDB |
| `graphql.anilist.co` | Канонические названия тайтлов по AniList ID |

---

## Ограничения

- **Только русская озвучка** — AniLibria не предоставляет оригинальный звук или субтитры
- Аниме, не вышедшее на AniLibria, возвращает 0 стримов (ожидаемое поведение)
- Некоторые тайтлы могут быть геоблокированы на стороне AniLibria
- Сервер на **бесплатном тарифе** Render засыпает при простое; первый запрос после паузы может быть медленным

---

## Лицензия

Copyright (c) 2025-2026 **Matvei Stupachenko**

Проект распространяется по лицензии [MIT](LICENSE). Разрешается свободное использование, изменение и распространение программного обеспечения при условии сохранения оригинального уведомления об авторских правах.

**Уведомление о сторонних API:** Этот аддон использует публичный REST API [AniLibria](https://anilibria.top), GraphQL API [AniList](https://anilist.co) и набор данных [Fribb anime-lists](https://github.com/Fribb/anime-lists). Проект является независимым и не связан с AniLibria, AniList или Fribb, не одобрен и не спонсируется ими. Все материалы, доступные через эти API, остаются собственностью их правообладателей.
