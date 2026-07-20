import { GoogleGenerativeAI } from '@google/generative-ai';

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

  const genAI = new GoogleGenerativeAI(apiKey);
  const model = genAI.getGenerativeModel({ model: GEMINI_MODEL });

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

  try {
    const result = await model.generateContent(prompt);
    recordOk();
    return result.response.text().trim();
  } catch (err) {
    recordFailure(err);
    throw err;
  }
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

  const genAI = new GoogleGenerativeAI(apiKey);
  const model = genAI.getGenerativeModel({ model: GEMINI_MODEL });
  const prompt = buildRegionPrompt({ userQuery, regionName, regionReport, channelMessages });
  try {
    const result = await model.generateContent(prompt);
    recordOk();
    return result.response.text().trim();
  } catch (err) {
    recordFailure(err);
    throw err;
  }
}
