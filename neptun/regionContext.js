/**
 * Region-scoped threat/alert analysis: which threats are inside or near a
 * given oblast/city, whether an alert is active there, and Ukrainian-language
 * report/caption builders shared by the map renderer, the bot fallback text
 * and the Gemini prompt.
 */

import {
  THREAT_EMOJI,
  normalizeAlertKey,
  extractAlertKeys,
  threatNature,
  threatDisplayName,
} from './threatMeta.js';
import { esc, b, i } from './telegramFormat.js';

// ── Geometry helpers ──────────────────────────────────────────────────────────

const EARTH_R_KM = 6371;
const toRad = (d) => (d * Math.PI) / 180;

export function haversineKm(lat1, lon1, lat2, lon2) {
  const dLat = toRad(lat2 - lat1);
  const dLon = toRad(lon2 - lon1);
  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLon / 2) ** 2;
  return 2 * EARTH_R_KM * Math.asin(Math.sqrt(a));
}

export function bearingDeg(lat1, lon1, lat2, lon2) {
  const y = Math.sin(toRad(lon2 - lon1)) * Math.cos(toRad(lat2));
  const x =
    Math.cos(toRad(lat1)) * Math.sin(toRad(lat2)) -
    Math.sin(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.cos(toRad(lon2 - lon1));
  return ((Math.atan2(y, x) * 180) / Math.PI + 360) % 360;
}

const DIR_FULL = ['північ', 'північний схід', 'схід', 'південний схід', 'південь', 'південний захід', 'захід', 'північний захід'];
const DIR_SHORT = ['пн', 'пн-сх', 'сх', 'пд-сх', 'пд', 'пд-зх', 'зх', 'пн-зх'];

export function bearingToWord(deg, { short = false } = {}) {
  if (!Number.isFinite(deg)) return '';
  const idx = Math.round((((deg % 360) + 360) % 360) / 45) % 8;
  return (short ? DIR_SHORT : DIR_FULL)[idx];
}

/** Bounding box { minLat, maxLat, minLon, maxLon } of a GeoJSON feature. */
export function featureBbox(feature) {
  const box = { minLat: Infinity, maxLat: -Infinity, minLon: Infinity, maxLon: -Infinity };
  const walk = (node) => {
    if (!Array.isArray(node)) return;
    if (node.length >= 2 && typeof node[0] === 'number' && typeof node[1] === 'number') {
      const [lon, lat] = node;
      if (lat < box.minLat) box.minLat = lat;
      if (lat > box.maxLat) box.maxLat = lat;
      if (lon < box.minLon) box.minLon = lon;
      if (lon > box.maxLon) box.maxLon = lon;
      return;
    }
    for (const child of node) walk(child);
  };
  walk(feature?.geometry?.coordinates);
  return Number.isFinite(box.minLat) ? box : null;
}

const pointInRing = (lat, lon, ring) => {
  let inside = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const [xi, yi] = ring[i]; // x = lon, y = lat
    const [xj, yj] = ring[j];
    const intersects = yi > lat !== yj > lat && lon < ((xj - xi) * (lat - yi)) / (yj - yi) + xi;
    if (intersects) inside = !inside;
  }
  return inside;
};

/** Ray-cast point-in-polygon for Polygon/MultiPolygon features (outer rings). */
export function pointInFeature(lat, lon, feature) {
  const geom = feature?.geometry;
  if (!geom) return false;
  if (geom.type === 'Polygon') return pointInRing(lat, lon, geom.coordinates?.[0] ?? []);
  if (geom.type === 'MultiPolygon') {
    return (geom.coordinates ?? []).some((poly) => pointInRing(lat, lon, poly?.[0] ?? []));
  }
  return false;
}

/** Distance from a point to a bbox (0 when inside). */
export function distanceToBboxKm(lat, lon, bbox) {
  const clampedLat = Math.min(Math.max(lat, bbox.minLat), bbox.maxLat);
  const clampedLon = Math.min(Math.max(lon, bbox.minLon), bbox.maxLon);
  return haversineKm(lat, lon, clampedLat, clampedLon);
}

