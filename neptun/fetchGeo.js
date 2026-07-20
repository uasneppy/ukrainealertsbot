/**
 * Downloads and caches the three NEPTUN boundary GeoJSON files locally.
 * On subsequent calls the cached files are read from disk, so the network
 * is only hit once per deployment.
 */

import fs from 'fs/promises';
import path from 'path';
import { fileURLToPath } from 'url';

import { fetchWithTimeout } from '../fetchWithTimeout.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

/** Overridable so tests (and unusual deployments) can point elsewhere. */
export function getGeoDir() {
  return process.env.NEPTUN_GEO_DIR || path.join(__dirname, 'geo');
}

/** Generous deadline — the raion boundaries are a multi-MB download. */
const TIMEOUT_MS = 30_000;

/**
 * Administrative boundaries change rarely, but "never" is not the same as
 * "rarely": the cache lives in a Docker volume that outlives deployments, so
 * without this the files downloaded on a container's first boot would be
 * served forever. Past this age the next getGeoData() call triggers a
 * background re-download; the current (still valid) data is returned meanwhile.
 */
const MAX_CACHE_AGE_MS = 30 * 24 * 60 * 60 * 1000; // 30 days
const AGE_CHECK_INTERVAL_MS = 60 * 60 * 1000; // at most one stat sweep per hour

const GEO_URLS = {
  ukraine: 'https://neptun.in.ua/ukraine.geojson',
  oblasts: 'https://neptun.in.ua/oblasts.geojson',
  raions: 'https://neptun.in.ua/raions.geojson',
};

async function downloadAndCache(name, url) {
  const destPath = path.join(getGeoDir(), `${name}.geojson`);
  console.log(`[fetchGeo] Downloading ${name}.geojson …`);
  const response = await fetchWithTimeout(url, { timeoutMs: TIMEOUT_MS });
  if (!response.ok) {
    throw new Error(`Failed to fetch ${url}: HTTP ${response.status}`);
  }
  const text = await response.text();
  await fs.writeFile(destPath, text, 'utf8');
  console.log(`[fetchGeo] Cached ${name}.geojson`);
  return JSON.parse(text);
}

async function loadOrDownload(name, url) {
  const destPath = path.join(getGeoDir(), `${name}.geojson`);
  try {
    const text = await fs.readFile(destPath, 'utf8');
    return JSON.parse(text);
  } catch {
    return downloadAndCache(name, url);
  }
}

/** In-process cache so repeated calls within the same run are free. */
let _cache = null;
let _lastAgeCheck = 0;
let _refreshInFlight = null;

/** Age of the oldest cached file; Infinity when any of them is missing. */
export async function geoCacheAgeMs(now = Date.now()) {
  const ages = await Promise.all(
    Object.keys(GEO_URLS).map(async (name) => {
      try {
        const stat = await fs.stat(path.join(getGeoDir(), `${name}.geojson`));
        return now - stat.mtimeMs;
      } catch {
        return Infinity;
      }
    })
  );
  return Math.max(...ages);
}

/**
 * Re-downloads in the background when the cache has aged out. Never blocks the
 * caller — boundaries that are a month stale are still perfectly usable for
 * the request in flight, so the refresh lands on a later one.
 */
function refreshIfStale() {
  const now = Date.now();
  if (_refreshInFlight || now - _lastAgeCheck < AGE_CHECK_INTERVAL_MS) return;
  _lastAgeCheck = now;

  _refreshInFlight = (async () => {
    const age = await geoCacheAgeMs(now);
    if (age <= MAX_CACHE_AGE_MS) return;
    console.log(
      `[fetchGeo] Cached boundaries are ${Math.round(age / 86_400_000)} days old — refreshing`
    );
    await forceRefreshGeo();
  })()
    .catch((err) => {
      // Keep serving the old files; the next check retries.
      console.error('[fetchGeo] Background refresh failed:', err?.message ?? err);
    })
    .finally(() => {
      _refreshInFlight = null;
    });
}

/**
 * Returns { ukraine, oblasts, raions } GeoJSON objects.
 * Files are downloaded once and stored in the geo dir, then re-checked for
 * staleness at most hourly (see MAX_CACHE_AGE_MS).
 */
export async function getGeoData() {
  if (_cache) {
    refreshIfStale();
    return _cache;
  }
  await fs.mkdir(getGeoDir(), { recursive: true });
  const [ukraine, oblasts, raions] = await Promise.all([
    loadOrDownload('ukraine', GEO_URLS.ukraine),
    loadOrDownload('oblasts', GEO_URLS.oblasts),
    loadOrDownload('raions', GEO_URLS.raions),
  ]);
  _cache = { ukraine, oblasts, raions };
  refreshIfStale();
  return _cache;
}

/**
 * Re-downloads all three files unconditionally and refreshes the in-process cache.
 */
export async function forceRefreshGeo() {
  await fs.mkdir(getGeoDir(), { recursive: true });
  _cache = null;
  const [ukraine, oblasts, raions] = await Promise.all([
    downloadAndCache('ukraine', GEO_URLS.ukraine),
    downloadAndCache('oblasts', GEO_URLS.oblasts),
    downloadAndCache('raions', GEO_URLS.raions),
  ]);
  _cache = { ukraine, oblasts, raions };
  return _cache;
}
