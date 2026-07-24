/**
 * The watcher sends unprompted messages about air raids, so its failure modes
 * are the dangerous kind: a false "відбій" from stale data, a restart storm of
 * alerts people already know about, or a flapping feed turned into spam.
 */
import { describe, it, expect, vi } from 'vitest';

import { createAlertWatcher, formatAlertNotification, formatThreatNotification } from '../neptun/alertWatcher.js';
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

describe('state across restarts', () => {
  const makeRestartWatcher = ({ initialStates, snapshot, staleStateMs }) => {
    const notify = vi.fn();
    const onStateChange = vi.fn();
    const clock = 10_000_000;
    const watcher = createAlertWatcher({
      getSnapshot: () => snapshot,
      getGeo: async () => GEO,
      notify,
      onStateChange,
      initialStates,
      staleStateMs,
      listRegions: () => [{ region: KYIV_OBLAST, chatIds: ['1'] }],
      now: () => clock,
    });
    return { watcher, notify, onStateChange, clock };
  };

  it('announces an alert that started while the bot was down', async () => {
    // The gap this closes: a deploy mid-raid used to swallow the notification
    // entirely, leaving subscribers waiting for a push that never came.
    const { watcher, notify } = makeRestartWatcher({
      initialStates: { [KYIV_OBLAST.cacheKey]: { confirmed: false, at: 10_000_000 - 60_000 } },
      snapshot: { threats: [], alerts: alertsFor('київська') },
    });

    const result = await watcher.tick();

    expect(notify).toHaveBeenCalledTimes(1);
    expect(result.announced[0]).toMatchObject({ active: true, missedWhileDown: true });
  });

  it('announces an all-clear that happened while the bot was down', async () => {
    const { watcher, notify } = makeRestartWatcher({
      initialStates: { [KYIV_OBLAST.cacheKey]: { confirmed: true, at: 10_000_000 - 60_000 } },
      snapshot: { threats: [], alerts: alertsFor() },
    });

    await watcher.tick();

    expect(notify).toHaveBeenCalledTimes(1);
    expect(notify.mock.calls[0][0]).toMatchObject({ active: false });
  });

  it('stays silent when nothing changed while the bot was down', async () => {
    const { watcher, notify } = makeRestartWatcher({
      initialStates: { [KYIV_OBLAST.cacheKey]: { confirmed: true, at: 10_000_000 - 60_000 } },
      snapshot: { threats: [], alerts: alertsFor('київська') },
    });

    await watcher.tick();

    expect(notify).not.toHaveBeenCalled();
  });

  it('ignores state too old to be news', async () => {
    // After a long outage the transitions people missed are history. Firing a
    // burst of them on boot is noise, not warning.
    const { watcher, notify } = makeRestartWatcher({
      initialStates: { [KYIV_OBLAST.cacheKey]: { confirmed: false, at: 0 } },
      snapshot: { threats: [], alerts: alertsFor('київська') },
      staleStateMs: 60_000,
    });

    await watcher.tick();

    expect(notify).not.toHaveBeenCalled();
  });

  it('seeds silently with no remembered state, and records it', async () => {
    const { watcher, notify, onStateChange } = makeRestartWatcher({
      initialStates: {},
      snapshot: { threats: [], alerts: alertsFor('київська') },
    });

    await watcher.tick();

    expect(notify).not.toHaveBeenCalled();
    expect(onStateChange).toHaveBeenCalledWith(KYIV_OBLAST.cacheKey, true, expect.any(Number));
  });

  it('records every confirmed transition so the next boot can reconcile', async () => {
    const notify = vi.fn();
    const onStateChange = vi.fn();
    let clock = 0;
    const box = { snapshot: { threats: [], alerts: alertsFor() } };
    const watcher = createAlertWatcher({
      getSnapshot: () => box.snapshot,
      getGeo: async () => GEO,
      notify,
      onStateChange,
      initialStates: {},
      listRegions: () => [{ region: KYIV_OBLAST, chatIds: ['1'] }],
      now: () => clock,
    });

    await watcher.tick(); // seed: quiet
    box.snapshot = { threats: [], alerts: alertsFor('київська') };
    clock += 1_000;
    await watcher.tick(); // alert announced

    expect(onStateChange).toHaveBeenLastCalledWith(KYIV_OBLAST.cacheKey, true, expect.any(Number));
  });
});

