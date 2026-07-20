/**
 * Resolves Ukrainian region/city names (in any common grammatical case) from
 * free-form chat text like "тривога в Києві" or "чому тривога в київській області".
 *
 * Matching is prefix-based: every region carries a list of lowercase prefixes
 * covering its declensions ("києв" matches "Києві"/"Києва", "київськ" matches
 * "київській"/"київської"…). The longest matching prefix wins; city-vs-oblast
 * ties (e.g. "донецьк" the city vs "донецька" the oblast) are broken by the
 * word "область" or an adjective ending ("-ій") in the query.
 */

// ── Oblast definitions (GeoJSON `properties.key` values) ─────────────────────

const OBLAST_EXTRA_PREFIXES = {
  'вінницька':          ['вінниччин', 'винницк'],
  'волинська':          ['волин'],
  'дніпропетровська':   ['дніпропетровщин', 'днепропетровск'],
  'донецька':           ['донеччин', 'донецк'],
  'житомирська':        ['житомирщин'],
  'закарпатська':       ['закарпатт', 'закарпать'],
  'запорізька':         ['запоріжчин', 'запорожск'],
  'івано-франківська':  ['франківськ', 'прикарпатт'],
  'кіровоградська':     ['кіровоградщин'],
  'луганська':          ['луганщин'],
  'львівська':          ['львівщин', 'львовск'],
  'миколаївська':       ['миколаївщин', 'николаевск'],
  'одеська':            ['одещин', 'одесск'],
  'полтавська':         ['полтавщин'],
  'рівненська':         ['рівненщин', 'ровенск'],
  'сумська':            ['сумщин'],
  'тернопільська':      ['тернопільщин'],
  'харківська':         ['харківщин', 'харьковск'],
  'хмельницька':        ['хмельниччин'],
  'черкаська':          ['черкащин'],
  'чернівецька':        ['буковин'],
  'чернігівська':       ['чернігівщин', 'черниговск'],
  'херсонська':         ['херсонщин'],
  'київська':           ['київщин', 'киевск'],
};

const ADJECTIVE_OBLAST_KEYS = Object.keys(OBLAST_EXTRA_PREFIXES);

const capitalizeWords = (s) =>
  s.replace(/(^|[\s\-])([а-яґєіїa-z])/g, (m, sep, ch) => sep + ch.toUpperCase());

const OBLAST_DEFS = [
  ...ADJECTIVE_OBLAST_KEYS.map((geoKey) => ({
    kind: 'oblast',
    geoKey,
    name: `${capitalizeWords(geoKey)} область`,
    // "київська" → prefix "київськ" covers every adjective declension
    prefixes: [geoKey.slice(0, -1), ...(OBLAST_EXTRA_PREFIXES[geoKey] ?? [])],
  })),
  {
    kind: 'oblast',
    geoKey: 'автономна республіка крим',
    name: 'АР Крим',
    // NB: no bare "автономн" / "арк" prefixes — they'd hijack everyday words
    // ("в автономному режимі", "в арках"); the suffix guard can't catch those.
    prefixes: ['крим', 'ар крим', 'автономна республіка', 'автономній республіці'],
  },
];

// ── City definitions ──────────────────────────────────────────────────────────
// oblastGeoKey — parent oblast (for "вся область" alert checks and context);
// raionKey    — the city's raion in raions.geojson (raion-level alert checks);
// alertKey    — set when the city is its own oblast-level alert unit (Київ, Севастополь).

