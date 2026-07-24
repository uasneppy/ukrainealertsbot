import { describe, it, expect, beforeEach, vi } from 'vitest';

import { dataFingerprint } from '../bot.js';
import { getState, hasSnapshot, streamAgeMs, onUpdate, __testables } from '../neptun/neptunStream.js';

const raw = (obj) => Buffer.from(JSON.stringify(obj));

describe('dataFingerprint', () => {
  const threats = [
    { id: 'b', lat: 50.45, lon: 30.52, type: 'uav', heading: 270 },
    { id: 'a', lat: 49.84, lon: 24.03, type: 'missile', heading: 90 },
  ];
  const alerts = { raions: ['r2', 'r1'], oblasts: ['kyiv'] };

  it('is insensitive to array ordering', () => {
    const fp1 = dataFingerprint({ threats, alerts });
    const fp2 = dataFingerprint({
      threats: [...threats].reverse(),
      alerts: { raions: ['r1', 'r2'], oblasts: ['kyiv'] },
    });
    expect(fp1).toBe(fp2);
  });

  it('changes when a threat moves', () => {
    const moved = threats.map((t) => (t.id === 'a' ? { ...t, lat: t.lat + 0.01 } : t));
    expect(dataFingerprint({ threats: moved, alerts })).not.toBe(
      dataFingerprint({ threats, alerts })
    );
  });

  it('changes when a threat appears or disappears', () => {
    expect(dataFingerprint({ threats: threats.slice(0, 1), alerts })).not.toBe(
      dataFingerprint({ threats, alerts })
    );
  });

  it('changes when alerts change', () => {
    expect(dataFingerprint({ threats, alerts: { raions: [], oblasts: [] } })).not.toBe(
      dataFingerprint({ threats, alerts })
    );
  });

  it('treats missing input as empty state', () => {
    expect(dataFingerprint({})).toBe(dataFingerprint({ threats: [], alerts: {} }));
    expect(dataFingerprint()).toBe(dataFingerprint({}));
  });
});

describe('neptunStream freshness', () => {
  beforeEach(() => __testables.reset());

  it('starts with no snapshot and infinite age', () => {
    expect(hasSnapshot()).toBe(false);
    expect(streamAgeMs()).toBe(Infinity);
  });

  it('snapshot message populates state and resets the freshness clock', () => {
    __testables.handleMessage(
      raw({ type: 'snapshot', data: { threats: [{ id: 'x', lat: 1, lon: 2 }] } })
    );
    expect(hasSnapshot()).toBe(true);
    expect(getState().threats).toHaveLength(1);
    expect(streamAgeMs()).toBeLessThan(1_000);
  });

  it('an empty snapshot still counts as authoritative live state', () => {
    __testables.handleMessage(raw({ type: 'snapshot', data: { threats: [] } }));
    expect(hasSnapshot()).toBe(true);
    expect(getState().threats).toHaveLength(0);
  });

  it('upsert / alerts / remove mutate state and keep it authoritative', () => {
    __testables.handleMessage(raw({ type: 'upsert', data: { id: 'y', lat: 3, lon: 4 } }));
    expect(getState().threats.map((t) => t.id)).toContain('y');

    __testables.handleMessage(raw({ type: 'alerts', data: { raions: ['r1'], oblasts: [] } }));
    expect(getState().alerts.raions).toEqual(['r1']);

    __testables.handleMessage(raw({ type: 'remove', data: { id: 'y' } }));
    expect(getState().threats).toHaveLength(0);
    expect(hasSnapshot()).toBe(true); // the alerts message was authoritative
  });

  it('heartbeat refreshes the clock without touching state', () => {
    __testables.handleMessage(raw({ type: 'heartbeat' }));
    expect(streamAgeMs()).toBeLessThan(1_000);
    expect(getState().threats).toHaveLength(0);
    expect(hasSnapshot()).toBe(false);
  });

  it('unparseable payloads do not update the freshness clock', () => {
    __testables.handleMessage(Buffer.from('not-json'));
    expect(streamAgeMs()).toBe(Infinity);
  });
});

describe('stream onUpdate', () => {
  it('fires on state changes but not on heartbeat, and unsubscribes', async () => {
    const { onUpdate, __testables } = await import('../neptun/neptunStream.js');
    __testables.reset();
    const cb = vi.fn();
    const off = onUpdate(cb);

    __testables.handleMessage(raw({ type: 'snapshot', data: { threats: [{ id: 'x', lat: 1, lon: 2 }] } }));
    __testables.handleMessage(raw({ type: 'upsert', data: { id: 'y', lat: 3, lon: 4 } }));
    __testables.handleMessage(raw({ type: 'alerts', data: { raions: ['r1'], oblasts: [] } }));
    expect(cb).toHaveBeenCalledTimes(3);

    __testables.handleMessage(raw({ type: 'heartbeat' }));
    expect(cb).toHaveBeenCalledTimes(3); // heartbeat is not a state change

    off();
    __testables.handleMessage(raw({ type: 'remove', data: { id: 'y' } }));
    expect(cb).toHaveBeenCalledTimes(3); // unsubscribed
  });
});