describe('live threat events (missiles / ballistics)', () => {
  const KYIV = resolveRegion('київ'); // city → status computed from coords, no geo needed
  const NO_ALERTS = { oblasts: [], raions: [] };

  const missile = (id, lat, lon, extra = {}) =>
    ({ id, type: 'missile', title: 'Ракета', lat, lon, ...extra });

  function cityWatcher() {
    const notify = vi.fn();
    const box = { snapshot: { threats: [], alerts: NO_ALERTS } };
    let clock = 1_000_000;
    const watcher = createAlertWatcher({
      getSnapshot: () => box.snapshot,
      getGeo: async () => ({}),
      notify,
      listRegions: () => [{ region: KYIV, chatIds: ['1'] }],
      now: () => clock,
    });
    return { watcher, notify, box, advance: (ms) => { clock += ms; } };
  }
  const threatEvents = (result) => result.announced.filter((a) => a.kind === 'threat');

  it('announces a missile approaching, even before a formal alert', async () => {
    const { watcher, box } = cityWatcher();
    await watcher.tick(); // seed empty

    // ~100 km south of Kyiv, heading north → toward the city.
    box.snapshot = { threats: [missile('m1', 49.546, 30.523, { heading: 0, locality: 'Обухів' })], alerts: NO_ALERTS };
    const events = threatEvents(await watcher.tick());

    expect(events).toHaveLength(1);
    expect(events[0].events[0].stage).toBe('near');
    expect(events[0].events[0].threat.name).toBe('Ракета');
  });

  it('does NOT announce a missile that is nearby but heading away', async () => {
    const { watcher, box } = cityWatcher();
    await watcher.tick();

    box.snapshot = { threats: [missile('m2', 49.546, 30.523, { heading: 180 })], alerts: NO_ALERTS }; // heading south
    expect(threatEvents(await watcher.tick())).toHaveLength(0);
  });

  it('announces again when the target enters the region, then stays quiet', async () => {
    const { watcher, box } = cityWatcher();
    await watcher.tick();

    box.snapshot = { threats: [missile('m3', 49.546, 30.523, { heading: 0 })], alerts: NO_ALERTS };
    expect(threatEvents(await watcher.tick())[0].events[0].stage).toBe('near');

    box.snapshot = { threats: [missile('m3', 50.450, 30.523, { heading: 0 })], alerts: NO_ALERTS }; // now overhead
    expect(threatEvents(await watcher.tick())[0].events[0].stage).toBe('in');

    // Still overhead next tick → no repeat.
    expect(threatEvents(await watcher.tick())).toHaveLength(0);
  });

  it('seeds silently — a missile already flying at boot is not re-announced', async () => {
    const { watcher, box } = cityWatcher();
    box.snapshot = { threats: [missile('m4', 49.546, 30.523, { heading: 0 })], alerts: NO_ALERTS };

    expect(threatEvents(await watcher.tick())).toHaveLength(0); // first tick = seed
    // And it's recorded, so it stays quiet afterwards.
    expect(threatEvents(await watcher.tick())).toHaveLength(0);
  });

  it('ignores slow types — a drone overhead gets no live alert', async () => {
    const { watcher, box } = cityWatcher();
    await watcher.tick();

    box.snapshot = { threats: [{ id: 'd1', type: 'uav', title: 'БпЛА', lat: 50.45, lon: 30.523, heading: 0 }], alerts: NO_ALERTS };
    expect(threatEvents(await watcher.tick())).toHaveLength(0);
  });

  it('ignores an approaching missile still beyond the live-alert distance', async () => {
    const { watcher, box } = cityWatcher();
    await watcher.tick();

    // ~128 km south — within the "nearby" radius but past the 120 km live gate.
    box.snapshot = { threats: [missile('m5', 49.293, 30.523, { heading: 0 })], alerts: NO_ALERTS };
    expect(threatEvents(await watcher.tick())).toHaveLength(0);
  });

  it('summarises several targets appearing at once into one message', async () => {
    const { watcher, box } = cityWatcher();
    await watcher.tick();

    box.snapshot = {
      threats: [
        missile('a', 49.55, 30.40, { heading: 0 }),
        missile('b', 49.55, 30.60, { heading: 0 }),
        { id: 'c', type: 'ballistic', title: 'Балістика', lat: 49.60, lon: 30.52, heading: 0 },
      ],
      alerts: NO_ALERTS,
    };
    const events = threatEvents(await watcher.tick());
    expect(events).toHaveLength(1);          // one message for the region
    expect(events[0].events.length).toBe(3); // covering three targets
  });
});

