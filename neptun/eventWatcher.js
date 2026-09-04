/**
 * Watches for nationwide threat events and announces each once.
 *
 * Two sources feed it:
 *   • the channel feed NEPTUN aggregates (/api/v1/messages) — the Air Force
 *     and intelligence channels say "зліт стратегічної авіації", "носії
 *     Калібрів у морі", "пуск 30 шахедів"; eventDetector turns those into
 *     kinds;
 *   • the threat map, for the one nationwide event it carries structurally:
 *     a `mig31k` marker is a MiG-31K in the air.
 *
 * The rules mirror the alert watcher's, for the same reasons:
 *  1. The first poll only seeds. After a restart, whatever is in the last ten
 *     minutes of the feed was already announced (or is history) — it must not
 *     be re-blasted to every chat.
 *  2. One announcement per kind per cooldown. Channels repeat and rephrase the
 *     same take-off for an hour; the second message is not a second take-off.
 *  3. Only the configured channels count. Hyperlocal channels narrate every
 *     rumour; a nationwide warning to every subscriber needs an official or
 *     intelligence source behind it.
 *  4. A failed poll is a skipped tick, never a guess.
 */

import { detectEvents, quoteMessage, EVENT_KINDS } from './eventDetector.js';

/** Channels whose messages may trigger a nationwide event (NEPTUN's official + intelligence tier). */
export const DEFAULT_EVENT_CHANNELS = ['@kpszsu', '@rozvidkaneba', '@ukrainian_intelligence'];
/** The feed holds ~10 minutes; polling well inside that never misses a message. */
export const DEFAULT_EVENT_POLL_MS = 20_000;
/** Same take-off is re-reported for the better part of an hour. */
export const DEFAULT_EVENT_COOLDOWN_MS = 30 * 60 * 1000;
/**
 * Drone launches come in waves ten to twenty minutes apart and the count is
 * the news, so they get a shorter window than a take-off.
 */
export const DEFAULT_UAV_COOLDOWN_MS = 10 * 60 * 1000;
/** A message older than this on a poll (after an outage) is history, not news. */
export const DEFAULT_MAX_MESSAGE_AGE_MS = 15 * 60 * 1000;

const normalizeChannel = (c) => {
  const s = String(c ?? '').trim().toLowerCase();
  return s && !s.startsWith('@') ? `@${s}` : s;
};

