/**
 * Shared threat metadata + NEPTUN alert-key normalisation.
 * Kept dependency-free so both the map renderer and the region context
 * helpers can import it without cycles.
 */

export const THREAT_COLORS = {
  missile:   '#ff4d4d',
  ballistic: '#b3122c', // deep crimson — was near-identical to missile red
  uav:       '#ff8c42',
  fpv:       '#ff4fa3',
  recon:     '#22c3b0', // teal — gold used to blend into the new amber alert fill
  kab:       '#a855f7',
  mig31k:    '#ff5f2e',
  unknown:   '#9aa7b5',
};

export const THREAT_EMOJI = {
  missile:   '🚀',
  ballistic: '💥',
  uav:       '✈️',
  fpv:       '🛸',
  recon:     '👁️',
  kab:       '💣',
  mig31k:    '🛩️',
  unknown:   '❓',
};

export const THREAT_NAMES_UA = {
  missile:   'Ракета',
  ballistic: 'Балістика',
  uav:       'БпЛА',
  fpv:       'FPV-дрон',
  recon:     'Розвідник',
  kab:       'КАБ',
  mig31k:    'МіГ-31К',
  unknown:   'Невідомо',
};

/** Back-compat: emoji + name, used in captions. */
export const THREAT_LABELS_UA = Object.fromEntries(
  Object.keys(THREAT_NAMES_UA).map((t) => [t, `${THREAT_EMOJI[t]} ${THREAT_NAMES_UA[t]}`])
);

// ── Alert key normalisation ───────────────────────────────────────────────────
// NEPTUN alert entries are objects ({ key, name, oblast, since }) — older code
// treated them as strings, so Set.has() never matched and no region was ever
// highlighted. GeoJSON features carry the same lowercase `properties.key`.

export function normalizeAlertKey(value) {
  // For objects, try key → name → oblast, skipping empty strings — some feed
  // entries have `key: ""` but a usable `name`.
  const candidates = value != null && typeof value === 'object' && !Array.isArray(value)
    ? [value.key, value.name, value.oblast]
    : [value];
  for (const candidate of candidates) {
    const normalized = String(candidate ?? '')
      .normalize('NFC')
      .toLowerCase()
      .replace(/\s+(область|обл\.?|район|р-н)\s*$/u, '')
      .trim();
    if (normalized) return normalized;
  }
  return '';
}

/** Normalises a list of alert entries (objects or strings) into unique keys. */
export function extractAlertKeys(entries) {
  return [...new Set((entries ?? []).map(normalizeAlertKey).filter(Boolean))];
}

// ── Alert levels ──────────────────────────────────────────────────────────────
// Since September 2026 an air-raid alert has a level (CMU resolution
// 1092-2026-п): yellow — a drone threat, where life largely goes on; red — a
// missile, missile-and-drone or massive drone threat, where everyone goes to
// the shelter. An alert moves between them while it runs. NEPTUN carries it
// as `level` + `reasons` on every alert entry.
//
// An entry without a usable level counts as red. The two mistakes are not
// equal: calling a red alert yellow tells people to stay put while missiles are
// in the air, calling a yellow one red only costs a trip to the shelter. The
// `known` flag keeps the display honest — the bot never prints "червоний
// рівень" for an entry that didn't say so.

export const ALERT_LEVEL_RANK = Object.freeze({ yellow: 1, red: 2 });

export const ALERT_LEVEL_EMOJI = Object.freeze({ yellow: '🟡', red: '🔴' });

/** "червоний рівень" — lower case, for use inside a sentence. */
export const ALERT_LEVEL_WORDS = Object.freeze({ yellow: 'жовтий рівень', red: 'червоний рівень' });

/** @returns {{ level: 'red'|'yellow', known: boolean }} */
export function entryAlertLevel(entry) {
  const raw = entry != null && typeof entry === 'object' ? String(entry.level ?? '').toLowerCase() : '';
  if (raw === 'yellow' || raw === 'red') return { level: raw, known: true };
  return { level: 'red', known: false };
}

/** The more severe of two levels; null counts as "no alert". */
export function maxAlertLevel(a, b) {
  return (ALERT_LEVEL_RANK[a] ?? 0) >= (ALERT_LEVEL_RANK[b] ?? 0) ? (a ?? null) : (b ?? null);
}

/** The feed's own words for why an alert is on ("Ракетна загроза (червоний рівень)"). */
export function entryAlertReasons(entry) {
  const reasons = entry != null && typeof entry === 'object' && Array.isArray(entry.reasons) ? entry.reasons : [];
  return reasons.filter((r) => typeof r === 'string' && r.trim()).map((r) => r.trim());
}

/**
 * Splits NEPTUN alerts into oblast/raion key lists for the renderer.
 * Raion alerts inside a fully-alerted oblast are dropped — the oblast fill
 * already covers them (raion entries carry their parent oblast name in
 * `.oblast`) — unless the raion's level is higher: a red district inside a
 * yellow oblast is exactly the part of the map that must not disappear.
 * String entries have no parent info and are kept as-is.
 */
