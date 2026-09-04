/**
 * What the bot saw tonight. NEPTUN has no history — its threat feed is "what
 * is in the air now" and its channel feed holds ten minutes — so a question
 * like "what flew over Kyiv tonight, and how many" can only be answered from
 * what the bot itself remembered as it went past.
 *
 * Two things are kept:
 *   • tracks — every NEPTUN track id with its type, the largest `count` the
 *     feed gave it, and a thinned trail of positions, so a region can later
 *     ask "did this ever pass over me";
 *   • messages — every monitoring-channel post, with the regions it mentions
 *     (computed once, on the way in — scanning thousands of posts per query
 *     would be the expensive part).
 *
 * Persisted to the data volume, debounced: a restart at 03:00 must not forget
 * the night, but rewriting a few megabytes on every upsert would be silly.
 */

import fs from 'fs/promises';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const FORMAT_VERSION = 1;
/** Long enough for "last night" to be askable through the following afternoon. */
export const DEFAULT_RETAIN_MS = 26 * 60 * 60 * 1000;
export const DEFAULT_PERSIST_DEBOUNCE_MS = 60_000;
export const DEFAULT_MAX_MESSAGES = 8000;
const MAX_SAMPLES = 24;
/** Nights start at 18:00 Kyiv time; before 09:00 it is still "tonight". */
export const NIGHT_START_HOUR = 18;
const NIGHT_END_HOUR = 9;

export function getNightLogFile() {
  return process.env.NIGHT_LOG_FILE || path.join(__dirname, '..', 'data', 'nightLog.json');
}

const KYIV_PARTS = new Intl.DateTimeFormat('en-US', {
  timeZone: 'Europe/Kyiv',
  hourCycle: 'h23',
  year: 'numeric', month: '2-digit', day: '2-digit',
  hour: '2-digit', minute: '2-digit', second: '2-digit',
});

function kyivParts(ms) {
  const p = Object.fromEntries(KYIV_PARTS.formatToParts(new Date(ms)).map((x) => [x.type, x.value]));
  return { y: +p.year, m: +p.month, d: +p.day, h: +p.hour, min: +p.minute, s: +p.second };
}

/**
 * The window "tonight" covers: from the most recent 18:00 Kyiv time. During
 * the day that still reads back to yesterday evening, which is what "за ніч"
 * means at 15:00. (Uses the current UTC offset; on the two DST nights a year
 * the boundary is off by an hour, which nobody will notice.)
 *
 * @returns {{ since: number, label: string, isNight: boolean }}
 */
export function nightWindow(now = Date.now(), startHour = NIGHT_START_HOUR) {
  const k = kyivParts(now);
  const wallAsUtc = Date.UTC(k.y, k.m - 1, k.d, k.h, k.min, k.s);
  const offsetMs = wallAsUtc - Math.floor(now / 1000) * 1000;
  let boundary = Date.UTC(k.y, k.m - 1, k.d, startHour);
  if (k.h < startHour) boundary -= 86_400_000;
  return {
    since: boundary - offsetMs,
    label: `з ${String(startHour).padStart(2, '0')}:00`,
    isNight: k.h >= startHour || k.h < NIGHT_END_HOUR,
  };
}

// Keyed on the parsed time, not the date string: the feed says "…:00Z", the
// reloaded store says "…:00.000Z", and a key that differs by format would let
// every post be recorded twice after a restart.
const messageKey = (channel, at, text) => `${String(channel ?? '').toLowerCase()}|${at}|${String(text).slice(0, 120)}`;

