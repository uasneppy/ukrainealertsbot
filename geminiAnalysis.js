import { GoogleGenAI } from '@google/genai';

const GEMINI_MODEL = 'gemini-3.5-flash';

/**
 * Both callers fall back gracefully when Gemini fails, which is right for the
 * user and terrible for the operator: a key that stopped working, or a model
 * name that 404s, looks exactly like "the AI had nothing to add" forever.
 * /status reads this so the degradation is visible.
 */
const _health = { lastOkAt: 0, lastFailAt: 0, lastError: '', calls: 0, failures: 0 };

export function getAiHealth() {
  return {
    configured: Boolean(process.env.GEMINI_API_KEY),
    model: GEMINI_MODEL,
    ..._health,
  };
}

function recordOk() {
  _health.calls += 1;
  _health.lastOkAt = Date.now();
}

/**
 * One call path for both prompts, so health tracking can't drift between them.
 * The @google/genai client returns the text directly rather than through a
 * response wrapper — the older @google/generative-ai shape was
 * `result.response.text()`.
 */
async function generate(apiKey, prompt) {
  try {
    const ai = new GoogleGenAI({ apiKey });
    const result = await ai.models.generateContent({
      model: GEMINI_MODEL,
      contents: prompt,
    });
    const text = typeof result?.text === 'string' ? result.text : String(result?.text ?? '');
    if (!text.trim()) throw new Error('Gemini returned an empty response');
    recordOk();
    return text.trim();
  } catch (err) {
    recordFailure(err);
    throw err;
  }
}

function recordFailure(err) {
  _health.calls += 1;
  _health.failures += 1;
  _health.lastFailAt = Date.now();
  _health.lastError = String(err?.message ?? err).slice(0, 200);
}

/**
 * Takes an array of plain-text channel messages and asks Gemini to identify
 * which cities / regions are at risk and why.
 *
 * @param {string[]} messages  Cleaned message strings, newest first.
 * @returns {Promise<string>}  Ukrainian-language analysis from Gemini.
 */
export async function analyzeAlertMessages(messages) {
  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) throw new Error('GEMINI_API_KEY is required');

  if (!messages.length) return 'Немає повідомлень для аналізу.';

  const messagesText = messages.map((m, i) => `${i + 1}. ${m}`).join('\n\n');

  const prompt = `Ти аналізуєш офіційні повідомлення про повітряні тривоги в Україні.

Ось останні ${messages.length} повідомлень з каналу повітряної оборони (від найновіших до найстаріших):

${messagesText}

Завдання — сформуй стислий підсумок для Telegram-чату. Використовуй лише звичайний текст із символами • та emoji. Жодного markdown (**зірочки**, __підкреслення__ тощо) — вони не відображаються коректно.

Структура відповіді (використовуй точно такий формат):

🔴 Під загрозою:
• [регіон / місто — тип загрози та напрямок, якщо відомо]
• ...

⚡ Тип загрози:
• [коротко: дрони, ракети, КАБи, авіація — звідки]

📢 Відбій: [оголошено / не оголошено]

Якщо якихось даних немає — пропусти відповідний розділ. Відповідай українською, коротко і по суті.`;

  return generate(apiKey, prompt);
}

/**
 * Builds the prompt for a region-scoped "чому тривога в X" question.
 * Exported separately so it can be unit-tested without an API key.
 */
export function buildRegionPrompt({ userQuery, regionName, regionReport, channelMessages = [] }) {
  const numbered = (channelMessages ?? [])
    .slice(0, 15)
    .map((m, i) => `${i + 1}. ${String(m).slice(0, 400)}`)
    .join('\n\n');
  const channelBlock = numbered
    ? `Останні повідомлення каналу Повітряних сил (@kpszsu), від найновіших до найстаріших:\n\n${numbered}`
    : 'Повідомлення каналу Повітряних сил зараз недоступні.';

  return `Ти — асистент з моніторингу повітряних тривог в Україні. Користувач запитав: «${userQuery}»
Регіон запиту: ${regionName}.

Актуальні дані радара загроз NEPTUN (оновлюються наживо):
${regionReport}

${channelBlock}

Дай відповідь САМЕ на запитання користувача щодо регіону «${regionName}»:
- Якщо тривога активна — поясни ймовірну причину: які загрози зафіксовані в регіоні чи прямують до нього (тип, звідки, напрямок), спираючись передусім на дані NEPTUN та повідомлення Повітряних сил.
- Якщо тривоги немає — так і скажи; коротко згадай найближчі загрози, лише якщо вони можуть стосуватися регіону.
- Не вигадуй: якщо про регіон немає підтверджених даних — скажи, що точна причина з наявних джерел не відома.

Формат: звичайний текст без markdown (без зірочок і підкреслень), до 100 слів, можна emoji та символ •. Відповідай українською.`;
}

/**
 * Region-scoped Gemini analysis for "чому тривога в <регіон>" queries.
 * Answers the user's exact question using live NEPTUN facts + channel posts.
 */
export async function analyzeRegionQuery({ userQuery, regionName, regionReport, channelMessages }) {
  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) throw new Error('GEMINI_API_KEY is required');

  const prompt = buildRegionPrompt({ userQuery, regionName, regionReport, channelMessages });
  return generate(apiKey, prompt);
}

/**
 * Builds the prompt for the night digest. `factsText` is describeNightFacts()
 * from neptun/nightDigest.js: NEPTUN tallies first, then the channel posts.
 * The rules are the whole point — the posts are terse, slangy and sometimes
 * contradictory, and the model must summarise them, not improve on them.
 */
export function buildNightPrompt({ regionName, factsText }) {
  return `Ти — асистент з моніторингу повітряних загроз в Україні. Склади короткий підсумок ночі для регіону «${regionName}» для Telegram-чату.

Вхідні дані (лише вони; нічого поза ними не існує):

${factsText}

Правила:
- Спирайся ТІЛЬКИ на наведені дані. Не вигадуй цілей, кількостей, часу чи напрямків. Якщо чогось у даних немає — пропусти або напиши «невідомо».
- Кількості з NEPTUN — це треки, не підтверджені цілі; кількості з каналів — «за повідомленнями». Так і пиши.
- Повідомлення каналів — це заяви, часто уривчасті («наче мінус», «курс північ»). Узагальнюй їх, не переказуй дослівно; якщо вони суперечать одне одному — скажи, що дані розходяться.
- Час — київський, у форматі ГГ:ХХ.
- Без markdown (жодних зірочок чи підкреслень), звичайний текст, emoji та • дозволені. До 120 слів.

Формат:
🌙 ${regionName} — за ніч
• Що летіло: [типи та кількості над регіоном / поблизу, з приблизним часом]
• Пуски та події: [пуски БпЛА з кількістю, зліт авіації, балістика, «Калібри» — з часом]
• Зараз: [одним реченням, що каже останнє повідомлення або NEPTUN]`;
}

/** Night digest from Gemini; throws without a key or on API failure. */
export async function analyzeNightDigest({ regionName, factsText }) {
  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) throw new Error('GEMINI_API_KEY is required');
  return generate(apiKey, buildNightPrompt({ regionName, factsText }));
}
