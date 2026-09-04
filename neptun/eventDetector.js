/**
 * Turns a monitoring-channel message into nationwide threat events.
 *
 * "Strategic aviation took off", "Kalibr carriers put to sea", "MiG-31K in the
 * air" and "≈30 Shaheds launched" are not on the NEPTUN threat map — they are
 * sentences in the Air Force channel and the intelligence channels NEPTUN
 * aggregates (/api/v1/messages). This module is the only place that reads
 * those sentences, and it is pure so every phrasing that ever fooled it can be
 * pinned in a test.
 *
 * It is deliberately conservative. A missed take-off costs little: the siren
 * that follows is announced anyway. A false "Kalibr launched" at 3 a.m. costs
 * the bot its credibility, and a muted bot warns nobody. So each sentence is
 * judged on its own (a negation in one must not cancel a take-off in the
 * next), a sentence that negates or retracts is dropped whole, and a subject
 * without a verb ("Ту-95 на аеродромі Оленья") is not an event.
 */

// Ukrainian keywords accept a Latin "i" inside Cyrillic words — channels type
// it often enough — and the Russian spellings the hyperlocal channels use.
const I = '[іi]';
const B = '(?<![а-яіїєґa-z])'; // word start; JS \b is ASCII-only

const re = (s) => new RegExp(s, 'iu');

const SUBJECT = {
  strategic: re(`${B}(?:стратег${I}чн|стратегическ|ту[\\s-]?95|ту[\\s-]?160|ту[\\s-]?22|оленья|оленьї|енгельс|шайковк|моздок|дягілев)`),
  mig31k:    re(`${B}(?:м${I}г|миг|mig)[\\s-]?31|${B}кинджал|${B}кинжал|${B}kinzhal`),
  kinzhal:   re(`${B}кинджал|${B}кинжал|${B}kinzhal`),
  kalibr:    re(`${B}кал${I}бр|${B}kalibr|нос${I}${I}?[вй]? .{0,40}мор|мор.{0,40}нос${I}${I}?`),
  ballistic: re(`${B}бал${I}ст|${B}баллист|${B}${I}скандер|${B}кн[\\s-]?23|швидк${I}сн[аі]? ц${I}л|скоростн[аяые]+ цел`),
  cruise:    re(`${B}крилат|${B}крылат|${B}кр${B}|${B}х[\\s-]?(?:101|555|59|22|32|69)`),
  uav:       re(`${B}(?:бпла|бпак|шахед|герань|геран|дрон|мопед|ударн(?:і|их|ые|ых)|реактивн)`),
};

// Verbs. "активність" counts only for aircraft: "активність дрона" is a
// hyperlocal channel narrating a drone that is already here, not a launch.
const LAUNCH_RE   = re(`${B}(?:за)?пуск|${B}старт(?:ув|ов|$)|${B}в${I}дстр${I}л|${B}запущен|${B}випущен|${B}выпущен`);
const TAKEOFF_RE  = re(`${B}зл${I}т|${B}зльот|${B}зл${I}та|${B}злет${I}л|${B}взлет|${B}взлёт|${B}п${I}дн(?:ял|ят)|${B}поднял|${B}вил${I}т|${B}вылет|у? ?пов${I}тр${I}|в воздухе`);
const AIRCRAFT_ACTIVITY_RE = re(`${B}активн${I}сть|${B}активность`);
const AT_SEA_RE   = re(`${B}вийш|${B}вихід|${B}вывед|${B}вывел|${B}вышл|${B}вивед|${B}вивел|${B}у мор|${B}в мор|${B}на бойов`);
const THREAT_RE   = re(`${B}загроз|${B}угроз|${B}ризик|${B}риск|${B}можлив|${B}ймов${I}рн|${B}вероятн|${B}не виключ`);
const COURSE_RE   = re(`${B}курс|${B}на (?:київ|ки[їі]в|одес|дн${I}пр|харк${I}в|запор|микола|льв${I}в|полтав|черн|суми|житомир|в${I}нниц|кременчу|кривий)`);

// A sentence that says it did NOT happen, or that it is over, is dropped whole.
const NEGATION_RE = re(`${B}не (?:заф${I}ксов|було|п${I}дтвердж|спостер|зазнач|фиксир|было|подтвержд)|${B}без (?:за)?пуск|в${I}дсутн|отсутств|спростов|опроверг|фейк|${B}минул|${B}знят|${B}в${I}дб${I}й|${B}отбой|скасов|отмен|${B}зак${I}нч|${B}заверш|${B}посадк|${B}приземл|${B}с${I}в на|${B}сели на|${B}сіли на|${B}повернул|${B}вернул`);

