/**
 * The geo cache lives in a Docker volume that outlives deployments, so the
 * disk-hit / download / staleness branching decides whether the bot ever picks
 * up new administrative boundaries.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import fs from 'fs/promises';
import path from 'path';
import os from 'os';

const FEATURE_COLLECTION = { type: 'FeatureCollection', features: [] };

let dir;
let fetchMock;

beforeEach(async () => {
  vi.resetModules(); // module-level _cache must not leak between cases
  dir = await fs.mkdtemp(path.join(os.tmpdir(), 'geo-'));
  process.env.NEPTUN_GEO_DIR = dir;

  fetchMock = vi.fn(async () => ({
    ok: true,
    text: async () => JSON.stringify(FEATURE_COLLECTION),
  }));
  vi.stubGlobal('fetch', fetchMock);
});

afterEach(async () => {
  await fs.rm(dir, { recursive: true, force: true });
  delete process.env.NEPTUN_GEO_DIR;
  vi.unstubAllGlobals();
});

const write = (name, mtime) => {
  const file = path.join(dir, `${name}.geojson`);
  return fs
    .writeFile(file, JSON.stringify(FEATURE_COLLECTION), 'utf8')
    .then(() => (mtime ? fs.utimes(file, mtime, mtime) : null));
};

describe('getGeoData', () => {
  it('downloads all three files on a cold cache and writes them to disk', async () => {
    const { getGeoData } = await import('../neptun/fetchGeo.js');

    const geo = await getGeoData();

    expect(fetchMock).toHaveBeenCalledTimes(3);
    expect(geo).toHaveProperty('ukraine');
    expect(geo).toHaveProperty('oblasts');
    expect(geo).toHaveProperty('raions');
    await expect(fs.readdir(dir)).resolves.toEqual(
      expect.arrayContaining(['oblasts.geojson', 'raions.geojson', 'ukraine.geojson'])
    );
  });

  it('reads from disk without touching the network when the cache is warm', async () => {
    await Promise.all([write('ukraine'), write('oblasts'), write('raions')]);
    const { getGeoData } = await import('../neptun/fetchGeo.js');

    await getGeoData();

    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('serves the in-process cache on repeat calls', async () => {
    await Promise.all([write('ukraine'), write('oblasts'), write('raions')]);
    const { getGeoData } = await import('../neptun/fetchGeo.js');

    const first = await getGeoData();
    const second = await getGeoData();

    expect(second).toBe(first); // same object, no re-read
  });

  it('re-downloads only the file that is missing', async () => {
    await Promise.all([write('ukraine'), write('oblasts')]);
    const { getGeoData } = await import('../neptun/fetchGeo.js');

    await getGeoData();

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchMock.mock.calls[0][0]).toContain('raions.geojson');
  });
});

describe('geoCacheAgeMs', () => {
  it('is Infinity when a file is missing', async () => {
    await write('ukraine');
    const { geoCacheAgeMs } = await import('../neptun/fetchGeo.js');

    await expect(geoCacheAgeMs()).resolves.toBe(Infinity);
  });

  it('reports the age of the oldest file', async () => {
    const now = Date.now();
    const oldSeconds = (now - 10 * 86_400_000) / 1000;
    await write('ukraine', now / 1000);
    await write('oblasts', now / 1000);
    await write('raions', oldSeconds);

    const { geoCacheAgeMs } = await import('../neptun/fetchGeo.js');
    const age = await geoCacheAgeMs(now);

    expect(age).toBeGreaterThan(9 * 86_400_000);
    expect(age).toBeLessThan(11 * 86_400_000);
  });
});

describe('stale cache refresh', () => {
  it('re-downloads in the background once the cache ages past the limit', async () => {
    const ancient = (Date.now() - 60 * 86_400_000) / 1000; // 60 days
    await Promise.all([write('ukraine', ancient), write('oblasts', ancient), write('raions', ancient)]);
    const { getGeoData } = await import('../neptun/fetchGeo.js');

    // The call itself is served from disk — the refresh must not block it.
    await getGeoData();
    expect(fetchMock).not.toHaveBeenCalled();

    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(3));
  });

  it('leaves a fresh cache alone', async () => {
    const recent = (Date.now() - 86_400_000) / 1000; // 1 day
    await Promise.all([write('ukraine', recent), write('oblasts', recent), write('raions', recent)]);
    const { getGeoData } = await import('../neptun/fetchGeo.js');

    await getGeoData();
    await getGeoData();
    await new Promise((r) => setTimeout(r, 30));

    expect(fetchMock).not.toHaveBeenCalled();
  });
});

describe('forceRefreshGeo', () => {
  it('re-downloads unconditionally even with a warm cache', async () => {
    await Promise.all([write('ukraine'), write('oblasts'), write('raions')]);
    const { getGeoData, forceRefreshGeo } = await import('../neptun/fetchGeo.js');

    await getGeoData();
    expect(fetchMock).not.toHaveBeenCalled();

    const geo = await forceRefreshGeo();

    expect(fetchMock).toHaveBeenCalledTimes(3);
    expect(geo).toHaveProperty('raions');
  });

  it('propagates a failed download', async () => {
    fetchMock.mockResolvedValue({ ok: false, status: 503, text: async () => '' });
    const { forceRefreshGeo } = await import('../neptun/fetchGeo.js');

    await expect(forceRefreshGeo()).rejects.toThrow('HTTP 503');
  });
});
