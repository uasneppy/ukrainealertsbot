/**
 * Renders are queued rather than run all at once: each one holds a Chromium
 * page containing raion-level GeoJSON, and unbounded concurrency can push the
 * container past the 2G cap in docker-compose.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

const { state } = vi.hoisted(() => ({
  state: { open: 0, peak: 0, closed: 0, failNextNewPage: false },
}));

vi.mock('../neptun/browser.js', async () => {
  const makePage = () => ({
    setViewport: async () => {},
    setContent: async () => {},
    evaluate: async () => {},
    waitForFunction: async () => {},
    // Hold the page open briefly so overlapping renders are actually observable.
    screenshot: async () => {
      await new Promise((r) => setTimeout(r, 20));
      return Buffer.from('png');
    },
    close: async () => {
      state.open -= 1;
      state.closed += 1;
    },
  });

  return {
    getOrLaunchBrowser: async () => ({
      newPage: async () => {
        if (state.failNextNewPage) {
          state.failNextNewPage = false;
          throw new Error('newPage failed');
        }
        state.open += 1;
        state.peak = Math.max(state.peak, state.open);
        return makePage();
      },
    }),
    closeBrowser: async () => {},
  };
});

// Keep the renderer off the disk/network for geo + icons.
vi.mock('../neptun/fetchGeo.js', () => ({
  getGeoData: async () => ({
    ukraine: { type: 'FeatureCollection', features: [] },
    oblasts: { type: 'FeatureCollection', features: [] },
    raions: { type: 'FeatureCollection', features: [] },
  }),
}));
vi.mock('../neptun/threatIcons.js', () => ({ loadThreatIcons: async () => ({}) }));

describe('render concurrency cap', () => {
  beforeEach(() => {
    state.open = 0;
    state.peak = 0;
    state.closed = 0;
  });

  it('never runs more renders at once than the limit, and completes them all', async () => {
    const { renderNeptunMap, renderQueueStats } = await import('../neptun/mapRenderer.js');
    const { limit } = renderQueueStats();

    const threats = [{ id: 't1', type: 'uav', lat: 50.4, lon: 30.5 }];
    const results = await Promise.all(
      Array.from({ length: 8 }, () => renderNeptunMap({ threats, alerts: {} }))
    );

    expect(results).toHaveLength(8);
    expect(state.peak).toBeLessThanOrEqual(limit);
    expect(state.peak).toBeGreaterThan(0);
    // Every page opened was also closed, and every slot handed back.
    expect(state.open).toBe(0);
    expect(state.closed).toBe(8);
    expect(renderQueueStats()).toMatchObject({ active: 0, queued: 0 });
  });

  it('releases the slot when a render throws after acquiring it', async () => {
    const { renderNeptunMap, renderQueueStats } = await import('../neptun/mapRenderer.js');

    // Fail inside the guarded section — a leak here would permanently burn a
    // slot and, repeated, deadlock every future render.
    state.failNextNewPage = true;
    await expect(renderNeptunMap({ threats: [], alerts: {} })).rejects.toThrow('newPage failed');

    expect(renderQueueStats()).toMatchObject({ active: 0, queued: 0 });

    // The next render still goes through, proving the slot came back.
    await expect(renderNeptunMap({ threats: [], alerts: {} })).resolves.toHaveProperty('buffer');
    expect(renderQueueStats()).toMatchObject({ active: 0, queued: 0 });
  });
});
