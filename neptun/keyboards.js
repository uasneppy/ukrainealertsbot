/**
 * Inline keyboards for map replies.
 *
 * During a raid people are typing «тривога в київській області» on a phone,
 * one-handed, possibly in the dark. A button is faster and can't be misspelled.
 *
 * Telegram caps callback_data at 64 *bytes*, and every region key here is
 * Cyrillic (two bytes a character), so the encoder checks the real byte length
 * and drops the button rather than sending a payload Telegram will reject.
 */

export const CALLBACK_REFRESH = 'r';
export const CALLBACK_SUBSCRIBE = 's';
export const CALLBACK_UNSUBSCRIBE = 'u';
/** Toggle one notification category; the payload after '|' is its key. */
export const CALLBACK_TOGGLE = 't';
/** The night digest for a region — what flew over it since the evening. */
export const CALLBACK_NIGHT = 'n';

const MAX_CALLBACK_BYTES = 64;

export function encodeCallback(action, cacheKey = '') {
  const data = `${action}|${cacheKey}`;
  return Buffer.byteLength(data, 'utf8') <= MAX_CALLBACK_BYTES ? data : null;
}

export function decodeCallback(data) {
  const raw = String(data ?? '');
  const separator = raw.indexOf('|');
  if (separator < 0) return { action: null, cacheKey: '' };
  return { action: raw.slice(0, separator), cacheKey: raw.slice(separator + 1) };
}

/**
 * @param {object} opts
 * @param {string|null} opts.cacheKey    region key, or null for the national map
 * @param {boolean} opts.subscribed      whether this chat already follows it
 * @param {boolean} opts.night           offer the night digest (region maps only)
 * @returns {object|undefined} reply_markup, or undefined when no button fits
 */
export function mapKeyboard({ cacheKey = null, subscribed = false, night = false } = {}) {
  const row = [];

  const refresh = encodeCallback(CALLBACK_REFRESH, cacheKey ?? '');
  if (refresh) row.push({ text: '🔄 Оновити', callback_data: refresh });

  if (cacheKey) {
    const action = subscribed ? CALLBACK_UNSUBSCRIBE : CALLBACK_SUBSCRIBE;
    const data = encodeCallback(action, cacheKey);
    if (data) {
      row.push({ text: subscribed ? '🔕 Відписатися' : '🔔 Підписатися', callback_data: data });
    }
  }

  const rows = row.length ? [row] : [];
  if (cacheKey && night) {
    const data = encodeCallback(CALLBACK_NIGHT, cacheKey);
    if (data) rows.push([{ text: '🌙 Що було за ніч', callback_data: data }]);
  }
  return rows.length ? { inline_keyboard: rows } : undefined;
}

/**
 * One toggle button per notification category, state shown in the label so
 * the keyboard is the settings screen — the message text under it only
 * explains what each category means.
 *
 * @param {Record<string, boolean>} settings   from getChatSettings()
 * @param {Array<{ key, emoji, label }>} categories  NOTIFY_CATEGORIES
 */
export function settingsKeyboard(settings, categories) {
  const rows = [];
  for (const { key, emoji, label } of categories) {
    const data = encodeCallback(CALLBACK_TOGGLE, key);
    if (!data) continue;
    rows.push([{ text: `${settings[key] ? '✅' : '🔕'} ${emoji} ${label}`, callback_data: data }]);
  }
  return rows.length ? { inline_keyboard: rows } : undefined;
}