export function createNightLog({
  file = null,
  retainMs = DEFAULT_RETAIN_MS,
  persistDebounceMs = DEFAULT_PERSIST_DEBOUNCE_MS,
  maxMessages = DEFAULT_MAX_MESSAGES,
  mentions = null, // (text) => Iterable<cacheKey>
  now = () => Date.now(),
  log = console,
} = {}) {
  const tracks = new Map();   // id → track
  const messages = new Map(); // key → message
  let dirty = false;
  let persistTimer = null;
  let writeChain = Promise.resolve();
  const filePath = () => file ?? getNightLogFile();

  function markDirty() {
    dirty = true;
    if (persistTimer) return;
    persistTimer = setTimeout(() => {
      persistTimer = null;
      persist();
    }, persistDebounceMs);
    persistTimer.unref?.();
  }

  function persist() {
    if (!dirty) return writeChain;
    dirty = false;
    prune();
    const snapshot = JSON.stringify({
      version: FORMAT_VERSION,
      tracks: [...tracks.values()],
      messages: [...messages.values()],
    });
    const target = filePath();
    writeChain = writeChain
      .then(async () => {
        const tmp = `${target}.tmp`;
        await fs.mkdir(path.dirname(target), { recursive: true });
        await fs.writeFile(tmp, snapshot, 'utf8');
        await fs.rename(tmp, target);
      })
      .catch((err) => log.error?.('[night-log] Failed to persist:', err?.message ?? err));
    return writeChain;
  }

  function prune() {
    const cutoff = now() - retainMs;
    for (const [id, t] of tracks) if (t.lastAt < cutoff) tracks.delete(id);
    for (const [key, m] of messages) if (m.at < cutoff) messages.delete(key);
    if (messages.size > maxMessages) {
      // Oldest first — Map keeps insertion order and messages arrive in order.
      const excess = messages.size - maxMessages;
      let i = 0;
      for (const key of messages.keys()) {
        if (i++ >= excess) break;
        messages.delete(key);
      }
    }
  }

  return {
    /** Records the current NEPTUN threat list; safe to call on every upsert. */
    recordThreats(threats = [], at = now()) {
      let changed = false;
      for (const t of threats) {
        if (!t?.id || !Number.isFinite(t.lat) || !Number.isFinite(t.lon)) continue;
        const type = String(t.type ?? 'unknown').toLowerCase();
        const count = Number.isFinite(t.count) && t.count > 0 ? t.count : 1;
        let track = tracks.get(t.id);
        if (!track) {
          track = {
            id: t.id, type, title: t.title ?? '', count, firstAt: at, lastAt: at,
            region: t.region ?? '', localities: [], samples: [],
            advisory: t.advisory === true || /загроз/iu.test(String(t.title ?? '')),
          };
          tracks.set(t.id, track);
          changed = true;
        }
        track.lastAt = at;
        if (count > track.count) { track.count = count; changed = true; }
        if (t.locality && !track.localities.includes(t.locality) && track.localities.length < 12) {
          track.localities.push(t.locality);
          changed = true;
        }
        const last = track.samples[track.samples.length - 1];
        if (!last || Math.abs(last[0] - t.lat) > 0.005 || Math.abs(last[1] - t.lon) > 0.005) {
          track.samples.push([t.lat, t.lon, at]);
          if (track.samples.length > MAX_SAMPLES) {
            // Thin the middle, keep the ends: the trail's shape survives, the size doesn't grow.
            const n = track.samples.length;
            track.samples = track.samples.filter((_, i) => i === 0 || i === n - 1 || i % 2 === 0);
          }
          changed = true;
        }
      }
      if (changed) markDirty();
      return changed;
    },

    /** Records channel posts; duplicates (same channel, date, text) are ignored. */
    recordMessages(list = [], at = now()) {
      let added = 0;
      const cutoff = now() - retainMs;
      for (const m of list) {
        if (!m || typeof m.text !== 'string' || !m.text.trim()) continue;
        const parsed = Date.parse(m.date ?? '');
        const when = Number.isFinite(parsed) ? parsed : at;
        const key = messageKey(m.channel, when, m.text);
        if (messages.has(key)) continue;
        if (when < cutoff) continue;
        messages.set(key, {
          channel: String(m.channel ?? ''),
          text: m.text,
          at: when,
          regions: mentions ? [...mentions(m.text)] : [],
        });
        added += 1;
      }
      if (added) markDirty();
      return added;
    },

    /** Tracks seen since `since` (by last position time), newest first. */
    tracksSince(since) {
      return [...tracks.values()].filter((t) => t.lastAt >= since).sort((a, b) => b.lastAt - a.lastAt);
    },

    /** Messages since `since`, newest first. */
    messagesSince(since) {
      return [...messages.values()].filter((m) => m.at >= since).sort((a, b) => b.at - a.at);
    },

    size() {
      return { tracks: tracks.size, messages: messages.size };
    },

    async load() {
      try {
        const data = JSON.parse(await fs.readFile(filePath(), 'utf8'));
        for (const t of data?.tracks ?? []) if (t?.id) tracks.set(t.id, t);
        for (const m of data?.messages ?? []) if (m?.text) messages.set(messageKey(m.channel, m.at, m.text), m);
        prune();
        log.log?.(`[night-log] Loaded ${tracks.size} track(s), ${messages.size} message(s)`);
      } catch (err) {
        if (err?.code !== 'ENOENT') log.error?.('[night-log] Could not read store, starting empty:', err?.message ?? err);
      }
    },

    /** Writes now if anything changed, and waits for it (shutdown path). */
    async flush() {
      if (persistTimer) {
        clearTimeout(persistTimer);
        persistTimer = null;
      }
      await persist();
      await writeChain;
    },

    prune,
  };
}
