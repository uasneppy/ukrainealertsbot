/**
 * Two-level alerts (since September 2026): yellow — a drone threat, red — a
 * missile or massive drone threat, and an alert moves between them while it
 * runs. The bot read every alert as the same red "Повітряна тривога", so a
 * drone alert went out as red and — worse — a yellow alert turning red, the
 * moment everyone should head for the shelter, said nothing at all.
 */
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { describe, it, expect, vi, afterEach } from 'vitest';

import {
  entryAlertLevel,
  maxAlertLevel,
  computeAlertKeySets,
  computeAlertLevels,
} from '../neptun/threatMeta.js';
import { buildRegionStatus, formatRegionReport } from '../neptun/regionContext.js';
import { createAlertWatcher, formatAlertNotification } from '../neptun/alertWatcher.js';
import { createChatNotifier } from '../neptun/chatNotifier.js';
import { buildNationalReport } from '../neptun/mapRenderer.js';
import { resolveRegion } from '../neptun/regionResolver.js';
import { stripHtml } from '../neptun/telegramFormat.js';
import { alertRoute } from '../bot.js';

const RED = 'Ракетна загроза (червоний рівень)';
const YELLOW = 'Дронова загроза (жовтий рівень)';

const oblastEntry = (key, level, extra = {}) => ({
  key, name: `${key} область`, oblast: `${key} область`, since: '2026-09-24T10:00:00Z',
  ...(level ? { level, reasons: [level === 'red' ? RED : YELLOW] } : {}),
  ...extra,
});
const raionEntry = (key, oblast, level, extra = {}) => ({
  key, name: `${key} район`, oblast: `${oblast} область`, since: '2026-09-24T10:05:00Z',
  ...(level ? { level, reasons: [level === 'red' ? RED : YELLOW] } : {}),
  ...extra,
});

describe('alert level helpers', () => {
  it('reads the level, and counts a missing one as red without claiming it', () => {
    expect(entryAlertLevel({ level: 'yellow' })).toEqual({ level: 'yellow', known: true });
    expect(entryAlertLevel({ level: 'red' })).toEqual({ level: 'red', known: true });
    // Calling a red alert yellow is the costly mistake; calling an unknown one
    // red only costs a trip to the shelter.
    expect(entryAlertLevel({})).toEqual({ level: 'red', known: false });
    expect(entryAlertLevel('київська')).toEqual({ level: 'red', known: false });
    expect(entryAlertLevel({ level: 'purple' })).toEqual({ level: 'red', known: false });
  });

  it('maxAlertLevel picks the more severe, null meaning none', () => {
    expect(maxAlertLevel('yellow', 'red')).toBe('red');
    expect(maxAlertLevel('red', 'yellow')).toBe('red');
    expect(maxAlertLevel(null, 'yellow')).toBe('yellow');
    expect(maxAlertLevel(undefined, null)).toBe(null);
  });

  it('keeps a red district inside a yellow oblast on the map', () => {
    const { oblastKeys, raionKeys } = computeAlertKeySets({
      oblasts: [oblastEntry('дніпропетровська', 'yellow')],
      raions: [
        raionEntry('нікопольський', 'дніпропетровська', 'red'),
        raionEntry('самарівський', 'дніпропетровська', 'yellow'),
      ],
    });

    expect(oblastKeys).toEqual(['дніпропетровська']);
    // The red one is the part that must go to shelter; the yellow one is
    // already covered by the yellow oblast fill.
    expect(raionKeys).toEqual(['нікопольський']);
  });

  it('still drops a district the oblast alert already covers', () => {
    const { raionKeys } = computeAlertKeySets({
      oblasts: [oblastEntry('дніпропетровська', 'red')],
      raions: [raionEntry('нікопольський', 'дніпропетровська', 'yellow')],
    });
    expect(raionKeys).toEqual([]);
  });

  it('computeAlertLevels maps keys to levels and says whether any were given', () => {
    const levels = computeAlertLevels({
      oblasts: [oblastEntry('луганська', 'red')],
      raions: [raionEntry('самарівський', 'дніпропетровська', 'yellow')],
    });
    expect(levels).toEqual({
      oblastLevels: { 'луганська': 'red' },
      raionLevels: { 'самарівський': 'yellow' },
      levelsKnown: true,
    });
    expect(computeAlertLevels({ oblasts: [{ key: 'луганська' }] }).levelsKnown).toBe(false);
  });
});

