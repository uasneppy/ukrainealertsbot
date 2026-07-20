/**
 * The watcher sends unprompted messages about air raids, so its failure modes
 * are the dangerous kind: a false "відбій" from stale data, a restart storm of
 * alerts people already know about, or a flapping feed turned into spam.
 */
import { describe, it, expect, vi } from 'vitest';

import { createAlertWatcher, formatAlertNotification } from '../neptun/alertWatcher.js';
import { resolveRegion } from '../neptun/regionResolver.js';

const KYIV_OBLAST = resolveRegion('київська область');
const GEO = { oblasts: { type: 'FeatureCollection', features: [] }, raions: { type: 'FeatureCollection', features: [] } };

const alertsFor = (...oblastKeys) => ({
  oblasts: oblastKeys.map((key) => ({ key, name: key, since: '2026-07-20T10:00:00Z' })),
  raions: [],
});

/** Watcher wired to controllable time and data. */
function makeWatcher({ snapshot, confirmOnMs = 0, confirmOffMs = 60_000 } = {}) {
  const notify = vi.fn();
  let clock = 1_000_000;
  const box = { snapshot: snapshot ?? { threats: [], alerts: alertsFor() } };

  const watcher = createAlertWatcher({
    getSnapshot: () => box.snapshot,
    getGeo: async () => GEO,
    notify,
    listRegions: () => [{ region: KYIV_OBLAST, chatIds: ['100', '200'] }],
    confirmOnMs,
    confirmOffMs,
    now: () => clock,
  });

  return {
    watcher,
    notify,
    box,
    advance: (ms) => {
      clock += ms;
    },
  };
}

