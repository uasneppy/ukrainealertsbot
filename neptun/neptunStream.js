/**
 * Long-lived WebSocket connection to the NEPTUN live stream.
 *
 * Handles:
 *   snapshot — replaces the entire threats map
 *   upsert   — adds or updates a single threat
 *   remove   — removes a threat by id
 *   alerts   — replaces the alerts state (raions / oblasts)
 *   heartbeat — keepalive, ignored
 *
 * Auto-reconnects with exponential backoff (1 s → 2 s → … → 30 s cap).
 */

import WebSocket from 'ws';

const WS_URL = 'wss://neptun.in.ua/api/v1/stream';
const MAX_BACKOFF_MS = 30_000;

/** In-memory live state */
const _threats = new Map(); // id → threat object
const _alerts = { raions: [], oblasts: [] };

let _reconnectDelay = 1_000;
let _ws = null;
let _started = false;

/** Returns a point-in-time snapshot of the live state. */
export function getState() {
  return {
    threats: [..._threats.values()],
    alerts: { raions: [..._alerts.raions], oblasts: [..._alerts.oblasts] },
  };
}

/** Returns true if we currently have a live snapshot (received at least one `snapshot` message). */
export function hasSnapshot() {
  return _threats.size > 0 || _alerts.raions.length > 0 || _alerts.oblasts.length > 0;
}

function handleMessage(raw) {
  let msg;
  try {
    msg = JSON.parse(raw.toString());
  } catch {
    console.error('[neptun-stream] Unparseable message');
    return;
  }

  switch (msg.type) {
    case 'snapshot': {
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
      _alerts.raions = msg.data?.raions ?? [];
      _alerts.oblasts = msg.data?.oblasts ?? [];
      break;
    }
    case 'heartbeat':
      // keepalive — nothing to do
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
  });

  _ws.on('message', (data) => handleMessage(data));

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
 * Starts the WebSocket stream connection.
 * Safe to call multiple times — only connects once.
 */
export function startStream() {
  if (_started) return;
  _started = true;
  connect();
}
