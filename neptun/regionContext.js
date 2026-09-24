/**
 * Region-scoped threat/alert analysis: which threats are inside or near a
 * given oblast/city, whether an alert is active there, and Ukrainian-language
 * report/caption builders shared by the map renderer, the bot fallback text
 * and the Gemini prompt.
 */

import {
  THREAT_EMOJI,
  ALERT_LEVEL_RANK,
  ALERT_LEVEL_EMOJI,
  ALERT_LEVEL_WORDS,
  normalizeAlertKey,
  extractAlertKeys,
  entryAlertLevel,
  entryAlertReasons,
  maxAlertLevel,
  isAreaOnly,
  groupSize,
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

/**
 * "~31 км", or "~31 км (±10)" when NEPTUN's own uncertainty is a material part
 * of the distance. A bare "~31 км" for a position NEPTUN places within ±10 km
 * reads as a measurement it isn't; ±4 on a 96 km distance is noise and stays
 * off the line.
 */
export function formatDistance(distanceKm, uncertaintyKm) {
  const d = Math.round(distanceKm);
  const u = Number.isFinite(uncertaintyKm) ? Math.round(uncertaintyKm) : 0;
  return u >= 5 && u * 4 >= d ? `~${d} км (±${u})` : `~${d} км`;
}

// ── Region status ─────────────────────────────────────────────────────────────

const describeThreat = (t, { distanceKm, direction, directionShort, inRegion, bearingFromRegion = null }) => {
  const type = String(t?.type ?? 'unknown').toLowerCase();
  return {
    id: t?.id,
    type,
    // Objects this one track stands for («Група БпЛА (5+)» → 5).
    count: groupSize(t),
    uncertaintyKm: Number.isFinite(t?.uncertaintyKm) ? t.uncertaintyKm : null,
    areaOnly: isAreaOnly(t),
    // 'advisory' is a warning that something may be used; 'tracked' is an
    // object with a position. The name already reflects it ("Загроза
    // балістики" vs "Балістика") so no caller can print a warning as a missile.
    nature: threatNature(t),
    name: threatDisplayName(t),
    emoji: THREAT_EMOJI[type] ?? THREAT_EMOJI.unknown,
    // NEPTUN sets `destination` when lat/lon is where the target is *heading*
    // ("курсом на Обухів"), not where it is. "над Обухів" would then put it
    // overhead a town it hasn't reached.
    destination: t?.destination === true && !isAreaOnly(t),
    approx: isAreaOnly(t) || t?.positionQuality === 'approx' || t?.lifecycle === 'uncertain',
    title: t?.title ?? '',
    locality: t?.locality ?? '',
    sourceRegion: t?.region ?? '',
    // An area-only track has no position — the feed's lat/lon is the oblast
    // centroid — so it has no coordinates, course or distance here either.
    lat: isAreaOnly(t) ? null : t?.lat,
    lon: isAreaOnly(t) ? null : t?.lon,
    heading: Number.isFinite(t?.heading) && !isAreaOnly(t) ? t.heading : null,
    headingWord: Number.isFinite(t?.heading) && !isAreaOnly(t) ? bearingToWord(t.heading) : '',
    headingShort: Number.isFinite(t?.heading) && !isAreaOnly(t) ? bearingToWord(t.heading, { short: true }) : '',
    distanceKm: Number.isFinite(distanceKm) ? Math.round(distanceKm) : null,
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

/** An alert entry as the report and the watcher use it. */
const describeAlertEntry = (entry, fallbackKey = '') => {
  const { level, known } = entryAlertLevel(entry);
  const key = normalizeAlertKey(entry) || fallbackKey;
  return {
    key,
    name: (entry && typeof entry === 'object' && entry.name) || key,
    since: (entry && typeof entry === 'object' && entry.since) || '',
    level,
    levelKnown: known,
    reasons: entryAlertReasons(entry),
  };
};

/**
 * The level that applies across several entries, and the reasons given at that
 * level — a yellow district's "Дронова загроза" is not the reason a region is
 * red, so it is left out.
 */
const summariseLevel = (entries) => {
  let level = null;
  for (const e of entries) level = maxAlertLevel(level, e.level);
  const top = entries.filter((e) => e.level === level);
  return {
    level,
    levelKnown: top.some((e) => e.levelKnown),
    reasons: [...new Set(top.flatMap((e) => e.reasons))],
  };
};

/**
 * Does an area-only track (one that names only an oblast) concern this region?
 * An oblast: when it is that oblast. A city: when the city is in it — by its
 * parent key, or by lying inside the oblast's outer boundary, which is how
 * «Ракета на Київщину» reaches Київ, an enclave with its own alert key.
 */
const areaConcerns = (t, region, geo) => {
  const key = normalizeAlertKey(t?.region);
  if (!key) return false;
  if (region.kind === 'oblast') return key === region.geoKey;
  if (region.kind !== 'city') return false;
  if (key === region.oblastGeoKey) return true;
  const feature = findOblastFeature(geo, key);
  return feature ? pointInFeature(region.lat, region.lon, feature) : false;
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
  // Area-only tracks that name this region's oblast. Kept apart from in/near
  // so nothing that sorts, frames or measures by distance ever sees them.
  const threatsArea = [];
  let alertScope = null;
  let alertSince = '';
  let alertedRaions = [];
  let oblastAlert = null;
  let applicable = [];
  let refPoint = null;

  const validThreats = threats.filter(
    (t) => Number.isFinite(t?.lat) && Number.isFinite(t?.lon) && !isAreaOnly(t)
  );
  for (const t of threats) {
    if (isAreaOnly(t) && areaConcerns(t, region, geo)) {
      threatsArea.push(describeThreat(t, { distanceKm: null, direction: '', directionShort: '', inRegion: true }));
    }
  }

  if (region.kind === 'oblast') {
    const feature = findOblastFeature(geo, region.geoKey);
    const bbox = feature ? featureBbox(feature) : null;
    refPoint = bbox
      ? { lat: (bbox.minLat + bbox.maxLat) / 2, lon: (bbox.minLon + bbox.maxLon) / 2 }
      : null;

    const oblastEntry = oblastEntries.find((e) => normalizeAlertKey(e) === region.geoKey) ?? null;
    alertedRaions = raionEntries
      .filter((e) => e && typeof e === 'object' && normalizeAlertKey(e.oblast) === region.geoKey)
      .map((e) => describeAlertEntry(e));

    if (oblastEntry) {
      alertScope = 'oblast';
      alertSince = oblastEntry.since ?? '';
      oblastAlert = describeAlertEntry(oblastEntry, region.geoKey);
    } else if (alertedRaions.length) {
      alertScope = 'raions';
      alertSince = minSince(alertedRaions);
    }
    // Everyone in the oblast is under the oblast-wide level, and the people in
    // a red district inside a yellow oblast are under red.
    applicable = [...(oblastAlert ? [oblastAlert] : []), ...alertedRaions];

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

    // Every entry that covers the city: its own alert, the whole parent
    // oblast, its raion. The most severe one is what the city is under, so it
    // also decides which scope the report names; among equals the old
    // precedence holds (own city → full oblast → raion), because a full oblast
    // alert subsumes raion entries (feeds often list both at once).
    const covering = [
      cityEntry && { scope: 'city', entry: describeAlertEntry(cityEntry, cityKey) },
      oblastEntry && { scope: 'oblast', entry: describeAlertEntry(oblastEntry, parentOblastKey) },
      raionEntry && typeof raionEntry === 'object' && { scope: 'raion', entry: describeAlertEntry(raionEntry, region.raionKey) },
    ].filter(Boolean);
    let chosen = null;
    for (const c of covering) {
      if (!chosen || ALERT_LEVEL_RANK[c.entry.level] > ALERT_LEVEL_RANK[chosen.entry.level]) chosen = c;
    }

    if (chosen) {
      alertScope = chosen.scope;
      alertSince = chosen.entry.since;
      if (chosen.scope === 'raion') {
        alertedRaions = [{ ...chosen.entry, key: region.raionKey, name: chosen.entry.name || region.raionKey }];
      }
      applicable = covering.map((c) => c.entry);
    } else if (region.raionKey && raionKeySet.has(region.raionKey)) {
      // A bare-string raion entry: an alert with no level or time attached.
      alertScope = 'raion';
      applicable = [describeAlertEntry(region.raionKey)];
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

  const level = alertScope != null ? summariseLevel(applicable) : { level: null, levelKnown: false, reasons: [] };

  return {
    region,
    alertActive: alertScope != null,
    alertScope, // 'oblast' | 'raions' | 'city' | 'raion' | null
    alertSince,
    // 'red' | 'yellow' | null — the most severe level covering the region.
    alertLevel: level.level,
    alertLevelKnown: level.levelKnown,
    alertReasons: level.reasons,
    oblastAlert,
    alertedRaions,
    threatsIn,
    threatsNear,
    threatsArea,
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

const levelEmoji = (level) => ALERT_LEVEL_EMOJI[level] ?? ALERT_LEVEL_EMOJI.red;

// What the alert is about, in the feed's own words ("Ракетна загроза (червоний
// рівень)"); the bare level when the feed gave a level but no reason; nothing
// when it gave neither — never a colour the feed didn't state.
const reasonLine = ({ reasons = [], level, levelKnown }, f) => {
  if (reasons.length) return f.i(reasons.join(' · '));
  if (levelKnown && ALERT_LEVEL_WORDS[level]) {
    const words = ALERT_LEVEL_WORDS[level];
    return f.i(words[0].toUpperCase() + words.slice(1));
  }
  return '';
};

// Districts grouped by level, most severe first: "🔴 Тривога у районах: …"
// and "🟡 Тривога у районах: …" as separate lines, each with its reason.
const raionGroupLines = (raions, f, { max = 5 } = {}) => {
  const lines = [];
  for (const level of ['red', 'yellow']) {
    const group = raions.filter((r) => r.level === level);
    if (!group.length) continue;
    const parts = group.slice(0, max).map((r) => `${f.esc(r.name)}${f.i(sinceSuffix(r.since))}`);
    const extra = group.length > max ? ` та ще ${group.length - max}` : '';
    lines.push(`${levelEmoji(level)} ${f.b('Тривога у районах:')} ${parts.join(', ')}${extra}`);
    const reason = reasonLine(summariseLevel(group), f);
    if (reason) lines.push(reason);
  }
  return lines;
};

const alertLine = (status, f) => {
  const { region, alertScope, alertSince, alertedRaions, oblastAlert } = status;
  const overall = { reasons: status.alertReasons, level: status.alertLevel, levelKnown: status.alertLevelKnown };
  const head = (text, level = status.alertLevel) => `${levelEmoji(level)} ${f.b(text)}${f.i(sinceSuffix(alertSince))}`;
  const withReason = (line, summary = overall) => [line, reasonLine(summary, f)].filter(Boolean).join('\n');
  switch (alertScope) {
    case 'oblast': {
      // A city under its parent oblast's alert: one line, like its own alert.
      if (!oblastAlert) return withReason(head('Тривога — вся область'));
      // The oblast itself: the oblast-wide line carries that entry's own level,
      // and a district inside it that is more severe (red inside yellow) gets
      // its own line — it is the part of the oblast that must go to shelter.
      const lines = [withReason(head('Тривога — вся область', oblastAlert.level), oblastAlert)];
      const rank = ALERT_LEVEL_RANK[oblastAlert.level];
      lines.push(...raionGroupLines(alertedRaions.filter((r) => ALERT_LEVEL_RANK[r.level] > rank), f));
      return lines.join('\n');
    }
    case 'city':
      return withReason(head(`Тривога у м. ${region.name}`));
    case 'raion':
      return withReason(head(`Тривога — ${alertedRaions[0]?.name ?? 'район міста'}`));
    case 'raions':
      return raionGroupLines(alertedRaions, f).join('\n');
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

// "БпЛА ×5" for a group, so one marker doesn't read as one drone.
const threatName = (t) => (t.count > 1 ? `${t.name} ×${t.count}` : t.name);

const threatLineIn = (t, { short = false, f = PLAIN } = {}) =>
  `• ${[`${t.emoji} ${f.b(threatName(t))}`, f.esc(threatPlace(t)), f.esc(threatCourse(t, short))].filter(Boolean).join(' · ')}`;

const threatLineNear = (t, { short = false, f = PLAIN } = {}) => {
  const dir = short ? t.directionShort : t.direction;
  // Locality alone: the parenthetical oblast doubled the line length and the
  // map already shows which oblast it's over.
  const distance = `${formatDistance(t.distanceKm, t.uncertaintyKm)}${dir ? ` на ${dir}` : ''}`;
  return `• ${[`${t.emoji} ${f.b(threatName(t))}`, distance, f.esc(threatCourse(t, short)), f.esc(threatPlace(t))].filter(Boolean).join(' · ')}`;
};

// An area-only track: the oblast it was reported for and nothing else — no
// distance, no direction, no course, because there is no point to measure from.
const threatLineArea = (t, { f = PLAIN } = {}) =>
  `• ${[`${t.emoji} ${f.b(threatName(t))}`, f.esc(t.sourceRegion || t.locality)].filter(Boolean).join(' · ')}`;

/**
 * The body as an array of blocks. Each block is a group of lines that belong
 * together (the alert line, the in-region list, the nearby list); the callers
 * join blocks with a blank line so the sections breathe.
 */
const statusBlocks = (status, { maxIn = 8, maxNear = 5, maxArea = 3, short = false, html = false } = {}) => {
  const f = fmt(html);
  const blocks = [alertLine(status, f)];
  const area = status.threatsArea ?? [];

  if (status.threatsIn.length) {
    const lines = [`⚠️ ${f.b(`У регіоні — ${status.threatsIn.length}`)}`];
    status.threatsIn.slice(0, maxIn).forEach((t) => lines.push(threatLineIn(t, { short, f })));
    if (status.threatsIn.length > maxIn) lines.push(f.i(`…та ще ${status.threatsIn.length - maxIn}`));
    blocks.push(lines.join('\n'));
  }

  if (area.length) {
    const lines = [`🗺 ${f.b(`По області, місце невідоме — ${area.length}`)}`];
    area.slice(0, maxArea).forEach((t) => lines.push(threatLineArea(t, { f })));
    if (area.length > maxArea) lines.push(f.i(`…та ще ${area.length - maxArea}`));
    blocks.push(lines.join('\n'));
  }

  if (status.threatsNear.length) {
    const lines = [`📡 ${f.b(`Поблизу — ${status.threatsNear.length}`)}`];
    status.threatsNear.slice(0, maxNear).forEach((t) => lines.push(threatLineNear(t, { short, f })));
    if (status.threatsNear.length > maxNear) lines.push(f.i(`…та ще ${status.threatsNear.length - maxNear}`));
    blocks.push(lines.join('\n'));
  }

  if (!status.threatsIn.length && !status.threatsNear.length && !area.length) {
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
  let maxArea = 3;
  const build = () =>
    [header, ...statusBlocks(status, { maxIn, maxNear, maxArea, short: true, html: true }), extra, footer].filter(Boolean).join('\n\n');
  let caption = build();
  while (caption.length > 1000 && (maxIn > 1 || maxNear > 0 || maxArea > 1)) {
    if (maxIn > 1) maxIn -= 1;
    if (maxNear > 0) maxNear -= 1;
    if (maxArea > 1) maxArea -= 1;
    caption = build();
  }
  return caption;
}
