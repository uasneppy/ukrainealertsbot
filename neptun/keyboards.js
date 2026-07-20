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
 * @returns {object|undefined} reply_markup, or undefined when no button fits
 */
export function mapKeyboard({ cacheKey = null, subscribed = false } = {}) {
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

  return row.length ? { inline_keyboard: [row] } : undefined;
}