describe('region status and report', () => {
  const DNIPRO_OBLAST = { kind: 'oblast', geoKey: 'дніпропетровська', name: 'Дніпропетровська область' };

  it('an oblast with red and yellow districts is red, for the red reason, and lists both groups', () => {
    const status = buildRegionStatus({
      region: DNIPRO_OBLAST,
      alerts: {
        oblasts: [],
        raions: [
          raionEntry('самарівський', 'дніпропетровська', 'yellow'),
          raionEntry('нікопольський', 'дніпропетровська', 'red'),
        ],
      },
    });

    expect(status.alertLevel).toBe('red');
    expect(status.alertReasons).toEqual([RED]);

    const text = formatRegionReport(status);
    expect(text).toContain('🔴 Тривога у районах: нікопольський район');
    expect(text).toContain('🟡 Тривога у районах: самарівський район');
    // Red first: it is the line that tells someone to move.
    expect(text.indexOf('🔴')).toBeLessThan(text.indexOf('🟡'));
    expect(text).toContain(RED);
    expect(text).toContain(YELLOW);
  });

  it('a yellow oblast alert reads yellow, with a separate line for a red district in it', () => {
    const status = buildRegionStatus({
      region: DNIPRO_OBLAST,
      alerts: {
        oblasts: [oblastEntry('дніпропетровська', 'yellow')],
        raions: [raionEntry('нікопольський', 'дніпропетровська', 'red')],
      },
    });

    expect(status.alertScope).toBe('oblast');
    expect(status.alertLevel).toBe('red');
    const text = formatRegionReport(status);
    expect(text).toContain('🟡 Тривога — вся область');
    expect(text).toContain('🔴 Тривога у районах: нікопольський район');
  });

  it('a city under a yellow oblast alert and a red raion alert is red, and names the raion', () => {
    const dnipro = resolveRegion('дніпро');
    const status = buildRegionStatus({
      region: dnipro,
      alerts: {
        oblasts: [oblastEntry('дніпропетровська', 'yellow')],
        raions: [raionEntry(dnipro.raionKey, 'дніпропетровська', 'red')],
      },
    });

    expect(status.alertLevel).toBe('red');
    expect(status.alertScope).toBe('raion');
    expect(stripHtml(formatRegionReport(status, { html: true }))).toMatch(/^🔴 Тривога — /m);
  });

  it('among equal levels the old precedence holds — a full oblast alert over the raion', () => {
    const dnipro = resolveRegion('дніпро');
    const status = buildRegionStatus({
      region: dnipro,
      alerts: {
        oblasts: [oblastEntry('дніпропетровська', 'red')],
        raions: [raionEntry(dnipro.raionKey, 'дніпропетровська', 'red')],
      },
    });
    expect(status.alertScope).toBe('oblast');
  });

  it('prints no colour words for entries that carry no level', () => {
    const status = buildRegionStatus({
      region: DNIPRO_OBLAST,
      alerts: { oblasts: [oblastEntry('дніпропетровська', null)], raions: [] },
    });

    expect(status.alertLevel).toBe('red');
    expect(status.alertLevelKnown).toBe(false);
    const text = formatRegionReport(status);
    expect(text).toContain('🔴 Тривога — вся область');
    expect(text).not.toMatch(/рівень/);
  });

  it('falls back to the bare level when the feed gives a level but no reason', () => {
    const status = buildRegionStatus({
      region: DNIPRO_OBLAST,
      alerts: { oblasts: [oblastEntry('дніпропетровська', null, { level: 'yellow' })], raions: [] },
    });
    expect(formatRegionReport(status)).toContain('Жовтий рівень');
  });
});

describe('national caption', () => {
  it('counts alerts per level, red first', () => {
    const text = stripHtml(buildNationalReport({
      alerts: {
        oblasts: [oblastEntry('луганська', 'red')],
        raions: [
          raionEntry('нікопольський', 'дніпропетровська', 'red'),
          raionEntry('самарівський', 'дніпропетровська', 'yellow'),
          raionEntry('павлоградський', 'дніпропетровська', 'yellow'),
        ],
      },
    }));

    expect(text).toContain('🔴 Тривога, червоний рівень — областей: 1, районів: 1');
    expect(text).toContain('🟡 Тривога, жовтий рівень — районів: 2');
  });

  it('keeps the single "Тривога" line when the feed has no levels', () => {
    const text = stripHtml(buildNationalReport({ alerts: { oblasts: [{ key: 'луганська' }], raions: [] } }));
    expect(text).toContain('🔴 Тривога — областей: 1');
    expect(text).not.toMatch(/рівень/);
  });
});

// ── The watcher ───────────────────────────────────────────────────────────────