export function computeAlertKeySets(alerts = {}) {
  const oblastKeys = extractAlertKeys(alerts.oblasts);
  const oblastLevels = new Map();
  for (const entry of alerts.oblasts ?? []) {
    const key = normalizeAlertKey(entry);
    if (key) oblastLevels.set(key, maxAlertLevel(oblastLevels.get(key), entryAlertLevel(entry).level));
  }
  const raionKeys = extractAlertKeys((alerts.raions ?? []).filter((entry) => {
    const parent = entry != null && typeof entry === 'object' && !Array.isArray(entry)
      ? normalizeAlertKey(entry.oblast)
      : '';
    if (!parent || !oblastLevels.has(parent)) return true;
    return ALERT_LEVEL_RANK[entryAlertLevel(entry).level] > ALERT_LEVEL_RANK[oblastLevels.get(parent)];
  }));
  return { oblastKeys, raionKeys };
}

/**
 * Level per alerted key, for colouring the map: `{ oblastLevels, raionLevels }`,
 * each key → 'red' | 'yellow'. `levelsKnown` is false when no entry carried a
 * level at all, so the legend can say "Тривога" instead of claiming a colour.
 */
export function computeAlertLevels(alerts = {}) {
  let levelsKnown = false;
  const collect = (entries) => {
    const out = {};
    for (const entry of entries ?? []) {
      const key = normalizeAlertKey(entry);
      if (!key) continue;
      const { level, known } = entryAlertLevel(entry);
      if (known) levelsKnown = true;
      out[key] = maxAlertLevel(out[key], level);
    }
    return out;
  };
  const oblastLevels = collect(alerts.oblasts);
  const raionLevels = collect(alerts.raions);
  return { oblastLevels, raionLevels, levelsKnown };
}

// ── Area-only tracks ──────────────────────────────────────────────────────────
// `areaOnly: true` means the sources named an oblast and nothing more («Ракета
// на Одеську область»). NEPTUN still sends lat/lon, but it is the oblast's
// centroid — where to put a label, not where anyone saw anything. Read as a
// position it became "БпЛА у регіоні" for Запоріжжя off a Dnipropetrovsk
// warning and "~111 км на схід" for Кривий Ріг: invented facts. So an
// area-only track is matched to regions by the oblast it names, and gets no
// distance, direction, course, trail or marker.

export function isAreaOnly(threat) {
  return threat != null && typeof threat === 'object' && threat.areaOnly === true;
}

/**
 * How many objects one track stands for: a «Група БпЛА (5+)» is one marker and
 * five drones. `count` absent or 0 means "not stated", i.e. one.
 */
export function groupSize(threat) {
  const n = Number(threat?.count);
  return Number.isFinite(n) && n >= 1 ? Math.floor(n) : 1;
}

// ── Advisory vs tracked object ────────────────────────────────────────────────
// NEPTUN reuses the threat types for two different things. A `ballistic` entry
// titled «Балістична загроза» (or a `mig31k` entry with `advisory: true`) is a
// warning that something *may* be used — "channels report a ballistic risk for
// the night" — while a «Крилата ракета» with a trail is an object being
// tracked. Read as a tracked object, an advisory becomes "балістика
// наближається, ~40 км" for a missile nobody has launched: the exact false alarm
// the operator reported. So the distinction is made once, here, and every
// caption and notification phrases the two differently.

const ADVISORY_TITLE_RE = /загроз|ризик|попередж|ймовірн/iu;
const ADVISORY_EXPLANATION_RE = /загроз|ймовірн|можлив|очіку/iu;
const TRACKED_EXPLANATION_RE = /пуск|зафіксовано|курсом|підтверджень/iu;

/**
 * @returns {'advisory'|'tracked'}
 */
export function threatNature(threat) {
  if (!threat || typeof threat !== 'object') return 'tracked';
  if (threat.advisory === true) return 'advisory';
  if (threat.advisory === false) return 'tracked';
  const type = String(threat.type ?? '').toLowerCase();
  // A MiG-31K on the map is never "over" anyone in Ukraine — the aircraft is
  // the carrier; the marker means "it took off, Kinzhal risk countrywide".
  if (type === 'mig31k') return 'advisory';
  if (ADVISORY_TITLE_RE.test(String(threat.title ?? ''))) return 'advisory';
  const explanation = String(threat.explanationShort ?? '');
  if (ADVISORY_EXPLANATION_RE.test(explanation) && !TRACKED_EXPLANATION_RE.test(explanation)) {
    return 'advisory';
  }
  return 'tracked';
}

/** Ukrainian label for an advisory of a given type — "Загроза балістики", not "Балістика". */
export const ADVISORY_LABELS_UA = {
  ballistic: 'Загроза балістики',
  missile:   'Загроза ракетного удару',
  kab:       'Загроза КАБ',
  mig31k:    'Зліт МіГ-31К',
  uav:       'Загроза БпЛА',
  fpv:       'Загроза FPV-дронів',
};

export function advisoryLabel(type) {
  const key = String(type ?? '').toLowerCase();
  return ADVISORY_LABELS_UA[key] ?? `Загроза: ${THREAT_NAMES_UA[key] ?? key}`;
}

/** Display name that already says whether this is a warning or a tracked object. */
export function threatDisplayName(threat) {
  const type = String(threat?.type ?? 'unknown').toLowerCase();
  if (threatNature(threat) === 'advisory') return advisoryLabel(type);
  return THREAT_NAMES_UA[type] ?? (threat?.title || type);
}
