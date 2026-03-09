/**
 * Bulk Anime Checker
 *
 * Fetches the top 500 most popular anime from AniList, then resolves each
 * directly by title through the Anilibria pipeline (alias → search → Fuse).
 * Also reports whether an IMDB mapping exists (needed for the live addon).
 *
 * Usage:
 *   node scripts/check-anime.js
 *
 * Results are printed to stdout AND saved to scripts/results.txt
 */

'use strict';

const path   = require('path');
const fs     = require('fs');
const axios  = require('axios');

// Bootstrap server modules (no HTTP server started)
const mappingCache = require('../src/mapping/cache');
const resolver     = require('../src/bridge/resolver');

// ─── Config ──────────────────────────────────────────────────────────────────

const TOTAL_ANIME    = 2000;
const PAGE_SIZE      = 50;
const CONCURRENCY    = 5;    // parallel resolver calls
const PAGE_DELAY_MS  = 700;  // between AniList page fetches (stay under 90 req/min limit)
const RESULTS_DIR    = __dirname;

// ─── AniList query ───────────────────────────────────────────────────────────

const POPULARITY_QUERY = `
query ($page: Int, $perPage: Int) {
  Page(page: $page, perPage: $perPage) {
    pageInfo { hasNextPage }
    media(type: ANIME, sort: POPULARITY_DESC) {
      id
      title { english romaji }
      synonyms
    }
  }
}`;

async function fetchAniListPage(page, perPage) {
  const MAX_RETRIES = 3;
  for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
    try {
      const { data } = await axios.post(
        'https://graphql.anilist.co',
        { query: POPULARITY_QUERY, variables: { page, perPage } },
        { headers: { 'Content-Type': 'application/json' }, timeout: 15_000 }
      );
      return data?.data?.Page || null;
    } catch (err) {
      const status = err.response?.status;
      if (status === 429 && attempt < MAX_RETRIES) {
        const retryAfter = parseInt(err.response?.headers?.['retry-after'] || '60', 10);
        const waitMs = (retryAfter + 2) * 1000;
        console.warn(`\n  [429] Rate-limited on page ${page}. Waiting ${retryAfter + 2}s...`);
        await sleep(waitMs);
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
    const items = pageResult.media || [];
    anime.push(...items);
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

  // Step 2: Warm up Anilibria title index in background (helps Fuse.js step)
  console.log('Starting Anilibria index warmup (background)...');
  resolver.warmup();

  // Step 3: Fetch top 500 anime from AniList
  console.log(`\nFetching top ${TOTAL_ANIME} anime from AniList by popularity...`);
  const animeList = await fetchPopularAnime(TOTAL_ANIME);

  // Step 4: Resolve each anime by title (no IMDB roundtrip)
  console.log(`\nResolving ${animeList.length} anime (concurrency=${CONCURRENCY})...\n`);

  const lines = [];
  let found = 0, missing = 0;
  let checked = 0;

  const tasks = animeList.map((anime, idx) => async () => {
    const english  = anime.title?.english || '';
    const romaji   = anime.title?.romaji  || '';
    const synonyms = anime.synonyms || [];
    const display  = english || romaji || `AniList#${anime.id}`;

    // Titles ordered romaji-first, with synonyms appended — mirrors collectTitles() in the real addon
    const titles = [romaji, english, ...synonyms].filter(Boolean);

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
      anilibriaId = await resolver.resolveByTitles(titles);
    } catch (err) {
      note = `resolver error: ${err.message}`;
    }

    if (anilibriaId) {
      note = `anilibria#${anilibriaId}`;
      found++;
    } else {
      note = note || 'not found in Anilibria';
      missing++;
    }

    const symbol = anilibriaId ? 'FOUND  ' : 'MISSING';
    const check  = anilibriaId ? '✓' : '✗';
    const imdb   = imdbId ? pad(imdbId, 12) : pad('-', 12);
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

  const fileContent = [
    `Stremio AniLibria — Bulk Check Results`,
    `Generated: ${now.toISOString()}`,
    '─'.repeat(100),
    output,
    summary,
  ].join('\n');

  fs.writeFileSync(resultsFile, fileContent, 'utf8');
  console.log(`\nResults saved to: ${resultsFile}`);

  process.exit(0);
}

main().catch(err => {
  console.error('\n[fatal]', err.message);
  process.exit(1);
});