const KYIV_OBLAST = resolveRegion('київська область');
const GEO = { oblasts: { type: 'FeatureCollection', features: [] }, raions: { type: 'FeatureCollection', features: [] } };
const kyivAlert = (level) => ({ oblasts: level ? [oblastEntry('київська', level)] : [], raions: [] });

function levelWatcher({ confirmOffMs = 30_000, initialStates = null, alerts = kyivAlert(null) } = {}) {
  const notify = vi.fn();
  const onStateChange = vi.fn();
  let clock = 5_000_000;
  const box = { snapshot: { threats: [], alerts } };
  const watcher = createAlertWatcher({
    getSnapshot: () => box.snapshot,
    getGeo: async () => GEO,
    notify,
    onStateChange,
    initialStates,
    confirmOffMs,
    listRegions: () => [{ region: KYIV_OBLAST, chatIds: ['1'] }],
    now: () => clock,
  });
  return {
    watcher, notify, onStateChange,
    set: (level) => { box.snapshot = { threats: [], alerts: kyivAlert(level) }; },
    advance: (ms) => { clock += ms; },
    alerts: () => notify.mock.calls.map(([e]) => e).filter((e) => e.kind === 'alert'),
  };
}

describe('watcher: alert levels', () => {
  it('announces a yellow alert as yellow', async () => {
    const w = levelWatcher();
    await w.watcher.tick(); // seed: quiet
    w.set('yellow');
    await w.watcher.tick();

    const [event] = w.alerts();
    expect(event).toMatchObject({ active: true, level: 'yellow', previousLevel: null });
    const text = stripHtml(formatAlertNotification(event));
    expect(text).toContain('🟡 Повітряна тривога — Київська область');
    expect(text).toContain(YELLOW);
  });

  it('announces yellow → red at once — the moment to go to the shelter', async () => {
    const w = levelWatcher();
    await w.watcher.tick();
    w.set('yellow');
    await w.watcher.tick();
    w.set('red');
    w.advance(1_000);
    await w.watcher.tick();

    const events = w.alerts();
    expect(events).toHaveLength(2);
    expect(events[1]).toMatchObject({ active: true, level: 'red', previousLevel: 'yellow' });
    const text = stripHtml(formatAlertNotification(events[1]));
    expect(text).toContain('🔴 Червоний рівень — Київська область');
    expect(text).toContain('посилено');
    expect(text).toContain(RED);
    expect(w.onStateChange).toHaveBeenLastCalledWith(KYIV_OBLAST.cacheKey, true, expect.any(Number), 'red');
  });

  it('holds red → yellow like an all-clear, then announces it', async () => {
    const w = levelWatcher();
    w.set('red');
    await w.watcher.tick(); // seed: red

    w.set('yellow');
    await w.watcher.tick();
    expect(w.alerts()).toHaveLength(0); // people leave the shelter on this — not yet

    w.advance(31_000);
    await w.watcher.tick();
    const [event] = w.alerts();
    expect(event).toMatchObject({ active: true, level: 'yellow', previousLevel: 'red' });
    expect(stripHtml(formatAlertNotification(event))).toContain('🟡 Жовтий рівень — Київська область');
  });

  it('says nothing when red dips to yellow and comes back inside the hold', async () => {
    const w = levelWatcher();
    w.set('red');
    await w.watcher.tick();
    w.set('yellow');
    await w.watcher.tick();
    w.advance(10_000);
    w.set('red');
    await w.watcher.tick();
    w.advance(60_000);
    await w.watcher.tick();

    expect(w.alerts()).toHaveLength(0);
  });

  it('carries the alert\'s peak level on the all-clear', async () => {
    const w = levelWatcher();
    await w.watcher.tick();
    w.set('yellow');
    await w.watcher.tick();
    w.set(null);
    await w.watcher.tick();
    w.advance(31_000);
    await w.watcher.tick();

    const clear = w.alerts().at(-1);
    expect(clear).toMatchObject({ active: false, peakLevel: 'yellow' });

    // A second alert that went red reports red, not the old yellow.
    w.set('yellow');
    await w.watcher.tick();
    w.set('red');
    await w.watcher.tick();
    w.set(null);
    await w.watcher.tick();
    w.advance(31_000);
    await w.watcher.tick();
    expect(w.alerts().at(-1)).toMatchObject({ active: false, peakLevel: 'red' });
  });

  describe('across a restart', () => {
    const at = 5_000_000 - 60_000;

    it('announces a rise to red that happened while the bot was down', async () => {
      const w = levelWatcher({
        initialStates: { [KYIV_OBLAST.cacheKey]: { confirmed: true, level: 'yellow', at } },
        alerts: kyivAlert('red'),
      });
      await w.watcher.tick();
      expect(w.alerts()).toEqual([
        expect.objectContaining({ level: 'red', previousLevel: 'yellow', missedWhileDown: true }),
      ]);
    });

    it('holds a drop to yellow that happened while the bot was down', async () => {
      const w = levelWatcher({
        initialStates: { [KYIV_OBLAST.cacheKey]: { confirmed: true, level: 'red', at } },
        alerts: kyivAlert('yellow'),
      });
      await w.watcher.tick();
      expect(w.alerts()).toHaveLength(0);
      w.advance(31_000);
      await w.watcher.tick();
      expect(w.alerts()).toEqual([expect.objectContaining({ level: 'yellow', previousLevel: 'red' })]);
    });

    it('stays silent when the remembered alert has no level (written before levels existed)', async () => {
      // The first deploy of this feature must not announce every running
      // alert again just because the old file didn't say which colour it was.
      const w = levelWatcher({
        initialStates: { [KYIV_OBLAST.cacheKey]: { confirmed: true, at } },
        alerts: kyivAlert('red'),
      });
      await w.watcher.tick();
      expect(w.alerts()).toHaveLength(0);
      // …and upgrades the record so the next restart can compare levels.
      expect(w.onStateChange).toHaveBeenCalledWith(KYIV_OBLAST.cacheKey, true, expect.any(Number), 'red');
    });
  });
});