const CITY_DEFS = [
  { name: 'Київ', lat: 50.4501, lon: 30.5234, radiusKm: 65, oblastGeoKey: 'м. київ', raionKey: null, alertKey: 'м. київ', prefixes: ['київ', 'києв', 'киев'] },
  { name: 'Харків', lat: 49.9935, lon: 36.2304, radiusKm: 55, oblastGeoKey: 'харківська', raionKey: 'харківський', prefixes: ['харків', 'харков', 'харьков'] },
  { name: 'Одеса', lat: 46.4825, lon: 30.7233, radiusKm: 55, oblastGeoKey: 'одеська', raionKey: 'одеський', prefixes: ['одес'] },
  { name: 'Дніпро', lat: 48.4647, lon: 35.0462, radiusKm: 55, oblastGeoKey: 'дніпропетровська', raionKey: 'дніпровський', prefixes: ['дніпр', 'днепр'] },
  { name: 'Запоріжжя', lat: 47.8388, lon: 35.1396, radiusKm: 55, oblastGeoKey: 'запорізька', raionKey: 'запорізький', prefixes: ['запоріж', 'запорож'] },
  { name: 'Львів', lat: 49.8397, lon: 24.0297, radiusKm: 50, oblastGeoKey: 'львівська', raionKey: 'львівський', prefixes: ['львів', 'львов'] },
  { name: 'Миколаїв', lat: 46.975, lon: 31.9946, radiusKm: 50, oblastGeoKey: 'миколаївська', raionKey: 'миколаївський', prefixes: ['миколаїв', 'миколаєв', 'николаев'] },
  { name: 'Маріуполь', lat: 47.0971, lon: 37.5434, radiusKm: 50, oblastGeoKey: 'донецька', raionKey: 'маріупольський', prefixes: ['маріупол', 'мариупол'] },
  { name: 'Донецьк', lat: 48.0159, lon: 37.8028, radiusKm: 50, oblastGeoKey: 'донецька', raionKey: 'донецький', prefixes: ['донецьк', 'донецк'] },
  { name: 'Луганськ', lat: 48.574, lon: 39.3078, radiusKm: 50, oblastGeoKey: 'луганська', raionKey: 'луганський', prefixes: ['луганськ', 'луганск'] },
  { name: 'Херсон', lat: 46.6354, lon: 32.6169, radiusKm: 50, oblastGeoKey: 'херсонська', raionKey: 'херсонський', prefixes: ['херсон'] },
  { name: 'Полтава', lat: 49.5883, lon: 34.5514, radiusKm: 50, oblastGeoKey: 'полтавська', raionKey: 'полтавський', prefixes: ['полтав'] },
  { name: 'Суми', lat: 50.9077, lon: 34.7981, radiusKm: 50, oblastGeoKey: 'сумська', raionKey: 'сумський', prefixes: ['суми', 'сумах'] },
  { name: 'Чернігів', lat: 51.4982, lon: 31.2893, radiusKm: 50, oblastGeoKey: 'чернігівська', raionKey: 'чернігівський', prefixes: ['чернігів', 'чернігов', 'чернигов'] },
  { name: 'Черкаси', lat: 49.4444, lon: 32.0598, radiusKm: 50, oblastGeoKey: 'черкаська', raionKey: 'черкаський', prefixes: ['черкас'] },
  { name: 'Житомир', lat: 50.2547, lon: 28.6587, radiusKm: 50, oblastGeoKey: 'житомирська', raionKey: 'житомирський', prefixes: ['житомир'] },
  { name: 'Вінниця', lat: 49.2331, lon: 28.4682, radiusKm: 50, oblastGeoKey: 'вінницька', raionKey: 'вінницький', prefixes: ['вінниц', 'винниц'] },
  { name: 'Кропивницький', lat: 48.5079, lon: 32.2623, radiusKm: 50, oblastGeoKey: 'кіровоградська', raionKey: 'кропивницький', prefixes: ['кропивницьк', 'кіровоград'] },
  { name: 'Рівне', lat: 50.6199, lon: 26.2516, radiusKm: 50, oblastGeoKey: 'рівненська', raionKey: 'рівненський', prefixes: ['рівне', 'рівном', 'ровно'] },
  { name: 'Луцьк', lat: 50.7472, lon: 25.3254, radiusKm: 45, oblastGeoKey: 'волинська', raionKey: 'луцький', prefixes: ['луцьк', 'луцк'] },
  { name: 'Тернопіль', lat: 49.5535, lon: 25.5948, radiusKm: 45, oblastGeoKey: 'тернопільська', raionKey: 'тернопільський', prefixes: ['тернопіл', 'тернопол'] },
  { name: 'Хмельницький', lat: 49.4229, lon: 26.9871, radiusKm: 45, oblastGeoKey: 'хмельницька', raionKey: 'хмельницький', prefixes: ['хмельницьк'] },
  { name: 'Ужгород', lat: 48.6208, lon: 22.2879, radiusKm: 45, oblastGeoKey: 'закарпатська', raionKey: 'ужгородський', prefixes: ['ужгород'] },
  { name: 'Івано-Франківськ', lat: 48.9226, lon: 24.7111, radiusKm: 45, oblastGeoKey: 'івано-франківська', raionKey: 'івано-франківський', prefixes: ['івано-франківськ', 'франківськ'] },
  { name: 'Чернівці', lat: 48.2921, lon: 25.9358, radiusKm: 45, oblastGeoKey: 'чернівецька', raionKey: 'чернівецький', prefixes: ['чернівц', 'черновц'] },
  { name: 'Кривий Ріг', lat: 47.9105, lon: 33.3918, radiusKm: 45, oblastGeoKey: 'дніпропетровська', raionKey: 'криворізький', prefixes: ['кривий ріг', 'кривому роз', 'кривого рог', 'криворіж', 'кривой рог'] },
  { name: 'Кременчук', lat: 49.067, lon: 33.4204, radiusKm: 45, oblastGeoKey: 'полтавська', raionKey: 'кременчуцький', prefixes: ['кременчу'] },
  { name: 'Біла Церква', lat: 49.7956, lon: 30.131, radiusKm: 45, oblastGeoKey: 'київська', raionKey: 'білоцерківський', prefixes: ['біла церк', 'білій церк', 'білоцерків', 'белая церк'] },
  { name: 'Севастополь', lat: 44.6166, lon: 33.5254, radiusKm: 45, oblastGeoKey: 'севастополь', raionKey: null, alertKey: 'севастополь', prefixes: ['севастопол'] },
  { name: 'Сімферополь', lat: 44.9521, lon: 34.1024, radiusKm: 45, oblastGeoKey: 'автономна республіка крим', raionKey: 'сімферопольський', prefixes: ['сімферопол', 'симферопол'] },
].map((c) => ({ kind: 'city', ...c }));

