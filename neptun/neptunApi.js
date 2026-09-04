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
 * @returns {Promise<Array>} Array of threat objects.
 */
export async function fetchThreats() {
  const response = await fetchWithTimeout(`${BASE}/threats`, { timeoutMs: TIMEOUT_MS });
  if (!response.ok) {
    throw new Error(`NEPTUN threats API error: HTTP ${response.status}`);
  }
  const data = await response.json();
  // The API may return { threats: [...] } or just [...]
  return Array.isArray(data) ? data : (data.threats ?? []);
}

/**
 * Fetches the current air-raid alert state.
 * @returns {Promise<{ raions: string[], oblasts: string[] }>}
 */
export async function fetchAlerts() {
  const response = await fetchWithTimeout(`${BASE}/alerts`, { timeoutMs: TIMEOUT_MS });
  if (!response.ok) {
    throw new Error(`NEPTUN alerts API error: HTTP ${response.status}`);
  }
  const data = await response.json();
  return {
    raions: data.raions ?? [],
    oblasts: data.oblasts ?? [],
  };
}

/**
 * Convenience: fetch both threats and alerts in parallel.
 */
export async function fetchSnapshot() {
  const [threats, alerts] = await Promise.all([fetchThreats(), fetchAlerts()]);
  return { threats, alerts };
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
