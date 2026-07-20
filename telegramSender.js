/**
 * Paced, retrying sender for unprompted messages (alert fan-out).
 *
 * Answering a user is one message; announcing a raid is one message per
 * subscribed chat, all at once. Telegram allows roughly 30 messages/second
 * overall, and a burst past that comes back as 429. Those are exactly the
 * messages that must not be dropped — nobody re-asks for a notification they
 * never knew was coming — so sends are queued, paced, and retried on the
 * server's own `retry_after`.
 *
 * Chats that reject permanently (bot blocked, kicked, chat deleted) are
 * reported to `onDeadChat` so their subscriptions can be dropped instead of
 * being retried forever on every alert.
 */

/** ~25 msg/s — comfortably under Telegram's global ceiling. */
export const DEFAULT_MIN_INTERVAL_MS = 40;
export const DEFAULT_MAX_RETRIES = 3;

/**
 * Telegram's flood-wait, in ms, or null if this isn't one.
 * The error shape differs across client versions, so check the known spots
 * rather than trusting one.
 */
export function retryAfterMs(err) {
  const params =
    err?.response?.body?.parameters ??
    err?.response?.parameters ??
    err?.parameters ??
    null;
  const seconds = params?.retry_after ?? err?.retry_after;
  const value = Number(seconds);
  return Number.isFinite(value) && value >= 0 ? value * 1000 : null;
}

/**
 * True when the chat will never accept messages again, so retrying is
 * pointless and the subscription should go. Deliberately narrow: a generic
 * 400 is not proof of a dead chat, and unsubscribing someone by mistake is
 * silent data loss.
 */
export function isDeadChatError(err) {
  const code = err?.response?.body?.error_code ?? err?.code ?? err?.statusCode;
  const description = String(
    err?.response?.body?.description ?? err?.description ?? err?.message ?? ''
  ).toLowerCase();

  if (code !== 400 && code !== 403) return false;

  return (
    description.includes('bot was blocked') ||
    description.includes('bot was kicked') ||
    description.includes('user is deactivated') ||
    description.includes('chat not found') ||
    description.includes('group chat was upgraded') ||
    description.includes('have no rights to send')
  );
}

const defaultSleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * @param {object} opts
 * @param {Function} opts.send        (chatId, text) => Promise
 * @param {Function} [opts.onDeadChat] (chatId, err) => void — prune the subscription
 * @returns {{ sendTo: Function, drain: Function, pending: Function }}
 */
export function createSender({
  send,
  onDeadChat = null,
  minIntervalMs = DEFAULT_MIN_INTERVAL_MS,
  maxRetries = DEFAULT_MAX_RETRIES,
  sleep = defaultSleep,
  now = () => Date.now(),
  log = console,
} = {}) {
  if (typeof send !== 'function') throw new Error('send is required');

  let chain = Promise.resolve();
  let lastSentAt = 0;
  let queued = 0;

  async function deliver(chatId, text) {
    for (let attempt = 0; ; attempt += 1) {
      const since = now() - lastSentAt;
      if (since < minIntervalMs) await sleep(minIntervalMs - since);

      try {
        lastSentAt = now();
        await send(chatId, text);
        return 'sent';
      } catch (err) {
        if (isDeadChatError(err)) {
          log.warn?.(`[sender] ${chatId} is unreachable, dropping: ${err?.message ?? err}`);
          try {
            onDeadChat?.(chatId, err);
          } catch (hookErr) {
            log.error?.('[sender] onDeadChat failed:', hookErr?.message ?? hookErr);
          }
          return 'dropped';
        }

        if (attempt >= maxRetries) {
          log.error?.(`[sender] giving up on ${chatId}: ${err?.message ?? err}`);
          return 'failed';
        }

        // Honour the server's own back-off when it gave one; otherwise a
        // short exponential wait for transient network trouble.
        const wait = retryAfterMs(err) ?? minIntervalMs * 2 ** attempt;
        await sleep(wait);
      }
    }
  }

  return {
    /** Queues a message. Never rejects — resolves 'sent' | 'dropped' | 'failed'. */
    sendTo(chatId, text) {
      queued += 1;
      const result = chain.then(() => deliver(chatId, text));
      // Keep the chain alive regardless of outcome, and don't let it retain
      // each result: this queue runs for the lifetime of the process.
      chain = result.then(
        () => {
          queued -= 1;
        },
        () => {
          queued -= 1;
        }
      );
      return result;
    },

    /** Resolves once the queue is empty (shutdown path). */
    drain() {
      return chain;
    },

    pending() {
      return queued;
    },
  };
}
