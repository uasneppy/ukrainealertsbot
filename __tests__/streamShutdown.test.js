/**
 * stopStream() backs the SIGTERM path in bot.js: a deploy must not leave a
 * socket, a watchdog interval or a pending reconnect behind while the process
 * is trying to exit.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

const { sockets } = vi.hoisted(() => ({ sockets: [] }));

vi.mock('ws', async () => {
  const { EventEmitter } = await import('events');
  class FakeSocket extends EventEmitter {
    static OPEN = 1;

    constructor(url) {
      super();
      this.url = url;
      this.readyState = FakeSocket.OPEN;
      this.terminated = false;
      this.pings = 0;
      sockets.push(this);
    }

    ping() {
      this.pings += 1;
    }

    terminate() {
      this.terminated = true;
      this.emit('close', 1006);
    }
  }
  return { default: FakeSocket };
});

describe('stopStream', () => {
  beforeEach(() => {
    vi.resetModules();
    sockets.length = 0;
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('terminates the socket and stops reconnecting', async () => {
    const { startStream, stopStream } = await import('../neptun/neptunStream.js');

    startStream();
    sockets[0].emit('open');
    expect(sockets).toHaveLength(1);

    stopStream();
    expect(sockets[0].terminated).toBe(true);

    // Neither the watchdog nor a queued reconnect may resurrect the socket.
    vi.advanceTimersByTime(300_000);
    expect(sockets).toHaveLength(1);
  });

  it('cancels a reconnect that was already scheduled', async () => {
    const { startStream, stopStream } = await import('../neptun/neptunStream.js');

    startStream();
    sockets[0].emit('open');
    sockets[0].emit('close', 1006); // drop → reconnect scheduled for +1 s

    stopStream();
    vi.advanceTimersByTime(300_000);

    expect(sockets).toHaveLength(1);
  });

  it('leaves the watchdog pinging while the stream is running', async () => {
    const { startStream, stopStream } = await import('../neptun/neptunStream.js');

    startStream();
    sockets[0].emit('open');

    vi.advanceTimersByTime(45_000); // three watchdog ticks
    expect(sockets[0].pings).toBeGreaterThan(0);
    expect(sockets[0].terminated).toBe(false);

    stopStream();
  });
});