const SENTENCE_SPLIT_RE = /[.!?\n]+|(?<=\S)\s+[—–-]\s+(?=[А-ЯІЇЄҐ])/u;

/** Per-kind metadata: which chat category it belongs to, and how it is titled. */
export const EVENT_KINDS = Object.freeze({
  strategic_takeoff: { category: 'strategic', emoji: '✈️', title: 'Зліт стратегічної авіації' },
  cruise_launch:     { category: 'strategic', emoji: '🚀', title: 'Пуски крилатих ракет' },
  kalibr_carriers:   { category: 'kalibr',    emoji: '🚢', title: 'Носії «Калібрів» у морі' },
  kalibr_launch:     { category: 'kalibr',    emoji: '🚀', title: 'Пуски «Калібрів»' },
  mig31k_takeoff:    { category: 'mig31k',    emoji: '🛩', title: 'Зліт МіГ-31К — загроза «Кинджалів»' },
  kinzhal_launch:    { category: 'mig31k',    emoji: '💥', title: 'Пуск «Кинджалів»' },
  ballistic_threat:  { category: 'ballistic', emoji: '⚠️', title: 'Загроза балістики' },
  ballistic_launch:  { category: 'ballistic', emoji: '💥', title: 'Пуск балістики' },
  uav_launch:        { category: 'uav',       emoji: '🛵', title: 'Пуски ударних БпЛА' },
});

const WORD_NUMBERS = {
  пара: 2, два: 2, дві: 2, двох: 2, три: 3, трьох: 3, чотири: 4, чотирьох: 4,
  "п'ять": 5, "п'яти": 5, шість: 6, шести: 6, сім: 7, семи: 7, вісім: 8, восьми: 8,
  "дев'ять": 9, десять: 10, десяти: 10, дюжин: 12,
};

// Designations ("Ту-95МС", "Х-101", "МіГ-31К", "Шахед-136") carry digits that
// are not counts. Strip them before looking for a number. No whitespace in
// the separator: "орієнтовно 30" is a count, not a model.
const DESIGNATION_RE = /[а-яіїєґa-z]+-?\d{2,3}[а-яіїєґa-z]*/giu;
const COUNT_UNIT_RE = /(\d{1,3})\s*(?:[хx×]\s*)?(?:шт|од\b|од\.|одиниц|борт|літак|самолет|шахед|бпла|дрон|ракет|калібр|кинджал|міг|ту\b|носі|пуск)/iu;
const COUNT_APPROX_RE = /(?:~|≈|близько|орієнтовно|приблизно|до|понад|більше|около|более|порядка)\s*(\d{1,3})\b(?!\s*(?:км|хв|год|%|:))/iu;
const COUNT_PLUS_RE = /(\d{1,3})\s*\+/u;
const COUNT_TIMES_RE = /(\d{1,2})\s*[хx×]\s*(?:міг|ту|су|бпла|шахед)/iu;

function extractCount(sentence) {
  // "2х МіГ-31К" — the multiplier sits right before the designation, so it
  // has to be read before the designation is stripped.
  const times = COUNT_TIMES_RE.exec(sentence);
  if (times) return Number(times[1]);
  const s = sentence.replace(DESIGNATION_RE, ' ');
  for (const r of [COUNT_UNIT_RE, COUNT_APPROX_RE, COUNT_PLUS_RE]) {
    const m = r.exec(s);
    if (m) {
      const n = Number(m[1]);
      if (n > 0 && n <= 300) return n;
    }
  }
  for (const [word, n] of Object.entries(WORD_NUMBERS)) {
    if (new RegExp(`${B}${word.replace("'", "['’ʼ]")}(?![а-яіїєґ])`, 'iu').test(s)) return n;
  }
  return null;
}

