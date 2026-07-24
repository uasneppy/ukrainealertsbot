/**
 * Renders the NEPTUN threat map to a PNG buffer using Puppeteer + Leaflet.
 * Leaflet is inlined from node_modules — no CDN dependency at render time.
 *
 * Usage:
 *   const { buffer, caption } = await renderNeptunMap({ threats, alerts, geo });
 */

import fs from 'fs/promises';
import { createRequire } from 'module';

import { getOrLaunchBrowser } from './browser.js';
import { getGeoData } from './fetchGeo.js';
import { loadThreatIcons } from './threatIcons.js';
import { getDefaultIconDataUrls } from './defaultIcons.js';
import {
  THREAT_COLORS,
  THREAT_EMOJI,
  THREAT_NAMES_UA,
  computeAlertKeySets,
} from './threatMeta.js';
import { buildRegionStatus, buildFocusCaption } from './regionContext.js';

const require = createRequire(import.meta.url);

// ── Threat metadata & alert-key helpers moved to threatMeta.js ───────────────
// Re-exported here for back-compat (tests and existing imports keep working).

export {
  THREAT_COLORS,
  THREAT_EMOJI,
  THREAT_NAMES_UA,
  THREAT_LABELS_UA,
  normalizeAlertKey,
  extractAlertKeys,
  computeAlertKeySets,
} from './threatMeta.js';

// ── Cities labelled on the map ────────────────────────────────────────────────

export const CITY_LABELS = [
  { name: 'Київ',      lat: 50.4501, lon: 30.5234 },
  { name: 'Львів',     lat: 49.8397, lon: 24.0297 },
  { name: 'Житомир',   lat: 50.2547, lon: 28.6587 },
  { name: 'Дніпро',    lat: 48.4647, lon: 35.0462 },
  { name: 'Запоріжжя', lat: 47.8388, lon: 35.1396 },
  { name: 'Суми',      lat: 50.9077, lon: 34.7981 },
  { name: 'Харків',    lat: 49.9935, lon: 36.2304 },
  { name: 'Донецьк',   lat: 48.0159, lon: 37.8028 },
  { name: 'Маріуполь', lat: 47.0971, lon: 37.5434 },
];

// ── Map palette ────────────────────────────────────────────────────────────
// Single source of truth for every non-marker color on the map. Marker/badge
// colors per threat type live in THREAT_COLORS (threatMeta.js) — kept
// separate since those are keyed by type, not by map layer.
//
// Alert severity is a two-step ladder (amber → red) instead of one pink wash,
// so a district-level alert and a whole-oblast alert read as different
// severities at a glance instead of blurring into the same muddy tone.
export const MAP_COLORS = {
  bg:                 '#080c14',  // page / space beyond the country outline
  oblastFill:         '#141e30',  // unalerted oblast fill
  oblastBorder:       '#3d5b82',  // unalerted oblast border
  raionGrid:          '#22314a',  // thin raion grid lines (texture only)
  countryOutline:     '#7fb2e8',  // Ukraine border

  raionAlertFill:     '#f5a623',  // district-level alert — amber "watch"
  raionAlertBorder:   '#f5a623',
  oblastAlertFill:    '#e0303f',  // whole-oblast alert — red "active"
  oblastAlertBorder:  '#ff5468',

  cityDot:            '#eaf2fb',
  cityLabel:          '#f2f7fd',
  threatLabel:        '#f4f8fc',  // marker text label (focused/region view)

  // Marker icons carry their own colour and read on any fill via a drop-shadow;
  // labels sit on a chip because a text-shadow can't hold against a saturated
  // alert fill.
  labelChip:          'rgba(8,13,22,0.86)',
  labelChipBorder:    'rgba(122,160,200,0.35)',

  panelBg:            'rgba(8,13,22,0.92)',
  panelBorder:        '#243854',
  legendLabel:        '#8ab4d4',
  legendText:         '#cdd9e5',

  focusOutline:        '#eaf2fb', // dashed oblast-of-interest outline
  focusCityRing:       '#ffffff',
  titleDot:            '#ff4444',
};

// ── Leaflet assets (vendored, inlined once per process) ──────────────────────

let _leafletAssetsPromise = null;
function getLeafletAssets() {
  if (!_leafletAssetsPromise) {
    _leafletAssetsPromise = (async () => {
      const [js, css] = await Promise.all([
        fs.readFile(require.resolve('leaflet/dist/leaflet.js'), 'utf8'),
        fs.readFile(require.resolve('leaflet/dist/leaflet.css'), 'utf8'),
      ]);
      return { js: js.replace(/<\/script>/gi, '<\\/script>'), css };
    })();
  }
  return _leafletAssetsPromise;
}

const PAGE_W = 1280;
const PAGE_H = 800;