/**
 * Min distance from a point to a feature's ring vertices. Real oblast borders
 * in the vendored GeoJSON are dense, so vertex distance ≈ border distance —
 * unlike bbox distance, which is ~0 for points inside the bounding box but
 * outside the polygon itself.
 */
export function distanceToFeatureKm(lat, lon, feature) {
  let best = Infinity;
  const walk = (node) => {
    if (!Array.isArray(node)) return;
    if (node.length >= 2 && typeof node[0] === 'number' && typeof node[1] === 'number') {
      const d = haversineKm(lat, lon, node[1], node[0]);
      if (d < best) best = d;
      return;
    }
    for (const child of node) walk(child);
  };
  walk(feature?.geometry?.coordinates);
  return best;
}

const featKey = (feature) => {
  const p = feature?.properties ?? {};
  return normalizeAlertKey(p.key ?? p.region ?? p.rayon ?? p.name);
};

export function findOblastFeature(geo, geoKey) {
  const target = normalizeAlertKey(geoKey);
  return (geo?.oblasts?.features ?? []).find((f) => featKey(f) === target) ?? null;
}

export function fmtKyivTime(iso) {
  const d = new Date(iso ?? '');
  if (Number.isNaN(d.getTime())) return '';
  return d.toLocaleTimeString('uk-UA', { hour: '2-digit', minute: '2-digit', timeZone: 'Europe/Kyiv' });
}

// ── Region status ─────────────────────────────────────────────────────────────

const describeThreat = (t, { distanceKm, direction, directionShort, inRegion, bearingFromRegion = null }) => {
  const type = String(t?.type ?? 'unknown').toLowerCase();
  return {
    id: t?.id,
    type,
    // 'advisory' is a warning that something may be used; 'tracked' is an
    // object with a position. The name already reflects it ("Загроза
    // балістики" vs "Балістика") so no caller can print a warning as a missile.
    nature: threatNature(t),
    name: threatDisplayName(t),
    emoji: THREAT_EMOJI[type] ?? THREAT_EMOJI.unknown,
    // NEPTUN sets `destination` when lat/lon is where the target is *heading*
    // ("курсом на Обухів"), not where it is. "над Обухів" would then put it
    // overhead a town it hasn't reached.
    destination: t?.destination === true,
    approx: t?.positionQuality === 'approx' || t?.lifecycle === 'uncertain',
    title: t?.title ?? '',
    locality: t?.locality ?? '',
    sourceRegion: t?.region ?? '',
    lat: t?.lat,
    lon: t?.lon,
    heading: Number.isFinite(t?.heading) ? t.heading : null,
    headingWord: Number.isFinite(t?.heading) ? bearingToWord(t.heading) : '',
    headingShort: Number.isFinite(t?.heading) ? bearingToWord(t.heading, { short: true }) : '',
    distanceKm: Math.round(distanceKm),
    direction,
    directionShort,
    // Numeric bearing from the region to the threat — lets the watcher tell an
    // approaching threat from one that's merely nearby but heading away.
    bearingFromRegion: Number.isFinite(bearingFromRegion) ? bearingFromRegion : null,
    inRegion,
    explanationShort: t?.explanationShort ?? '',
  };
};

const minSince = (entries) => {
  const times = entries
    .map((e) => new Date(e?.since ?? '').getTime())
    .filter((t) => Number.isFinite(t) && t > 0);
  return times.length ? new Date(Math.min(...times)).toISOString() : '';
};

/**
 * Builds the live status of a region: alert state + threats inside / nearby.
 *
 * @param {object} opts
 * @param {object} opts.region   Descriptor from resolveRegion() (kind oblast|city)
 * @param {Array}  opts.threats  NEPTUN threat objects
 * @param {object} opts.alerts   { oblasts: [], raions: [] }
 * @param {object} opts.geo      { oblasts, raions, ukraine } GeoJSON
 */
