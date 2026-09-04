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

/**
 * Splits NEPTUN alerts into oblast/raion key lists for the renderer.
 * Raion alerts inside a fully-alerted oblast are dropped — the strong red
 * oblast fill already covers them (raion entries carry their parent oblast
 * name in `.oblast`). String entries have no parent info and are kept as-is.
 */
export function computeAlertKeySets(alerts = {}) {
  const oblastKeys = extractAlertKeys(alerts.oblasts);
  const oblastKeySet = new Set(oblastKeys);
  const raionKeys = extractAlertKeys((alerts.raions ?? []).filter((entry) => {
    const parent = entry != null && typeof entry === 'object' && !Array.isArray(entry)
      ? normalizeAlertKey(entry.oblast)
      : '';
    return !(parent && oblastKeySet.has(parent));
  }));
  return { oblastKeys, raionKeys };
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
