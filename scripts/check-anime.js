/**
 * Bulk Anime Checker
 *
 * Fetches the most popular anime from AniList, then resolves each through
 * the addon's AniLibria matching pipeline (MAL ID → alias → fuzzy).
 * Also reports whether an IMDB mapping exists (needed for the live addon).
 *
 * Usage:
 *   npm run check-anime
 *
 * Results are printed to stdout AND saved to scripts/results_<timestamp>.txt
 */

'use strict';

const path = require('path');
const fs   = require('fs');

// Bootstrap server modules (no HTTP server started)
const http         = require('../src/api/http');
const mappingCache = require('../src/mapping/cache');
const resolver     = require('../src/bridge/resolver');

// ─── Config ──────────────────────────────────────────────────────────────────

const TOTAL_ANIME    = 2000;
const PAGE_SIZE      = 50;
const CONCURRENCY    = 5;    // parallel resolver calls
const PAGE_DELAY_MS  = 700;  // between AniList page fetches (stay under the 90 req/min limit)
const RESULTS_DIR    = __dirname;

// ─── AniList query ───────────────────────────────────────────────────────────

const POPULARITY_QUERY = `
query ($page: Int, $perPage: Int) {
  Page(page: $page, perPage: $perPage) {
    pageInfo { hasNextPage }
    media(type: ANIME, sort: POPULARITY_DESC) {
      id
      idMal
      seasonYear
      startDate { year }
      title { english romaji native }
      synonyms
    }
  }
}`;

async function fetchAniListPage(page, perPage) {
  const MAX_RETRIES = 3;
  for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
    try {
      const data = await http.postJson(
        'https://graphql.anilist.co',
        { query: POPULARITY_QUERY, variables: { page, perPage } },
        { service: 'AniList', timeout: 15_000, retries: 1 },
      );
      return data?.data?.Page || null;
    } catch (err) {
      if (err.status === 429 && attempt < MAX_RETRIES) {
        const retryAfter = parseInt(err.retryAfter || '60', 10);
        console.warn(`\n  [429] Rate-limited on page ${page}. Waiting ${retryAfter + 2}s...`);
        await sleep((retryAfter + 2) * 1000);
        continue;
      }
      console.warn(`\n  [warn] AniList page ${page} failed (attempt ${attempt}): ${err.message}`);
      return null;
    }
  }
  return null;
}

async function fetchPopularAnime(totalCount) {
  const anime = [];
  const pages = Math.ceil(totalCount / PAGE_SIZE);

  for (let page = 1; page <= pages; page++) {
    process.stdout.write(`  Fetching AniList page ${page}/${pages}...\r`);
    const pageResult = await fetchAniListPage(page, PAGE_SIZE);
    if (!pageResult) continue;
    anime.push(...(pageResult.media || []));
    if (!pageResult.pageInfo?.hasNextPage) break;
    if (page < pages) await sleep(PAGE_DELAY_MS);
  }

  console.log(`  Fetched ${anime.length} anime from AniList.         `);
  return anime.slice(0, totalCount);
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

/** Run at most `limit` async tasks concurrently. */
async function pLimit(tasks, limit) {
  const results = [];
  let i = 0;

  async function worker() {
    while (i < tasks.length) {
      const idx = i++;
      results[idx] = await tasks[idx]();
    }
  }

  await Promise.all(Array.from({ length: Math.min(limit, tasks.length) }, worker));
  return results;
}

function pad(str, len) {
  return String(str).padEnd(len).slice(0, len);
}

// ─── Main ─────────────────────────────────────────────────────────────────────

async function main() {
  console.log('=== Stremio AniLibria — Bulk Anime Checker ===\n');

  // Step 1: Load Fribb IMDB mapping (needed for imdbId reporting)
  console.log('Loading Fribb IMDB mapping...');
  await mappingCache.load();
  console.log(`  Loaded ${mappingCache.getMappingSize()} IMDB mappings.`);

  // Step 2: Build the AniLibria catalog index in the background
  console.log('Building AniLibria catalog index (background)...');
  resolver.warmup();

  // Step 3: Fetch popular anime from AniList
  console.log(`\nFetching top ${TOTAL_ANIME} anime from AniList by popularity...`);
  const animeList = await fetchPopularAnime(TOTAL_ANIME);

  // Step 4: Resolve each anime (no IMDB roundtrip)
  console.log(`\nResolving ${animeList.length} anime (concurrency=${CONCURRENCY})...\n`);

  const lines = [];
  let found = 0, missing = 0;
  let checked = 0;

  const tasks = animeList.map((anime, idx) => async () => {
    const display = anime.title?.english || anime.title?.romaji || `AniList#${anime.id}`;

    // IMDB ID is informational only — shows addon compatibility
    let imdbId = null;
    try {
      imdbId = await mappingCache.getImdbByAnilist(anime.id);
    } catch { /* skip */ }

    checked++;
    process.stdout.write(`  [${checked}/${animeList.length}] ${pad(display, 40)}\r`);

    let anilibriaId = null;
    let note;

    try {
      const res = await resolver.resolveMedia(anime);
      anilibriaId = res.releaseIds[0] || null;
      if (anilibriaId) note = `anilibria#${anilibriaId} (${res.method})`;
      else if (res.uncertain) note = 'lookup failed (upstream error)';
    } catch (err) {
      note = `resolver error: ${err.message}`;
    }

    if (anilibriaId) found++;
    else missing++;
    note = note || 'not found in Anilibria';

    const symbol = anilibriaId ? 'FOUND  ' : 'MISSING';
    const check  = anilibriaId ? '✓' : '✗';
    const imdb   = pad(imdbId || '-', 12);
    lines[idx] = `${check} ${symbol}  ${imdb}  ${pad(display, 42)}  → ${note}`;
  });

  await pLimit(tasks, CONCURRENCY);

  // Step 5: Print results
  console.log('\n\n' + '─'.repeat(100));
  console.log('RESULTS');
  console.log('─'.repeat(100));

  const output = lines.join('\n');
  console.log(output);

  const now = new Date();
  const dateStr = now.toLocaleString('en-GB', {
    day: '2-digit', month: 'short', year: 'numeric',
    hour: '2-digit', minute: '2-digit', second: '2-digit',
    hour12: false, timeZoneName: 'short',
  });

  const summary = [
    '',
    '─'.repeat(100),
    `SUMMARY: ${animeList.length} checked  |  ✓ ${found} found  |  ✗ ${missing} missing`,
    `Generated: ${dateStr}`,
    '─'.repeat(100),
  ].join('\n');

  console.log(summary);

  // Step 6: Save to file
  const ts = now.toISOString().replace(/[:.]/g, '-').replace('T', '_').slice(0, 19);
  const resultsFile = path.join(RESULTS_DIR, `results_${ts}.txt`);

  fs.writeFileSync(resultsFile, [
    'Stremio AniLibria — Bulk Check Results',
    `Generated: ${now.toISOString()}`,
    '─'.repeat(100),
    output,
    summary,
  ].join('\n'), 'utf8');
  console.log(`\nResults saved to: ${resultsFile}`);

  process.exit(0);
}

main().catch(err => {
  console.error('\n[fatal]', err.message);
  process.exit(1);
});
