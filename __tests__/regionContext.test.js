import { describe, expect, it } from 'vitest';

import {
  haversineKm,
  bearingDeg,
  bearingToWord,
  featureBbox,
  pointInFeature,
  distanceToBboxKm,
  findOblastFeature,
  fmtKyivTime,
  buildRegionStatus,
  formatRegionReport,
  buildFocusCaption,
} from '../neptun/regionContext.js';

// Square "oblast" spanning lon 30–31, lat 50–51.
const squareFeature = {
  type: 'Feature',
  properties: { key: 'тестова' },
  geometry: {
    type: 'Polygon',
    coordinates: [[[30, 50], [31, 50], [31, 51], [30, 51], [30, 50]]],
  },
};

const geo = { oblasts: { type: 'FeatureCollection', features: [squareFeature] } };

const oblastRegion = { kind: 'oblast', geoKey: 'тестова', name: 'Тестова область' };

describe('geometry helpers', () => {
  it('haversineKm: Kyiv → Kharkiv ≈ 410 km', () => {
    const d = haversineKm(50.4501, 30.5234, 49.9935, 36.2304);
    expect(d).toBeGreaterThan(380);
    expect(d).toBeLessThan(440);
  });

  it('bearingDeg/bearingToWord: east and south-west', () => {
    const east = bearingDeg(50, 30, 50, 31);
    expect(bearingToWord(east)).toBe('схід');
    expect(bearingToWord(225)).toBe('південний захід');
    expect(bearingToWord(225, { short: true })).toBe('пд-зх');
    expect(bearingToWord(NaN)).toBe('');
  });

  it('pointInFeature: inside / outside for Polygon and MultiPolygon', () => {
    expect(pointInFeature(50.5, 30.5, squareFeature)).toBe(true);
    expect(pointInFeature(49.5, 30.5, squareFeature)).toBe(false);
    const multi = {
      geometry: { type: 'MultiPolygon', coordinates: [squareFeature.geometry.coordinates] },
    };
    expect(pointInFeature(50.5, 30.5, multi)).toBe(true);
    expect(pointInFeature(49.5, 30.5, multi)).toBe(false);
  });

  it('featureBbox + distanceToBboxKm', () => {
    const bbox = featureBbox(squareFeature);
    expect(bbox).toEqual({ minLat: 50, maxLat: 51, minLon: 30, maxLon: 31 });
    expect(distanceToBboxKm(50.5, 30.5, bbox)).toBe(0);
    expect(distanceToBboxKm(50.5, 31.5, bbox)).toBeGreaterThan(30);
  });

  it('findOblastFeature matches normalised keys', () => {
    expect(findOblastFeature(geo, 'тестова')).toBe(squareFeature);
    expect(findOblastFeature(geo, 'Тестова область')).toBe(squareFeature);
    expect(findOblastFeature(geo, 'інша')).toBeNull();
  });

  it('fmtKyivTime converts UTC to Kyiv summer time', () => {
    expect(fmtKyivTime('2026-07-18T18:05:00Z')).toBe('21:05');
    expect(fmtKyivTime('not a date')).toBe('');
    expect(fmtKyivTime('')).toBe('');
  });
});

describe('buildRegionStatus — oblast', () => {
  const threats = [
    { id: 'in1', type: 'uav', title: 'БпЛА', lat: 50.5, lon: 30.5, locality: 'Село', heading: 90 },
    { id: 'near1', type: 'missile', title: 'Ракета', lat: 50.5, lon: 31.6 }, // ~43 km east of bbox
    { id: 'far1', type: 'uav', title: 'БпЛА', lat: 55, lon: 40 },
    { id: 'bad1', type: 'uav', title: 'БпЛА', lat: null, lon: undefined },
  ];

  it('splits threats into in-region and nearby, skipping far/invalid ones', () => {
    const status = buildRegionStatus({ region: oblastRegion, threats, alerts: {}, geo });
    expect(status.threatsIn.map((t) => t.id)).toEqual(['in1']);
    expect(status.threatsNear.map((t) => t.id)).toEqual(['near1']);
    expect(status.threatsIn[0].headingWord).toBe('схід');
    expect(status.threatsNear[0].distanceKm).toBeGreaterThan(30);
    expect(status.threatsNear[0].direction).toBe('схід');
  });

  it('full-oblast alert → scope "oblast"', () => {
    const alerts = { oblasts: [{ key: 'тестова', name: 'Тестова область', since: '2026-07-18T18:05:00Z' }] };
    const status = buildRegionStatus({ region: oblastRegion, threats: [], alerts, geo });
    expect(status.alertActive).toBe(true);
    expect(status.alertScope).toBe('oblast');
    expect(status.alertSince).toBe('2026-07-18T18:05:00Z');
  });

  it('raion alerts inside the oblast → scope "raions" with the earliest since', () => {
    const alerts = {
      raions: [
        { key: 'р-один', name: 'Перший район', oblast: 'Тестова область', since: '2026-07-18T18:10:00Z' },
        { key: 'р-два', name: 'Другий район', oblast: 'Тестова область', since: '2026-07-18T18:02:00Z' },
        { key: 'чужий', name: 'Чужий район', oblast: 'Інша область', since: '2026-07-18T18:00:00Z' },
      ],
    };
    const status = buildRegionStatus({ region: oblastRegion, threats: [], alerts, geo });
    expect(status.alertScope).toBe('raions');
    expect(status.alertedRaions).toHaveLength(2);
    expect(new Date(status.alertSince).toISOString()).toBe('2026-07-18T18:02:00.000Z');
  });

  it('no alerts → inactive', () => {
    const status = buildRegionStatus({ region: oblastRegion, threats: [], alerts: {}, geo });
    expect(status.alertActive).toBe(false);
    expect(status.alertScope).toBeNull();
  });
});

