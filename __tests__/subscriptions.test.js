/**
 * Subscriptions must survive a redeploy — one silently lost is worse than one
 * never created, because nobody finds out until an expected alert doesn't come.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'fs/promises';
import path from 'path';
import os from 'os';

import {
  loadSubscriptions,
  flushSubscriptions,
  subscribe,
  unsubscribe,
  listSubscriptions,
  subscribedRegions,
  getSubscriptionsFile,
  __resetSubscriptions,
  MAX_PER_CHAT,
} from '../neptun/subscriptions.js';

let dir;

beforeEach(async () => {
  dir = await fs.mkdtemp(path.join(os.tmpdir(), 'subs-'));
  process.env.SUBSCRIPTIONS_FILE = path.join(dir, 'subscriptions.json');
  __resetSubscriptions();
});

afterEach(async () => {
  await flushSubscriptions(); // a queued write landing mid-cleanup breaks rm
  await fs.rm(dir, { recursive: true, force: true });
  delete process.env.SUBSCRIPTIONS_FILE;
});

const readStore = async () => JSON.parse(await fs.readFile(getSubscriptionsFile(), 'utf8'));

describe('subscribe', () => {
  it('resolves the region and stores the subscription', async () => {
    const result = subscribe(42, 'київ');

    expect(result.ok).toBe(true);
    expect(result.region).toMatchObject({ kind: 'city', name: 'Київ' });
    expect(listSubscriptions(42)).toHaveLength(1);
  });

  it('accepts declined and colloquial forms via the resolver', () => {
    expect(subscribe(1, 'харківщина').ok).toBe(true);
    expect(subscribe(1, 'львівській області').ok).toBe(true);

    expect(listSubscriptions(1).map((s) => s.name).sort()).toEqual([
      'Львівська область',
      'Харківська область',
    ]);
  });

  it('rejects unresolvable regions and the whole country', () => {
    expect(subscribe(1, 'мордор')).toMatchObject({ ok: false, reason: 'unresolved' });
    expect(subscribe(1, 'україна')).toMatchObject({ ok: false, reason: 'unresolved' });
    expect(listSubscriptions(1)).toHaveLength(0);
  });

  it('reports duplicates instead of storing them twice', () => {
    subscribe(7, 'київ');
    // Different phrasing, same region.
    const second = subscribe(7, 'києві');

    expect(second).toMatchObject({ ok: false, reason: 'duplicate' });
    expect(listSubscriptions(7)).toHaveLength(1);
  });

  it('caps how many regions one chat can watch', () => {
    const queries = [
      'київ', 'харків', 'одеса', 'дніпро', 'львів',
      'суми', 'полтава', 'чернігів', 'черкаси', 'житомир',
    ];
    for (const q of queries) expect(subscribe(9, q).ok).toBe(true);
    expect(listSubscriptions(9)).toHaveLength(MAX_PER_CHAT);

    expect(subscribe(9, 'вінниця')).toMatchObject({ ok: false, reason: 'limit' });
  });

  it('keeps chats isolated', () => {
    subscribe(1, 'київ');
    subscribe(2, 'харків');

    expect(listSubscriptions(1).map((s) => s.name)).toEqual(['Київ']);
    expect(listSubscriptions(2).map((s) => s.name)).toEqual(['Харків']);
  });
});

describe('unsubscribe', () => {
  it('removes a single region by cache key', () => {
    subscribe(3, 'київ');
    const { region } = subscribe(3, 'харків');

    expect(unsubscribe(3, region.cacheKey)).toEqual({ ok: true, removed: 1 });
    expect(listSubscriptions(3).map((s) => s.name)).toEqual(['Київ']);
  });

  it('removes everything when no key is given', () => {
    subscribe(4, 'київ');
    subscribe(4, 'одеса');

    expect(unsubscribe(4)).toEqual({ ok: true, removed: 2 });
    expect(listSubscriptions(4)).toHaveLength(0);
  });

  it('is a no-op for unknown chats and regions', () => {
    expect(unsubscribe(999)).toEqual({ ok: false, removed: 0 });
    subscribe(5, 'київ');
    expect(unsubscribe(5, 'c:немає')).toEqual({ ok: false, removed: 0 });
  });
});

describe('persistence', () => {
  it('writes atomically and reloads across a restart', async () => {
    subscribe(11, 'київщина');
    subscribe(11, 'суми');
    await flushSubscriptions();

    const stored = await readStore();
    expect(stored.version).toBe(1);
    expect(Object.keys(stored.chats)).toEqual(['11']);

    // Simulate a redeploy: fresh in-memory state, same file.
    __resetSubscriptions();
    await loadSubscriptions();

    expect(listSubscriptions(11).map((s) => s.name).sort()).toEqual([
      'Київська область',
      'Суми',
    ]);
  });

  it('leaves no temp file behind', async () => {
    subscribe(12, 'київ');
    await flushSubscriptions();

    const files = await fs.readdir(dir);
    expect(files).toEqual(['subscriptions.json']);
  });

  it('starts empty rather than crashing on a corrupt store', async () => {
    await fs.writeFile(getSubscriptionsFile(), '{ this is not json', 'utf8');

    await expect(loadSubscriptions()).resolves.toBeUndefined();
    expect(listSubscriptions(1)).toHaveLength(0);

    // And the store is usable again afterwards.
    expect(subscribe(1, 'київ').ok).toBe(true);
  });

  it('starts empty when the file does not exist yet', async () => {
    await expect(loadSubscriptions()).resolves.toBeUndefined();
    expect(subscribedRegions()).toEqual([]);
  });

  it('drops entries the resolver no longer recognises', async () => {
    await fs.writeFile(
      getSubscriptionsFile(),
      JSON.stringify({
        version: 1,
        chats: { 20: { 'c:київ': { query: 'київ', name: 'Київ' }, 'c:атлантида': { query: 'атлантида', name: 'Атлантида' } } },
      }),
      'utf8'
    );

    await loadSubscriptions();

    expect(listSubscriptions(20).map((s) => s.name)).toEqual(['Київ']);
  });
});

describe('subscribedRegions', () => {
  it('groups subscribers by region so the watcher evaluates each one once', () => {
    subscribe(1, 'київ');
    subscribe(2, 'києві'); // same region, different chat and phrasing
    subscribe(2, 'харківщина');

    const regions = subscribedRegions();
    const kyiv = regions.find((r) => r.region.name === 'Київ');
    const kharkiv = regions.find((r) => r.region.name === 'Харківська область');

    expect(regions).toHaveLength(2);
    expect(kyiv.chatIds.sort()).toEqual(['1', '2']);
    expect(kharkiv.chatIds).toEqual(['2']);
  });

  it('is empty when nobody is subscribed', () => {
    expect(subscribedRegions()).toEqual([]);
  });
});

describe('subscribedChats', () => {
  it('lists every chat with at least one subscription, once', async () => {
    const { subscribedChats } = await import('../neptun/subscriptions.js');
    subscribe(11, 'київ');
    subscribe(11, 'харків');
    subscribe(22, 'одеса');
    subscribe(33, 'львів');
    unsubscribe(33);

    expect(subscribedChats().sort()).toEqual(['11', '22']);
  });
});
