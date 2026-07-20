/**
 * Watches subscribed regions and reports alert start / all-clear transitions.
 *
 * Three rules make the difference between a useful notifier and a harmful one:
 *
 *  1. Never announce from stale data. If the stream isn't fresh the tick is
 *     skipped entirely — an "відбій" sent because our socket died is worse
 *     than no message at all, since people act on it.
 *  2. Edge-triggered, and the first observation only seeds state. Otherwise
 *     every restart would blast "тривога" at every subscriber for alerts that
 *     have been running for hours.
 *  3. Confirmation is asymmetric. An alert starting goes out immediately —
 *     people are heading for shelter and a minute of debounce is a minute of
 *     warning thrown away. An all-clear must hold for CONFIRM_OFF_MS first,
 *     because telling someone it's over when it isn't is the one mistake here
 *     with a real cost.
 *
 * Dependencies are injected so the whole thing is testable without a socket.
 */

import { buildRegionStatus } from './regionContext.js';
import { subscribedRegions } from './subscriptions.js';

/** Alert start: announced as soon as it is observed. */
export const DEFAULT_CONFIRM_ON_MS = 0;
/** All-clear: must hold this long, so a flapping feed can't sound the retreat. */
export const DEFAULT_CONFIRM_OFF_MS = 60_000;
export const DEFAULT_INTERVAL_MS = 20_000;

export function createAlertWatcher({
  getSnapshot,
  getGeo,
  notify,
  listRegions = subscribedRegions,
  confirmOnMs = DEFAULT_CONFIRM_ON_MS,
  confirmOffMs = DEFAULT_CONFIRM_OFF_MS,
  intervalMs = DEFAULT_INTERVAL_MS,
  now = () => Date.now(),
} = {}) {
  if (typeof getSnapshot !== 'function') throw new Error('getSnapshot is required');
  if (typeof getGeo !== 'function') throw new Error('getGeo is required');
  if (typeof notify !== 'function') throw new Error('notify is required');

  /** cacheKey → { confirmed, candidate, candidateSince } */
  const states = new Map();
  let timer = null;

  async function tick() {
    const regions = listRegions();
    if (!regions.length) return { skipped: 'no-subscribers', announced: [] };

    // null means "nothing trustworthy to reason about" — see rule 1. Awaited
    // because the authoritative source is the API, not in-memory stream state.
    const snapshot = await getSnapshot();
    if (!snapshot) return { skipped: 'stale', announced: [] };

    const geo = await getGeo();
    const t = now();
    const announced = [];

    for (const { region, chatIds } of regions) {
      const status = buildRegionStatus({
        region,
        threats: snapshot.threats ?? [],
        alerts: snapshot.alerts ?? {},
        geo,
      });
      const active = status.alertActive;

      let state = states.get(region.cacheKey);
      if (!state) {
        // Rule 2: seed silently.
        states.set(region.cacheKey, { confirmed: active, candidate: active, candidateSince: t });
        continue;
      }

      if (active !== state.candidate) {
        state.candidate = active;
        state.candidateSince = t;
      }

      // Rule 3: alerts go out at once, all-clears have to prove themselves.
      const requiredHoldMs = state.candidate ? confirmOnMs : confirmOffMs;
      if (state.candidate !== state.confirmed && t - state.candidateSince >= requiredHoldMs) {
        state.confirmed = state.candidate;
        announced.push({ region, chatIds, active: state.confirmed, status });
      }
    }

    for (const event of announced) {
      // One unreachable chat (blocked bot, deleted group) must not stop the
      // rest of the notifications from going out.
      try {
        await notify(event);
      } catch (err) {
        console.error(
          `[alert-watcher] notify failed for ${event.region.name}:`,
          err?.message ?? err
        );
      }
    }

    return { skipped: null, announced };
  }

  return {
    tick,

    /** Current confirmed state per region — diagnostics and tests. */
    snapshotStates: () => new Map([...states].map(([k, v]) => [k, { ...v }])),

    start() {
      if (timer) return;
      timer = setInterval(() => {
        tick().catch((err) => console.error('[alert-watcher] tick failed:', err?.message ?? err));
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

/** Ukrainian notification text for a confirmed transition. */
export function formatAlertNotification({ region, active, status }) {
  if (!active) {
    return `🟢 Відбій тривоги — ${region.name}`;
  }

  const lines = [`🔴 Повітряна тривога — ${region.name}`];

  const threats = status?.threatsIn ?? [];
  if (threats.length) {
    const summary = new Map();
    for (const threat of threats) {
      summary.set(threat.name, (summary.get(threat.name) ?? 0) + 1);
    }
    const parts = [...summary.entries()].map(([name, count]) => `${name} ×${count}`);
    lines.push(`⚠️ У регіоні: ${parts.join(', ')}`);
  }

  // Command form, not a sentence: building "тривога в <name>" would need the
  // locative case ("в закарпатській області"), and a nominative name dropped
  // into that slot reads as broken Ukrainian.
  lines.push(`🗺 Мапа: /map ${region.name}`);
  return lines.join('\n');
}
