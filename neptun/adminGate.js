/**
 * Who may change a chat's settings.
 *
 * In a private chat, the person. In a group, only its admins: a bot that lets
 * any member mute ballistic warnings for everyone is a bot one troll can turn
 * off. Telegram answers "is this user an admin" with a network call, and a
 * settings screen invites several taps in a row, so answers are cached
 * briefly. On a failed check the answer is no — a denied admin retries; a
 * granted non-admin silently changes what a whole group is warned about.
 */

export const DEFAULT_ADMIN_TTL_MS = 5 * 60 * 1000;
const ADMIN_STATUSES = new Set(['creator', 'administrator']);

export function isGroupChat(chat) {
  return chat?.type === 'group' || chat?.type === 'supergroup';
}

/**
 * @param {object} opts
 * @param {Function} opts.getChatMember  (chatId, userId) => Promise<{ status }>
 */
export function createAdminGate({
  getChatMember,
  ttlMs = DEFAULT_ADMIN_TTL_MS,
  now = () => Date.now(),
  log = console,
} = {}) {
  if (typeof getChatMember !== 'function') throw new Error('getChatMember is required');

  const cache = new Map(); // "chatId:userId" → { allowed, at }

  /**
   * @param {object} opts
   * @param {object} opts.chat        Telegram chat object ({ id, type })
   * @param {object} [opts.from]      Telegram user who acted
   * @param {object} [opts.senderChat] `sender_chat` — set when an anonymous
   *                                   admin or the channel itself posts
   * @returns {Promise<{ allowed: boolean, reason: string }>}
   */
  async function canManage({ chat, from, senderChat } = {}) {
    if (!chat) return { allowed: false, reason: 'no-chat' };
    if (chat.type === 'private') return { allowed: true, reason: 'private' };
    // Anonymous group admins post as the group itself; there is no user to
    // look up, and only an admin can do this in the first place.
    if (senderChat && String(senderChat.id) === String(chat.id)) {
      return { allowed: true, reason: 'anonymous-admin' };
    }
    if (!from?.id) return { allowed: false, reason: 'no-user' };

    const key = `${chat.id}:${from.id}`;
    const cached = cache.get(key);
    if (cached && now() - cached.at < ttlMs) {
      return { allowed: cached.allowed, reason: cached.allowed ? 'admin' : 'not-admin' };
    }

    try {
      const member = await getChatMember(chat.id, from.id);
      const allowed = ADMIN_STATUSES.has(member?.status);
      cache.set(key, { allowed, at: now() });
      if (cache.size > 2000) cache.delete(cache.keys().next().value);
      return { allowed, reason: allowed ? 'admin' : 'not-admin' };
    } catch (err) {
      log.warn?.(`[admin-gate] getChatMember failed for ${key}: ${err?.message ?? err}`);
      return { allowed: false, reason: 'unknown' };
    }
  }

  return { canManage, __cacheSize: () => cache.size };
}
