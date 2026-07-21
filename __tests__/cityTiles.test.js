/**
 * Street tiles are an opt-in enhancement: the map must stay self-contained
 * (boundaries only, no network) unless a tile source is configured.
 */
import { describe, it, expect } from 'vitest';

import { resolveCityTiles } from '../neptun/mapRenderer.js';

describe('resolveCityTiles', () => {
  it('is off by default — nothing configured, no tiles', () => {
    expect(resolveCityTiles({})).toBeNull();
  });

  it('builds a dark Stadia URL from just the API key', () => {
    const t = resolveCityTiles({ STADIA_API_KEY: 'abc123' });
    expect(t.url).toContain('stadiamaps.com');
    expect(t.url).toContain('alidade_smooth_dark');
    expect(t.url).toContain('api_key=abc123');
    expect(t.url).toContain('{z}/{x}/{y}');
    expect(t.attribution).toContain('OpenStreetMap');
  });

  it('lets an explicit CITY_TILES_URL win, with its own attribution', () => {
    const t = resolveCityTiles({
      CITY_TILES_URL: 'https://tiles.example/{z}/{x}/{y}.png',
      CITY_TILES_ATTRIBUTION: '© Example',
      STADIA_API_KEY: 'ignored',
    });
    expect(t.url).toBe('https://tiles.example/{z}/{x}/{y}.png');
    expect(t.attribution).toBe('© Example');
    expect(t.url).not.toContain('stadia');
  });

  it('defaults the max zoom and honours an override', () => {
    expect(resolveCityTiles({ CITY_TILES_URL: 'x/{z}/{x}/{y}' }).maxZoom).toBe(19);
    expect(resolveCityTiles({ CITY_TILES_URL: 'x/{z}/{x}/{y}', CITY_TILES_MAX_ZOOM: '17' }).maxZoom).toBe(17);
  });
});
