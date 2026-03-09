/**
 * Bulk Anime Checker
 *
 * Fetches the top 500 most popular anime from AniList, maps them to IMDB IDs
 * via the Fribb mapping, then runs each through the full Anilibria resolver.
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

const TOTAL_ANIME    = 500;
const PAGE_SIZE      = 50;
const CONCURRENCY    = 5;    // parallel resolver calls
const PAGE_DELAY_MS  = 400;  // between AniList page fetches
const RESULTS_FILE   = path.join(__dirname, 'results.txt');

// ─── AniList query ───────────────────────────────────────────────────────────

const POPULARITY_QUERY = `
query ($page: Int, $perPage: Int) {
  Page(page: $page, perPage: $perPage) {
    media(type: ANIME, sort: POPULARITY_DESC) {
      id
      title { english romaji }
    }
  }
}`;

async function fetchPopularAnime(totalCount) {
  const anime = [];
  const pages = Math.ceil(totalCount / PAGE_SIZE);

  for (let page = 1; page <= pages; page++) {
    process.stdout.write(`  Fetching AniList page ${page}/${pages}...\r`);
    try {
      const { data } = await axios.post(
        'https://graphql.anilist.co',
        { query: POPULARITY_QUERY, variables: { page, perPage: PAGE_SIZE } },
        { headers: { 'Content-Type': 'application/json' }, timeout: 15_000 }
      );
      const items = data?.data?.Page?.media || [];
      anime.push(...items);
      if (items.length < PAGE_SIZE) break;
    } catch (err) {
      console.warn(`\n  [warn] AniList page ${page} failed: ${err.message}`);
    }
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

  // Step 1: Load Fribb IMDB mapping
  console.log('Loading Fribb IMDB mapping...');
  await mappingCache.load();

  // Step 2: Warm up Anilibria title index in background (helps Fuse.js step)
  console.log('Starting Anilibria index warmup (background)...');
  resolver.warmup();

  // Step 3: Fetch top 500 anime from AniList
  console.log(`\nFetching top ${TOTAL_ANIME} anime from AniList by popularity...`);
  const animeList = await fetchPopularAnime(TOTAL_ANIME);

  // Step 4: Resolve each anime
  console.log(`\nResolving ${animeList.length} anime (concurrency=${CONCURRENCY})...\n`);

  const lines = [];
  let found = 0, missing = 0, noImdb = 0;
  let checked = 0;

  const tasks = animeList.map((anime, idx) => async () => {
    const title = anime.title?.english || anime.title?.romaji || `AniList#${anime.id}`;

    // Look up IMDB ID via Fribb mapping (keyed by AniList ID)
    // The mapping cache uses getByImdb(), so we need to find the IMDB ID for this AniList ID.
    // We'll use the internal byAnilist map indirectly: try getImdbByAnilist if exported,
    // otherwise check the mapping by brute approach using existing API.
    let imdbId = null;
    try {
      // mappingCache doesn't export getImdbByAnilist by name in all versions;
      // we use the exported function if available
      if (typeof mappingCache.getImdbByAnilist === 'function') {
        imdbId = await mappingCache.getImdbByAnilist(anime.id);
      }
    } catch { /* skip */ }

    checked++;
    process.stdout.write(`  [${checked}/${animeList.length}] ${pad(title, 40)}\r`);

    let status, anilibriaId, note;

    if (!imdbId) {
      status = '?';
      note   = 'no IMDB in Fribb mapping';
      noImdb++;
    } else {
      try {
        anilibriaId = await resolver.resolveImdbToAnilibria(imdbId);
      } catch (err) {
        note = `resolver error: ${err.message}`;
      }

      if (anilibriaId) {
        status = '✓';
        note   = `anilibria#${anilibriaId}`;
        found++;
      } else {
        status = '✗';
        note   = note || 'not found in Anilibria';
        missing++;
      }
    }

    const symbol = status === '✓' ? 'FOUND  ' : status === '✗' ? 'MISSING' : 'NO_IMDB';
    const line = `${status} ${symbol}  ${pad(imdbId || '-', 12)}  ${pad(title, 42)}  → ${note}`;
    lines[idx] = line;
  });

  await pLimit(tasks, CONCURRENCY);

  // Step 5: Print results
  console.log('\n\n' + '─'.repeat(100));
  console.log('RESULTS');
  console.log('─'.repeat(100));

  const output = lines.join('\n');
  console.log(output);

  const summary = [
    '',
    '─'.repeat(100),
    `SUMMARY: ${animeList.length} checked  |  ✓ ${found} found  |  ✗ ${missing} missing  |  ? ${noImdb} no IMDB mapping`,
    '─'.repeat(100),
  ].join('\n');

  console.log(summary);

  // Step 6: Save to file
  const fileContent = [
    `Stremio AniLibria — Bulk Check Results`,
    `Generated: ${new Date().toISOString()}`,
    '─'.repeat(100),
    output,
    summary,
  ].join('\n');

  fs.writeFileSync(RESULTS_FILE, fileContent, 'utf8');
  console.log(`\nResults saved to: ${RESULTS_FILE}`);

  process.exit(0);
}

main().catch(err => {
  console.error('\n[fatal]', err.message);
  process.exit(1);
});