// ── Street tiles for the city view (optional) ─────────────────────────────────
// The map is self-contained by default — boundaries only, rendered offline, no
// third-party tiles (see CLAUDE.md). Streets are an opt-in enhancement for the
// tight city view, where NEPTUN's precise coordinates let you see which street a
// threat is over. Off unless configured, so the default stays self-contained.
//
//   STADIA_API_KEY        → dark Stadia basemap, the recommended path (one var)
//   CITY_TILES_URL        → any {z}/{x}/{y} template (wins over STADIA_API_KEY)
//   CITY_TILES_ATTRIBUTION→ overrides the attribution string
//
// Returns null when nothing is configured — the render then behaves exactly as
// it did before street tiles existed.
export function resolveCityTiles(env = process.env) {
  const attribution = env.CITY_TILES_ATTRIBUTION;
  if (env.CITY_TILES_URL) {
    return {
      url: env.CITY_TILES_URL,
      attribution: attribution || '© OpenStreetMap',
      maxZoom: Number(env.CITY_TILES_MAX_ZOOM) || 19,
    };
  }
  if (env.STADIA_API_KEY) {
    return {
      url: `https://tiles.stadiamaps.com/tiles/alidade_smooth_dark/{z}/{x}/{y}{r}.png?api_key=${env.STADIA_API_KEY}`,
      attribution: attribution || '© Stadia Maps · © OpenStreetMap',
      maxZoom: 20,
    };
  }
  return null;
}

// ── Render concurrency ────────────────────────────────────────────────────────
// Every render opens a page on the shared Chromium, and a page holding a full
// raion-level GeoJSON is not cheap. Unbounded concurrency (a busy group, or
// several regions asked for at once) can push the container past the 2G cap in
// docker-compose and take the bot down. Queue instead: a render that waits
// 200 ms is invisible to the user, an OOM-killed container is not.

const MAX_CONCURRENT_RENDERS = Math.max(1, Number(process.env.MAX_CONCURRENT_RENDERS) || 2);

let _activeRenders = 0;
const _renderQueue = [];

function acquireRenderSlot() {
  if (_activeRenders < MAX_CONCURRENT_RENDERS) {
    _activeRenders += 1;
    return Promise.resolve();
  }
  return new Promise((resolve) => _renderQueue.push(resolve));
}

function releaseRenderSlot() {
  const next = _renderQueue.shift();
  // Hand the slot straight to the next waiter rather than decrementing and
  // letting it re-check — that would let a newcomer barge in ahead of it.
  if (next) next();
  else _activeRenders = Math.max(0, _activeRenders - 1);
}

/** Introspection for tests and diagnostics. */
export function renderQueueStats() {
  return { active: _activeRenders, queued: _renderQueue.length, limit: MAX_CONCURRENT_RENDERS };
}

/** Distance below which a threat is close enough to belong in the city frame. */
export const CITY_FRAME_INCLUDE_KM = 40;
/** Never zoom out past this half-extent — beyond it the city is a dot. */
export const CITY_FRAME_MAX_KM = 46;

/**
 * Half-extent of a city view, in km.
 *
 * A city view must stay a *city* view. It shows the city and its immediate
 * surroundings, expanding just enough to include threats that are genuinely
 * close (≤ CITY_FRAME_INCLUDE_KM). A target tens of km out belongs on the
 * oblast map — pulling the frame out to fit one distant drone turns Kyiv into a
 * dot, which is the bug this guards against. Distant threats are still in the
 * caption's "Поблизу" section and counted only there, not on this map.
 *
 * @param {object} opts
 * @param {Array}  opts.threatsIn     Threats classified as inside the region
 * @param {Array}  opts.threatsNear   Threats outside it but nearby
 */
export function computeCityFrameKm({ threatsIn = [], threatsNear = [] } = {}) {
  const framed = [...threatsIn, ...threatsNear].filter((t) => t.distanceKm <= CITY_FRAME_INCLUDE_KM);

  let frameKm = framed.length ? 16 : 24;
  for (const threat of framed) {
    frameKm = Math.max(frameKm, threat.distanceKm * 1.2 + 6);
  }
  return Math.min(frameKm, CITY_FRAME_MAX_KM);
}

/** Per-type counts, names, emoji and colours for the legend and captions. */
export function computeTypeMeta(threats = []) {
  const typeMeta = {};
  for (const t of threats) {
    const type = String(t?.type ?? 'unknown').toLowerCase();
    if (!typeMeta[type]) {
      typeMeta[type] = {
        count: 0,
        name: THREAT_NAMES_UA[type] ?? (t?.title || t?.name || type),
        emoji: THREAT_EMOJI[type] ?? THREAT_EMOJI.unknown,
        color: THREAT_COLORS[type] ?? THREAT_COLORS.unknown,
      };
    }
    typeMeta[type].count += 1;
  }
  return typeMeta;
}