export function buildRegionStatus({ region, threats = [], alerts = {}, geo = {} }) {
  const oblastEntries = alerts.oblasts ?? [];
  const raionEntries = alerts.raions ?? [];
  const raionKeySet = new Set(extractAlertKeys(raionEntries));

  const threatsIn = [];
  const threatsNear = [];
  let alertScope = null;
  let alertSince = '';
  let alertedRaions = [];
  let refPoint = null;

  const validThreats = threats.filter(
    (t) => Number.isFinite(t?.lat) && Number.isFinite(t?.lon)
  );

  if (region.kind === 'oblast') {
    const feature = findOblastFeature(geo, region.geoKey);
    const bbox = feature ? featureBbox(feature) : null;
    refPoint = bbox
      ? { lat: (bbox.minLat + bbox.maxLat) / 2, lon: (bbox.minLon + bbox.maxLon) / 2 }
      : null;

    const oblastEntry = oblastEntries.find((e) => normalizeAlertKey(e) === region.geoKey) ?? null;
    alertedRaions = raionEntries
      .filter((e) => e && typeof e === 'object' && normalizeAlertKey(e.oblast) === region.geoKey)
      .map((e) => ({ key: normalizeAlertKey(e), name: e.name || normalizeAlertKey(e), since: e.since ?? '' }));

    if (oblastEntry) {
      alertScope = 'oblast';
      alertSince = oblastEntry.since ?? '';
    } else if (alertedRaions.length) {
      alertScope = 'raions';
      alertSince = minSince(alertedRaions);
    }

    const NEARBY_KM = 90;
    for (const t of validThreats) {
      const inside = feature ? pointInFeature(t.lat, t.lon, feature) : false;
      if (inside) {
        const d = refPoint ? haversineKm(refPoint.lat, refPoint.lon, t.lat, t.lon) : 0;
        threatsIn.push(describeThreat(t, { distanceKm: d, direction: '', directionShort: '', inRegion: true }));
      } else if (bbox && distanceToBboxKm(t.lat, t.lon, bbox) <= NEARBY_KM) {
        // Cheap bbox prefilter, then honest distance to the oblast border.
        const d = distanceToFeatureKm(t.lat, t.lon, feature);
        if (d <= NEARBY_KM) {
          const b = refPoint ? bearingDeg(refPoint.lat, refPoint.lon, t.lat, t.lon) : NaN;
          threatsNear.push(describeThreat(t, {
            distanceKm: d,
            direction: bearingToWord(b),
            directionShort: bearingToWord(b, { short: true }),
            bearingFromRegion: b,
            inRegion: false,
          }));
        }
      }
    }
  } else if (region.kind === 'city') {
    refPoint = { lat: region.lat, lon: region.lon };
    const inKm = region.radiusKm ?? 60;
    const nearKm = Math.max(140, inKm * 2);

    const cityKey = region.alertKey ? normalizeAlertKey(region.alertKey) : '';
    const cityEntry = cityKey ? oblastEntries.find((e) => normalizeAlertKey(e) === cityKey) ?? null : null;
    const raionEntry = region.raionKey
      ? raionEntries.find((e) => normalizeAlertKey(e) === region.raionKey) ?? null
      : null;
    const parentOblastKey = region.oblastGeoKey && region.oblastGeoKey !== cityKey ? region.oblastGeoKey : '';
    const oblastEntry = parentOblastKey
      ? oblastEntries.find((e) => normalizeAlertKey(e) === parentOblastKey) ?? null
      : null;

    // Precedence: own city alert → full parent oblast → city's raion. A full
    // oblast alert subsumes raion entries (feeds often list both at once).
    if (cityEntry) {
      alertScope = 'city';
      alertSince = cityEntry.since ?? '';
    } else if (oblastEntry) {
      alertScope = 'oblast';
      alertSince = oblastEntry.since ?? '';
    } else if (raionEntry && typeof raionEntry === 'object') {
      alertScope = 'raion';
      alertSince = raionEntry.since ?? '';
      alertedRaions = [{ key: region.raionKey, name: raionEntry.name || region.raionKey, since: raionEntry.since ?? '' }];
    } else if (region.raionKey && raionKeySet.has(region.raionKey)) {
      alertScope = 'raion';
    }

    for (const t of validThreats) {
      const d = haversineKm(region.lat, region.lon, t.lat, t.lon);
      if (d > nearKm) continue;
      const b = bearingDeg(region.lat, region.lon, t.lat, t.lon);
      const desc = describeThreat(t, {
        distanceKm: d,
        direction: bearingToWord(b),
        directionShort: bearingToWord(b, { short: true }),
        bearingFromRegion: b,
        inRegion: d <= inKm,
      });
      (desc.inRegion ? threatsIn : threatsNear).push(desc);
    }
  }

  threatsIn.sort((a, b) => a.distanceKm - b.distanceKm);
  threatsNear.sort((a, b) => a.distanceKm - b.distanceKm);

  return {
    region,
    alertActive: alertScope != null,
    alertScope, // 'oblast' | 'raions' | 'city' | 'raion' | null
    alertSince,
    alertedRaions,
    threatsIn,
    threatsNear,
    refPoint,
  };
}

