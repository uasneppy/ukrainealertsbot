/**
 * The event watcher fans a nationwide warning out to every subscriber, so its
 * failure modes are the loud ones: re-announcing the last ten minutes of the
 * feed after a restart, saying "take-off" once per channel that repeats it,
 * or trusting a hyperlocal rumour channel with a countrywide alert.
 */
import { describe, it, expect, vi } from 'vitest';

import { createEventWatcher } from '../neptun/eventWatcher.js';

const msg = (text, { channel = '@kpszsu', date = '2026-09-04T19:00:00Z' } = {}) => ({ channel, text, date });
const T0 = Date.parse('2026-09-04T19:00:30Z');

function make({ messages = [], snapshot = null, cooldownMs, uavCooldownMs, channels } = {}) {
  const notify = vi.fn();
  const box = { messages, snapshot };
  let clock = T0;
  const watcher = createEventWatcher({
    fetchMessages: async () => {
      if (box.messages instanceof Error) throw box.messages;
      return box.messages;
    },
    getSnapshot: async () => box.snapshot,
    notify,
    ...(cooldownMs !== undefined ? { cooldownMs } : {}),
    ...(uavCooldownMs !== undefined ? { uavCooldownMs } : {}),
    ...(channels !== undefined ? { channels } : {}),
    now: () => clock,
    log: { warn() {}, error() {} },
  });
  return { watcher, notify, box, advance: (ms) => { clock += ms; } };
}

const at = (offsetSec) => new Date(Date.parse('2026-09-04T19:00:00Z') + offsetSec * 1000).toISOString();