export function normalizeText(text) {
  return String(text ?? '')
    .toLowerCase()
    .replace(/[’‘ʼ`]/g, "'")
    .replace(/[«»"“”]/g, '')
    .replace(/ /g, ' ')
    .replace(/[ \t]+/g, ' ')
    .trim();
}

function detectInSentence(s) {
  if (!s || NEGATION_RE.test(s)) return [];

  const subj = Object.fromEntries(Object.entries(SUBJECT).map(([k, r]) => [k, r.test(s)]));
  const launch = LAUNCH_RE.test(s);
  const takeoff = TAKEOFF_RE.test(s);
  const activity = AIRCRAFT_ACTIVITY_RE.test(s);
  const threat = THREAT_RE.test(s);
  const kinds = new Set();

  if (subj.mig31k) {
    if (launch && (subj.kinzhal || !subj.strategic)) kinds.add('kinzhal_launch');
    else if (takeoff || activity || threat) kinds.add('mig31k_takeoff');
  }

  if (subj.strategic) {
    if (launch) kinds.add('cruise_launch');
    else if (takeoff || activity) kinds.add('strategic_takeoff');
  }

  if (subj.kalibr) {
    if (launch) kinds.add('kalibr_launch');
    else if (AT_SEA_RE.test(s) || threat) kinds.add('kalibr_carriers');
  } else if (subj.cruise && launch && !subj.strategic && !subj.mig31k) {
    // "Пуски крилатих ракет з акваторії Чорного моря" — sea-launched = Kalibr.
    kinds.add(/мор|акватор/iu.test(s) ? 'kalibr_launch' : 'cruise_launch');
  }

  if (subj.ballistic && !subj.mig31k) {
    // Any concrete report — a launch, a course, a "fast target" — is a launch;
    // only pure "загроза застосування" wording is the advisory.
    if (launch || COURSE_RE.test(s) || /швидк[іi]сн|скоростн/iu.test(s) || !threat) kinds.add('ballistic_launch');
    else kinds.add('ballistic_threat');
  }

  if (subj.uav && (launch || takeoff) && !subj.strategic && !subj.mig31k) {
    kinds.add('uav_launch');
  }

  const count = kinds.size ? extractCount(s) : null;
  return [...kinds].map((kind) => ({ kind, count, sentence: s }));
}

/**
 * @param {string} text  Raw channel message.
 * @returns {Array<{ kind: string, count: number|null, sentence: string }>}
 *          Distinct kinds in the order found; count is the first number that
 *          reads as a quantity (or null).
 */
export function detectEvents(text) {
  const norm = normalizeText(text);
  if (!norm) return [];
  const found = new Map();
  for (const raw of norm.split(SENTENCE_SPLIT_RE)) {
    const s = raw.trim();
    for (const ev of detectInSentence(s)) {
      const prev = found.get(ev.kind);
      if (!prev || (prev.count == null && ev.count != null)) found.set(ev.kind, ev);
    }
  }
  return [...found.values()];
}

// Channel boilerplate — "Підписатись", "Наш додаток", donate links — is not
// part of the warning and would be quoted into every notification.
const BOILERPLATE_LINE_RE = /підпис|подпис|зв.?язок|додаток|підтрим|поддерж|донат|t\.me\/|https?:\/\/|^\s*[✙@#]|^\s*[\p{Emoji}\s]+$/iu;

/** The message with boilerplate removed, trimmed for quoting. */
export function quoteMessage(text, maxLen = 280) {
  const lines = String(text ?? '')
    .split('\n')
    .map((l) => l.trim())
    .filter((l) => l && !BOILERPLATE_LINE_RE.test(l));
  const joined = lines.join('\n').trim();
  return joined.length > maxLen ? `${joined.slice(0, maxLen - 1).trimEnd()}…` : joined;
}

/**
 * Ukrainian text for one nationwide event. The channel's own words are quoted
 * because they carry the specifics (which airfield, how many) that a template
 * cannot, and the source is named so nobody has to take the bot's word for it.
 */
export function formatEventNotification({ kind, count = null, quote = '', channel = '', date = null }) {
  const meta = EVENT_KINDS[kind] ?? { emoji: '📡', title: kind };
  const headCount = count != null ? (kind === 'uav_launch' ? ` — ≈${count}` : ` (×${count})`) : '';
  const lines = [`${meta.emoji} ${meta.title}${headCount}`];
  if (quote) lines.push(`«${quote}»`);
  const time = date ? fmtTime(date) : '';
  const source = [channel, time].filter(Boolean).join(' · ');
  if (source) lines.push(`📡 ${source}`);
  return lines.join('\n');
}

function fmtTime(iso) {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '';
  return d.toLocaleTimeString('uk-UA', { hour: '2-digit', minute: '2-digit', timeZone: 'Europe/Kyiv' });
}
