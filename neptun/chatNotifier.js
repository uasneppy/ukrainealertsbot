/**
 * The last filter before an unprompted message reaches a chat.
 *
 * The watchers decide *what* happened; this decides who hears about it:
 *   • the chat's category settings (a chat that muted «Калібри» stays quiet),
 *   • one notice per chat per key inside a window — the same ballistic risk
 *     reaches the bot twice, once as a NEPTUN advisory placed over Kyiv and
 *     once as the Air Force's own message. Both are true; one message is the
 *     warning, the second is the bot repeating itself.
 *
 * Keys are "<kind>" for a nationwide event and "<kind>|<region>" for a
 * regional one. A nationwide warning covers its regions, so it silences the
 * regional variant that follows; a regional one never silences the nationwide
 * one, which is genuinely wider news.
 */

export const DEFAULT_DEDUPE_MS = 30 * 60 * 1000;

export function createChatNotifier({
  sendTo,
  getSettings,
  dedupeMs = DEFAULT_DEDUPE_MS,
  now = () => Date.now(),
} = {}) {
  if (typeof sendTo !== 'function') throw new Error('sendTo is required');
  if (typeof getSettings !== 'function') throw new Error('getSettings is required');

  const recent = new Map(); // chatId → Map<key, at>

  const recentlySent = (chatId, key, t) => {
    const at = recent.get(chatId)?.get(key);
    return at != null && t - at < dedupeMs;
  };
  const record = (chatId, key, t) => {
    let byKey = recent.get(chatId);
    if (!byKey) recent.set(chatId, (byKey = new Map()));
    byKey.set(key, t);
    // Old entries are dead weight after the window; keep the map bounded.
    for (const [k, at] of byKey) if (t - at >= dedupeMs) byKey.delete(k);
  };

  /**
   * @param {object} opts
   * @param {string}   opts.category  a NOTIFY_CATEGORIES key
   * @param {string}   opts.text
   * @param {string[]} opts.chatIds
   * @param {string}   [opts.key]     dedupe key; omit for messages that must always go
   * @returns {{ sent: string[], muted: string[], deduped: string[] }}
   */
  function deliver({ category, text, chatIds = [], key = null }) {
    const t = now();
    const result = { sent: [], muted: [], deduped: [] };
    const base = key && key.includes('|') ? key.slice(0, key.indexOf('|')) : null;

    for (const chatId of chatIds) {
      const id = String(chatId);
      if (getSettings(id)?.[category] === false) {
        result.muted.push(id);
        continue;
      }
      if (key) {
        if (recentlySent(id, key, t) || (base && recentlySent(id, base, t))) {
          result.deduped.push(id);
          continue;
        }
        record(id, key, t);
      }
      sendTo(id, text);
      result.sent.push(id);
    }
    return result;
  }

  return { deliver };
}