describe('createAlertWatcher', () => {
  it('requires its dependencies', () => {
    expect(() => createAlertWatcher()).toThrow('getSnapshot is required');
    expect(() => createAlertWatcher({ getSnapshot: () => null })).toThrow('getGeo is required');
    expect(() => createAlertWatcher({ getSnapshot: () => null, getGeo: async () => ({}) }))
      .toThrow('notify is required');
  });

  it('says nothing on the first observation — a restart is not news', async () => {
    const { watcher, notify, box } = makeWatcher();
    box.snapshot = { threats: [], alerts: alertsFor('київська') }; // alert already running

    const result = await watcher.tick();

    expect(notify).not.toHaveBeenCalled();
    expect(result.announced).toHaveLength(0);
    expect(watcher.snapshotStates().get(KYIV_OBLAST.cacheKey)).toMatchObject({ confirmed: true });
  });

  it('announces an alert on the very first tick that sees it', async () => {
    const { watcher, notify, box } = makeWatcher();

    await watcher.tick(); // seed: no alert
    box.snapshot = { threats: [], alerts: alertsFor('київська') };

    // No debounce on the way up — a minute of caution is a minute of warning lost.
    const result = await watcher.tick();

    expect(notify).toHaveBeenCalledTimes(1);
    expect(result.announced[0]).toMatchObject({ active: true });
    expect(result.announced[0].chatIds).toEqual(['100', '200']);
  });

  it('does not announce the same state twice', async () => {
    const { watcher, notify, box, advance } = makeWatcher();

    await watcher.tick();
    box.snapshot = { threats: [], alerts: alertsFor('київська') };
    await watcher.tick();
    expect(notify).toHaveBeenCalledTimes(1);

    advance(50_000);
    await watcher.tick();
    await watcher.tick();
    expect(notify).toHaveBeenCalledTimes(1);
  });

  it('makes the all-clear wait, then announces it', async () => {
    const { watcher, notify, box, advance } = makeWatcher();

    box.snapshot = { threats: [], alerts: alertsFor('київська') };
    await watcher.tick(); // seed: alerted

    box.snapshot = { threats: [], alerts: alertsFor() };
    await watcher.tick(); // change seen — must NOT go out yet
    expect(notify).not.toHaveBeenCalled();

    advance(65_000);
    await watcher.tick();

    expect(notify).toHaveBeenCalledTimes(1);
    expect(notify.mock.calls[0][0]).toMatchObject({ active: false });
  });

  it('never sends a premature all-clear when the feed flaps', async () => {
    const { watcher, notify, box, advance } = makeWatcher();

    box.snapshot = { threats: [], alerts: alertsFor('київська') };
    await watcher.tick(); // seed: alerted

    box.snapshot = { threats: [], alerts: alertsFor() }; // blip: alert vanishes
    advance(10_000);
    await watcher.tick();

    box.snapshot = { threats: [], alerts: alertsFor('київська') }; // and returns
    advance(10_000);
    await watcher.tick();

    advance(120_000);
    await watcher.tick();

    // The alert never actually ended, so nobody was told it had.
    expect(notify).not.toHaveBeenCalled();
  });

  it('skips the tick entirely when the stream is not fresh', async () => {
    const { watcher, notify, box, advance } = makeWatcher();

    box.snapshot = { threats: [], alerts: alertsFor('київська') };
    await watcher.tick(); // seed: alerted

    // Socket died: getSnapshot returns null. This must NOT read as "відбій".
    box.snapshot = null;
    advance(120_000);
    const result = await watcher.tick();

    expect(result.skipped).toBe('stale');
    expect(notify).not.toHaveBeenCalled();
    expect(watcher.snapshotStates().get(KYIV_OBLAST.cacheKey)).toMatchObject({ confirmed: true });
  });

  it('does no work when nobody is subscribed', async () => {
    const notify = vi.fn();
    const getSnapshot = vi.fn();
    const watcher = createAlertWatcher({
      getSnapshot,
      getGeo: async () => GEO,
      notify,
      listRegions: () => [],
    });

    const result = await watcher.tick();

    expect(result.skipped).toBe('no-subscribers');
    expect(getSnapshot).not.toHaveBeenCalled();
    expect(notify).not.toHaveBeenCalled();
  });

  it('keeps notifying other regions when one notify throws', async () => {
    const notify = vi.fn().mockRejectedValueOnce(new Error('chat blocked'));
    let clock = 0;
    const kharkiv = resolveRegion('харківська область');
    const box = { snapshot: { threats: [], alerts: alertsFor() } };

    const watcher = createAlertWatcher({
      getSnapshot: () => box.snapshot,
      getGeo: async () => GEO,
      notify,
      listRegions: () => [
        { region: KYIV_OBLAST, chatIds: ['1'] },
        { region: kharkiv, chatIds: ['2'] },
      ],
      now: () => clock,
    });

    await watcher.tick();
    box.snapshot = { threats: [], alerts: alertsFor('київська', 'харківська') };
    clock += 1_000;
    const result = await watcher.tick();

    expect(result.announced).toHaveLength(2);
    expect(notify).toHaveBeenCalledTimes(2); // the rejection did not abort the loop
  });

  it('start/stop manage the interval', async () => {
    vi.useFakeTimers();
    try {
      const notify = vi.fn();
      const getSnapshot = vi.fn(() => ({ threats: [], alerts: alertsFor() }));
      const watcher = createAlertWatcher({
        getSnapshot,
        getGeo: async () => GEO,
        notify,
        listRegions: () => [{ region: KYIV_OBLAST, chatIds: ['1'] }],
        intervalMs: 1_000,
      });

      watcher.start();
      watcher.start(); // idempotent
      await vi.advanceTimersByTimeAsync(3_500);
      const calls = getSnapshot.mock.calls.length;
      expect(calls).toBeGreaterThanOrEqual(3);

      watcher.stop();
      await vi.advanceTimersByTimeAsync(5_000);
      expect(getSnapshot.mock.calls.length).toBe(calls);
    } finally {
      vi.useRealTimers();
    }
  });
});

describe('formatAlertNotification', () => {
  const region = { name: 'Київська область' };

  it('describes an alert with what is flying in the region', () => {
    const text = formatAlertNotification({
      region,
      active: true,
      status: { threatsIn: [{ name: 'БпЛА' }, { name: 'БпЛА' }, { name: 'Ракета' }] },
    });

    expect(text).toContain('🔴 Повітряна тривога — Київська область');
    expect(text).toContain('БпЛА ×2');
    expect(text).toContain('Ракета ×1');
  });

  it('points at the map with a command rather than a mis-declined sentence', () => {
    // "тривога в Київська область" is not grammatical Ukrainian; the locative
    // ("в київській області") can't be derived from the stored name, so the
    // hint uses the command form instead.
    const text = formatAlertNotification({ region, active: true, status: { threatsIn: [] } });

    expect(text).toContain('/map Київська область');
    expect(text).not.toMatch(/тривога в Київська/);
  });

  it('omits the threat line when nothing is in the region', () => {
    const text = formatAlertNotification({ region, active: true, status: { threatsIn: [] } });

    expect(text).toContain('🔴 Повітряна тривога');
    expect(text).not.toContain('У регіоні:');
  });

  it('is a single short line for the all-clear', () => {
    const text = formatAlertNotification({ region, active: false, status: {} });

    expect(text).toBe('🟢 Відбій тривоги — Київська область');
  });
});
