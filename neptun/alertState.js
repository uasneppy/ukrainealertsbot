/**
 * Last known alert state per region, persisted across restarts.
 *
 * Without this the watcher seeds silently on boot, which is right for a normal
 * start but wrong across a deploy: an alert that *begins* while the bot is down
 * is then never announced, and subscribers sit waiting for a push that already
 * silently didn't happen. Persisting what we last told people lets the first
 * tick after boot notice what changed while we were away.
 *
 * Lives beside subscriptions.json in the same volume — see docker-compose.yml.
 */

import fs from 'fs/promises';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const FORMAT_VERSION = 1;

export function getAlertStateFile() {
  return process.env.ALERT_STATE_FILE || path.join(__dirname, '..', 'data', 'alertState.json');
}

let _states = new Map(); // cacheKey → { confirmed: boolean, at: epoch ms }
let _writeChain = Promise.resolve();

export function flushAlertState() {
  return _writeChain;
}

/** Resets in-memory state (tests only). */
export function __resetAlertState() {
  _states = new Map();
  _writeChain = Promise.resolve();
}

export async function loadAlertState() {
  try {
    const raw = await fs.readFile(getAlertStateFile(), 'utf8');
    const data = JSON.parse(raw);
    for (const [key, entry] of Object.entries(data?.regions ?? {})) {
      if (typeof entry?.confirmed === 'boolean' && Number.isFinite(entry?.at)) {
        _states.set(key, { confirmed: entry.confirmed, at: entry.at });
      }
    }
    console.log(`[alert-state] Loaded ${_states.size} region(s)`);
  } catch (err) {
    if (err?.code !== 'ENOENT') {
      // Corrupt file must not block startup; the watcher just seeds silently.
      console.error('[alert-state] Could not read store, starting empty:', err?.message ?? err);
    }
  }
  return getAlertState();
}

/** @returns {Record<string, { confirmed: boolean, at: number }>} */
export function getAlertState() {
  return Object.fromEntries([..._states].map(([k, v]) => [k, { ...v }]));
}

/** Records a confirmed transition and schedules an atomic write. */
export function recordAlertState(cacheKey, confirmed, at = Date.now()) {
  _states.set(String(cacheKey), { confirmed: Boolean(confirmed), at });

  const snapshot = JSON.stringify(
    { version: FORMAT_VERSION, regions: Object.fromEntries(_states) },
    null,
    2
  );
  const file = getAlertStateFile();

  _writeChain = _writeChain
    .then(async () => {
      const tmp = `${file}.tmp`;
      await fs.mkdir(path.dirname(file), { recursive: true });
      await fs.writeFile(tmp, snapshot, 'utf8');
      await fs.rename(tmp, file);
    })
    .catch((err) => {
      console.error('[alert-state] Failed to persist:', err?.message ?? err);
    });

  return _writeChain;
}
