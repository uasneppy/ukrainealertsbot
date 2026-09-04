/**
 * Per-chat notification settings: which categories of unprompted message a
 * chat wants. Stored beside subscriptions in the same volume — same reason:
 * a setting silently reset on redeploy is a chat that muted ballistics and
 * gets them again at 3 a.m., or one that wanted them and stops getting them.
 *
 * Only overrides are stored. Every category defaults to on, and a category
 * added later is on for existing chats too — a warning nobody opted out of is
 * better than one nobody knew they could opt into.
 */

import fs from 'fs/promises';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const FORMAT_VERSION = 1;

/**
 * The categories, in the order they are shown. `key` is what the code and the
 * callback payload use; everything else is the user-facing label.
 */
export const NOTIFY_CATEGORIES = Object.freeze([
  { key: 'alert',     emoji: '🔴', label: 'Тривога / відбій',      hint: 'початок і кінець тривоги у ваших регіонах' },
  { key: 'targets',   emoji: '🚀', label: 'Цілі поблизу',          hint: 'ракети та КАБи, що наближаються до регіону' },
  { key: 'ballistic', emoji: '💥', label: 'Балістика',             hint: 'загроза або пуск балістики' },
  { key: 'mig31k',    emoji: '🛩', label: 'МіГ-31К / «Кинджал»',   hint: 'зліт носіїв і пуски' },
  { key: 'strategic', emoji: '✈️', label: 'Стратегічна авіація',   hint: 'зліт Ту-95/Ту-160 і пуски крилатих ракет' },
  { key: 'kalibr',    emoji: '🚢', label: '«Калібри»',             hint: 'носії в морі та пуски' },
  { key: 'uav',       emoji: '🛵', label: 'Пуски БпЛА',            hint: 'старт ударних дронів і їх кількість' },
]);

const CATEGORY_KEYS = new Set(NOTIFY_CATEGORIES.map((c) => c.key));

export function isNotifyCategory(key) {
  return CATEGORY_KEYS.has(String(key));
}

export function getChatSettingsFile() {
  return process.env.CHAT_SETTINGS_FILE || path.join(__dirname, '..', 'data', 'chatSettings.json');
}

/** chatId (string) → { [category]: false } — overrides only. */
let _chats = new Map();
let _writeChain = Promise.resolve();

function persist() {
  const snapshot = JSON.stringify(
    { version: FORMAT_VERSION, chats: Object.fromEntries(_chats) },
    null,
    2
  );
  const file = getChatSettingsFile();
  _writeChain = _writeChain
    .then(async () => {
      const tmp = `${file}.tmp`;
      await fs.mkdir(path.dirname(file), { recursive: true });
      await fs.writeFile(tmp, snapshot, 'utf8');
      await fs.rename(tmp, file);
    })
    .catch((err) => {
      console.error('[chat-settings] Failed to persist:', err?.message ?? err);
    });
  return _writeChain;
}

export function flushChatSettings() {
  return _writeChain;
}

/** Resets in-memory state (tests only). */
export function __resetChatSettings() {
  _chats = new Map();
  _writeChain = Promise.resolve();
}

export async function loadChatSettings() {
  try {
    const raw = await fs.readFile(getChatSettingsFile(), 'utf8');
    const data = JSON.parse(raw);
    for (const [chatId, overrides] of Object.entries(data?.chats ?? {})) {
      const entries = Object.entries(overrides ?? {}).filter(
        ([key, value]) => CATEGORY_KEYS.has(key) && value === false
      );
      if (entries.length) _chats.set(String(chatId), Object.fromEntries(entries));
    }
    console.log(`[chat-settings] Loaded ${_chats.size} chat(s)`);
  } catch (err) {
    if (err?.code !== 'ENOENT') {
      console.error('[chat-settings] Could not read store, starting empty:', err?.message ?? err);
    }
  }
}

/** @returns {Record<string, boolean>} every category → enabled */
export function getChatSettings(chatId) {
  const overrides = _chats.get(String(chatId)) ?? {};
  const settings = {};
  for (const { key } of NOTIFY_CATEGORIES) settings[key] = overrides[key] !== false;
  return settings;
}

/** @returns {Record<string, boolean>|null} the new settings, or null for an unknown key */
export function setChatSetting(chatId, key, enabled) {
  if (!CATEGORY_KEYS.has(String(key))) return null;
  const id = String(chatId);
  const overrides = { ...(_chats.get(id) ?? {}) };
  if (enabled) delete overrides[key];
  else overrides[key] = false;
  if (Object.keys(overrides).length) _chats.set(id, overrides);
  else _chats.delete(id);
  persist();
  return getChatSettings(id);
}

export function toggleChatSetting(chatId, key) {
  if (!CATEGORY_KEYS.has(String(key))) return null;
  return setChatSetting(chatId, key, !getChatSettings(chatId)[key]);
}

/** The /settings message body. The buttons under it do the toggling. */
export function formatSettingsMessage(settings, { isGroup = false } = {}) {
  const lines = ['⚙️ Сповіщення для цього чату', ''];
  for (const { key, emoji, label, hint } of NOTIFY_CATEGORIES) {
    lines.push(`${settings[key] ? '✅' : '🔕'} ${emoji} ${label} — ${hint}`);
  }
  lines.push('');
  lines.push('Натисни кнопку, щоб увімкнути або вимкнути категорію.');
  lines.push('Сповіщення надходять лише за регіонами з /subscriptions; загальнодержавні події — якщо є хоч одна підписка.');
  if (isGroup) lines.push('У групі змінювати налаштування можуть лише адміністратори.');
  return lines.join('\n');
}
