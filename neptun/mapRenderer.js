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

function buildSkeletonHtml({ js, css }) {
  return `<!DOCTYPE html>
<html>
<head>
<meta charset="utf-8">
<style>${css}</style>
<style>
  * { margin: 0; padding: 0; box-sizing: border-box; }
  html, body { width: ${PAGE_W}px; height: ${PAGE_H}px; overflow: hidden; background: #0b1220; }
  #map { width: ${PAGE_W}px; height: ${PAGE_H}px; background: #0b1220; }
  .leaflet-container { background: #0b1220 !important; }

  .city-marker { pointer-events: none; }
  .city-dot {
    position: absolute; left: 0; top: 0; width: 8px; height: 8px; border-radius: 50%;
    background: #eaf2fb; border: 1.5px solid rgba(5,10,20,0.9);
    box-shadow: 0 0 5px rgba(0,0,0,0.9);
  }
  .city-name {
    position: absolute; left: 12px; top: -8px;
    font: 700 15px/1 sans-serif; color: #f2f7fd; white-space: nowrap;
    text-shadow: 0 1px 3px #000, 0 0 7px rgba(0,0,0,0.95);
    letter-spacing: 0.02em;
  }

  .threat-emoji {
    font-size: 26px; line-height: 30px; text-align: center;
    filter: drop-shadow(0 1px 3px rgba(0,0,0,0.9));
  }
  .threat-img { filter: drop-shadow(0 2px 5px rgba(0,0,0,0.85)); }
  .threat-wrap { display: flex; flex-direction: column; align-items: center; }
  .threat-label {
    margin-top: 2px; font: 700 11px/1.15 sans-serif; color: #ffe9c9;
    white-space: nowrap; text-shadow: 0 1px 2px #000, 0 0 6px #000;
  }

  .legend {
    position: fixed; bottom: 18px; right: 18px;
    background: rgba(10,16,28,0.92); border: 1px solid #2a4060;
    border-radius: 8px; padding: 10px 14px; z-index: 1000; font-family: sans-serif;
  }
  .legend-title { color: #8ab4d4; font-size: 11px; font-weight: bold;
    text-transform: uppercase; letter-spacing: 0.08em; margin-bottom: 6px; }
  .legend-item { display: flex; align-items: center; gap: 7px;
    color: #cdd9e5; font-size: 12px; margin: 3px 0; }
  .legend-alert { display: flex; align-items: center; gap: 7px;
    color: #ffb3b3; font-size: 12px; margin: 4px 0 0; }
  .alert-swatch { width: 14px; height: 10px; border-radius: 2px; flex-shrink: 0; }
  .alert-swatch-raion  { background: rgba(255,138,138,0.55); border: 1px solid #ffabab; }
  .alert-swatch-oblast { background: rgba(214,26,26,0.70);  border: 1px solid #ff5c5c; }

  .title-bar {
    position: fixed; top: 12px; left: 50%; transform: translateX(-50%);
    background: rgba(10,16,28,0.88); border: 1px solid #2a4060;
    border-radius: 8px; padding: 6px 18px; z-index: 1000;
    font-family: sans-serif; color: #8ab4d4; font-size: 13px;
    display: flex; align-items: center; gap: 10px;
  }
  .title-dot { width: 8px; height: 8px; border-radius: 50%; background: #ff4444;
    box-shadow: 0 0 6px #ff4444; }
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
    typeMeta, iconDataUrls, cities, timestamp, focusView,
  } = payload;

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

  // 1. Oblast fills — whole-oblast alert → strong red
  L.geoJSON(oblasts, {
    style: (f) => (oblastSet.has(featKey(f))
      ? { stroke: false, fillColor: '#d61a1a', fillOpacity: 0.62 }
      : { stroke: false, fillColor: '#1c2f4a', fillOpacity: 0.94 }),
  }).addTo(map);

  // 2. Raion grid — thin borders for texture
  L.geoJSON(raions, {
    style: () => ({ color: '#2b4a6f', weight: 0.55, opacity: 0.85, fill: false }),
  }).addTo(map);

  // 3. Alerted raions — pale red fill (individual districts)
  L.geoJSON(raions, {
    filter: (f) => raionSet.has(featKey(f)),
    style: () => ({ color: '#ffabab', weight: 1.1, opacity: 0.9, fillColor: '#ff8a8a', fillOpacity: 0.52 }),
  }).addTo(map);

  // 4. Oblast borders above the fills
  L.geoJSON(oblasts, {
    style: (f) => (oblastSet.has(featKey(f))
      ? { color: '#ff5c5c', weight: 1.8, opacity: 1, fill: false }
      : { color: '#47709c', weight: 1.15, opacity: 1, fill: false }),
  }).addTo(map);

  // 5. Country outline
  L.geoJSON(ukraine, {
    style: () => ({ color: '#84b3e0', weight: 2.4, opacity: 1, fill: false }),
  }).addTo(map);

  // Fit the frame: whole country, a single oblast, or a city with surroundings
  let focusFeature = null;
  if (focusView && focusView.kind === 'oblast') {
    focusFeature = ((oblasts && oblasts.features) || []).find((f) => featKey(f) === focusView.key) || null;
  }
  if (focusFeature) {
    map.fitBounds(L.geoJSON(focusFeature).getBounds(), { padding: [26, 26] });
    L.geoJSON(focusFeature, {
      style: () => ({ color: '#eaf2fb', weight: 2.6, opacity: 0.95, fill: false, dashArray: '6 4' }),
    }).addTo(map);
  } else if (focusView && focusView.kind === 'city') {
    // frameKm is the adaptive half-extent (tight around the city + its
    // threats); radiusKm is only the classification zone, not the frame.
    const halfKm = focusView.frameKm || focusView.radiusKm;
    const dLat = halfKm / 110.574;
    const dLon = halfKm / (111.32 * Math.cos((focusView.lat * Math.PI) / 180));
    map.fitBounds(
      [[focusView.lat - dLat, focusView.lon - dLon], [focusView.lat + dLat, focusView.lon + dLon]],
      { padding: [8, 8] }
    );
    L.circleMarker([focusView.lat, focusView.lon], {
      radius: 11, color: '#ffffff', weight: 2, opacity: 0.95, fill: false, dashArray: '2 3',
    }).addTo(map);
  } else {
    map.fitBounds(L.geoJSON(ukraine).getBounds(), { padding: [12, 12] });
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
  const kmToDeg = (lat, km) => [km / 110.574, km / (111.32 * Math.cos((lat * Math.PI) / 180))];
  threats.forEach((t) => {
    if (typeof t.lat !== 'number' || typeof t.lon !== 'number') return;
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

  // 7. Threat markers — user icon or built-in badge; unknown types get the
  //    "unknown" badge (emoji divIcon only as a last-resort fallback).
  //    In focused (region) mode each marker also carries a text label.
  threats.forEach((t) => {
    if (typeof t.lat !== 'number' || typeof t.lon !== 'number') return;
    const iconUrl = iconDataUrls[t.type] || iconDataUrls.unknown;
    let icon;
    if (t.label) {
      const visual = iconUrl
        ? '<img src="' + iconUrl + '" style="width:38px;height:38px" class="threat-img">'
        : '<div class="threat-emoji">' + ((typeMeta[t.type] && typeMeta[t.type].emoji) || '❓') + '</div>';
      icon = L.divIcon({
        className: '',
        iconSize: [160, 60],
        iconAnchor: [80, 19],
        html: '<div class="threat-wrap">' + visual + '<div class="threat-label">' + t.label + '</div></div>',
      });
    } else if (iconUrl) {
      icon = L.icon({ iconUrl, iconSize: [38, 38], iconAnchor: [19, 19], className: 'threat-img' });
    } else {
      icon = L.divIcon({
        className: '',
        iconSize: [30, 30],
        iconAnchor: [15, 15],
        html: '<div class="threat-emoji">' + ((typeMeta[t.type] && typeMeta[t.type].emoji) || '❓') + '</div>',
      });
    }
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
      ? '<img src="' + legendUrl + '" style="width:16px;height:16px;object-fit:contain">'
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

  document.body.insertAdjacentHTML('beforeend', legendHtml + titleHtml);

  window.__mapReady = true;
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
  // or near the region, while the map still draws every threat in the frame.
  const focusStatus = focus
    ? buildRegionStatus({ region: focus, threats, alerts, geo: geoData })
    : null;
  const metaSource = focusStatus
    ? [...focusStatus.threatsIn, ...focusStatus.threatsNear]
    : threats;

  // Per-type metadata for markers, legend and caption.
  const typeMeta = {};
  for (const t of metaSource) {
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
  const page = await browser.newPage();

  try {
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
      // Tight adaptive frame for cities: hug the city and the threats actually
      // near it, so the exact locality a threat flies over is clearly visible.
      const inCity = focusStatus ? focusStatus.threatsIn : [];
      let frameKm = inCity.length ? 18 : 28;
      for (const t of inCity) frameKm = Math.max(frameKm, t.distanceKm * 1.25 + 6);
      frameKm = Math.min(frameKm, focus.radiusKm ?? 60);
      focusView = {
        kind: 'city', name: focus.name, lat: focus.lat, lon: focus.lon,
        radiusKm: focus.radiusKm ?? 60, frameKm,
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
    });

    await page.waitForFunction(() => window.__mapReady === true, { timeout: 5_000 });

    const buffer = await page.screenshot({ type: 'png', fullPage: false });
    const caption = focusStatus ? buildFocusCaption(focusStatus, now) : buildCaption(typeMeta, alerts, now);

    return { buffer, caption };
  } finally {
    await page.close().catch(() => {});
  }
}

function buildCaption(typeMeta, alerts, date) {
  const lines = [];
  lines.push('🗺 NEPTUN — Карта загроз України');

  const types = Object.keys(typeMeta);
  if (types.length > 0) {
    const summary = types
      .map((type) => `${typeMeta[type].emoji} ${typeMeta[type].name} ×${typeMeta[type].count}`)
      .join(', ');
    lines.push(`⚠️ Загрози: ${summary}`);
  } else {
    lines.push('✅ Активних загроз не виявлено');
  }

  const oblastCount = (alerts.oblasts ?? []).length;
  const raionCount = (alerts.raions ?? []).length;
  if (oblastCount > 0 || raionCount > 0) {
    const parts = [];
    if (oblastCount > 0) parts.push(`областей: ${oblastCount}`);
    if (raionCount > 0) parts.push(`районів: ${raionCount}`);
    lines.push(`🔴 Тривога — ${parts.join(', ')}`);
  }

  const timeStr = date.toLocaleTimeString('uk-UA', {
    hour: '2-digit', minute: '2-digit', timeZone: 'Europe/Kyiv',
  });
  lines.push(`🕐 ${timeStr} Kyiv  •  © neptun.in.ua`);

  return lines.join('\n');
}