/**
 * The national caption as plain text, without rendering anything. Used as the
 * answer when a render fails: the facts are known even when Chromium isn't
 * available to draw them.
 */
export function buildNationalReport({ threats = [], alerts = {}, date = new Date() } = {}) {
  return buildCaption(computeTypeMeta(threats), alerts, date);
}

function buildSkeletonHtml({ js, css }) {
  const C = MAP_COLORS;
  return `<!DOCTYPE html>
<html>
<head>
<meta charset="utf-8">
<style>${css}</style>
<style>
  * { margin: 0; padding: 0; box-sizing: border-box; }
  html, body { width: ${PAGE_W}px; height: ${PAGE_H}px; overflow: hidden; background: ${C.bg}; }
  #map { width: ${PAGE_W}px; height: ${PAGE_H}px; background: ${C.bg}; }
  .leaflet-container { background: ${C.bg} !important; }
  /* No fade-in: a rendered still must not catch tiles mid-transition (they show
     as a translucent dark rectangle). A loaded tile is opaque immediately. */
  .leaflet-tile { transition: none !important; }
  .leaflet-fade-anim .leaflet-tile { will-change: auto; }

  .city-marker { pointer-events: none; }
  .city-dot {
    position: absolute; left: 0; top: 0; width: 8px; height: 8px; border-radius: 50%;
    background: ${C.cityDot}; border: 1.5px solid rgba(5,10,20,0.9);
    box-shadow: 0 0 5px rgba(0,0,0,0.9);
  }
  /* City names sit on top of alert fills as often as on the base map, so the
     chip does the work a text-shadow can't on saturated red. */
  .city-name {
    position: absolute; left: 12px; top: -10px;
    font: 700 15px/1 sans-serif; color: ${C.cityLabel}; white-space: nowrap;
    letter-spacing: 0.02em;
    background: ${C.labelChip}; padding: 2px 7px; border-radius: 5px;
    box-shadow: 0 1px 4px rgba(0,0,0,0.6);
  }

  .threat-emoji {
    font-size: 30px; line-height: 1; text-align: center;
    filter: drop-shadow(0 1px 3px rgba(0,0,0,0.9));
  }
  .threat-wrap { display: flex; flex-direction: column; align-items: center; }

  /* Bare icon — no disc, no ring. The icon carries its own colour (both the
     built-in badges and user icons/*.webp are coloured), so the wrapper was
     redundant and cluttered the map. A drop-shadow keeps it legible on a
     saturated alert fill. */
  .threat-icon { width: 40px; height: 40px; display: flex; align-items: center; justify-content: center; }
  .threat-icon img {
    width: 40px; height: 40px; object-fit: contain; display: block;
    filter: drop-shadow(0 1px 2px rgba(0,0,0,0.95)) drop-shadow(0 0 3px rgba(0,0,0,0.55));
  }

  .threat-label {
    margin-top: 4px; font: 700 12px/1.2 sans-serif; color: ${C.threatLabel};
    white-space: nowrap;
    background: ${C.labelChip}; border: 1px solid ${C.labelChipBorder};
    padding: 2px 7px; border-radius: 5px;
    box-shadow: 0 1px 4px rgba(0,0,0,0.6);
  }

  .legend {
    position: fixed; bottom: 18px; right: 18px;
    background: ${C.panelBg}; border: 1px solid ${C.panelBorder};
    border-radius: 10px; padding: 11px 15px; z-index: 1000; font-family: sans-serif;
  }
  .legend-title { color: ${C.legendLabel}; font-size: 12px; font-weight: bold;
    text-transform: uppercase; letter-spacing: 0.08em; margin-bottom: 6px; }
  .legend-item { display: flex; align-items: center; gap: 8px;
    color: ${C.legendText}; font-size: 13px; margin: 4px 0; }
  .legend-alert { display: flex; align-items: center; gap: 7px;
    color: ${C.legendText}; font-size: 13px; margin: 5px 0 0; }
  .alert-swatch { width: 14px; height: 10px; border-radius: 2px; flex-shrink: 0; }
  .alert-swatch-raion  { background: ${C.raionAlertFill}66; border: 1px solid ${C.raionAlertBorder}; }
  .alert-swatch-oblast { background: ${C.oblastAlertFill}99; border: 1px solid ${C.oblastAlertBorder}; }

  .title-bar {
    position: fixed; top: 12px; left: 50%; transform: translateX(-50%);
    background: ${C.panelBg}; border: 1px solid ${C.panelBorder};
    border-radius: 8px; padding: 7px 20px; z-index: 1000;
    font-family: sans-serif; color: ${C.legendLabel}; font-size: 14px; white-space: nowrap;
    display: flex; align-items: center; gap: 10px;
  }
  .title-dot { width: 8px; height: 8px; border-radius: 50%; background: ${C.titleDot};
    box-shadow: 0 0 6px ${C.titleDot}; }

  /* Tile attribution — required by the OSM/provider terms whenever street
     tiles are shown. Small but legible, bottom-left, out of the legend's way. */
  .tiles-attr {
    position: fixed; bottom: 6px; left: 8px; z-index: 1000;
    background: ${C.labelChip}; color: ${C.legendText};
    font-family: sans-serif; font-size: 11px; padding: 2px 7px; border-radius: 4px;
    opacity: 0.9;
  }
</style>
<script>${js}</script>
</head>
<body>
<div id="map"></div>
</body>
</html>`;
}