describe('buildRegionStatus — city', () => {
  const kyiv = {
    kind: 'city', name: 'Київ', lat: 50.4501, lon: 30.5234,
    radiusKm: 65, alertKey: 'м. київ', oblastGeoKey: 'м. київ', raionKey: null,
  };

  it('classifies threats by distance from the city', () => {
    const threats = [
      { id: 'c1', type: 'uav', title: 'БпЛА', lat: 50.5111, lon: 30.7909, locality: 'Бровари' }, // ~20 km
      { id: 'c2', type: 'uav', title: 'БпЛА', lat: 50.2547, lon: 28.6587, locality: 'Житомир' }, // ~133 km
      { id: 'c3', type: 'uav', title: 'БпЛА', lat: 46.48, lon: 30.72 }, // Odesa — far
    ];
    const status = buildRegionStatus({ region: kyiv, threats, alerts: {}, geo });
    expect(status.threatsIn.map((t) => t.id)).toEqual(['c1']);
    expect(status.threatsNear.map((t) => t.id)).toEqual(['c2']);
    expect(status.threatsIn[0].direction).not.toBe('');
  });

  it('city-level alert (м. київ) → scope "city"', () => {
    const alerts = { oblasts: [{ key: 'м. київ', name: 'м. Київ', since: '2026-07-18T18:05:00Z' }] };
    const status = buildRegionStatus({ region: kyiv, threats: [], alerts, geo });
    expect(status.alertScope).toBe('city');
    expect(status.alertSince).toBe('2026-07-18T18:05:00Z');
  });

  it('raion-level alert → scope "raion", full-oblast alert → scope "oblast"', () => {
    const kharkiv = {
      kind: 'city', name: 'Харків', lat: 49.9935, lon: 36.2304,
      radiusKm: 55, alertKey: null, oblastGeoKey: 'харківська', raionKey: 'харківський',
    };
    const viaRaion = buildRegionStatus({
      region: kharkiv, threats: [],
      alerts: { raions: [{ key: 'харківський', name: 'Харківський район', oblast: 'Харківська область', since: '2026-07-18T17:00:00Z' }] },
      geo,
    });
    expect(viaRaion.alertScope).toBe('raion');

    const viaOblast = buildRegionStatus({
      region: kharkiv, threats: [],
      alerts: { oblasts: [{ key: 'харківська', name: 'Харківська область', since: '2026-07-18T17:20:00Z' }] },
      geo,
    });
    expect(viaOblast.alertScope).toBe('oblast');
  });
});

describe('report and caption builders', () => {
  const alerts = { oblasts: [{ key: 'тестова', name: 'Тестова область', since: '2026-07-18T18:05:00Z' }] };
  const threats = [
    { id: 'in1', type: 'uav', title: 'БпЛА', lat: 50.5, lon: 30.5, locality: 'Село', heading: 270 },
  ];

  it('formatRegionReport contains the region, alert line and threat line', () => {
    const status = buildRegionStatus({ region: oblastRegion, threats, alerts, geo });
    const report = formatRegionReport(status);
    expect(report).toContain('📍 Тестова область');
    expect(report).toContain('🔴 Тривога — вся область (з 21:05)');
    expect(report).toContain('БпЛА — Село');
    expect(report).toContain('курс: захід');
  });

  it('reports "no alert / no threats" states', () => {
    const status = buildRegionStatus({ region: oblastRegion, threats: [], alerts: {}, geo });
    const report = formatRegionReport(status);
    expect(report).toContain('🟢 Тривоги немає');
    expect(report).toContain('✅ Загроз у регіоні та поблизу не зафіксовано');
  });

  it('buildFocusCaption stays under the Telegram 1024-char limit', () => {
    const manyThreats = Array.from({ length: 40 }, (_, i) => ({
      id: `t${i}`, type: 'uav', title: 'БпЛА',
      lat: 50.1 + (i % 9) * 0.1, lon: 30.1 + (i % 9) * 0.1,
      locality: `Дуже-Довга-Назва-Населеного-Пункту-№${i}`, heading: 45,
    }));
    const status = buildRegionStatus({ region: oblastRegion, threats: manyThreats, alerts, geo });
    const caption = buildFocusCaption(status, new Date('2026-07-18T18:30:00Z'));
    expect(caption.length).toBeLessThanOrEqual(1024);
    expect(caption).toContain('🗺 NEPTUN — Тестова область');
    expect(caption).toContain('© neptun.in.ua');
  });
});
