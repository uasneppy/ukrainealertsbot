/**
 * The watcher must react to the freshest data (the live stream) but not miss an
 * all-clear the socket dropped — so it reconciles against authoritative REST
 * periodically. This is the opposite priority to the map source.
 */
import { describe, it, expect, vi } from 'vitest';

import { createWatcherSource } from '../neptun/liveState.js';

const streamState = { threats: [{ id: 's' }], alerts: { oblasts: ['stream'], raions: [] } };
const restState = { threats: [{ id: 'r' }], alerts: { oblasts: ['rest'], raions: [] } };

function make({ streamFresh = true, restResult = restState, ageMs = 1_000 } = {}) {
  const apiSource = { getOrNull: vi.fn(async () => restResult) };
  let clock = 1_000_000;
  const src = createWatcherSource({
    apiSource,
    getState: () => streamState,
    hasSnapshot: () => streamFresh,
    streamAgeMs: () => (streamFresh ? ageMs : 999_999),
    freshMs: 45_000,
    reconcileMs: 30_000,
    now: () => clock,
  });
  return { src, apiSource, advance: (ms) => { clock += ms; } };
}

describe('createWatcherSource', () => {
  it('validates its dependencies', () => {
    expect(() => createWatcherSource()).toThrow('apiSource');
    expect(() => createWatcherSource({ apiSource: { getOrNull() {} } })).toThrow('getState');
  });

  it('reads the live stream while it is fresh — no REST fetch on the hot path', async () => {
    const { src, apiSource } = make();
    // First call reconciles (lastReconcile=0 → due), so REST once...
    await src.get();
    apiSource.getOrNull.mockClear();
    // ...then subsequent quick calls use the stream, no REST.
    const a = await src.get();
    const b = await src.get();
    expect(apiSource.getOrNull).not.toHaveBeenCalled();
    expect(a.alerts.oblasts).toEqual(['stream']);
    expect(b.alerts.oblasts).toEqual(['stream']);
  });

  it('reconciles against REST at least every reconcileMs', async () => {
    const { src, apiSource, advance } = make();
    await src.get();                 // reconcile (due at start)
    apiSource.getOrNull.mockClear();

    await src.get();                 // stream
    expect(apiSource.getOrNull).not.toHaveBeenCalled();

    advance(31_000);                 // past reconcileMs
    const r = await src.get();       // must hit REST
    expect(apiSource.getOrNull).toHaveBeenCalledTimes(1);
    expect(r.alerts.oblasts).toEqual(['rest']); // authoritative wins the reconcile
  });

  it('falls back to REST when the stream is not fresh', async () => {
    const { src, apiSource } = make({ streamFresh: false });
    const r = await src.get();
    expect(apiSource.getOrNull).toHaveBeenCalled();
    expect(r.alerts.oblasts).toEqual(['rest']);
  });

  it('uses a fresh stream when REST fails', async () => {
    const { src } = make({ restResult: null }); // getOrNull returns null on failure
    const r = await src.get();
    expect(r.alerts.oblasts).toEqual(['stream']);
  });

  it('returns null when neither REST nor a fresh stream is available', async () => {
    const { src } = make({ streamFresh: false, restResult: null });
    expect(await src.get()).toBeNull();
  });
});