// ── Page-side render function (serialised & sent to Puppeteer) ───────────────
// NOTE: no outer-scope references allowed — everything must come through `payload`.

function _renderOnPage(payload) {
  const {
    ukraine, oblasts, raions,
    threats, alertedOblastKeys, alertedRaionKeys,
    typeMeta, iconDataUrls, cities, timestamp, focusView, colors, tiles,
  } = payload;
  const C = colors;

  // Mirrors normalizeAlertKey() on the Node side (keep in sync).
  const norm = (v) => String(v ?? '')
    .normalize('NFC')
    .toLowerCase()
    .replace(/\s+(область|обл\.?|район|р-н)\s*$/u, '')
    .trim();
  const featKey = (f) => {
    const p = (f && f.properties) || {};
    return norm(p.key ?? p.region ?? p.rayon ?? p.name);
  };

  const oblastSet = new Set(alertedOblastKeys);
  const raionSet = new Set(alertedRaionKeys);

  // Street tiles (city view only). When present they are the basemap, so the
  // opaque oblast fill is dropped and the alert fills are softened to let the
  // streets — the whole reason for tiles — show through.
  const hasTiles = !!(tiles && tiles.url);

  /* eslint-disable no-undef */
  const map = L.map('map', {
    zoomControl: false,
    attributionControl: false,
    zoomSnap: 0, // fractional zoom → fitBounds can zoom in as close as possible
    dragging: false,
    touchZoom: false,
    scrollWheelZoom: false,
    doubleClickZoom: false,
    boxZoom: false,
    keyboard: false,
  });

  let baseTiles = null;
  if (hasTiles) {
    baseTiles = L.tileLayer(tiles.url, {
      maxZoom: tiles.maxZoom || 19,
      detectRetina: true,
      crossOrigin: true,
      keepBuffer: 0,
    }).addTo(map);
  }

  // 1. Oblast fills — whole-oblast alert → strong red "active" tone. Over tiles
  //    the unalerted fill is dropped entirely and the alert tint is softened.
  L.geoJSON(oblasts, {
    style: (f) => (oblastSet.has(featKey(f))
      ? { stroke: false, fillColor: C.oblastAlertFill, fillOpacity: hasTiles ? 0.28 : 0.42 }
      : { stroke: false, fillColor: C.oblastFill, fillOpacity: hasTiles ? 0 : 0.94 }),
  }).addTo(map);

  // 2. Raion grid — thin borders for texture. Skipped over tiles, which already
  //    carry far more detail than a grid would add.
  if (!hasTiles) {
    L.geoJSON(raions, {
      style: () => ({ color: C.raionGrid, weight: 0.7, opacity: 0.9, fill: false }),
    }).addTo(map);
  }

  // 3. Alerted raions — amber "watch" fill (individual districts, lower
  //    severity than a whole-oblast alert, so a distinct hue rather than a
  //    paler version of the same red)
  L.geoJSON(raions, {
    filter: (f) => raionSet.has(featKey(f)),
    style: () => ({ color: C.raionAlertBorder, weight: 1.1, opacity: 0.9, fillColor: C.raionAlertFill, fillOpacity: hasTiles ? 0.20 : 0.30 }),
  }).addTo(map);

  // 4. Oblast borders above the fills
  L.geoJSON(oblasts, {
    style: (f) => (oblastSet.has(featKey(f))
      ? { color: C.oblastAlertBorder, weight: 1.8, opacity: 1, fill: false }
      : { color: C.oblastBorder, weight: 1.15, opacity: 1, fill: false }),
  }).addTo(map);

  // 5. Country outline
  L.geoJSON(ukraine, {
    style: () => ({ color: C.countryOutline, weight: 2.4, opacity: 1, fill: false }),
  }).addTo(map);

  // Fit the frame: whole country, a single oblast, or a city with surroundings
  let focusFeature = null;
  if (focusView && focusView.kind === 'oblast') {
    focusFeature = ((oblasts && oblasts.features) || []).find((f) => featKey(f) === focusView.key) || null;
  }
  if (focusFeature) {
    map.fitBounds(L.geoJSON(focusFeature).getBounds(), { padding: [64, 64], animate: false });
    L.geoJSON(focusFeature, {
      style: () => ({ color: C.focusOutline, weight: 2.6, opacity: 0.95, fill: false, dashArray: '6 4' }),
    }).addTo(map);
  } else if (focusView && focusView.kind === 'city') {
    // frameKm is the adaptive half-extent (tight around the city + its
    // threats); radiusKm is only the classification zone, not the frame.
    const halfKm = focusView.frameKm || focusView.radiusKm;
    const dLat = halfKm / 110.574;
    const dLon = halfKm / (111.32 * Math.cos((focusView.lat * Math.PI) / 180));
    map.fitBounds(
      [[focusView.lat - dLat, focusView.lon - dLon], [focusView.lat + dLat, focusView.lon + dLon]],
      { padding: [56, 56], animate: false }
    );
    L.circleMarker([focusView.lat, focusView.lon], {
      radius: 11, color: C.focusCityRing, weight: 2, opacity: 0.95, fill: false, dashArray: '2 3',
    }).addTo(map);
  } else {
    map.fitBounds(L.geoJSON(ukraine).getBounds(), { padding: [26, 26], animate: false });
  }

  // 6. City labels (below threat markers)
  cities.forEach((c) => {
    L.marker([c.lat, c.lon], {
      interactive: false,
      keyboard: false,
      zIndexOffset: -1000,
      icon: L.divIcon({
        className: 'city-marker',
        iconSize: [0, 0],
        iconAnchor: [4, 4],
        html: '<div class="city-dot"></div><div class="city-name">' + c.name + '</div>',
      }),
    }).addTo(map);
  });

  // 6b. Focused city label, if the city is not in the standard label list
  if (focusView && focusView.kind === 'city' && !cities.some((c) => c.name === focusView.name)) {
    L.marker([focusView.lat, focusView.lon], {
      interactive: false,
      keyboard: false,
      zIndexOffset: -900,
      icon: L.divIcon({
        className: 'city-marker',
        iconSize: [0, 0],
        iconAnchor: [4, 4],
        html: '<div class="city-dot"></div><div class="city-name">' + focusView.name + '</div>',
      }),
    }).addTo(map);
  }

  // 6c. Focused mode: flight trails + course vectors. NEPTUN positions are
  //     precise, so the past track and an arrow of the current heading make
  //     it obvious over which locality a threat flies and where it's going.
  // Shrunk slightly so a marker right on the edge — whose label would be
  // sliced by the canvas — counts as outside.
  const viewBounds = map.getBounds().pad(-0.03);
  const inView = (t) => viewBounds.contains([t.lat, t.lon]);

  const kmToDeg = (lat, km) => [km / 110.574, km / (111.32 * Math.cos((lat * Math.PI) / 180))];
  threats.forEach((t) => {
    if (typeof t.lat !== 'number' || typeof t.lon !== 'number' || !inView(t)) return;
    const color = (typeMeta[t.type] && typeMeta[t.type].color) || '#9aa7b5';
    if (Array.isArray(t.trail) && t.trail.length) {
      L.polyline(t.trail.concat([[t.lat, t.lon]]), {
        color, weight: 2, opacity: 0.55, dashArray: '2 5', interactive: false,
      }).addTo(map);
      t.trail.forEach((p) => {
        L.circleMarker(p, {
          radius: 2, color, weight: 1, fillColor: color, fillOpacity: 0.8, opacity: 0.8, interactive: false,
        }).addTo(map);
      });
    }
    if (typeof t.heading === 'number') {
      const rad = (t.heading * Math.PI) / 180;
      const [vLat, vLon] = kmToDeg(t.lat, 7);
      const tip = [t.lat + vLat * Math.cos(rad), t.lon + vLon * Math.sin(rad)];
      const barb = (offsetDeg) => {
        const r = ((t.heading + 180 + offsetDeg) * Math.PI) / 180;
        const [bLat, bLon] = kmToDeg(tip[0], 2.4);
        return [tip[0] + bLat * Math.cos(r), tip[1] + bLon * Math.sin(r)];
      };
      L.polyline([[t.lat, t.lon], tip], { color, weight: 2.5, opacity: 0.9, interactive: false }).addTo(map);
      L.polyline([barb(-32), tip, barb(32)], { color, weight: 2.5, opacity: 0.9, interactive: false }).addTo(map);
    }
  });

  // 7. Threat markers. Every marker is a badge: a dark disc so the icon reads
  //    Just the icon — no disc or ring around it. The icon art carries its own
  //    colour, so the wrapper only cluttered the map. In focused (region) mode
  //    the marker also carries a text label.
  threats.forEach((t) => {
    if (typeof t.lat !== 'number' || typeof t.lon !== 'number' || !inView(t)) return;
    const meta = typeMeta[t.type] || {};
    const iconUrl = iconDataUrls[t.type] || iconDataUrls.unknown;
    const marker = iconUrl
      ? '<div class="threat-icon"><img src="' + iconUrl + '" alt=""></div>'
      : '<div class="threat-emoji">' + (meta.emoji || '❓') + '</div>';

    const icon = t.label
      ? L.divIcon({
        className: '',
        iconSize: [200, 72],
        iconAnchor: [100, 20],
        html: '<div class="threat-wrap">' + marker + '<div class="threat-label">' + t.label + '</div></div>',
      })
      : L.divIcon({
        className: '',
        iconSize: [40, 40],
        iconAnchor: [20, 20],
        html: marker,
      });

    L.marker([t.lat, t.lon], { interactive: false, keyboard: false, zIndexOffset: 1000, icon }).addTo(map);
  });
  /* eslint-enable no-undef */


  // Legend — display names for unknown threat types come from the feed's
  // `title`, i.e. untrusted input: escape anything interpolated into HTML.
  const esc = (s) => String(s)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
  const legendItems = Object.keys(typeMeta).map((type) => {
    const meta = typeMeta[type];
    const legendUrl = iconDataUrls[type] || iconDataUrls.unknown;
    const visual = legendUrl
      ? '<img src="' + legendUrl + '" style="width:18px;height:18px;object-fit:contain">'
      : '<span style="font-size:14px;line-height:1">' + meta.emoji + '</span>';
    return '<div class="legend-item">' + visual + '<span>' + esc(meta.name) + ' ×' + meta.count + '</span></div>';
  }).join('');

  const alertRows =
    (alertedRaionKeys.length
      ? '<div class="legend-alert"><div class="alert-swatch alert-swatch-raion"></div><span>Тривога — район</span></div>' : '') +
    (alertedOblastKeys.length
      ? '<div class="legend-alert"><div class="alert-swatch alert-swatch-oblast"></div><span>Тривога — вся область</span></div>' : '');

  const total = Object.keys(typeMeta).reduce((s, k) => s + typeMeta[k].count, 0);
  const legendHtml = '<div class="legend"><div class="legend-title">Загрози (' + total + ')</div>'
    + legendItems + alertRows + '</div>';

  const titleHtml = '<div class="title-bar"><div class="title-dot"></div>'
    + '<span>' + (focusView && focusView.name ? 'NEPTUN — ' + focusView.name : 'NEPTUN — Карта загроз') + '</span>'
    + '<span style="color:#607a94;font-size:11px">' + timestamp + '</span></div>';

  // Tile attribution is a licence requirement, not decoration — always shown
  // when tiles are on. `tiles.attribution` is operator-set config, not feed
  // input, but escape it anyway before putting it in the DOM.
  const attrHtml = hasTiles
    ? '<div class="tiles-attr">' + esc(tiles.attribution || '© OpenStreetMap') + '</div>'
    : '';

  document.body.insertAdjacentHTML('beforeend', legendHtml + titleHtml + attrHtml);

  // Keep city names readable. Runs after the panels are inserted, or they
  // aren't in the DOM to be measured and a name ends up under the legend. Leaflet has no label collision, so a name
  //    parked to the right of its dot lands under whatever marker or panel
  //    happens to be there — "Київ" rendered as "в". A half-covered marker is
  //    still identifiable by its coloured ring; a half-covered name is noise.
  //    So the names move, trying positions around the dot until one is clear.
  const rectsOverlap = (a, b) =>
    !(a.right <= b.left || a.left >= b.right || a.bottom <= b.top || a.top >= b.bottom);
  const grow = (r, p) => ({ left: r.left - p, top: r.top - p, right: r.right + p, bottom: r.bottom + p });

  const obstacles = [];
  document.querySelectorAll('.threat-icon, .threat-emoji, .threat-label, .legend, .title-bar').forEach((el) => {
    obstacles.push(grow(el.getBoundingClientRect(), 3));
  });

  const placedLabels = [];
  document.querySelectorAll('.city-name').forEach((label) => {
    const w = label.offsetWidth;
    const h = label.offsetHeight;
    const positions = [
      { left: 12, top: -10 },              // default: right of the dot
      { left: -(w + 10), top: -10 },       // left
      { left: -(w / 2), top: -(h + 12) },  // above
      { left: -(w / 2), top: 16 },         // below
      { left: 12, top: -(h + 14) },        // upper right
      { left: 12, top: 16 },               // lower right
      { left: -(w + 10), top: -(h + 14) }, // upper left
      { left: -(w + 10), top: 16 },        // lower left
      // Farther out: when a threat marker sits directly on the city, every
      // close position still lands on the 38 px badge — "Суми" rendered as
      // "уми". These clear it.
      { left: 30, top: -10 },
      { left: -(w + 28), top: -10 },
      { left: -(w / 2), top: -(h + 30) },
      { left: -(w / 2), top: 34 },
    ];

    let placed = false;
    for (const pos of positions) {
      label.style.left = pos.left + 'px';
      label.style.top = pos.top + 'px';
      const box = grow(label.getBoundingClientRect(), 2);
      const clashes =
        obstacles.some((o) => rectsOverlap(box, o)) ||
        placedLabels.some((o) => rectsOverlap(box, o));
      if (!clashes) {
        placed = true;
        break;
      }
    }
    if (!placed) {
      // Nowhere clean — keep the conventional position rather than inventing one.
      label.style.left = '12px';
      label.style.top = '-10px';
    }
    placedLabels.push(grow(label.getBoundingClientRect(), 2));
  });

  // Without tiles the map is drawn synchronously and is ready now.
  //
  // With tiles it's timing-sensitive: Leaflet loads tiles in waves, and its
  // 'load' event fires at the end of each wave — screenshotting on the first
  // one caught a later wave still arriving, showing as a dark rectangle over
  // the not-yet-painted tiles. So wait until the grid has been quiet for a
  // beat (no new 'load' for SETTLE_MS), and cap the whole wait so a slow or
  // unreachable source degrades to a gappy map rather than hanging the render.
  // (The tile fade-in is also disabled in CSS, so a loaded tile is opaque at
  // once instead of transitioning through a translucent state.)
  if (baseTiles) {
    const SETTLE_MS = 500;
    let settle = null;
    const arm = () => {
      if (settle) clearTimeout(settle);
      settle = setTimeout(() => { window.__mapReady = true; }, SETTLE_MS);
    };
    baseTiles.on('load', arm);   // fires per wave, incl. all-errored (fast-fails)
    setTimeout(() => { window.__mapReady = true; }, 8000); // hard upper bound
  } else {
    window.__mapReady = true;
  }
}