describe('alertRoute — who hears which level', () => {
  it('a yellow start is also a "yellow" message', () => {
    expect(alertRoute({ active: true, level: 'yellow', previousLevel: null })).toEqual(['alert', 'yellow']);
  });

  it('anything touching red goes to every chat that wants alerts', () => {
    expect(alertRoute({ active: true, level: 'red', previousLevel: null })).toBe('alert');
    expect(alertRoute({ active: true, level: 'red', previousLevel: 'yellow' })).toBe('alert');
    // The drop back to yellow: whoever heard the red needs to hear it ended.
    expect(alertRoute({ active: true, level: 'yellow', previousLevel: 'red' })).toBe('alert');
    expect(alertRoute({ active: false, peakLevel: 'red' })).toBe('alert');
  });

  it('the відбій of an alert that stayed yellow follows the yellow setting', () => {
    expect(alertRoute({ active: false, peakLevel: 'yellow' })).toEqual(['alert', 'yellow']);
  });

  it('a chat with yellow off hears the red, not the yellow', () => {
    const sendTo = vi.fn();
    const notifier = createChatNotifier({
      sendTo,
      getSettings: () => ({ alert: true, yellow: false }),
    });

    notifier.deliver({ category: alertRoute({ active: true, level: 'yellow' }), text: 'y', chatIds: ['1'] });
    notifier.deliver({ category: alertRoute({ active: true, level: 'red', previousLevel: 'yellow' }), text: 'r', chatIds: ['1'] });

    expect(sendTo.mock.calls).toEqual([['1', 'r']]);
  });

  it('a chat with alerts off hears neither', () => {
    const sendTo = vi.fn();
    const notifier = createChatNotifier({ sendTo, getSettings: () => ({ alert: false, yellow: true }) });
    notifier.deliver({ category: ['alert', 'yellow'], text: 'y', chatIds: ['1'] });
    expect(sendTo).not.toHaveBeenCalled();
  });
});

describe('alertState persists the level', () => {
  let dir;
  afterEach(async () => {
    delete process.env.ALERT_STATE_FILE;
    if (dir) await fs.rm(dir, { recursive: true, force: true });
    dir = null;
  });

  it('round-trips the level, and reads an old file without one', async () => {
    dir = await fs.mkdtemp(path.join(os.tmpdir(), 'alert-state-'));
    process.env.ALERT_STATE_FILE = path.join(dir, 'alertState.json');
    const mod = await import('../neptun/alertState.js');
    mod.__resetAlertState();

    await mod.recordAlertState('o:київська', true, 1_000, 'yellow');
    await mod.recordAlertState('c:дніпро', false, 2_000, 'red'); // no level on "off"
    mod.__resetAlertState();
    const loaded = await mod.loadAlertState();
    expect(loaded).toEqual({
      'o:київська': { confirmed: true, at: 1_000, level: 'yellow' },
      'c:дніпро': { confirmed: false, at: 2_000 },
    });

    await fs.writeFile(process.env.ALERT_STATE_FILE, JSON.stringify({ version: 1, regions: { 'c:київ': { confirmed: true, at: 3 } } }));
    mod.__resetAlertState();
    expect(await mod.loadAlertState()).toEqual({ 'c:київ': { confirmed: true, at: 3 } });
  });
});
