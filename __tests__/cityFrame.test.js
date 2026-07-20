/**
 * The frame has to agree with the caption. A city map captioned
 * "Загрози (4)" that shows one marker — the other three cropped out — is worse
 * than useless during an attack, because the ones approaching are exactly what
 * the person is asking about.
 */
import { describe, it, expect } from 'vitest';

import { computeCityFrameKm } from '../neptun/mapRenderer.js';

const at = (distanceKm) => ({ distanceKm });

describe('computeCityFrameKm', () => {
  it('stays tight when nothing is around', () => {
    expect(computeCityFrameKm({ radiusKm: 65 })).toBe(28);
  });

  it('hugs the city when threats are right on top of it', () => {
    expect(computeCityFrameKm({ radiusKm: 65, threatsIn: [at(2), at(5)] })).toBe(18);
  });

  it('opens up to include a threat inside the radius', () => {
    const frame = computeCityFrameKm({ radiusKm: 65, threatsIn: [at(40)] });

    expect(frame).toBeGreaterThan(40);
    expect(frame).toBeLessThan(60);
  });

  it('includes nearby threats the caption counts', () => {
    // The regression: these were counted but cropped out.
    const frame = computeCityFrameKm({
      radiusKm: 65,
      threatsIn: [at(10)],
      threatsNear: [at(78), at(92)],
    });

    expect(frame).toBeGreaterThanOrEqual(92);
  });

  it('ignores threats too far to belong in a city view', () => {
    // 200 km away is a national-map concern; the caption still lists it.
    const frame = computeCityFrameKm({ radiusKm: 65, threatsIn: [at(10)], threatsNear: [at(200)] });

    expect(frame).toBeLessThan(60);
  });

  it('never zooms out past the point where the city is a dot', () => {
    const frame = computeCityFrameKm({
      radiusKm: 65,
      threatsNear: [at(100), at(104)],
    });

    expect(frame).toBe(95);
  });

  it('scales the nearby cut-off with the city radius', () => {
    // A 45 km city (Луцьк) admits less than a 65 km one (Київ).
    const small = computeCityFrameKm({ radiusKm: 45, threatsNear: [at(80)] });
    const large = computeCityFrameKm({ radiusKm: 65, threatsNear: [at(80)] });

    expect(small).toBe(28); // 80 > 45 * 1.6 — excluded
    expect(large).toBeGreaterThan(80); // 80 < 65 * 1.6 — included
  });

  it('tolerates missing input', () => {
    expect(computeCityFrameKm()).toBe(28);
    expect(computeCityFrameKm({})).toBe(28);
  });
});
