/**
 * The single answer to "what is happening right now".
 *
 * The REST API is the authority. The WebSocket stream is faster and is what
 * drives cheap freshness checks, but it cannot be trusted as the source of
 * truth for a user-facing answer: its freshness clock is reset by `heartbeat`
 * and `pong`, so a connection that is alive but has missed an `upsert` or a
 * `remove` looks perfectly healthy while its state has quietly drifted. Nothing
 * ever reconciled that drift, so a map could disagree with the API for as long
 * as the socket stayed up.
 *
 * For an air-raid map that disagreement is the whole failure mode — "there were
 * ballistic missiles inbound and the map was out of sync". So every user-facing
 * request now reads the API, and the stream is the fallback for when the API is
 * unreachable, not the default.
 *
 * Concurrent callers share one request, so a burst of "тривога" in a busy group
 * is a single fetch — but a *current* one, never a cached older answer.
 */

/** How stale stream state may be before it stops being an acceptable fallback. */
export const DEFAULT_STREAM_FALLBACK_MS = 60_000;

export function createSnapshotSource({
  fetchSnapshot,
  getState,
  hasSnapshot,
  streamAgeMs,
  fallbackMs = DEFAULT_STREAM_FALLBACK_MS,
  log = console,
} = {}) {
  if (typeof fetchSnapshot !== 'function') throw new Error('fetchSnapshot is required');
  if (typeof getState !== 'function') throw new Error('getState is required');
  if (typeof hasSnapshot !== 'function') throw new Error('hasSnapshot is required');
  if (typeof streamAgeMs !== 'function') throw new Error('streamAgeMs is required');

  let inFlight = null;

  function fetchOnce() {
    if (!inFlight) {
      // Promise.resolve().then(...) so a synchronous throw is a rejection too.
      inFlight = Promise.resolve()
        .then(() => fetchSnapshot())
        .finally(() => {
          inFlight = null;
        });
    }
    return inFlight;
  }

  /**
   * @returns {Promise<{threats: Array, alerts: object, source: 'api'|'stream'}>}
   * @throws when the API fails and no usable stream state exists — the caller
   *         must say "не вдалося" rather than show something outdated.
   */
  async function get() {
    try {
      const snapshot = await fetchOnce();
      return {
        threats: snapshot?.threats ?? [],
        alerts: snapshot?.alerts ?? { oblasts: [], raions: [] },
        source: 'api',
      };
    } catch (err) {
      if (hasSnapshot() && streamAgeMs() < fallbackMs) {
        log.warn?.('[neptun] API unavailable, falling back to stream state:', err?.message ?? err);
        const state = getState();
        return { threats: state.threats, alerts: state.alerts, source: 'stream' };
      }
      throw err;
    }
  }

  /** Same, but null instead of throwing — for callers that must skip, not guess. */
  async function getOrNull() {
    try {
      return await get();
    } catch (err) {
      log.warn?.('[neptun] No usable live state:', err?.message ?? err);
      return null;
    }
  }

  return { get, getOrNull };
}

/**
 * Freshest-first source for the *alert watcher* — the opposite priority to the
 * map source above.
 *
 * A map is a user asking "what's true right now", so it reads authoritative
 * REST. A notification is a race: a missile is on the WebSocket the instant
 * NEPTUN sees it, while the REST snapshot can lag it by seconds. Being a few
 * seconds late on "ballistic inbound" is the failure the operator reported, so
 * the watcher reads the live stream while it's fresh.
 *
 * The safety valve is a periodic reconcile against REST (every reconcileMs):
 * the stream's `alerts` message is a full replacement, but if the socket ever
 * dropped one, the stream would sit on a stale alert state — so at least that
 * often, and whenever the stream is quiet, we read authoritative REST instead.
 * That bounds a missed "відбій" to reconcileMs rather than "until the socket
 * reconnects".
 */
export function createWatcherSource({
  apiSource,
  getState,
  hasSnapshot,
  streamAgeMs,
  freshMs = 45_000,
  reconcileMs = 30_000,
  now = () => Date.now(),
} = {}) {
  if (!apiSource || typeof apiSource.getOrNull !== 'function') {
    throw new Error('apiSource with getOrNull is required');
  }
  if (typeof getState !== 'function') throw new Error('getState is required');
  if (typeof hasSnapshot !== 'function') throw new Error('hasSnapshot is required');
  if (typeof streamAgeMs !== 'function') throw new Error('streamAgeMs is required');

  let lastReconcileAt = 0;
  const fromStream = () => {
    const s = getState();
    return { threats: s?.threats ?? [], alerts: s?.alerts ?? { oblasts: [], raions: [] } };
  };

  async function get() {
    const streamFresh = hasSnapshot() && streamAgeMs() < freshMs;
    const reconcileDue = now() - lastReconcileAt >= reconcileMs;

    if (streamFresh && !reconcileDue) return fromStream();

    // Reconcile against authoritative REST — or it's our only option because the
    // stream is quiet/down.
    const rest = await apiSource.getOrNull();
    if (rest) {
      lastReconcileAt = now();
      return rest;
    }
    // REST failed. A fresh stream still beats nothing; otherwise skip the tick.
    return streamFresh ? fromStream() : null;
  }

  return { get };
}
