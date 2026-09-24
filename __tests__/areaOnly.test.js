/**
 * `areaOnly: true` — the sources named an oblast and nothing more. NEPTUN's
 * lat/lon for it is the oblast centroid. Read as a position, the
 * Dnipropetrovsk warning of 24 Sept 2026 came out as "БпЛА у регіоні" for
 * Запоріжжя (another oblast) and "~111 км на схід" for Кривий Ріг: invented
 * facts, and for a missile a push notification about a place nobody named.
 */
import os from 'node:os';
import path from 'node:path';

import { describe, it, expect, vi } from 'vitest';

import { buildRegionStatus, formatRegionReport, formatDistance } from '../neptun/regionContext.js';
import { createAlertWatcher, formatThreatNotification } from '../neptun/alertWatcher.js';
import { createNightLog } from '../neptun/nightLog.js';
import { classifyTrack } from '../neptun/nightDigest.js';
import { computeTypeMeta } from '../neptun/mapRenderer.js';
import { resolveRegion } from '../neptun/regionResolver.js';
import { stripHtml } from '../neptun/telegramFormat.js';

// The track NEPTUN served at 11:52 on 24 Sept 2026, verbatim but for the time.
const DNIPRO_AREA_UAV = {
  id: 'trk_00213706', type: 'uav', title: 'БпЛА — по області',
  region: 'Дніпропетровська область', district: '', locality: 'Дніпропетровська область',
  lat: 48.27085836179639, lon: 34.78592104996836, heading: null,
  confidenceLevel: 'medium', sourceCount: 3, count: 1,
  explanationShort: 'БпЛА — Дніпропетровська область: попередження по області, точка невідома. Підтверджень: 3.',
  status: 'active', uncertaintyKm: 70, positionQuality: 'approx', lifecycle: 'uncertain', areaOnly: true,
};

const areaMissile = (id, extra = {}) => ({
  ...DNIPRO_AREA_UAV, id, type: 'missile', title: 'Ракета — по області', count: 1, ...extra,
});

const NO_ALERTS = { oblasts: [], raions: [] };

// A square around Kyiv standing in for Київська область: Київ is an enclave
// with its own alert key, inside the oblast's outer boundary.
const KYIV_OBLAST_FEATURE = {
  type: 'Feature',
  properties: { key: 'київська' },
  geometry: { type: 'Polygon', coordinates: [[[29.5, 49.5], [32, 49.5], [32, 51.5], [29.5, 51.5], [29.5, 49.5]]] },
};
const GEO = { oblasts: { type: 'FeatureCollection', features: [KYIV_OBLAST_FEATURE] } };

describe('region status', () => {
  it('never reaches a city in another oblast', () => {
    // The live bug: the centroid sat inside Запоріжжя's in-radius.
    const status = buildRegionStatus({ region: resolveRegion('запоріжжя'), threats: [DNIPRO_AREA_UAV], alerts: NO_ALERTS });
    expect(status.threatsIn).toHaveLength(0);
    expect(status.threatsNear).toHaveLength(0);
    expect(status.threatsArea).toHaveLength(0);
  });

  it('never gets a distance', () => {
    const status = buildRegionStatus({ region: resolveRegion('кривий ріг'), threats: [DNIPRO_AREA_UAV], alerts: NO_ALERTS });
    expect(status.threatsNear).toHaveLength(0);
    expect(status.threatsArea).toHaveLength(1);
    const text = formatRegionReport(status);
    expect(text).not.toMatch(/км/);
    expect(text).toContain('По області, місце невідоме — 1');
    expect(text).toContain('БпЛА · Дніпропетровська область');
  });

  it('is listed for a city in that oblast — apart from what is over the city', () => {
    const status = buildRegionStatus({ region: resolveRegion('дніпро'), threats: [DNIPRO_AREA_UAV], alerts: NO_ALERTS });
    expect(status.threatsIn).toHaveLength(0);
    expect(status.threatsArea).toEqual([
      expect.objectContaining({ id: 'trk_00213706', areaOnly: true, distanceKm: null, lat: null, lon: null, headingWord: '' }),
    ]);
    expect(formatRegionReport(status)).not.toContain('У регіоні');
  });

  it('is listed for the oblast itself, matched by name — no geometry needed', () => {
    const status = buildRegionStatus({
      region: { kind: 'oblast', geoKey: 'дніпропетровська', name: 'Дніпропетровська область' },
      threats: [DNIPRO_AREA_UAV],
      alerts: NO_ALERTS,
    });
    expect(status.threatsArea).toHaveLength(1);
    expect(status.threatsIn).toHaveLength(0);
  });

  it('reaches Київ for «на Київщину» — the city lies inside the oblast boundary', () => {
    const kyivAreaMissile = areaMissile('trk_kyiv', { region: 'Київська область', locality: 'Київська область', lat: 50.4, lon: 30.6 });
    const status = buildRegionStatus({ region: resolveRegion('київ'), threats: [kyivAreaMissile], alerts: NO_ALERTS, geo: GEO });
    expect(status.threatsArea).toHaveLength(1);
    expect(status.threatsIn).toHaveLength(0);
  });

  it('does not stop "no threats" from being said when there are none', () => {
    const status = buildRegionStatus({ region: resolveRegion('львів'), threats: [DNIPRO_AREA_UAV], alerts: NO_ALERTS });
    expect(formatRegionReport(status)).toContain('Загроз у регіоні та поблизу не зафіксовано');
  });
});

