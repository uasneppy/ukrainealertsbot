/**
 * Watches subscribed regions and reports two kinds of unprompted notification:
 *
 *   • Alert transitions — тривога starting / відбій — per region.
 *   • Live threat events — a fast, dangerous target (missile, ballistic, KAB)
 *     appearing near a subscribed region or entering it. These are the
 *     "react now" notifications the operator asked for.
 *   • Advisories — NEPTUN marks a *risk* ("Балістична загроза" over Kyiv, a
 *     MiG-31K in the air) with the same threat types it uses for tracked
 *     objects. Read as an object, a ballistic advisory became "балістика
 *     наближається, ~40 км" for a missile nobody had launched. So advisories
 *     are told apart (threatMeta.threatNature), phrased as a warning, and said
 *     once per region per quiet window — not on every re-issued track id.
 *
 * Rules that keep this a notifier and not a firehose:
 *
 *  1. Never announce from stale data. If the stream isn't fresh the tick is
 *     skipped entirely — an "відбій" or a phantom missile from a dead socket is
 *     worse than silence, because people act on it.
 *  2. Edge-triggered, and the first observation only seeds state. A restart must
 *     not re-blast "тривога" — or "ракета летить" — for things already in the
 *     sky when the bot came up.
 *  3. Confirmation is asymmetric for alerts: тривога goes out at once, відбій
 *     must hold for CONFIRM_OFF_MS first (a premature all-clear is the costly
 *     mistake).
 *  4. Threat events are event-based, not continuous. A target is announced when
 *     it appears (approaching) and again when it enters the region — never per
 *     tick as it drifts, which is the main source of spam. Only high-priority
 *     types qualify; drones/recon are covered by the region alert and the map.
 *  5. An advisory is said once. NEPTUN re-issues advisory tracks under new ids
 *     as sources repeat the warning; each would otherwise be "news" again.
 *     After one announcement the same kind of advisory for the same region is
 *     silent for advisoryQuietMs, however many ids it goes through.
 *
 * Dependencies are injected so the whole thing is testable without a socket.
 */

import { buildRegionStatus, fmtKyivTime } from './regionContext.js';
import { subscribedRegions } from './subscriptions.js';

/** Alert start: announced as soon as it is observed. */
export const DEFAULT_CONFIRM_ON_MS = 0;
/**
 * All-clear: must hold this long before it's announced, so a feed that briefly
 * flaps off-then-on doesn't sound the retreat. A premature "відбій" is the
 * costly mistake, so this stays non-zero — but 30 s balances that against not
 * making people wait a minute-plus for a real all-clear. Tunable via
 * CONFIRM_OFF_MS.
 */
export const DEFAULT_CONFIRM_OFF_MS = 30_000;
/**
 * Safety-net poll. The fast path is wake() — the stream nudges the watcher the
 * moment a threat changes — so this only has to catch changes the stream can't
 * signal (e.g. an alert flip the API shows but the socket missed). Kept short so
 * even that path is timely.
 */
export const DEFAULT_INTERVAL_MS = 8_000;
/**
 * wake() coalesces bursts: at most one triggered tick this often. Kept short
 * because a stream-backed tick is cheap (no network) — the point is only to
 * fold a flurry of upserts into one check.
 */
export const DEFAULT_MIN_TICK_GAP_MS = 1_500;

/**
 * How old persisted state may be and still be worth reconciling against. After
 * a long outage the transitions people missed are history, not news.
 */
export const DEFAULT_STALE_STATE_MS = 6 * 60 * 60 * 1000;

/**
 * Fast, dangerous types that get per-target live notifications. MiG-31K is
 * deliberately absent: the marker is the carrier aircraft over Russia, so
 * "MiG-31K approaching, 110 km" is never true of anyone's region — its
 * take-off is a nationwide event and is announced by the event watcher.
 */
export const DEFAULT_LIVE_ALERT_TYPES = ['missile', 'ballistic', 'kab'];
/**
 * After an advisory (e.g. ballistic risk) is announced for a region, the same
 * kind of advisory there stays silent this long. Sources repeat the warning
 * every few minutes through the night; one message is the warning, the rest
 * is noise that teaches people to mute the bot.
 */
export const DEFAULT_ADVISORY_QUIET_MS = 30 * 60 * 1000;
/** A "near" target this far or closer, and approaching, is worth announcing. */
export const DEFAULT_LIVE_ALERT_KM = 120;
/** Heading within this many degrees of the region counts as "approaching". */
const APPROACH_CONE_DEG = 60;

