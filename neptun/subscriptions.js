/**
 * Per-chat region subscriptions, persisted to disk.
 *
 * Storage is a single JSON file. It must survive redeploys — a subscription
 * silently lost on `docker compose up` is worse than one that was never
 * created, because nobody finds out until the alert they were waiting for
 * doesn't arrive. See the `subscriptions` volume in docker-compose.yml.
 *
 * What's stored is the user's original phrase, not the resolved descriptor:
 * the resolver is the single source of truth for what "харківщина" means, and
 * re-resolving on load means improvements to it apply to existing
 * subscriptions instead of leaving stale copies behind.
 */

import fs from 'fs/promises';
import path from 'path';
import { fileURLToPath } from 'url';

import { resolveRegion } from './regionResolver.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const FORMAT_VERSION = 1;
/** Guard against one chat pinning unbounded work onto every watcher tick. */
export const MAX_PER_CHAT = 10;

export function getSubscriptionsFile() {
  return process.env.SUBSCRIPTIONS_FILE || path.join(__dirname, '..', 'data', 'subscriptions.json');
}

/** chatId (string) → Map<cacheKey, { query, name, kind, since }> */
let _chats = new Map();
let _loaded = false;
let _writeChain = Promise.resolve();

function toPlain() {
  const chats = {};
  for (const [chatId, subs] of _chats) {
    chats[chatId] = Object.fromEntries(subs);
  }
  return { version: FORMAT_VERSION, chats };
}

/**
 * Writes are serialised and atomic (temp file + rename): the watcher and a
 * user command can both touch the store, and a half-written JSON file would
 * drop every subscription on the next boot.
 */
function persist() {
  const snapshot = JSON.stringify(toPlain(), null, 2);
  // Resolve the destination now, not when the queued write runs: the write is
  // of *this* state, so it belongs in the file that was configured for it.
  const file = getSubscriptionsFile();
  _writeChain = _writeChain.then(async () => {
    const tmp = `${file}.tmp`;
    await fs.mkdir(path.dirname(file), { recursive: true });
    await fs.writeFile(tmp, snapshot, 'utf8');
    await fs.rename(tmp, file);
  }).catch((err) => {
    console.error('[subscriptions] Failed to persist:', err?.message ?? err);
  });
  return _writeChain;
}

/** Waits for any in-flight write — used by tests and the shutdown path. */
export function flushSubscriptions() {
  return _writeChain;
}

export async function loadSubscriptions() {
  if (_loaded) return;
  _loaded = true;
  try {
    const raw = await fs.readFile(getSubscriptionsFile(), 'utf8');
    const data = JSON.parse(raw);
    for (const [chatId, subs] of Object.entries(data?.chats ?? {})) {
      const entries = Object.entries(subs ?? {}).filter(([, sub]) => resolveRegion(sub?.query ?? ''));
      if (entries.length) _chats.set(String(chatId), new Map(entries));
    }
    console.log(`[subscriptions] Loaded ${_chats.size} chat(s)`);
  } catch (err) {
    if (err?.code !== 'ENOENT') {
      // A corrupt file must not take the bot down; start empty and let the
      // next write replace it.
      console.error('[subscriptions] Could not read store, starting empty:', err?.message ?? err);
    }
  }
}

/** Resets in-memory state (tests only). */
export function __resetSubscriptions() {
  _chats = new Map();
  _loaded = false;
  _writeChain = Promise.resolve();
}

/**
 * @returns {{ ok: boolean, reason?: 'unresolved'|'duplicate'|'limit', region?: object }}
 */
export function subscribe(chatId, query) {
  const region = resolveRegion(query);
  if (!region || region.kind === 'country') return { ok: false, reason: 'unresolved' };

  const key = String(chatId);
  const subs = _chats.get(key) ?? new Map();
  if (subs.has(region.cacheKey)) return { ok: false, reason: 'duplicate', region };
  if (subs.size >= MAX_PER_CHAT) return { ok: false, reason: 'limit', region };

  subs.set(region.cacheKey, {
    query: String(query).trim(),
    name: region.name,
    kind: region.kind,
    since: new Date().toISOString(),
  });
  _chats.set(key, subs);
  persist();
  return { ok: true, region };
}

/** Removes one region, or every subscription when cacheKey is omitted. */
export function unsubscribe(chatId, cacheKey = null) {
  const key = String(chatId);
  const subs = _chats.get(key);
  if (!subs || subs.size === 0) return { ok: false, removed: 0 };

  let removed = 0;
  if (cacheKey) {
    removed = subs.delete(cacheKey) ? 1 : 0;
  } else {
    removed = subs.size;
    subs.clear();
  }
  if (subs.size === 0) _chats.delete(key);
  if (removed) persist();
  return { ok: removed > 0, removed };
}

/** @returns {Array<{ cacheKey, query, name, kind, since }>} */
export function listSubscriptions(chatId) {
  const subs = _chats.get(String(chatId));
  if (!subs) return [];
  return [...subs.entries()].map(([cacheKey, sub]) => ({ cacheKey, ...sub }));
}

/**
 * Every chat with at least one subscription — the audience for nationwide
 * events (a MiG-31K take-off has no region to match against).
 *
 * @returns {string[]}
 */
export function subscribedChats() {
  return [..._chats.entries()].filter(([, subs]) => subs.size > 0).map(([chatId]) => chatId);
}

/**
 * Every distinct region anyone subscribes to, with its subscriber chat ids.
 * The watcher evaluates each region once regardless of subscriber count.
 *
 * @returns {Array<{ region: object, chatIds: string[] }>}
 */
export function subscribedRegions() {
  const byKey = new Map();
  for (const [chatId, subs] of _chats) {
    for (const [cacheKey, sub] of subs) {
      let entry = byKey.get(cacheKey);
      if (!entry) {
        const region = resolveRegion(sub.query);
        if (!region) continue; // resolver no longer recognises it — skip quietly
        entry = { region, chatIds: [] };
        byKey.set(cacheKey, entry);
      }
      entry.chatIds.push(chatId);
    }
  }
  return [...byKey.values()];
}
