/**
 * Renders the NEPTUN threat map to a PNG buffer using Puppeteer + Leaflet.
 *
 * Usage:
 *   const { buffer, caption } = await renderNeptunMap({ threats, alerts, geo });
 */

import { getOrLaunchBrowser } from './browser.js';
import { getGeoData } from './fetchGeo.js';

// ── Threat metadata ──────────────────────────────────────────────────────────

export const THREAT_COLORS = {
  missile:   '#ff4444',
  ballistic: '#cc0000',
  uav:       '#ff8c00',
  recon:     '#ffd700',
  kab:       '#bb00ff',
  mig31k:    '#ff6600',
  unknown:   '#888888',
};

export const THREAT_LABELS_UA = {
  missile:   '🚀 Ракета',
  ballistic: '💥 Балістична',
  uav:       '✈️ БпЛА',
  recon:     '👁 Розвідник',
  kab:       '💣 КАБ',
  mig31k:    '🛩 МіГ-31К',
  unknown:   '❓ Невідомо',
};

// ── HTML skeleton ─────────────────────────────────────────────────────────────
// Leaflet is loaded from CDN; we wait for 'load' before injecting data.

const MAP_SKELETON_HTML = `<!DOCTYPE html>
<html>
<head>
<meta charset="utf-8">
<style>
  * { margin: 0; padding: 0; box-sizing: border-box; }
  html, body { width: 1200px; height: 760px; overflow: hidden; background: #0d1117; }
  #map { width: 1200px; height: 760px; background: #0d1117; }
  .leaflet-container { background: #0d1117 !important; }
  .legend {
    position: fixed; bottom: 18px; right: 18px;
    background: rgba(10,16,28,0.92); border: 1px solid #2a4060;
    border-radius: 8px; padding: 10px 14px; z-index: 1000; font-family: sans-serif;
  }
  .legend-title { color: #8ab4d4; font-size: 11px; font-weight: bold;
    text-transform: uppercase; letter-spacing: 0.08em; margin-bottom: 6px; }
  .legend-item { display: flex; align-items: center; gap: 7px;
    color: #cdd9e5; font-size: 12px; margin: 3px 0; }
  .legend-dot { width: 12px; height: 12px; border-radius: 50%;
    border: 1.5px solid rgba(255,255,255,0.4); flex-shrink: 0; }
  .legend-alert { display: flex; align-items: center; gap: 7px;
    color: #ff8888; font-size: 12px; margin: 4px 0 0; }
  .alert-swatch { width: 14px; height: 10px; border-radius: 2px;
    background: rgba(220,0,0,0.45); border: 1px solid #ff4444; flex-shrink: 0; }
  .title-bar {
    position: fixed; top: 12px; left: 50%; transform: translateX(-50%);
    background: rgba(10,16,28,0.88); border: 1px solid #2a4060;
    border-radius: 8px; padding: 6px 18px; z-index: 1000;
    font-family: sans-serif; color: #8ab4d4; font-size: 13px;
    display: flex; align-items: center; gap: 10px;
  }
  .title-dot { width: 8px; height: 8px; border-radius: 50; background: #ff4444;
    box-shadow: 0 0 6px #ff4444; animation: pulse 1.5s infinite; }
  @keyframes pulse {
    0%,100% { opacity: 1; } 50% { opacity: 0.3; }
  }
</style>
<link rel="stylesheet"
  href="https://unpkg.com/leaflet@1.9.4/dist/leaflet.css"
  crossorigin="anonymous"/>
<script src="https://unpkg.com/leaflet@1.9.4/dist/leaflet.js"
  crossorigin="anonymous"></script>
</head>
<body>
<div id="map"></div>
</body>
</html>`;

// ── Page-side render function (serialised & sent to Puppeteer) ───────────────
// NOTE: no outer-scope references allowed — everything must come through `payload`.

