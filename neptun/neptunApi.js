/**
 * One-off REST calls to the public NEPTUN API.
 * No API key required.
 */

import { fetchWithTimeout } from '../fetchWithTimeout.js';

const BASE = 'https://neptun.in.ua/api/v1';

/** Short deadline — these calls block a user waiting on a map reply. */
const TIMEOUT_MS = 8_000;

/**
 * Fetches the current threat list.
 * @returns {Promise<{ threats: Array, serverTime: string|null }>} `serverTime`
 *   is when NEPTUN built the snapshot — the only way to tell a fresh answer
 *   from one a CDN has been holding.
 */
export async function fetchThreatsSnapshot() {
  const response = await fetchWithTimeout(`${BASE}/threats`, { timeoutMs: TIMEOUT_MS });
  if (!response.ok) {
    throw new Error(`NEPTUN threats API error: HTTP ${response.status}`);
  }
  const data = await response.json();
  // The API may return { threats: [...] } or just [...]
  return {
    threats: Array.isArray(data) ? data : (data?.threats ?? []),
    serverTime: typeof data?.serverTime === 'string' ? data.serverTime : null,
  };
}

/**
 * Fetches the current threat list.
 * @returns {Promise<Array>} Array of threat objects.
 */
export async function fetchThreats() {
  return (await fetchThreatsSnapshot()).threats;
}

/**
 * Fetches the current air-raid alert state.
 *
 * Entries carry `level` ('red' | 'yellow') and `reasons`; the payload carries
 * `version` and `updatedAt` — when the alert state last *changed*, not when
 * this copy was made, so they order two copies but can't age one on its own.
 *
 * @returns {Promise<{ raions: Array, oblasts: Array, version?: number, updatedAt?: string }>}
 */
export async function fetchAlerts() {
  const response = await fetchWithTimeout(`${BASE}/alerts`, { timeoutMs: TIMEOUT_MS });
  if (!response.ok) {
    throw new Error(`NEPTUN alerts API error: HTTP ${response.status}`);
  }
  return normalizeAlertsPayload(await response.json());
}

/** `{ raions, oblasts }` plus the version stamps when the payload has them. */
export function normalizeAlertsPayload(data) {
  const alerts = {
    raions: data?.raions ?? [],
    oblasts: data?.oblasts ?? [],
  };
  if (Number.isFinite(data?.version)) alerts.version = data.version;
  if (typeof data?.updatedAt === 'string') alerts.updatedAt = data.updatedAt;
  return alerts;
}

/**
 * Convenience: fetch both threats and alerts in parallel.
 * @returns {Promise<{ threats: Array, alerts: object, serverTime: string|null }>}
 */
export async function fetchSnapshot() {
  const [{ threats, serverTime }, alerts] = await Promise.all([fetchThreatsSnapshot(), fetchAlerts()]);
  return { threats, alerts, serverTime };
}

/**
 * The monitoring-channel feed NEPTUN aggregates (the Air Force channel, the
 * intelligence channels, dozens of hyperlocal ones): the last ~10 minutes of
 * raw messages. This is where "strategic aviation took off" and "Kalibr
 * carriers at sea" live — nothing on the threat map says that.
 *
 * @returns {Promise<Array<{ channel: string, text: string, date: string }>>}
 */
export async function fetchChannelMessages() {
  const response = await fetchWithTimeout(`${BASE}/messages`, { timeoutMs: TIMEOUT_MS });
  if (!response.ok) {
    throw new Error(`NEPTUN messages API error: HTTP ${response.status}`);
  }
  const data = await response.json();
  const list = Array.isArray(data) ? data : (data?.messages ?? []);
  return list.filter((m) => m && typeof m.text === 'string');
}
