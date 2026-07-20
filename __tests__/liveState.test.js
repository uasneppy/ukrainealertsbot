/**
 * The map must agree with the API. The stream's freshness clock is reset by
 * heartbeat and pong, so a socket that is alive but has missed an update looks
 * perfectly healthy while its state is wrong — and it used to be preferred over
 * the API for every reply, with nothing to reconcile the drift.
 */
import { describe, it, expect, vi } from 'vitest';

import { createSnapshotSource, DEFAULT_STREAM_FALLBACK_MS } from '../neptun/liveState.js';

const API_STATE = {
  threats: [{ id: 'api-1', type: 'ballistic', lat: 50, lon: 30 }],
  alerts: { oblasts: [{ key: 'київська' }], raions: [] },
};

const STREAM_STATE = {
  threats: [{ id: 'stale-1', type: 'uav', lat: 49, lon: 24 }],
  alerts: { oblasts: [], raions: [] },
};

const silence = { warn: () => {} };

function make({ fetchSnapshot, streamAge = 0, streamHasData = true, ...rest } = {}) {
  return createSnapshotSource({
    fetchSnapshot: fetchSnapshot ?? (async () => API_STATE),
    getState: () => STREAM_STATE,
    hasSnapshot: () => streamHasData,
    streamAgeMs: () => streamAge,
    log: silence,
    ...rest,
  });
}

describe('createSnapshotSource', () => {
  it('validates its dependencies', () => {
    expect(() => createSnapshotSource()).toThrow('fetchSnapshot is required');
    expect(() => createSnapshotSource({ fetchSnapshot: () => {} })).toThrow('getState is required');
  });

  it('reads the API even when the stream is connected and fresh', async () => {
    // The regression: a healthy socket meant the API was never consulted, so a
    // drifted stream was served indefinitely.
    const fetchSnapshot = vi.fn(async () => API_STATE);
    const source = make({ fetchSnapshot, streamAge: 0, streamHasData: true });

    const snapshot = await source.get();

    expect(fetchSnapshot).toHaveBeenCalledTimes(1);
    expect(snapshot.source).toBe('api');
    expect(snapshot.threats[0].id).toBe('api-1');
  });

  it('fetches again on every request — no time-based caching of the data', async () => {
    const fetchSnapshot = vi.fn(async () => API_STATE);
    const source = make({ fetchSnapshot });

    await source.get();
    await source.get();
    await source.get();

    expect(fetchSnapshot).toHaveBeenCalledTimes(3);
  });

  it('shares one request between concurrent callers', async () => {
    let resolveFetch;
    const fetchSnapshot = vi.fn(() => new Promise((r) => { resolveFetch = () => r(API_STATE); }));
    const source = make({ fetchSnapshot });

    const all = Promise.all([source.get(), source.get(), source.get()]);
    // The fetch is kicked off in a microtask, so wait for it to actually start.
    await vi.waitFor(() => expect(fetchSnapshot).toHaveBeenCalled());
    resolveFetch();
    const results = await all;

    expect(fetchSnapshot).toHaveBeenCalledTimes(1);
    expect(results.every((r) => r.threats[0].id === 'api-1')).toBe(true);
  });

  it('starts a new request once the shared one has settled', async () => {
    const fetchSnapshot = vi.fn(async () => API_STATE);
    const source = make({ fetchSnapshot });

    await Promise.all([source.get(), source.get()]);
    await source.get();

    expect(fetchSnapshot).toHaveBeenCalledTimes(2);
  });

  it('falls back to stream state when the API is unreachable', async () => {
    const source = make({
      fetchSnapshot: async () => { throw new Error('ECONNREFUSED'); },
      streamAge: 5_000,
      streamHasData: true,
    });

    const snapshot = await source.get();

    expect(snapshot.source).toBe('stream');
    expect(snapshot.threats[0].id).toBe('stale-1');
  });

  it('refuses stale stream state when the API is unreachable', async () => {
    const source = make({
      fetchSnapshot: async () => { throw new Error('ECONNREFUSED'); },
      streamAge: DEFAULT_STREAM_FALLBACK_MS + 1,
      streamHasData: true,
    });

    // Better to say "не вдалося" than to draw a map from state this old.
    await expect(source.get()).rejects.toThrow('ECONNREFUSED');
  });

  it('throws when the API fails and the stream never had data', async () => {
    const source = make({
      fetchSnapshot: async () => { throw new Error('boom'); },
      streamHasData: false,
    });

    await expect(source.get()).rejects.toThrow('boom');
  });

  it('surfaces a synchronous throw as a rejection', async () => {
    const source = make({
      fetchSnapshot: () => { throw new Error('sync boom'); },
      streamHasData: false,
    });

    await expect(source.get()).rejects.toThrow('sync boom');
  });

  it('does not wedge after a failure', async () => {
    let attempt = 0;
    const source = make({
      fetchSnapshot: async () => {
        attempt += 1;
        if (attempt === 1) throw new Error('transient');
        return API_STATE;
      },
      streamHasData: false,
    });

    await expect(source.get()).rejects.toThrow('transient');
    await expect(source.get()).resolves.toMatchObject({ source: 'api' });
  });

  it('getOrNull returns null instead of throwing', async () => {
    const source = make({
      fetchSnapshot: async () => { throw new Error('boom'); },
      streamHasData: false,
    });

    await expect(source.getOrNull()).resolves.toBeNull();
  });

  it('normalises a partial API response', async () => {
    const source = make({ fetchSnapshot: async () => ({}) });

    const snapshot = await source.get();

    expect(snapshot.threats).toEqual([]);
    expect(snapshot.alerts).toEqual({ oblasts: [], raions: [] });
  });
});