function _renderOnPage(payload) {
  const {
    ukraine, oblasts, raions,
    threats, alertedOblastKeys, alertedRaionKeys,
    threatColors, threatLabels, timestamp,
  } = payload;

  const alertOblastSet = new Set(alertedOblastKeys);
  const alertRaionSet  = new Set(alertedRaionKeys);

  const map = L.map('map', {  // eslint-disable-line no-undef
    zoomControl: false,
    attributionControl: false,
    dragging: false,
    touchZoom: false,
    scrollWheelZoom: false,
    doubleClickZoom: false,
    boxZoom: false,
    keyboard: false,
  });

  // ── Raion layer (draw first / bottom) ──
  L.geoJSON(raions, {  // eslint-disable-line no-undef
    style: (f) => {
      const alerted = alertRaionSet.has(f.properties?.key);
      return {
        color:       alerted ? '#ff4500' : '#1e3552',
        weight:      alerted ? 1.2 : 0.5,
        fillColor:   alerted ? '#ff2200' : 'transparent',
        fillOpacity: alerted ? 0.35 : 0,
      };
    },
  }).addTo(map);

  // ── Oblast layer ──
  L.geoJSON(oblasts, {  // eslint-disable-line no-undef
    style: (f) => {
      const alerted = alertOblastSet.has(f.properties?.key);
      return {
        color:       alerted ? '#ff4444' : '#2a4a6a',
        weight:      alerted ? 2 : 1.5,
        fillColor:   alerted ? '#cc0000' : '#0d2035',
        fillOpacity: alerted ? 0.30 : 0.40,
      };
    },
  }).addTo(map);

  // ── Ukraine outline (top border layer) ──
  L.geoJSON(ukraine, {  // eslint-disable-line no-undef
    style: () => ({
      color: '#5a8ab5',
      weight: 3,
      fill: false,
    }),
  }).addTo(map);

  // ── Fit to Ukraine bounds ──
  const bounds = L.geoJSON(ukraine).getBounds();  // eslint-disable-line no-undef
  map.fitBounds(bounds, { padding: [45, 45] });

  // ── Threat markers ──
  threats.forEach((t) => {
    if (typeof t.lat !== 'number' || typeof t.lon !== 'number') return;
    const color  = threatColors[t.type] ?? threatColors.unknown;
    const radius = (t.type === 'ballistic' || t.type === 'missile') ? 9 : 7;
    L.circleMarker([t.lat, t.lon], {  // eslint-disable-line no-undef
      radius,
      fillColor:   color,
      color:       'rgba(0,0,0,0.7)',
      weight:      1.5,
      fillOpacity: 0.92,
    }).addTo(map);
  });

  // ── Legend ──
  const presentTypes = [...new Set(threats.map((t) => t.type ?? 'unknown'))];
  const legendItems = presentTypes
    .map((type) => {
      const color = threatColors[type] ?? threatColors.unknown;
      const label = threatLabels[type] ?? type;
      return `<div class="legend-item">
        <div class="legend-dot" style="background:${color}"></div>
        <span>${label}</span>
      </div>`;
    })
    .join('');

  const hasAlerts = alertedOblastKeys.length > 0 || alertedRaionKeys.length > 0;
  const alertRow = hasAlerts
    ? `<div class="legend-alert"><div class="alert-swatch"></div><span>Тривога</span></div>`
    : '';

  const threatCount = threats.length;
  const legendHtml = `<div class="legend">
    <div class="legend-title">Загрози (${threatCount})</div>
    ${legendItems}
    ${alertRow}
  </div>`;

  // ── Title bar ──
  const titleHtml = `<div class="title-bar">
    <div class="title-dot"></div>
    <span>NEPTUN — Карта загроз</span>
    <span style="color:#556a80;font-size:11px">${timestamp}</span>
  </div>`;

  document.body.insertAdjacentHTML('beforeend', legendHtml + titleHtml);

  window.__mapReady = true;
}

// ── Public API ────────────────────────────────────────────────────────────────

/**
 * @param {object} opts
 * @param {Array}  opts.threats          Array of threat objects from NEPTUN
 * @param {object} opts.alerts           { raions: string[], oblasts: string[] }
 * @param {object} [opts.geo]            Pre-loaded geo data (skips disk read when provided)
 * @returns {Promise<{ buffer: Buffer, caption: string }>}
 */
export async function renderNeptunMap({ threats = [], alerts = {}, geo } = {}) {
  const geoData = geo ?? (await getGeoData());
  const { ukraine, oblasts, raions } = geoData;

  const alertedOblastKeys = alerts.oblasts ?? [];
  const alertedRaionKeys  = alerts.raions  ?? [];

  const now = new Date();
  const timestamp = now.toLocaleTimeString('uk-UA', {
    hour: '2-digit', minute: '2-digit', timeZone: 'Europe/Kyiv',
  }) + ' Kyiv';

  const browser = await getOrLaunchBrowser();
  const page = await browser.newPage();

  try {
    await page.setViewport({ width: 1200, height: 760, deviceScaleFactor: 1 });
    await page.setContent(MAP_SKELETON_HTML, { waitUntil: 'load', timeout: 20_000 });

    await page.evaluate(_renderOnPage, {
      ukraine, oblasts, raions,
      threats, alertedOblastKeys, alertedRaionKeys,
      threatColors: THREAT_COLORS,
      threatLabels: THREAT_LABELS_UA,
      timestamp,
    });

    // Wait up to 5 s for the render flag
    await page.waitForFunction(() => window.__mapReady === true, { timeout: 5_000 });

    const buffer = await page.screenshot({ type: 'png', fullPage: false });

    const alertCount = alertedOblastKeys.length + alertedRaionKeys.length;
    const caption = buildCaption(threats, alertCount, now);

    return { buffer, caption };
  } finally {
    await page.close().catch(() => {});
  }
}

function buildCaption(threats, alertRegionCount, date) {
  const lines = [];
  lines.push(`🗺 NEPTUN — Карта загроз України`);

  if (threats.length > 0) {
    const byType = {};
    for (const t of threats) {
      byType[t.type ?? 'unknown'] = (byType[t.type ?? 'unknown'] ?? 0) + 1;
    }
    const summary = Object.entries(byType)
      .map(([type, n]) => `${THREAT_LABELS_UA[type] ?? type} ×${n}`)
      .join(', ');
    lines.push(`⚠️ Загрози: ${summary}`);
  } else {
    lines.push('✅ Активних загроз не виявлено');
  }

  if (alertRegionCount > 0) {
    lines.push(`🔴 Тривога у ${alertRegionCount} регіонах`);
  }

  const timeStr = date.toLocaleTimeString('uk-UA', {
    hour: '2-digit', minute: '2-digit', timeZone: 'Europe/Kyiv',
  });
  lines.push(`🕐 ${timeStr} Kyiv  •  © neptun.in.ua`);

  return lines.join('\n');
}
