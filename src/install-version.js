/**
 * Installed manifest versions.
 *
 * Stremio keeps the manifest it fetched at install time and never sends its
 * version. Every request is therefore tagged (req.installVersion) with:
 *   - the version in the URL, for the version-tagged routes
 *     (/v/3.0.0/manifest.json, /v/3.0.0/stream/series/tt123:1:1.json);
 *   - otherwise the version the client is known to have, see
 *     telemetry/client-versions.js;
 *   - otherwise "legacy": an install from before 3.0.0, or a client not seen
 *     since it reinstalled.
 *
 * The install page keeps handing out /manifest.json: Stremio identifies an
 * installed addon by its URL, so reinstalling from the same URL updates it in
 * place, while a tagged URL would add a second copy of the addon.
 *
 * Outdated installs (legacy, or below MIN_SUPPORTED_MANIFEST_VERSION) get a
 * "please reinstall" entry on top of their anime stream results.
 */

const semver = require('semver');
const config = require('./config');
const clientVersions = require('./telemetry/client-versions');

/**
 * Oldest installed manifest version that does not need a reinstall.
 *
 * Bump this ONLY when a release changes the manifest in a way existing
 * installs cannot pick up: Stremio keeps the manifest from install time, so
 * new resources, catalogs, types or idPrefixes reach a user only after a
 * reinstall. Releases that only change server-side behaviour leave it alone,
 * since every install already gets them.
 *
 * 3.0.0 added the catalogs and the meta resource.
 */
const MIN_SUPPORTED_MANIFEST_VERSION = '3.0.0';

/** Version of requests whose client is not known to have any manifest version. */
const LEGACY = 'legacy';

/** Longer than any version this addon hands out; keeps garbage out of telemetry. */
const MAX_VERSION_LENGTH = 32;

/**
 * Parse the :version segment of a tagged URL.
 * Only canonical semver ("3.0.0", "3.1.0-beta.1") is accepted: no "v" prefix,
 * no build metadata, nothing this addon never hands out.
 * @returns {string|null} the version, or null when malformed
 */
function parse(raw) {
  if (typeof raw !== 'string' || raw.length > MAX_VERSION_LENGTH) return null;
  return semver.valid(raw) === raw ? raw : null;
}

/**
 * Whether an install should be told to reinstall.
 * @param {string|null|undefined} installVersion - a version, LEGACY, or
 *        null/undefined for calls that are not addon requests (no notice)
 */
function needsReinstall(installVersion) {
  if (installVersion === LEGACY) return true;
  return parse(installVersion) !== null && semver.lt(installVersion, MIN_SUPPORTED_MANIFEST_VERSION);
}

/** Version for a request without a (valid) version in its URL. */
function clientVersion(req) {
  return clientVersions.knownVersion(req.ip) ?? LEGACY;
}

/**
 * Express middleware for the /v/:version mount: tags the request with its
 * install version. A malformed version can only come from an edited URL: its
 * manifest is refused (so it cannot be installed) and its resource requests
 * are served like unprefixed ones.
 */
function tagVersioned(req, res, next) {
  const installVersion = parse(req.params.version);
  if (installVersion === null && req.path === '/manifest.json') {
    return res.status(404).json({ err: 'unknown version' });
  }
  req.installVersion = installVersion ?? clientVersion(req);
  next();
}

/** Express middleware for the unprefixed routes. */
function tagUnversioned(req, res, next) {
  req.installVersion = clientVersion(req);
  next();
}

/**
 * Link to the install page, listed first for outdated installs. It has no url
 * and no bingeGroup, so it never plays and auto-play of the next episode
 * never picks it.
 */
function updateNotice() {
  return {
    name: '⚠️ AniLibria',
    description: 'Доступно обновление — нажмите, чтобы переустановить\nUpdate available — tap to reinstall',
    externalUrl: config.addonUrl,
  };
}

/** Prepend the update notice to a stream response when the install is outdated. */
function withUpdateNotice(response, installVersion) {
  if (!needsReinstall(installVersion)) return response;
  return { ...response, streams: [updateNotice(), ...response.streams] };
}

module.exports = {
  MIN_SUPPORTED_MANIFEST_VERSION, LEGACY,
  parse, needsReinstall, tagVersioned, tagUnversioned, updateNotice, withUpdateNotice,
};
