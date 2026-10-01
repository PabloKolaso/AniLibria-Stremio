/**
 * Human-readable names and explanations for the values the backend uses.
 */

export const STATUS_LABEL = {
  healthy: 'Healthy',
  idle: 'Idle',
  warning: 'Warning',
  degraded: 'Degraded',
  down: 'Down',
};

/** Outcome categories of anime stream requests (telemetry/traffic.js). */
export const CATEGORY = {
  found: { label: 'Found', tone: 'ok', color: '#3ecf8e', help: 'Streams returned' },
  not_on_anilibria: { label: 'Not on AniLibria', tone: 'cat-not_on_anilibria', color: '#a08cff', help: 'Anime AniLibria has no release for (not an error)' },
  episode_missing: { label: 'Episode missing', tone: 'warn', color: '#f2b33d', help: 'Release found, but not the requested episode' },
  unsupported: { label: 'Unsupported', tone: 'neutral', color: '#6f6f8a', help: 'Season 0 (specials) — not mapped by design' },
  blocked: { label: 'Blocked', tone: 'neutral', color: '#9a9ab2', help: 'Geo- or copyright-blocked on AniLibria' },
  error: { label: 'Error', tone: 'bad', color: '#f2605d', help: 'The addon could not answer (timeout, upstream failure, …)' },
  unclassified: { label: 'Unclassified', tone: 'neutral', color: '#4a4a60', help: 'Recorded before outcome tracking existed' },
  pass_through: { label: 'Non-anime', tone: 'neutral', color: '#4f6d99', help: 'IMDB ID not in the anime mapping — passed through with no streams' },
};

export const REASON = {
  found: 'Found',
  not_anime: 'Not an anime (not in the ID mapping)',
  not_on_anilibria: 'Anime not on AniLibria',
  episode_not_found: 'Episode not found in the release',
  special_season: 'Season 0 / specials',
  release_missing: 'Catalog release no longer exists',
  blocked: 'Blocked on AniLibria',
  timeout: 'Timed out (20 s)',
  lookup_failed: 'Lookup failed (upstream error)',
  release_fetch_failed: 'Release fetch failed',
  mapping_unavailable: 'ID mapping not loaded',
  plan_failed: 'Planning failed',
  unexpected: 'Unexpected error (bug)',
};

export const METHOD = {
  mal: { label: 'MAL ID', help: 'Exact MyAnimeList/Shikimori ID match', confidence: 'high' },
  alias: { label: 'Exact alias', help: 'Exact AniLibria alias with the same year', confidence: 'high' },
  pinned: { label: 'Pinned', help: 'Release approved by the admin', confidence: 'high' },
  direct: { label: 'Direct', help: "Request from this addon's own catalog (release known)", confidence: 'high' },
  search: { label: 'Search API', help: "AniLibria's title search (low confidence)", confidence: 'low' },
  fuse: { label: 'Fuzzy title', help: 'Fuzzy title match over the local index (low confidence)', confidence: 'low' },
  unknown: { label: 'Unknown', help: '', confidence: 'low' },
};

export const RESOURCE = {
  stream: 'Stream',
  catalog: 'Catalog',
  meta: 'Meta',
  manifest: 'Manifest',
  other: 'Other',
};

export const MISSING_CATEGORY = {
  not_on_anilibria: { label: 'Not on AniLibria', help: 'Anime in the ID mapping that AniLibria has no release for. Usually not dubbed (yet).' },
  mapping_gap: { label: 'Missing from mapping', help: 'Cinemeta lists these as anime, but the Fribb ID mapping has no entry — the addon cannot reach them even if AniLibria has a dub.' },
  episode_missing: { label: 'Episode not found', help: 'The release was found but not the requested episode — often an episode-numbering or season-split problem.' },
  not_dubbed: { label: 'Not dubbed yet', help: 'Marked by you as not dubbed yet. Cleared automatically when a request succeeds.' },
  now_available: { label: 'Now available', help: 'Previously missing titles that now resolve — confirmed by a request, or detected against the AniLibria index / mapping (unconfirmed).' },
  ignored: { label: 'Ignored', help: 'Hidden by you.' },
};

export const LIKELY_CAUSE = {
  not_released_yet: { label: 'Not released yet', tone: 'neutral', help: 'AniLibria is still dubbing this release; the episode is beyond the latest one.' },
  beyond_release: { label: 'Beyond release', tone: 'warn', help: 'The finished release has fewer episodes — probably a season split or numbering mismatch.' },
  numbering_mismatch: { label: 'Numbering mismatch', tone: 'bad', help: 'The episode number is within the release range but was not found — numbering differs.' },
  numbering_unknown: { label: 'Numbering unknown', tone: 'warn', help: 'The absolute episode number could not be computed (Cinemeta season sizes missing).' },
  no_episodes: { label: 'No episodes', tone: 'neutral', help: 'The release has no playable episodes.' },
};

export const TRENDING_REASON = {
  not_on_anilibria: 'Not on AniLibria',
  untrusted_match: 'Only a fuzzy match (rejected)',
  not_playable: 'No playable episodes',
  blocked: 'Blocked on AniLibria',
  not_returned: 'Release not returned by AniLibria',
  duplicate: 'Same release already listed',
  lookup_uncertain: 'Lookup inconclusive',
  no_metadata: 'No IDs or titles on AniList',
};

export const RELEASING_REASON = {
  no_playable_episodes: 'No playable episodes yet',
  blocked: 'Blocked on AniLibria',
  not_returned: 'Not returned by AniLibria',
  not_checked: 'Not checked',
};

export const UPDATE_EVENT = {
  episode: 'New episode',
  release: 'New release',
  blocked: 'Blocked',
  unblocked: 'Unblocked',
};

export function reasonLabel(reason) {
  return REASON[reason] || reason || '—';
}