// ── Report / caption builders ─────────────────────────────────────────────────

const sinceSuffix = (iso) => {
  const t = fmtKyivTime(iso);
  return t ? ` (з ${t})` : '';
};

// Two renderings of every line: plain (the Gemini prompt reads it) and
// Telegram HTML (a person reads it). `f` is the formatter set for the mode so
// the wording is written once. In plain mode the helpers pass text through.
const PLAIN = { esc: (s) => String(s ?? ''), b: (s) => String(s ?? ''), i: (s) => String(s ?? '') };
const RICH = { esc, b, i };
const fmt = (html) => (html ? RICH : PLAIN);

const alertLine = (status, f) => {
  const { region, alertScope, alertSince, alertedRaions } = status;
  switch (alertScope) {
    case 'oblast':
      return `🔴 ${f.b('Тривога — вся область')}${f.i(sinceSuffix(alertSince))}`;
    case 'city':
      return `🔴 ${f.b(`Тривога у м. ${region.name}`)}${f.i(sinceSuffix(alertSince))}`;
    case 'raion':
      return `🔴 ${f.b(`Тривога — ${alertedRaions[0]?.name ?? 'район міста'}`)}${f.i(sinceSuffix(alertSince))}`;
    case 'raions': {
      const parts = alertedRaions.slice(0, 5).map((r) => `${f.esc(r.name)}${f.i(sinceSuffix(r.since))}`);
      const extra = alertedRaions.length > 5 ? ` та ще ${alertedRaions.length - 5}` : '';
      return `🔴 ${f.b('Тривога у районах:')} ${parts.join(', ')}${extra}`;
    }
    default:
      return `🟢 ${f.b('Тривоги немає')}`;
  }
};

// One threat, one line. A single " · " separator throughout — mixing "—",
// commas and "(…)" is what made these hard to scan on a phone.
// Where a threat is, in words: "курсом на X" when the feed marks the point as
// the destination, plain locality otherwise. An advisory has no course — it is
// a warning about a place, not an object moving toward it.
const threatPlace = (t) => {
  const place = t.locality || t.sourceRegion || '';
  if (t.destination && t.locality && t.nature !== 'advisory') return `курсом на ${t.locality}`;
  return place;
};

const threatCourse = (t, short) => {
  if (t.nature === 'advisory' || t.destination || !t.headingWord) return '';
  return `курс ${short ? t.headingShort : t.headingWord}`;
};

