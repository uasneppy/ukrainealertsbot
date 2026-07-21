/**
 * A city view must stay a *city* view. The bug this guards against: a single
 * threat tens of km away pulling the frame out until Kyiv is a dot. Distant
 * "поблизу" threats belong on the oblast map and in the caption, not on the
 * tight city frame.
 */
import { describe, it, expect } from 'vitest';

import { computeCityFrameKm, CITY_FRAME_MAX_KM } from '../neptun/mapRenderer.js';

const at = (distanceKm) => ({ distanceKm });

describe('computeCityFrameKm', () => {
  it('is a tight city view when nothing is close', () => {
    expect(computeCityFrameKm({})).toBe(24);
    expect(computeCityFrameKm({ threatsIn: [], threatsNear: [] })).toBe(24);
  });

  it('hugs the city when threats are right over it', () => {
    expect(computeCityFrameKm({ threatsIn: [at(2), at(5)] })).toBe(16);
  });

  it('opens up to include a threat within the metro area', () => {
    const frame = computeCityFrameKm({ threatsIn: [at(25)] });
    expect(frame).toBeGreaterThan(25);
    expect(frame).toBeLessThanOrEqual(CITY_FRAME_MAX_KM);
  });

  it('does NOT zoom out for a distant threat — the city stays the subject', () => {
    // The reported bug: a lone drone ~90 km out turned Kyiv into a dot.
    expect(computeCityFrameKm({ threatsNear: [at(90)] })).toBe(24);
    expect(computeCityFrameKm({ threatsIn: [at(3)], threatsNear: [at(90)] })).toBe(16);
  });

  it('never exceeds the metro-scale cap', () => {
    // A threat right at the inclusion edge still can't blow the frame open.
    expect(computeCityFrameKm({ threatsNear: [at(40)] })).toBeLessThanOrEqual(CITY_FRAME_MAX_KM);
    expect(computeCityFrameKm({ threatsIn: [at(40)] })).toBe(CITY_FRAME_MAX_KM);
  });

  it('tolerates missing input', () => {
    expect(() => computeCityFrameKm()).not.toThrow();
    expect(computeCityFrameKm()).toBe(24);
  });
});
