/**
 * One-off REST calls to the public NEPTUN API.
 * No API key required.
 */

const BASE = 'https://neptun.in.ua/api/v1';

/**
 * Fetches the current threat list.
 * @returns {Promise<Array>} Array of threat objects.
 */
export async function fetchThreats() {
  const response = await fetch(`${BASE}/threats`);
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
  const response = await fetch(`${BASE}/alerts`);
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
