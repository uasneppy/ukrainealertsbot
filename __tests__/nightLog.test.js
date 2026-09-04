/**
 * NEPTUN has no history; the night log is the bot's memory of the night. Its
 * failure modes: a restart at 03:00 forgetting everything, a track counted
 * twice, a swarm counted as one drone, and unbounded growth.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'fs/promises';
import path from 'path';
import os from 'os';

import { createNightLog, nightWindow } from '../neptun/nightLog.js';

let dir;
let logs;
beforeEach(async () => {
  dir = await fs.mkdtemp(path.join(os.tmpdir(), 'night-log-'));
  logs = [];
});
// Every log persists on a (zero) debounce; a write landing while the temp
// directory is being removed made CI fail with ENOTEMPTY. Flush them first —
// the same rule the subscriptions tests follow.
afterEach(async () => {
  await Promise.all(logs.map((l) => l.flush()));
  await fs.rm(dir, { recursive: true, force: true });
});

const T0 = Date.parse('2026-09-04T20:00:00Z');
const make = (over = {}) => {
  let clock = T0;
  const log = createNightLog({ file: path.join(dir, 'nightLog.json'), persistDebounceMs: 0, now: () => clock, log: { log() {}, error() {} }, ...over });
  logs.push(log);
  return { log, advance: (ms) => { clock += ms; } };
};
const uav = (id, lat, lon, extra = {}) => ({ id, type: 'uav', title: 'БпЛА', lat, lon, ...extra });

describe('nightWindow', () => {
  it('starts at the most recent 18:00 Kyiv time', () => {
    // 21:30 UTC on 4 Sep = 00:30 Kyiv on 5 Sep → since 18:00 Kyiv on 4 Sep = 15:00 UTC.
    const w = nightWindow(Date.parse('2026-09-04T21:30:00Z'));
    expect(new Date(w.since).toISOString()).toBe('2026-09-04T15:00:00.000Z');
    expect(w.isNight).toBe(true);
    // 14:00 Kyiv the next day still reads back to yesterday evening.
    const day = nightWindow(Date.parse('2026-09-05T11:00:00Z'));
    expect(new Date(day.since).toISOString()).toBe('2026-09-04T15:00:00.000Z');
    expect(day.isNight).toBe(false);
    // 18:30 Kyiv → today's 18:00.
    const evening = nightWindow(Date.parse('2026-09-05T15:30:00Z'));
    expect(new Date(evening.since).toISOString()).toBe('2026-09-05T15:00:00.000Z');
  });
});

describe('createNightLog — tracks', () => {
  it('keeps one entry per track id, the largest count and a trail of positions', () => {
    const { log, advance } = make();
    log.recordThreats([uav('a', 50.0, 30.0, { count: 1 })]);
    advance(60_000);
    log.recordThreats([uav('a', 50.1, 30.1, { count: 5, locality: 'Обухів' })]);
    advance(60_000);
    log.recordThreats([uav('a', 50.1, 30.1)]); // unchanged position → no new sample

    const [track] = log.tracksSince(0);
    expect(log.size().tracks).toBe(1);
    expect(track).toMatchObject({ id: 'a', type: 'uav', count: 5, localities: ['Обухів'] });
    expect(track.samples).toHaveLength(2);
    expect(track.lastAt).toBe(T0 + 120_000);
  });

  it('marks advisories and ignores entries without a position', () => {
    const { log } = make();
    log.recordThreats([
      { id: 'adv', type: 'ballistic', title: 'Балістична загроза', lat: 50.45, lon: 30.52 },
      { id: 'nolatlon', type: 'uav' },
    ]);
    const tracks = log.tracksSince(0);
    expect(tracks).toHaveLength(1);
    expect(tracks[0].advisory).toBe(true);
  });

  it('bounds the trail length', () => {
    const { log, advance } = make();
    for (let i = 0; i < 100; i++) {
      log.recordThreats([uav('long', 50 + i * 0.01, 30)]);
      advance(10_000);
    }
    expect(log.tracksSince(0)[0].samples.length).toBeLessThanOrEqual(24);
  });
});

describe('createNightLog — messages', () => {
  it('records once per (channel, date, text) and tags mentioned regions', () => {
    const { log } = make({ mentions: (t) => (t.includes('Київ') ? ['c:київ'] : []) });
    const m = { channel: '@kpszsu', text: 'БпЛА курсом на Київ', date: '2026-09-04T19:59:00Z' };
    expect(log.recordMessages([m, m])).toBe(1);
    expect(log.recordMessages([m])).toBe(0);
    expect(log.messagesSince(0)[0]).toMatchObject({ channel: '@kpszsu', regions: ['c:київ'] });
  });

  it('drops messages older than the retention window and caps the total', () => {
    const { log } = make({ retainMs: 60 * 60_000, maxMessages: 3 });
    log.recordMessages([{ channel: 'x', text: 'old', date: '2026-09-04T18:00:00Z' }]);
    expect(log.size().messages).toBe(0);
    for (let i = 0; i < 5; i++) log.recordMessages([{ channel: 'x', text: `m${i}`, date: new Date(T0 - i * 1000).toISOString() }]);
    log.prune();
    expect(log.size().messages).toBe(3);
  });

  it('filters by time, newest first', () => {
    const { log } = make();
    log.recordMessages([
      { channel: 'x', text: 'a', date: '2026-09-04T19:00:00Z' },
      { channel: 'x', text: 'b', date: '2026-09-04T19:30:00Z' },
    ]);
    const since = Date.parse('2026-09-04T19:15:00Z');
    expect(log.messagesSince(since).map((m) => m.text)).toEqual(['b']);
    expect(log.messagesSince(0).map((m) => m.text)).toEqual(['b', 'a']);
  });
});

describe('createNightLog — persistence', () => {
  it('survives a restart', async () => {
    const { log } = make();
    log.recordThreats([uav('a', 50, 30, { count: 3 })]);
    log.recordMessages([{ channel: '@kpszsu', text: 'Пуски КР', date: '2026-09-04T19:59:00Z' }]);
    await log.flush();

    const { log: reloaded } = make();
    await reloaded.load();
    expect(reloaded.size()).toEqual({ tracks: 1, messages: 1 });
    expect(reloaded.tracksSince(0)[0]).toMatchObject({ id: 'a', count: 3 });
    // And the reloaded message is still deduplicated against a re-fetch.
    expect(reloaded.recordMessages([{ channel: '@kpszsu', text: 'Пуски КР', date: '2026-09-04T19:59:00Z' }])).toBe(0);
  });

  it('starts empty on a corrupt file', async () => {
    await fs.writeFile(path.join(dir, 'nightLog.json'), '{oops', 'utf8');
    const { log } = make();
    await expect(log.load()).resolves.toBeUndefined();
    expect(log.size()).toEqual({ tracks: 0, messages: 0 });
  });
});