/** True when a nearby target is heading roughly toward the region. */
function isApproaching(threat) {
  if (threat.inRegion) return true;
  // Unknown heading/bearing → assume yes; never suppress a possible threat.
  if (!Number.isFinite(threat.heading) || !Number.isFinite(threat.bearingFromRegion)) return true;
  const towardRegion = (threat.bearingFromRegion + 180) % 360;
  const raw = Math.abs((threat.heading - towardRegion + 360) % 360);
  const angle = Math.min(raw, 360 - raw);
  return angle <= APPROACH_CONE_DEG;
}

export function createAlertWatcher({
  getSnapshot,
  getGeo,
  notify,
  listRegions = subscribedRegions,
  confirmOnMs = DEFAULT_CONFIRM_ON_MS,
  confirmOffMs = DEFAULT_CONFIRM_OFF_MS,
  intervalMs = DEFAULT_INTERVAL_MS,
  minTickGapMs = DEFAULT_MIN_TICK_GAP_MS,
  initialStates = null,
  onStateChange = null,
  staleStateMs = DEFAULT_STALE_STATE_MS,
  liveAlertTypes = DEFAULT_LIVE_ALERT_TYPES,
  liveAlertKm = DEFAULT_LIVE_ALERT_KM,
  advisoryQuietMs = DEFAULT_ADVISORY_QUIET_MS,
  now = () => Date.now(),
} = {}) {
  if (typeof getSnapshot !== 'function') throw new Error('getSnapshot is required');
  if (typeof getGeo !== 'function') throw new Error('getGeo is required');
  if (typeof notify !== 'function') throw new Error('notify is required');

  const prioritySet = new Set(liveAlertTypes);
  /**
   * cacheKey → { confirmed, candidate, candidateSince,
   *              threats: Map<id, stage>, advisoryAt: Map<type, epoch ms> }
   */
  const states = new Map();
  let timer = null;
  let ticking = false;   // re-entrancy guard: periodic + wake() must not overlap
  let lastTickAt = 0;
  let wakeTimer = null;

  /**
   * Reconciles the tracked high-priority threats for a region against the
   * current status, returning the events to announce. `seeding` records the
   * current set silently (first tick / restart) so nothing already in the sky
   * is re-announced.
   *
   * @returns {Array<{ stage: 'near'|'in', threat: object }>}
   */
  function trackThreats(tracked, status, seeding) {
    // "in" wins over "near" for the same id; keep the strongest stage per id.
    const byId = new Map();
    const consider = (threat, stage) => {
      // Advisories are handled by trackAdvisories: an approach cone and a
      // distance mean nothing for a warning about a place.
      if (!threat?.id || !prioritySet.has(threat.type) || threat.nature === 'advisory') return;
      const prev = byId.get(threat.id);
      if (!prev || (prev.stage === 'near' && stage === 'in')) byId.set(threat.id, { threat, stage });
    };
    for (const threat of status.threatsIn) consider(threat, 'in');
    for (const threat of status.threatsNear) {
      if (threat.distanceKm <= liveAlertKm && isApproaching(threat)) consider(threat, 'near');
    }

    const events = [];
    const seen = new Set();
    for (const [id, { threat, stage }] of byId) {
      seen.add(id);
      const prevStage = tracked.get(id);
      tracked.set(id, stage);
      if (seeding) continue; // record silently the first time we see the region
      if (!prevStage) events.push({ stage, threat });                       // appeared
      else if (prevStage === 'near' && stage === 'in') events.push({ stage: 'in', threat }); // entered
      // prev 'in' → nothing; 'near' → 'near' → nothing (no per-tick drift spam)
    }
    // A track that's gone (passed / lost) is dropped; a new id re-notifies.
    for (const id of [...tracked.keys()]) if (!seen.has(id)) tracked.delete(id);
    return events;
  }

  /**
   * Advisories that apply to the region: a warning positioned inside it (an
   * oblast-wide risk is placed at the oblast; a city one at the city). Nearby
   * advisories are ignored — a ballistic risk for Kharkiv is not news in Sumy.
   * Announced once per type per quiet window, regardless of how many track
   * ids the feed issues for it; the id set is still recorded so the same track
   * is never considered twice.
   *
   * @returns {Array<{ threat: object }>}
   */
  function trackAdvisories(state, status, seeding, t) {
    const events = [];
    const seen = new Set();
    for (const threat of status.threatsIn) {
      if (!threat?.id || threat.nature !== 'advisory' || !prioritySet.has(threat.type)) continue;
      seen.add(threat.id);
      const known = state.threats.has(threat.id);
      state.threats.set(threat.id, 'advisory');
      if (known) continue;
      // "Never announced" must not read as "announced at epoch 0": with a
      // small clock that would look like inside the quiet window.
      const last = state.advisoryAt.get(threat.type);
      if (seeding || (last != null && t - last < advisoryQuietMs)) {
        // Seeding: whatever is on the board at boot was already announced (or
        // is history). Either way the quiet window starts now, so a re-issued
        // id a minute after a restart is not a second warning.
        if (seeding) state.advisoryAt.set(threat.type, t);
        continue;
      }
      state.advisoryAt.set(threat.type, t);
      events.push({ threat });
    }
    for (const [id, stage] of [...state.threats]) {
      if (stage === 'advisory' && !seen.has(id)) state.threats.delete(id);
    }
    return events;
  }

  async function runTick() {
    const regions = listRegions();
    if (!regions.length) return { skipped: 'no-subscribers', announced: [] };

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
      const seeding = !state;

      // ── Alert transition (тривога / відбій) ──
      if (seeding) {
        const remembered = initialStates ? initialStates[region.cacheKey] : null;
        const usable =
          remembered &&
          typeof remembered.confirmed === 'boolean' &&
          t - (remembered.at ?? 0) <= staleStateMs;

        state = { confirmed: active, candidate: active, candidateSince: t, threats: new Map(), advisoryAt: new Map() };
        states.set(region.cacheKey, state);

        if (usable && remembered.confirmed !== active) {
          if (active) {
            // Тривога began while we were down — a deploy during a raid. The
            // one case where the first tick must speak, and speak at once.
            onStateChange?.(region.cacheKey, active, t);
            announced.push({ kind: 'alert', region, chatIds, active, status, missedWhileDown: true });
          } else {
            // Відбій while we were down. Even here it must survive the
            // confirmOffMs hold: the first read after boot is exactly when a
            // flapping feed or a half-warm stream is most likely, and a
            // premature all-clear is the costly mistake. Seed the old
            // confirmed state and let the normal hold logic announce it.
            state.confirmed = true;
          }
        } else if (!usable) {
          onStateChange?.(region.cacheKey, active, t);
        }
      } else {
        if (active !== state.candidate) {
          state.candidate = active;
          state.candidateSince = t;
        }
        const requiredHoldMs = state.candidate ? confirmOnMs : confirmOffMs;
        if (state.candidate !== state.confirmed && t - state.candidateSince >= requiredHoldMs) {
          state.confirmed = state.candidate;
          onStateChange?.(region.cacheKey, state.confirmed, t);
          announced.push({ kind: 'alert', region, chatIds, active: state.confirmed, status });
        }
      }

      // ── Live threat events (missiles / ballistics / …) ──
      const events = trackThreats(state.threats, status, seeding);
      if (events.length) {
        // One message per region per tick, even for several targets at once.
        announced.push({ kind: 'threat', region, chatIds, events, status });
      }

      // ── Advisories (a risk announced for the region, not an object) ──
      const advisories = trackAdvisories(state, status, seeding, t);
      if (advisories.length) {
        announced.push({ kind: 'advisory', region, chatIds, events: advisories, status });
      }
    }

    for (const event of announced) {
      try {
        await notify(event);
      } catch (err) {
        console.error(`[alert-watcher] notify failed for ${event.region.name}:`, err?.message ?? err);
      }
    }

    return { skipped: null, announced };
  }

  /**
   * Runs one tick, but never overlapping another. The periodic timer and wake()
   * both call this; a tick that arrives while one is in flight is dropped (the
   * running one already reflects the latest state by the time it reads it).
   */
  async function tick() {
    if (ticking) return { skipped: 'busy', announced: [] };
    ticking = true;
    lastTickAt = now();
    try {
      return await runTick();
    } finally {
      ticking = false;
    }
  }

  /**
   * Nudge the watcher to check soon — called when the stream reports changed
   * state. Coalesced to at most one triggered tick per minTickGapMs so a burst
   * of upserts during a raid doesn't become a burst of REST fetches.
   */
  function wake() {
    if (wakeTimer) return; // one already scheduled — it'll pick up the latest
    const delay = Math.max(0, minTickGapMs - (now() - lastTickAt));
    wakeTimer = setTimeout(() => {
      wakeTimer = null;
      tick().catch((err) => console.error('[alert-watcher] wake tick failed:', err?.message ?? err));
    }, delay);
    wakeTimer.unref?.();
  }

  return {
    tick,
    wake,
    snapshotStates: () => new Map([...states].map(([k, v]) => [k, { ...v, threats: new Map(v.threats), advisoryAt: new Map(v.advisoryAt) }])),
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
      if (wakeTimer) {
        clearTimeout(wakeTimer);
        wakeTimer = null;
      }
    },
  };
}