const threatLineIn = (t, { short = false, f = PLAIN } = {}) =>
  `• ${[`${t.emoji} ${f.b(t.name)}`, f.esc(threatPlace(t)), f.esc(threatCourse(t, short))].filter(Boolean).join(' · ')}`;

const threatLineNear = (t, { short = false, f = PLAIN } = {}) => {
  const dir = short ? t.directionShort : t.direction;
  // Locality alone: the parenthetical oblast doubled the line length and the
  // map already shows which oblast it's over.
  const distance = `~${t.distanceKm} км${dir ? ` на ${dir}` : ''}`;
  return `• ${[`${t.emoji} ${f.b(t.name)}`, distance, f.esc(threatCourse(t, short)), f.esc(threatPlace(t))].filter(Boolean).join(' · ')}`;
};

/**
 * The body as an array of blocks. Each block is a group of lines that belong
 * together (the alert line, the in-region list, the nearby list); the callers
 * join blocks with a blank line so the sections breathe.
 */
const statusBlocks = (status, { maxIn = 8, maxNear = 5, short = false, html = false } = {}) => {
  const f = fmt(html);
  const blocks = [alertLine(status, f)];

  if (status.threatsIn.length) {
    const lines = [`⚠️ ${f.b(`У регіоні — ${status.threatsIn.length}`)}`];
    status.threatsIn.slice(0, maxIn).forEach((t) => lines.push(threatLineIn(t, { short, f })));
    if (status.threatsIn.length > maxIn) lines.push(f.i(`…та ще ${status.threatsIn.length - maxIn}`));
    blocks.push(lines.join('\n'));
  }

  if (status.threatsNear.length) {
    const lines = [`📡 ${f.b(`Поблизу — ${status.threatsNear.length}`)}`];
    status.threatsNear.slice(0, maxNear).forEach((t) => lines.push(threatLineNear(t, { short, f })));
    if (status.threatsNear.length > maxNear) lines.push(f.i(`…та ще ${status.threatsNear.length - maxNear}`));
    blocks.push(lines.join('\n'));
  }

  if (!status.threatsIn.length && !status.threatsNear.length) {
    blocks.push('✅ Загроз у регіоні та поблизу не зафіксовано');
  }

  return blocks;
};

const footerLine = (date, f = PLAIN) => {
  const timeStr = date.toLocaleTimeString('uk-UA', {
    hour: '2-digit', minute: '2-digit', timeZone: 'Europe/Kyiv',
  });
  return f.i(`🕐 ${timeStr} за Києвом · © neptun.in.ua`);
};

/**
 * Region report. Plain by default (it is the Gemini prompt's facts); with
 * `html: true` it is the Telegram fallback message when a render fails.
 */
export function formatRegionReport(status, opts = {}) {
  const f = fmt(opts.html);
  return [`📍 ${f.b(status.region.name)}`, ...statusBlocks(status, { maxIn: 10, maxNear: 6, ...opts })]
    .join('\n\n');
}

/**
 * Telegram photo caption for the focused map (kept under the 1024-char limit).
 * `extra` is an optional block appended before the footer — the night summary —
 * and it takes part in the shrink loop, so a long night never pushes the
 * caption over the limit.
 */
export function buildFocusCaption(status, date = new Date(), { extra = '' } = {}) {
  // Captions are only ever read by Telegram, so they are always HTML.
  const header = `🗺 ${b(`NEPTUN — ${status.region.name}`)}`;
  const footer = footerLine(date, RICH);

  let maxIn = 7;
  let maxNear = 4;
  const build = () =>
    [header, ...statusBlocks(status, { maxIn, maxNear, short: true, html: true }), extra, footer].filter(Boolean).join('\n\n');
  let caption = build();
  while (caption.length > 1000 && (maxIn > 1 || maxNear > 0)) {
    if (maxIn > 1) maxIn -= 1;
    if (maxNear > 0) maxNear -= 1;
    caption = build();
  }
  return caption;
}