describe('formatThreatNotification', () => {
  const region = { name: 'Київ' };
  const t = (over = {}) => ({ emoji: '🚀', name: 'Ракета', distanceKm: 80, direction: 'пд', headingWord: 'пн', locality: 'Обухів', ...over });

  it('phrases a single approaching target urgently', () => {
    const text = formatThreatNotification({ region, events: [{ stage: 'near', threat: t() }] });
    expect(text).toContain('🚀 Ракета — Київ');
    expect(text).toContain('наближається');
    expect(text).toContain('80 км');
    expect(text).toContain('/map Київ');
  });

  it('marks a target that has entered the region', () => {
    const text = formatThreatNotification({ region, events: [{ stage: 'in', threat: t() }] });
    expect(text).toContain('🚨');
    expect(text).toContain('над Обухів');
  });

  it('summarises several targets with correct Ukrainian plural', () => {
    const two = formatThreatNotification({ region, events: [
      { stage: 'near', threat: t() }, { stage: 'near', threat: t({ name: 'Балістика', emoji: '💥' }) },
    ] });
    expect(two).toContain('2 цілі');

    const five = formatThreatNotification({ region, events: Array.from({ length: 5 }, () => ({ stage: 'near', threat: t() })) });
    expect(five).toContain('5 цілей');
  });
});

describe('wake() and re-entrancy (faster reaction)', () => {
  it('coalesces a burst of wakes into a single tick', async () => {
    vi.useFakeTimers();
    try {
      const getSnapshot = vi.fn(async () => ({ threats: [], alerts: alertsFor() }));
      const watcher = createAlertWatcher({
        getSnapshot, getGeo: async () => GEO, notify: vi.fn(),
        listRegions: () => [{ region: KYIV_OBLAST, chatIds: ['1'] }],
        minTickGapMs: 2_000,
      });

      watcher.wake(); watcher.wake(); watcher.wake(); // a burst of upserts
      await vi.advanceTimersByTimeAsync(2_100);

      expect(getSnapshot).toHaveBeenCalledTimes(1); // one tick, not three
    } finally {
      vi.useRealTimers();
    }
  });

  it('throttles a wake that arrives right after a tick', async () => {
    vi.useFakeTimers();
    try {
      const getSnapshot = vi.fn(async () => ({ threats: [], alerts: alertsFor() }));
      const watcher = createAlertWatcher({
        getSnapshot, getGeo: async () => GEO, notify: vi.fn(),
        listRegions: () => [{ region: KYIV_OBLAST, chatIds: ['1'] }],
        minTickGapMs: 2_000,
      });

      await watcher.tick();                 // establishes lastTickAt
      expect(getSnapshot).toHaveBeenCalledTimes(1);

      watcher.wake();                        // just after a tick → must wait
      await vi.advanceTimersByTimeAsync(500);
      expect(getSnapshot).toHaveBeenCalledTimes(1); // not yet
      await vi.advanceTimersByTimeAsync(1_600);
      expect(getSnapshot).toHaveBeenCalledTimes(2); // fired after the gap
    } finally {
      vi.useRealTimers();
    }
  });

  it('drops an overlapping tick instead of running two at once', async () => {
    let release;
    const gate = new Promise((r) => { release = r; });
    const getSnapshot = vi.fn(async () => { await gate; return { threats: [], alerts: alertsFor() }; });
    const watcher = createAlertWatcher({
      getSnapshot, getGeo: async () => GEO, notify: vi.fn(),
      listRegions: () => [{ region: KYIV_OBLAST, chatIds: ['1'] }],
    });

    const first = watcher.tick();            // starts, blocks on the gate
    const second = await watcher.tick();     // arrives mid-flight
    expect(second).toMatchObject({ skipped: 'busy' });

    release();
    await first;
    expect(getSnapshot).toHaveBeenCalledTimes(1); // the busy one never fetched
  });
});