describe('createEventWatcher', () => {
  it('requires its dependencies', () => {
    expect(() => createEventWatcher()).toThrow('fetchMessages is required');
    expect(() => createEventWatcher({ fetchMessages: async () => [] })).toThrow('notify is required');
  });

  it('only seeds on the first poll — a restart does not re-announce the feed', async () => {
    const { watcher, notify } = make({ messages: [msg('Зліт МіГ-31К з аеродрому Савастлейка')] });

    const result = await watcher.tick();

    expect(notify).not.toHaveBeenCalled();
    expect(result.announced).toHaveLength(0);
    await watcher.tick(); // same message again → still nothing
    expect(notify).not.toHaveBeenCalled();
  });

  it('announces a new message after seeding, with the kind, count and source', async () => {
    const { watcher, notify, box, advance } = make({ messages: [] });
    await watcher.tick();

    box.messages = [msg('Зафіксовано зліт 7 бортів Ту-95МС з аеродрому Оленья', { channel: '@rozvidkaneba', date: at(20) })];
    advance(20_000);
    const result = await watcher.tick();

    expect(result.announced).toHaveLength(1);
    expect(notify).toHaveBeenCalledWith(expect.objectContaining({
      kind: 'strategic_takeoff', category: 'strategic', count: 7, channel: '@rozvidkaneba',
    }));
  });

  it('says a kind once per cooldown even as channels repeat it', async () => {
    const { watcher, notify, box, advance } = make({ messages: [], cooldownMs: 60_000 });
    await watcher.tick();

    box.messages = [msg('Зліт МіГ-31К!', { date: at(10) })];
    advance(10_000);
    await watcher.tick();
    box.messages = [msg('Зліт МіГ-31К!', { date: at(10) }), msg('МіГ-31К в повітрі', { channel: '@rozvidkaneba', date: at(20) })];
    advance(10_000);
    await watcher.tick();
    expect(notify).toHaveBeenCalledTimes(1);

    // Past the cooldown, a fresh report is news again.
    box.messages = [msg('Знову зліт МіГ-31К', { date: at(100) })];
    advance(80_000);
    await watcher.tick();
    expect(notify).toHaveBeenCalledTimes(2);
  });

  it('gives drone launches their own, shorter window', async () => {
    const { watcher, notify, box, advance } = make({ messages: [], cooldownMs: 60_000, uavCooldownMs: 5_000 });
    await watcher.tick();

    box.messages = [msg('Пуск ~20 шахедів з Курська', { date: at(10) })];
    advance(10_000);
    await watcher.tick();
    box.messages = [msg('Пуск ще ~15 шахедів з Приморсько-Ахтарська', { date: at(17) })];
    advance(7_000);
    await watcher.tick();

    expect(notify).toHaveBeenCalledTimes(2);
    expect(notify.mock.calls[1][0]).toMatchObject({ kind: 'uav_launch', count: 15 });
  });

  it('ignores channels outside the trusted set', async () => {
    const { watcher, notify, box, advance } = make({ messages: [] });
    await watcher.tick();

    box.messages = [msg('Зліт стратегічної авіації!', { channel: '@some_hyperlocal', date: at(10) })];
    advance(10_000);
    await watcher.tick();

    expect(notify).not.toHaveBeenCalled();
  });

  it('accepts "all" to trust every channel, and matches handles case-insensitively', async () => {
    const { watcher, notify, box, advance } = make({ messages: [], channels: ['KPSZSU'] });
    await watcher.tick();
    box.messages = [msg('Пуски Калібрів!', { channel: '@KpSzSu', date: at(10) })];
    advance(10_000);
    await watcher.tick();
    expect(notify).toHaveBeenCalledTimes(1);

    const all = make({ messages: [], channels: 'all' });
    await all.watcher.tick();
    all.box.messages = [msg('Пуски Калібрів!', { channel: '@anyone', date: at(10) })];
    all.advance(10_000);
    await all.watcher.tick();
    expect(all.notify).toHaveBeenCalledTimes(1);
  });

  it('treats a message older than the window as history, not news', async () => {
    const { watcher, notify, box, advance } = make({ messages: [] });
    await watcher.tick();

    box.messages = [msg('Зліт МіГ-31К', { date: '2026-09-04T18:00:00Z' })]; // an hour old
    advance(10_000);
    await watcher.tick();

    expect(notify).not.toHaveBeenCalled();
  });

  it('skips the tick when the feed fails, and reports it', async () => {
    const { watcher, notify, box } = make({ messages: [] });
    await watcher.tick();

    box.messages = new Error('HTTP 503');
    const result = await watcher.tick();

    expect(result.skipped).toBe('fetch-failed');
    expect(notify).not.toHaveBeenCalled();
    expect(watcher.stats().lastError).toBe('HTTP 503');
  });

  it('announces a MiG-31K that appears on the threat map, but not one already there at boot', async () => {
    const mig = (id) => ({ id, type: 'mig31k', title: 'МіГ-31К', lat: 55, lon: 43, count: 2, explanationShort: 'Зліт МіГ-31К' });
    const { watcher, notify, box, advance } = make({ messages: [], snapshot: { threats: [mig('a')] } });
    await watcher.tick(); // seed
    expect(notify).not.toHaveBeenCalled();

    box.snapshot = { threats: [mig('a'), mig('b')] };
    advance(10_000);
    await watcher.tick();

    expect(notify).toHaveBeenCalledTimes(1);
    expect(notify.mock.calls[0][0]).toMatchObject({ kind: 'mig31k_takeoff', channel: 'NEPTUN', count: 2 });
  });

  it('deduplicates the same take-off across the map and the channel feed', async () => {
    const { watcher, notify, box, advance } = make({ messages: [], snapshot: { threats: [] } });
    await watcher.tick();

    box.snapshot = { threats: [{ id: 'm', type: 'mig31k', title: 'МіГ-31К', lat: 55, lon: 43 }] };
    box.messages = [msg('Зліт МіГ-31К з Савастлейки', { date: at(10) })];
    advance(10_000);
    await watcher.tick();

    expect(notify).toHaveBeenCalledTimes(1);
  });

  it('keeps notifying when one notify throws', async () => {
    const notify = vi.fn().mockRejectedValueOnce(new Error('boom'));
    const box = { messages: [] };
    let clock = T0;
    const watcher = createEventWatcher({
      fetchMessages: async () => box.messages, notify, now: () => clock, log: { warn() {}, error() {} },
    });
    await watcher.tick();
    box.messages = [msg('Зліт МіГ-31К. Пуски Калібрів.', { date: at(10) })];
    clock += 10_000;
    const result = await watcher.tick();

    expect(result.announced).toHaveLength(2);
    expect(notify).toHaveBeenCalledTimes(2);
  });

  it('does no work — and does not seed — while nobody is subscribed', async () => {
    const fetchMessages = vi.fn(async () => [msg('Зліт МіГ-31К', { date: at(0) })]);
    const notify = vi.fn();
    let audience = false;
    let clock = T0;
    const watcher = createEventWatcher({ fetchMessages, notify, hasAudience: () => audience, now: () => clock });

    expect(await watcher.tick()).toMatchObject({ skipped: 'no-subscribers' });
    expect(fetchMessages).not.toHaveBeenCalled();

    // First subscriber: this tick seeds; the message already in the feed is
    // not replayed to them.
    audience = true;
    await watcher.tick();
    expect(fetchMessages).toHaveBeenCalledTimes(1);
    expect(notify).not.toHaveBeenCalled();
  });

  it('start/stop manage the interval', async () => {
    vi.useFakeTimers();
    try {
      const fetchMessages = vi.fn(async () => []);
      const watcher = createEventWatcher({ fetchMessages, notify: vi.fn(), intervalMs: 1_000 });
      watcher.start();
      watcher.start();
      await vi.advanceTimersByTimeAsync(3_500);
      const calls = fetchMessages.mock.calls.length;
      expect(calls).toBeGreaterThanOrEqual(3);
      watcher.stop();
      await vi.advanceTimersByTimeAsync(5_000);
      expect(fetchMessages.mock.calls.length).toBe(calls);
    } finally {
      vi.useRealTimers();
    }
  });
});
