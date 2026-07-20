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
const GEO_DIR = path.join(__dirname, 'geo');

/** Generous deadline — the raion boundaries are a multi-MB download. */
const TIMEOUT_MS = 30_000;

const GEO_URLS = {
  ukraine: 'https://neptun.in.ua/ukraine.geojson',
  oblasts: 'https://neptun.in.ua/oblasts.geojson',
  raions: 'https://neptun.in.ua/raions.geojson',
};

async function downloadAndCache(name, url) {
  const destPath = path.join(GEO_DIR, `${name}.geojson`);
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
  const destPath = path.join(GEO_DIR, `${name}.geojson`);
  try {
    const text = await fs.readFile(destPath, 'utf8');
    return JSON.parse(text);
  } catch {
    return downloadAndCache(name, url);
  }
}

/** In-process cache so repeated calls within the same run are free. */
let _cache = null;

/**
 * Returns { ukraine, oblasts, raions } GeoJSON objects.
 * Files are downloaded once and stored in neptun/geo/.
 */
export async function getGeoData() {
  if (_cache) return _cache;
  await fs.mkdir(GEO_DIR, { recursive: true });
  const [ukraine, oblasts, raions] = await Promise.all([
    loadOrDownload('ukraine', GEO_URLS.ukraine),
    loadOrDownload('oblasts', GEO_URLS.oblasts),
    loadOrDownload('raions', GEO_URLS.raions),
  ]);
  _cache = { ukraine, oblasts, raions };
  return _cache;
}

/**
 * Re-downloads all three files unconditionally and refreshes the in-process cache.
 */
export async function forceRefreshGeo() {
  await fs.mkdir(GEO_DIR, { recursive: true });
  _cache = null;
  const [ukraine, oblasts, raions] = await Promise.all([
    downloadAndCache('ukraine', GEO_URLS.ukraine),
    downloadAndCache('oblasts', GEO_URLS.oblasts),
    downloadAndCache('raions', GEO_URLS.raions),
  ]);
  _cache = { ukraine, oblasts, raions };
  return _cache;
}