// ── Notification text ─────────────────────────────────────────────────────────

/** Ukrainian text for an alert transition (тривога / відбій). */
export function formatAlertNotification({ region, active, status }) {
  if (!active) {
    return `🟢 Відбій тривоги — ${region.name}`;
  }

  const since = fmtKyivTime(status?.alertSince);
  const lines = [`🔴 Повітряна тривога — ${region.name}${since ? ` (з ${since})` : ''}`];

  const threats = status?.threatsIn ?? [];
  if (threats.length) {
    const summary = new Map();
    for (const threat of threats) summary.set(threat.name, (summary.get(threat.name) ?? 0) + 1);
    lines.push(`⚠️ У регіоні: ${[...summary.entries()].map(([n, c]) => `${n} ×${c}`).join(', ')}`);
  }

  lines.push(`🗺 Мапа: /map ${region.name}`);
  return lines.join('\n');
}

const threatWhere = ({ stage, threat }) => {
  // `destination` means the feed's point is where the target is heading, so
  // "над Обухів" would put it overhead a town it hasn't reached yet.
  const heading = threat.destination && threat.locality ? `курсом на ${threat.locality}` : '';
  if (stage === 'in') {
    if (heading) return heading;
    if (!threat.locality) return 'у регіоні';
    return threat.approx ? `у районі ${threat.locality}` : `над ${threat.locality}`;
  }
  const dir = threat.direction ? ` на ${threat.direction}` : '';
  const course = !heading && threat.headingWord ? `, курс ${threat.headingWord}` : '';
  const place = heading ? ` · ${heading}` : threat.locality ? ` · ${threat.locality}` : '';
  return `~${threat.distanceKm} км${dir}${course}${place}`;
};

