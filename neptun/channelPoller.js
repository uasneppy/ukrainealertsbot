/**
 * Polls public Telegram channels that NEPTUN does not aggregate (the radio-log
 * style ones — @AerisRimor, @StrategicaviationT) through their t.me web
 * preview, the same way «чому тривога» already reads @kpszsu.
 *
 * The preview is rate-limited and a channel owner can switch it off at any
 * time, so each channel fails on its own, the failure is a skipped poll, and
 * /status can see it. Never a guess, never a crash.
 */

export const DEFAULT_POLL_MS = 60_000;

export function createChannelPoller({
  channels = [],
  fetchChannel,          // (handle) => Promise<Array<{ channel, text, date }>>
  onMessages,            // (messages) => void
  intervalMs = DEFAULT_POLL_MS,
  now = () => Date.now(),
  log = console,
} = {}) {
  if (typeof fetchChannel !== 'function') throw new Error('fetchChannel is required');
  if (typeof onMessages !== 'function') throw new Error('onMessages is required');

  const handles = [...new Set(channels.map((c) => String(c).trim()).filter(Boolean))];
  const stats = new Map(handles.map((h) => [h, { lastOkAt: 0, lastError: null, received: 0 }]));
  let timer = null;
  let ticking = false;

  async function runTick() {
    const received = [];
    for (const handle of handles) {
      const s = stats.get(handle);
      try {
        const list = await fetchChannel(handle);
        s.lastOkAt = now();
        s.lastError = null;
        s.received += list.length;
        received.push(...list.map((m) => ({ ...m, channel: m.channel ?? handle })));
      } catch (err) {
        s.lastError = err?.message ?? String(err);
        log.warn?.(`[channel-poller] ${handle}: ${s.lastError}`);
      }
    }
    if (received.length) {
      try {
        onMessages(received);
      } catch (err) {
        log.error?.('[channel-poller] onMessages failed:', err?.message ?? err);
      }
    }
    return received.length;
  }

  async function tick() {
    if (ticking) return 0;
    ticking = true;
    try {
      return await runTick();
    } finally {
      ticking = false;
    }
  }

  return {
    tick,
    channels: () => [...handles],
    stats: () => Object.fromEntries([...stats].map(([h, s]) => [h, { ...s }])),
    start() {
      if (timer || !handles.length) return;
      timer = setInterval(() => {
        tick().catch((err) => log.error?.('[channel-poller] tick failed:', err?.message ?? err));
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
