import { GoogleGenerativeAI } from '@google/generative-ai';

const GEMINI_MODEL = 'gemini-3.5-flash';

// Channels whose messages are fetched and analysed together.
// Add or remove public Telegram channel usernames here.
export const ALERT_CHANNELS = ['kpszsu'];

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

  const result = await model.generateContent(prompt);
  return result.response.text().trim();
}