/**
 * Ukrainian text for one or more live threat events in a region. A single
 * missile is one urgent line; several at once are summarised so a raid is one
 * message per region per tick, not a burst.
 */
export function formatThreatNotification({ region, events }) {
  // Urgency marker, distinct from the threat's own type emoji (so a missile
  // isn't "🚀 🚀"): 🚨 once something is overhead, ⚠️ while it's inbound.
  const anyIn = events.some((e) => e.stage === 'in');
  const head = anyIn ? '🚨' : '⚠️';

  if (events.length === 1) {
    const e = events[0];
    // "in" already reads "над <locality>"; don't prefix it again.
    const detail = e.stage === 'in' ? threatWhere(e) : `наближається: ${threatWhere(e)}`;
    return [
      `${head} ${e.threat.emoji} ${e.threat.name} — ${region.name}`,
      detail,
      `🗺 Мапа: /map ${region.name}`,
    ].join('\n');
  }

  const lines = [`${head} ${region.name}: ${events.length} ${pluralTargets(events.length)}`];
  for (const e of events.slice(0, 6)) {
    lines.push(`• ${e.threat.emoji} ${e.threat.name} — ${threatWhere(e)}`);
  }
  if (events.length > 6) lines.push(`…та ще ${events.length - 6}`);
  lines.push(`🗺 Мапа: /map ${region.name}`);
  return lines.join('\n');
}

/**
 * Ukrainian text for advisories in a region. Deliberately not urgent-sounding:
 * it says a risk was announced, quotes NEPTUN's own explanation when there is
 * one, and states plainly that nothing has been launched — the sentence that
 * was missing when "Балістика — Київ, наближається" went out for a warning.
 */
export function formatAdvisoryNotification({ region, events }) {
  const lines = [];
  for (const { threat } of events.slice(0, 4)) {
    lines.push(`⚠️ ${threat.emoji} ${threat.name} — ${region.name}`);
    const explanation = String(threat.explanationShort ?? '').trim();
    if (explanation) lines.push(explanation.length > 200 ? `${explanation.slice(0, 199)}…` : explanation);
  }
  lines.push('Це попередження про ризик, а не зафіксований пуск. Стежте за тривогою у своєму районі.');
  lines.push(`🗺 Мапа: /map ${region.name}`);
  return lines.join('\n');
}

function pluralTargets(n) {
  const mod10 = n % 10;
  const mod100 = n % 100;
  if (mod10 === 1 && mod100 !== 11) return 'ціль';
  if (mod10 >= 2 && mod10 <= 4 && (mod100 < 10 || mod100 >= 20)) return 'цілі';
  return 'цілей';
}