describe('alert watcher', () => {
  function watcherFor(query) {
    const notify = vi.fn();
    const box = { snapshot: { threats: [], alerts: NO_ALERTS } };
    let clock = 1_000_000;
    const watcher = createAlertWatcher({
      getSnapshot: () => box.snapshot,
      getGeo: async () => GEO,
      notify,
      listRegions: () => [{ region: resolveRegion(query), chatIds: ['1'] }],
      now: () => clock,
    });
    return {
      watcher, box,
      advance: (ms) => { clock += ms; },
      threatEvents: () => notify.mock.calls.map(([e]) => e).filter((e) => e.kind === 'threat'),
    };
  }

  it('announces an area-only missile to its oblast as exactly that', async () => {
    const w = watcherFor('дніпро');
    await w.watcher.tick(); // seed
    w.box.snapshot = { threats: [areaMissile('m1')], alerts: NO_ALERTS };
    await w.watcher.tick();

    const [event] = w.threatEvents();
    expect(event.events).toEqual([expect.objectContaining({ stage: 'area' })]);
    const text = stripHtml(formatThreatNotification(event));
    expect(text).toContain('⚠️ 🚀 Ракета — Дніпро');
    expect(text).toContain('по області: Дніпропетровська область · точне місце невідоме');
    expect(text).not.toMatch(/км|над |🚨/);
  });

  it('says nothing to a city in another oblast', async () => {
    const w = watcherFor('запоріжжя');
    await w.watcher.tick();
    w.box.snapshot = { threats: [areaMissile('m1')], alerts: NO_ALERTS };
    await w.watcher.tick();
    expect(w.threatEvents()).toHaveLength(0);
  });

  it('announces again once the same track has a real position, then goes quiet', async () => {
    const w = watcherFor('дніпро');
    await w.watcher.tick();
    w.box.snapshot = { threats: [areaMissile('m1')], alerts: NO_ALERTS };
    await w.watcher.tick();

    const located = {
      ...areaMissile('m1'), areaOnly: false, locality: 'Дніпро', title: 'Ракета',
      lat: 48.47, lon: 35.05, positionQuality: 'confirmed', lifecycle: 'confirmed', uncertaintyKm: 4,
    };
    w.box.snapshot = { threats: [located], alerts: NO_ALERTS };
    w.advance(2_000);
    await w.watcher.tick();
    w.advance(2_000);
    await w.watcher.tick();

    const stages = w.threatEvents().map((e) => e.events[0].stage);
    expect(stages).toEqual(['area', 'in']);
  });
});

describe('night log', () => {
  it('keeps the oblast an area-only track named, and no sample at its centroid', () => {
    // Nothing is flushed: the write is debounced far past the test, and the
    // file points into the OS temp dir in case it ever isn't.
    const log = createNightLog({ file: path.join(os.tmpdir(), `nightlog-area-${process.pid}.json`), now: () => 1_000 });
    log.recordThreats([DNIPRO_AREA_UAV], 1_000);
    const [track] = log.tracksSince(0);
    expect(track.samples).toEqual([]);
    expect(track.localities).toEqual([]);
    expect(track.areaRegion).toBe('Дніпропетровська область');
  });

  it('counts such a track for its oblast and for no city', () => {
    const track = { id: 't', samples: [], areaRegion: 'Дніпропетровська область' };
    expect(classifyTrack(track, { kind: 'oblast', geoKey: 'дніпропетровська' }, {})).toBe('in');
    expect(classifyTrack(track, resolveRegion('дніпро'), {})).toBe(null);
    expect(classifyTrack(track, resolveRegion('запоріжжя'), {})).toBe(null);
  });
});

describe('uncertainty and group size', () => {
  it('formatDistance adds NEPTUN\'s ± only when it is material', () => {
    expect(formatDistance(31, 10)).toBe('~31 км (±10)');
    expect(formatDistance(96, 10)).toBe('~96 км');   // 10 on 96 is noise
    expect(formatDistance(12, 4)).toBe('~12 км');    // under 5 km never shown
    expect(formatDistance(30.6, null)).toBe('~31 км');
  });

  it('a nearby line carries the uncertainty', () => {
    const status = buildRegionStatus({
      region: resolveRegion('дніпро'),
      // ~66 km out, placed within ±25 — values NEPTUN really sends.
      threats: [{ id: 'u', type: 'uav', title: 'БпЛА', lat: 48.0, lon: 35.6, uncertaintyKm: 25, heading: 90 }],
      alerts: NO_ALERTS,
    });
    expect(status.threatsNear).toHaveLength(1);
    expect(formatRegionReport(status)).toMatch(/~6\d км \(±25\)/);
  });

  it('a group reads as its size, in lines and in the legend count', () => {
    const group = { id: 'g', type: 'uav', title: 'Група БпЛА (5+)', count: 5, lat: 48.47, lon: 35.05, locality: 'Дніпро' };
    const single = { id: 's', type: 'uav', title: 'БпЛА', lat: 48.48, lon: 35.06, locality: 'Дніпро' };
    const status = buildRegionStatus({ region: resolveRegion('дніпро'), threats: [group, single], alerts: NO_ALERTS });
    const text = formatRegionReport(status);
    expect(text).toContain('БпЛА ×5');
    expect(computeTypeMeta([group, single]).uav.count).toBe(6);
    expect(computeTypeMeta([{ type: 'uav', count: 0 }]).uav.count).toBe(1); // 0 = not stated
  });
});