export function createEventWatcher({
  fetchMessages,
  getSnapshot = null,
  notify,
  onMessages = null,     // (messages) => void — every fetched post, any channel; feeds the night log
  hasAudience = () => true,
  channels = DEFAULT_EVENT_CHANNELS,
  cooldownMs = DEFAULT_EVENT_COOLDOWN_MS,
  uavCooldownMs = DEFAULT_UAV_COOLDOWN_MS,
  intervalMs = DEFAULT_EVENT_POLL_MS,
  maxMessageAgeMs = DEFAULT_MAX_MESSAGE_AGE_MS,
  detect = detectEvents,
  now = () => Date.now(),
  log = console,
} = {}) {
  if (typeof fetchMessages !== 'function') throw new Error('fetchMessages is required');
  if (typeof notify !== 'function') throw new Error('notify is required');

  const allowAll = channels === 'all' || (Array.isArray(channels) && channels.includes('all'));
  const channelSet = new Set((Array.isArray(channels) ? channels : []).map(normalizeChannel).filter(Boolean));

  const seenMessages = new Map(); // key → seen-at (pruned by age)
  const lastAnnouncedAt = new Map(); // kind → epoch ms
  let knownMigIds = new Set();
  let seeded = false;
  let migSeeded = false;
  let timer = null;
  let ticking = false;
  const stats = { lastPollAt: 0, lastOkAt: 0, lastEventAt: 0, announced: 0, lastError: null };

  const messageKey = (m) => `${normalizeChannel(m.channel)}|${m.date ?? ''}|${String(m.text).slice(0, 200)}`;
  const cooldownFor = (kind) => (kind === 'uav_launch' ? uavCooldownMs : cooldownMs);

  function announceable(kind, t) {
    const last = lastAnnouncedAt.get(kind);
    return last == null || t - last >= cooldownFor(kind);
  }

  async function runTick() {
    // Nobody to tell → nothing to fetch. Seeding is deferred too, so the first
    // subscriber's first tick seeds rather than replays the feed to them.
    if (!hasAudience()) return { skipped: 'no-subscribers', announced: [] };

    const t = now();
    stats.lastPollAt = t;
    const announced = [];

    // ── Channel feed ──
    let messages;
    try {
      messages = await fetchMessages();
      stats.lastOkAt = t;
      stats.lastError = null;
    } catch (err) {
      stats.lastError = err?.message ?? String(err);
      log.warn?.('[event-watcher] feed fetch failed:', stats.lastError);
      messages = null;
    }

    if (messages) {
      if (onMessages) {
        try {
          onMessages(messages);
        } catch (err) {
          log.error?.('[event-watcher] onMessages failed:', err?.message ?? err);
        }
      }
      const fresh = messages.filter((m) => {
        if (!allowAll && !channelSet.has(normalizeChannel(m.channel))) return false;
        const at = Date.parse(m.date ?? '');
        return !Number.isFinite(at) || t - at <= maxMessageAgeMs;
      });
      // Oldest first, so a take-off is announced before the launch that followed it.
      fresh.sort((a, b) => Date.parse(a.date ?? 0) - Date.parse(b.date ?? 0));

      const unseen = fresh.filter((m) => !seenMessages.has(messageKey(m)));
      for (const m of fresh) seenMessages.set(messageKey(m), t);
      for (const [key, at] of seenMessages) if (t - at > maxMessageAgeMs * 2) seenMessages.delete(key);

      if (!seeded) {
        seeded = true; // whatever was already in the feed is not news
      } else {
        for (const m of unseen) {
          for (const { kind, count, sentence } of detect(m.text)) {
            if (!EVENT_KINDS[kind] || !announceable(kind, t)) continue;
            lastAnnouncedAt.set(kind, t);
            // Quote the sentence that triggered the event, not the whole post:
            // a long message quoted whole was a truncated wall of bullets.
            const quote = sentence ? quoteMessage(sentence) : quoteMessage(m.text);
            announced.push({
              kind,
              category: EVENT_KINDS[kind].category,
              count,
              quote,
              channel: normalizeChannel(m.channel),
              date: m.date ?? null,
            });
          }
        }
      }
    }

    // ── MiG-31K on the threat map ──
    if (getSnapshot) {
      let snapshot = null;
      try {
        snapshot = await getSnapshot();
      } catch (err) {
        log.warn?.('[event-watcher] snapshot failed:', err?.message ?? err);
      }
      if (snapshot) {
        const migs = (snapshot.threats ?? []).filter((th) => th?.id && String(th.type).toLowerCase() === 'mig31k');
        const current = new Set(migs.map((th) => th.id));
        if (!migSeeded) {
          migSeeded = true;
        } else {
          for (const th of migs) {
            if (knownMigIds.has(th.id) || !announceable('mig31k_takeoff', t)) continue;
            lastAnnouncedAt.set('mig31k_takeoff', t);
            announced.push({
              kind: 'mig31k_takeoff',
              category: EVENT_KINDS.mig31k_takeoff.category,
              count: Number.isFinite(th.count) && th.count > 0 ? th.count : null,
              quote: String(th.explanationShort ?? th.title ?? '').trim(),
              channel: 'NEPTUN',
              date: th.confirmedAt ?? th.updatedAt ?? null,
            });
          }
        }
        knownMigIds = current;
      }
    }

    for (const event of announced) {
      stats.announced += 1;
      stats.lastEventAt = t;
      try {
        await notify(event);
      } catch (err) {
        log.error?.(`[event-watcher] notify failed for ${event.kind}:`, err?.message ?? err);
      }
    }

    return { skipped: messages ? null : 'fetch-failed', announced };
  }

  async function tick() {
    if (ticking) return { skipped: 'busy', announced: [] };
    ticking = true;
    try {
      return await runTick();
    } finally {
      ticking = false;
    }
  }

  return {
    tick,
    stats: () => ({ ...stats }),
    start() {
      if (timer) return;
      timer = setInterval(() => {
        tick().catch((err) => log.error?.('[event-watcher] tick failed:', err?.message ?? err));
      }, intervalMs);
      timer.unref?.();
    },
    stop() {
      if (timer) {
        clearInterval(timer);
        timer = null;
      }
    },
  };
}
