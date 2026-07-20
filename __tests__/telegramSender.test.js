/**
 * These are unprompted messages: nobody re-asks for a notification they never
 * knew was coming, so a dropped 429 is a notification lost outright.
 */
import { describe, it, expect, vi } from 'vitest';

import {
  createSender,
  retryAfterMs,
  isDeadChatError,
  DEFAULT_MIN_INTERVAL_MS,
} from '../telegramSender.js';

/** Virtual clock: sleep advances time instantly, so pacing is observable. */
function makeClock() {
  let t = 0;
  return {
    now: () => t,
    sleep: async (ms) => {
      t += ms;
    },
    advance: (ms) => {
      t += ms;
    },
    get time() {
      return t;
    },
  };
}

const flood = (seconds) => {
  const err = new Error('ETELEGRAM: 429 Too Many Requests');
  err.response = { body: { error_code: 429, parameters: { retry_after: seconds } } };
  return err;
};

const blocked = () => {
  const err = new Error('ETELEGRAM: 403 Forbidden');
  err.response = { body: { error_code: 403, description: 'Forbidden: bot was blocked by the user' } };
  return err;
};

const silence = { warn: () => {}, error: () => {} };

describe('retryAfterMs', () => {
  it('reads retry_after from the shapes clients actually use', () => {
    expect(retryAfterMs(flood(3))).toBe(3000);
    expect(retryAfterMs({ parameters: { retry_after: 2 } })).toBe(2000);
    expect(retryAfterMs({ response: { parameters: { retry_after: 1 } } })).toBe(1000);
    expect(retryAfterMs({ retry_after: 0 })).toBe(0);
  });

  it('returns null when the error is not a flood wait', () => {
    expect(retryAfterMs(new Error('socket hang up'))).toBeNull();
    expect(retryAfterMs(null)).toBeNull();
    expect(retryAfterMs({ response: { body: {} } })).toBeNull();
  });
});

describe('isDeadChatError', () => {
  it('recognises chats that will never accept messages again', () => {
    expect(isDeadChatError(blocked())).toBe(true);
    for (const description of [
      'Forbidden: bot was kicked from the group chat',
      'Bad Request: chat not found',
      'Forbidden: user is deactivated',
    ]) {
      expect(isDeadChatError({ response: { body: { error_code: 403, description } } })).toBe(true);
    }
  });

  it('does not treat transient or unexplained failures as dead chats', () => {
    // Unsubscribing someone by mistake is silent data loss, so this stays narrow.
    expect(isDeadChatError(flood(5))).toBe(false);
    expect(isDeadChatError(new Error('socket hang up'))).toBe(false);
    expect(isDeadChatError({ response: { body: { error_code: 400, description: 'Bad Request: message is too long' } } })).toBe(false);
    expect(isDeadChatError({ response: { body: { error_code: 500, description: 'Internal Server Error' } } })).toBe(false);
  });
});

describe('createSender', () => {
  it('requires a send function', () => {
    expect(() => createSender()).toThrow('send is required');
  });

  it('delivers every message in order', async () => {
    const clock = makeClock();
    const seen = [];
    const sender = createSender({
      send: async (chatId, text) => seen.push(`${chatId}:${text}`),
      ...clock,
      log: silence,
    });

    const results = await Promise.all([
      sender.sendTo(1, 'a'),
      sender.sendTo(2, 'b'),
      sender.sendTo(3, 'c'),
    ]);

    expect(results).toEqual(['sent', 'sent', 'sent']);
    expect(seen).toEqual(['1:a', '2:b', '3:c']);
  });

  it('paces sends so a fan-out cannot burst past the rate limit', async () => {
    const clock = makeClock();
    const times = [];
    const sender = createSender({
      send: async () => times.push(clock.time),
      ...clock,
      log: silence,
    });

    await Promise.all(Array.from({ length: 5 }, (_, i) => sender.sendTo(i, 'x')));

    expect(times).toHaveLength(5);
    for (let i = 1; i < times.length; i += 1) {
      expect(times[i] - times[i - 1]).toBeGreaterThanOrEqual(DEFAULT_MIN_INTERVAL_MS);
    }
  });

  it('waits exactly as long as Telegram asks, then succeeds', async () => {
    const clock = makeClock();
    let attempts = 0;
    const sender = createSender({
      send: async () => {
        attempts += 1;
        if (attempts === 1) throw flood(5);
      },
      ...clock,
      log: silence,
    });

    const before = clock.time;
    await expect(sender.sendTo(1, 'hello')).resolves.toBe('sent');

    expect(attempts).toBe(2);
    expect(clock.time - before).toBeGreaterThanOrEqual(5000);
  });

  it('gives up after maxRetries instead of looping forever', async () => {
    const clock = makeClock();
    let attempts = 0;
    const sender = createSender({
      send: async () => {
        attempts += 1;
        throw flood(1);
      },
      maxRetries: 2,
      ...clock,
      log: silence,
    });

    await expect(sender.sendTo(1, 'x')).resolves.toBe('failed');
    expect(attempts).toBe(3); // initial + 2 retries
  });

  it('retries transient errors with backoff', async () => {
    const clock = makeClock();
    let attempts = 0;
    const sender = createSender({
      send: async () => {
        attempts += 1;
        if (attempts < 3) throw new Error('socket hang up');
      },
      ...clock,
      log: silence,
    });

    await expect(sender.sendTo(1, 'x')).resolves.toBe('sent');
    expect(attempts).toBe(3);
  });

  it('drops a dead chat immediately and reports it for pruning', async () => {
    const clock = makeClock();
    const onDeadChat = vi.fn();
    let attempts = 0;
    const sender = createSender({
      send: async () => {
        attempts += 1;
        throw blocked();
      },
      onDeadChat,
      ...clock,
      log: silence,
    });

    await expect(sender.sendTo(42, 'x')).resolves.toBe('dropped');

    expect(attempts).toBe(1); // no point retrying
    expect(onDeadChat).toHaveBeenCalledTimes(1);
    expect(onDeadChat.mock.calls[0][0]).toBe(42);
  });

  it('keeps delivering to everyone else when one chat fails', async () => {
    const clock = makeClock();
    const delivered = [];
    const sender = createSender({
      send: async (chatId) => {
        if (chatId === 2) throw blocked();
        delivered.push(chatId);
      },
      ...clock,
      log: silence,
    });

    const results = await Promise.all([1, 2, 3].map((id) => sender.sendTo(id, 'alert')));

    expect(results).toEqual(['sent', 'dropped', 'sent']);
    expect(delivered).toEqual([1, 3]);
  });

  it('survives an onDeadChat hook that throws', async () => {
    const clock = makeClock();
    const sender = createSender({
      send: async () => {
        throw blocked();
      },
      onDeadChat: () => {
        throw new Error('store exploded');
      },
      ...clock,
      log: silence,
    });

    await expect(sender.sendTo(1, 'x')).resolves.toBe('dropped');
  });

  it('drain() waits for the queue and pending() tracks it', async () => {
    const clock = makeClock();
    const sender = createSender({ send: async () => {}, ...clock, log: silence });

    sender.sendTo(1, 'a');
    sender.sendTo(2, 'b');
    expect(sender.pending()).toBe(2);

    await sender.drain();
    expect(sender.pending()).toBe(0);
  });
});
