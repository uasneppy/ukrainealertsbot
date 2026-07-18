/**
 * Long-lived WebSocket connection to the NEPTUN live stream.
 *
 * Handles:
 *   snapshot — replaces the entire threats map
 *   upsert   — adds or updates a single threat
 *   remove   — removes a threat by id
 *   alerts   — replaces the alerts state (raions / oblasts)
 *   heartbeat — keepalive, refreshes the freshness clock
 *
 * Resilience:
 *   - Auto-reconnects with exponential backoff (1 s → 2 s → … → 30 s cap).
 *   - Watchdog: pings the server and force-reconnects when no traffic has
 *     arrived for STALE_AFTER_MS. Half-open TCP connections (NAT timeout,
 *     server restart without FIN) never emit 'close', so without this the
 *     in-memory state silently freezes and the bot serves outdated maps.
 *   - streamAgeMs() exposes freshness so consumers can fall back to REST.
 */

import WebSocket from 'ws';

const WS_URL = 'wss://neptun.in.ua/api/v1/stream';
const MAX_BACKOFF_MS = 30_000;
const WATCHDOG_INTERVAL_MS = 15_000;
const STALE_AFTER_MS = 90_000;

/** In-memory live state */
const _threats = new Map(); // id → threat object
const _alerts = { raions: [], oblasts: [] };

let _reconnectDelay = 1_000;
let _ws = null;
let _started = false;
let _receivedSnapshot = false;
let _lastTrafficAt = 0; // wall-clock ms of the last WS traffic (message or pong)

/** Returns a point-in-time snapshot of the live state. */
export function getState() {
  return {
    threats: [..._threats.values()],
    alerts: { raions: [..._alerts.raions], oblasts: [..._alerts.oblasts] },
  };
}

/** True once the stream has delivered at least one authoritative state message. */
export function hasSnapshot() {
  return (
    _receivedSnapshot ||
    _threats.size > 0 ||
    _alerts.raions.length > 0 ||
    _alerts.oblasts.length > 0
  );
}

/** Milliseconds since the last WebSocket traffic; Infinity if none yet. */
export function streamAgeMs() {
  return _lastTrafficAt ? Date.now() - _lastTrafficAt : Infinity;
}

function handleMessage(raw) {
  let msg;
  try {
    msg = JSON.parse(raw.toString());
  } catch {
    console.error('[neptun-stream] Unparseable message');
    return;
  }

  _lastTrafficAt = Date.now();

  switch (msg.type) {
    case 'snapshot': {
      _receivedSnapshot = true;
      _threats.clear();
      for (const t of msg.data?.threats ?? []) {
        if (t?.id) _threats.set(t.id, t);
      }
      break;
    }
    case 'upsert': {
      const t = msg.data;
      if (t?.id) _threats.set(t.id, t);
      break;
    }
    case 'remove': {
      const id = msg.data?.id;
      if (id) _threats.delete(id);
      break;
    }
    case 'alerts': {
      _receivedSnapshot = true;
      _alerts.raions = msg.data?.raions ?? [];
      _alerts.oblasts = msg.data?.oblasts ?? [];
      break;
    }
    case 'heartbeat':
      // keepalive — freshness clock already updated above
      break;
    default:
      console.log('[neptun-stream] Unknown message type:', msg.type);
  }
}

function connect() {
  _ws = new WebSocket(WS_URL);

  _ws.on('open', () => {
    console.log('[neptun-stream] Connected');
    _reconnectDelay = 1_000;
    _lastTrafficAt = Date.now();
  });

  _ws.on('message', (data) => handleMessage(data));

  _ws.on('pong', () => {
    _lastTrafficAt = Date.now();
  });

  _ws.on('close', (code, reason) => {
    console.log(
      `[neptun-stream] Disconnected (${code}). Reconnecting in ${_reconnectDelay / 1000}s…`
    );
    setTimeout(connect, _reconnectDelay);
    _reconnectDelay = Math.min(_reconnectDelay * 2, MAX_BACKOFF_MS);
  });

  _ws.on('error', (err) => {
    // The 'close' event fires right after 'error', so reconnect is handled there.
    console.error('[neptun-stream] Error:', err.message);
  });
}

/**
 * Detects half-open connections: the socket looks OPEN but no traffic (data,
 * heartbeat or pong) has arrived for STALE_AFTER_MS. terminate() forces the
 * 'close' event, which triggers the normal reconnect path.
 */
function watchdogTick() {
  if (!_ws || _ws.readyState !== WebSocket.OPEN) return; // reconnect logic owns other states
  const age = streamAgeMs();
  if (age > STALE_AFTER_MS) {
    console.warn(
      `[neptun-stream] No traffic for ${Math.round(age / 1000)}s — forcing reconnect`
    );
    _ws.terminate();
    return;
  }
  try {
    _ws.ping();
  } catch {
    // Socket died between checks — 'close' will follow and reconnect.
  }
}

/**
 * Starts the WebSocket stream connection and its freshness watchdog.
 * Safe to call multiple times — only connects once.
 */
export function startStream() {
  if (_started) return;
  _started = true;
  connect();
  const timer = setInterval(watchdogTick, WATCHDOG_INTERVAL_MS);
  timer.unref?.();
}

/** Test hooks — not used by production code paths. */
export const __testables = {
  handleMessage,
  reset() {
    _threats.clear();
    _alerts.raions = [];
    _alerts.oblasts = [];
    _receivedSnapshot = false;
    _lastTrafficAt = 0;
  },
};
