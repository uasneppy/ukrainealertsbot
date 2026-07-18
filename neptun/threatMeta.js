/**
 * Shared threat metadata + NEPTUN alert-key normalisation.
 * Kept dependency-free so both the map renderer and the region context
 * helpers can import it without cycles.
 */

export const THREAT_COLORS = {
  missile:   '#ff4444',
  ballistic: '#cc0000',
  uav:       '#ff8c00',
  fpv:       '#ff4fa3',
  recon:     '#ffd700',
  kab:       '#bb00ff',
  mig31k:    '#ff6600',
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