// ── Public API ────────────────────────────────────────────────────────────────

/**
 * @param {object} opts
 * @param {Array}  opts.threats  Array of threat objects from NEPTUN
 * @param {object} opts.alerts   { raions: Array, oblasts: Array } — entries are
 *                               NEPTUN objects ({ key, name, oblast, … }) or strings
 * @param {object} [opts.geo]    Pre-loaded geo data (skips disk read when provided)
 * @param {object} [opts.focus]  Region descriptor from resolveRegion() — renders a
 *                               zoomed oblast/city view with per-threat labels
 * @returns {Promise<{ buffer: Buffer, caption: string }>}
 */
export async function renderNeptunMap({ threats = [], alerts = {}, geo, focus = null } = {}) {
  const geoData = geo ?? (await getGeoData());
  const { ukraine, oblasts, raions } = geoData;

  const { oblastKeys, raionKeys } = computeAlertKeySets(alerts);

  // Focused (region-detail) mode: the legend and caption cover only threats in
  // or near the region.
  const focusStatus = focus
    ? buildRegionStatus({ region: focus, threats, alerts, geo: geoData })
    : null;

  // City view: compute the frame up front so the legend counts exactly what the
  // tight frame shows. Counting far "поблизу" threats the frame excludes gave a
  // legend of "Загрози (1)" over a map with no marker (and vice-versa).
  const cityFrameKm = focus && focus.kind === 'city' && focusStatus
    ? computeCityFrameKm({ threatsIn: focusStatus.threatsIn, threatsNear: focusStatus.threatsNear })
    : null;

  let metaSource;
  if (!focusStatus) {
    metaSource = threats;
  } else if (cityFrameKm != null) {
    metaSource = [...focusStatus.threatsIn, ...focusStatus.threatsNear]
      .filter((t) => t.distanceKm <= cityFrameKm);
  } else {
    metaSource = [...focusStatus.threatsIn, ...focusStatus.threatsNear];
  }

  // Per-type metadata for markers, legend and caption.
  const typeMeta = computeTypeMeta(metaSource);

  // Street tiles only for the city view — pointless at oblast/national zoom, and
  // it keeps tile traffic to the one view that benefits. null unless configured.
  const tiles = focus && focus.kind === 'city' ? resolveCityTiles() : null;

  // Marker icons: built-in SVG badges (font-independent), overridden by any
  // user files from the icons/ folder — re-read every render, so icons can be
  // swapped live without a restart. Ship only icons for types actually present
  // (plus the `unknown` fallback) to keep the page payload lean.
  const userIcons = await loadThreatIcons();
  const allIcons = { ...getDefaultIconDataUrls(THREAT_COLORS), ...userIcons };
  const iconDataUrls = {};
  for (const type of new Set([...Object.keys(typeMeta), 'unknown'])) {
    if (allIcons[type]) iconDataUrls[type] = allIcons[type];
  }

  const now = new Date();
  const timestamp = now.toLocaleTimeString('uk-UA', {
    hour: '2-digit', minute: '2-digit', timeZone: 'Europe/Kyiv',
  }) + ' Kyiv';

  const [browser, leaflet] = await Promise.all([getOrLaunchBrowser(), getLeafletAssets()]);

  await acquireRenderSlot();
  let page;
  try {
    page = await browser.newPage();
    await page.setViewport({ width: PAGE_W, height: PAGE_H, deviceScaleFactor: 1 });
    await page.setContent(buildSkeletonHtml(leaflet), { waitUntil: 'load', timeout: 20_000 });

    // Slim the payload — trails etc. are not needed for markers. In focused
    // mode every marker gets a text label (type + locality from the feed).
    const escapeHtml = (s) => String(s)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
    const slimThreats = threats.map((t) => {
      const type = String(t?.type ?? 'unknown').toLowerCase();
      const entry = { lat: t?.lat, lon: t?.lon, type };
      if (focus) {
        const label = `${THREAT_NAMES_UA[type] ?? (t?.title || '')}${t?.locality ? ' · ' + t.locality : ''}`.trim();
        if (label) entry.label = escapeHtml(label);
        if (Number.isFinite(t?.heading)) entry.heading = t.heading;
        const trail = (Array.isArray(t?.trail) ? t.trail : [])
          .map((p) => (Array.isArray(p) ? [p?.[0], p?.[1]] : [p?.lat, p?.lon]))
          .filter((p) => Number.isFinite(p[0]) && Number.isFinite(p[1]))
          .slice(-12);
        if (trail.length) entry.trail = trail;
      }
      return entry;
    });

    let focusView = null;
    if (focus && focus.kind === 'oblast') {
      focusView = { kind: 'oblast', key: focus.geoKey, name: focus.name };
    } else if (focus) {
      focusView = {
        kind: 'city', name: focus.name, lat: focus.lat, lon: focus.lon,
        radiusKm: focus.radiusKm ?? 60, frameKm: cityFrameKm ?? computeCityFrameKm({}),
      };
    }

    await page.evaluate(_renderOnPage, {
      ukraine, oblasts, raions,
      threats: slimThreats,
      alertedOblastKeys: oblastKeys,
      alertedRaionKeys: raionKeys,
      typeMeta, iconDataUrls,
      cities: CITY_LABELS,
      timestamp,
      focusView,
      colors: MAP_COLORS,
      tiles,
    });

    // Tiles load over the network in headless Chromium, so allow more time; the
    // page caps its own wait, so this is only an upper bound.
    await page.waitForFunction(() => window.__mapReady === true, { timeout: tiles ? 12_000 : 5_000 });

    const buffer = await page.screenshot({ type: 'png', fullPage: false });
    const caption = focusStatus ? buildFocusCaption(focusStatus, now) : buildCaption(typeMeta, alerts, now);

    return { buffer, caption };
  } finally {
    if (page) await page.close().catch(() => {});
    releaseRenderSlot();
  }
}