const COUNTRY_DEF = { kind: 'country', prefixes: ['україн', 'украин', 'вся країна', 'всій країні'] };

const ALL_DEFS = [...OBLAST_DEFS, ...CITY_DEFS, COUNTRY_DEF];

// ── Text normalisation ────────────────────────────────────────────────────────

const normalizeText = (raw) =>
  String(raw ?? '')
    .normalize('NFC')
    .toLowerCase()
    .replace(/[’ʼ`´]/g, "'")
    .replace(/\s+/g, ' ')
    .trim();

/** Strips leading prepositions / "місто" markers from a region phrase. */
const cleanRegionText = (raw) =>
  normalizeText(raw)
    .replace(/^(?:(?:в|у|на|по)\s+)?(?:місті|місто|м\.|смт)\s*/u, '')
    .replace(/^(?:в|у|на|по)\s+/u, '')
    .replace(/[?!.,;:]+$/u, '')
    .trim();

const TRAILING_STOPWORDS = new Set([
  'зараз', 'сьогодні', 'вночі', 'знову', 'досі', 'ще', 'вже', 'і', 'чи', 'а', 'це', 'там', 'таки', 'бот',
]);

const trimRegionPhrase = (raw) => {
  let tokens = cleanRegionText(raw).split(' ').filter(Boolean).slice(0, 4);
  while (tokens.length && TRAILING_STOPWORDS.has(tokens[tokens.length - 1])) tokens.pop();
  return tokens.join(' ');
};

// ── Query parsing ─────────────────────────────────────────────────────────────

const REGION_CHARS = "[а-яґєії'\\-\\.\\s]";

/**
 * Detects "тривога в <регіон>" queries (optionally prefixed with "чому").
 * Returns { why: boolean, regionText: string } or null when the message has
 * no region-scoped alert query. Word order "чому в <регіон> тривога" is also
 * supported.
 */
export function parseRegionQuery(text) {
  const norm = normalizeText(text);
  if (!norm.includes('тривог')) return null;

  // NB: JS `\b` is ASCII-only and never matches around Cyrillic words —
  // use lookarounds / explicit whitespace instead.
  const why = /(?<![а-яґєіїa-z])(?:чому|чого|почему)(?![а-яґєіїa-z])/u.test(norm);

  let match = norm.match(new RegExp(`тривог\\S*\\s+(?:в|у|на|по)\\s+(${REGION_CHARS}{2,60})`, 'u'));
  let regionText = match?.[1];

  if (!regionText) {
    match = norm.match(new RegExp(`(?:^|\\s)(?:в|у|на|по)\\s+(${REGION_CHARS}{2,60}?)\\s+тривог`, 'u'));
    regionText = match?.[1];
  }

  if (!regionText) return null;

  const trimmed = trimRegionPhrase(regionText);
  if (!trimmed) return null;

  return { why, regionText: trimmed };
}

// ── Region resolution ─────────────────────────────────────────────────────────

/**
 * A prefix match is only valid when the rest of the token it ends in looks
 * like a Ukrainian inflectional ending (short, vowels + в/г/ж/й/м/н/х/ь).
 * This is what stops "кримінальному" from resolving to Crimea while still
 * accepting "криму", "києві", "київській", "запоріжжі", "донецького" etc.
 */
const isValidPrefixMatch = (text, prefix) => {
  const tokenRemainder = text.slice(prefix.length).match(/^\S*/u)[0];
  if (tokenRemainder.length > 4) return false;
  return /^[аеєиіїоуюявгжймнхь']*$/u.test(tokenRemainder);
};

const isOblastish = (regionText) => {
  if (/област|обл(?![а-яґєіїa-z])/u.test(regionText)) return true;
  const firstToken = regionText.split(' ')[0] ?? '';
  return /(?:ій|їй|ої|ою)$/u.test(firstToken);
};

const toRegion = (def) => {
  if (def.kind === 'oblast') {
    return { kind: 'oblast', geoKey: def.geoKey, name: def.name, cacheKey: `o:${def.geoKey}` };
  }
  if (def.kind === 'city') {
    return {
      kind: 'city',
      name: def.name,
      lat: def.lat,
      lon: def.lon,
      radiusKm: def.radiusKm,
      oblastGeoKey: def.oblastGeoKey ?? null,
      raionKey: def.raionKey ?? null,
      alertKey: def.alertKey ?? null,
      cacheKey: `c:${def.name.toLowerCase()}`,
    };
  }
  return { kind: 'country', cacheKey: 'country' };
};

/**
 * Resolves a region phrase ("києві", "київській області", "харківщині",
 * "ар крим"…) to a region descriptor, or null when nothing matches.
 */
export function resolveRegion(rawText) {
  const text = cleanRegionText(rawText);
  if (!text) return null;

  const matches = [];
  for (const def of ALL_DEFS) {
    for (const prefix of def.prefixes) {
      if (text.startsWith(prefix) && isValidPrefixMatch(text, prefix)) {
        matches.push({ def, len: prefix.length });
      }
    }
  }
  if (!matches.length) return null;

  const maxLen = Math.max(...matches.map((m) => m.len));
  const top = matches.filter((m) => m.len === maxLen);

  let winner = top[0].def;
  if (top.length > 1) {
    const oblast = top.find((m) => m.def.kind === 'oblast');
    const city = top.find((m) => m.def.kind === 'city');
    if (oblast && city) winner = isOblastish(text) ? oblast.def : city.def;
  } else if (winner.kind === 'city' && isOblastish(text)) {
    // e.g. "харківській області" where only the city prefix matched the query —
    // prefer the city's parent oblast when the phrase is clearly об adjective.
    const parent = OBLAST_DEFS.find((o) => o.geoKey === winner.oblastGeoKey && o.geoKey !== 'м. київ');
    if (parent && winner.alertKey == null) winner = parent;
  }

  return toRegion(winner);
}

export const __testables = {
  cleanRegionText,
  trimRegionPhrase,
  isOblastish,
  isValidPrefixMatch,
  OBLAST_DEFS,
  CITY_DEFS,
};

/**
 * Reverses a descriptor's cacheKey back into the descriptor.
 *
 * Inline-keyboard callbacks can only carry 64 bytes, so a button ships the
 * cacheKey and the handler resolves it here rather than round-tripping the
 * user's original phrasing.
 */
export function regionFromCacheKey(cacheKey) {
  const key = String(cacheKey ?? '');
  for (const def of ALL_DEFS) {
    if (def.kind === 'country') continue;
    const region = toRegion(def);
    if (region.cacheKey === key) return region;
  }
  return null;
}