function buildCaption(typeMeta, alerts, date) {
  // Blocks joined by a blank line — one comma-joined blob of threat types was
  // the hard-to-scan part. One type per line reads at a glance.
  const blocks = ['🗺 NEPTUN — Карта загроз України'];

  const types = Object.keys(typeMeta);
  if (types.length > 0) {
    const lines = ['⚠️ Загрози в небі'];
    for (const type of types) {
      const meta = typeMeta[type];
      lines.push(`• ${meta.emoji} ${meta.name} ×${meta.count}`);
    }
    blocks.push(lines.join('\n'));
  } else {
    blocks.push('✅ Активних загроз не виявлено');
  }

  const oblastCount = (alerts.oblasts ?? []).length;
  const raionCount = (alerts.raions ?? []).length;
  if (oblastCount > 0 || raionCount > 0) {
    const parts = [];
    if (oblastCount > 0) parts.push(`областей: ${oblastCount}`);
    if (raionCount > 0) parts.push(`районів: ${raionCount}`);
    blocks.push(`🔴 Тривога — ${parts.join(', ')}`);
  }

  const timeStr = date.toLocaleTimeString('uk-UA', {
    hour: '2-digit', minute: '2-digit', timeZone: 'Europe/Kyiv',
  });
  blocks.push(`🕐 ${timeStr} за Києвом · © neptun.in.ua`);

  return blocks.join('\n\n');
}
