/**
 * A rendered map may only be reused while the data behind it is unchanged.
 * The bug this pins: coalescing on "a render is already running" handed a
 * caller that had just fetched newer positions the frame built from the older
 * ones — worst during a ballistic alert, when positions change fastest.
 */
import { describe, it, expect, vi } from 'vitest';

import { createFrameCache, DEFAULT_REUSE_MS } from '../neptun/frameCache.js';

const deferred = () => {
  let resolve;
  const promise = new Promise((r) => { resolve = r; });
  return { promise, resolve };
};

describe('createFrameCache', () => {
  it('requires a render function', () => {
    expect(() => createFrameCache()).toThrow('render is required');
  });

  it('renders on first request', async () => {
    const render = vi.fn(async () => 'frame-a');
    const cache = createFrameCache({ render });

    await expect(cache.get('fp-a', {})).resolves.toBe('frame-a');
    expect(render).toHaveBeenCalledTimes(1);
  });

  it('reuses the frame while the data fingerprint is unchanged', async () => {
    const render = vi.fn(async () => 'frame-a');
    const cache = createFrameCache({ render });

    await cache.get('fp-a', {});
    await cache.get('fp-a', {});

    expect(render).toHaveBeenCalledTimes(1);
  });

  it('re-renders as soon as the data changes, however recent the frame', async () => {
    let n = 0;
    const render = vi.fn(async () => `frame-${++n}`);
    const cache = createFrameCache({ render, now: () => 1000 }); // clock frozen

    await expect(cache.get('fp-a', {})).resolves.toBe('frame-1');
    await expect(cache.get('fp-b', {})).resolves.toBe('frame-2');
    expect(render).toHaveBeenCalledTimes(2);
  });

  it('stops reusing once reuseMs has elapsed', async () => {
    let t = 0;
    const render = vi.fn(async () => 'frame');
    const cache = createFrameCache({ render, reuseMs: 1000, now: () => t });

    await cache.get('fp-a', {});
    t = 999;
    await cache.get('fp-a', {});
    expect(render).toHaveBeenCalledTimes(1);

    t = 1001;
    await cache.get('fp-a', {});
    expect(render).toHaveBeenCalledTimes(2);
  });

  it('shares one in-flight render between callers asking for the same data', async () => {
    const d = deferred();
    const render = vi.fn(() => d.promise);
    const cache = createFrameCache({ render });

    const a = cache.get('fp-a', {});
    const b = cache.get('fp-a', {});
    d.resolve('frame-a');

    expect(await a).toBe('frame-a');
    expect(await b).toBe('frame-a');
    expect(render).toHaveBeenCalledTimes(1);
  });

  it('never hands a caller a render of different data', async () => {
    // The regression. Old data is mid-render; a caller arrives with newer data
    // and must get a render of *its* data, not the one already in flight.
    const first = deferred();
    const second = deferred();
    const render = vi.fn()
      .mockImplementationOnce(() => first.promise)
      .mockImplementationOnce(() => second.promise);
    const cache = createFrameCache({ render });

    const stale = cache.get('fp-old', { positions: 'old' });
    const fresh = cache.get('fp-new', { positions: 'new' });

    second.resolve('frame-new');
    first.resolve('frame-old');

    expect(await fresh).toBe('frame-new');
    expect(await stale).toBe('frame-old');
    expect(render).toHaveBeenCalledTimes(2);
    expect(render.mock.calls[1][0]).toEqual({ positions: 'new' });
  });

  it('leaves the newest frame cached when an older render finishes last', async () => {
    const first = deferred();
    const second = deferred();
    let t = 0;
    const render = vi.fn()
      .mockImplementationOnce(() => first.promise)
      .mockImplementationOnce(() => second.promise);
    const cache = createFrameCache({ render, now: () => t });

    const stale = cache.get('fp-old', {});
    const fresh = cache.get('fp-new', {});
    second.resolve('frame-new');
    await fresh;
    t = 1;
    first.resolve('frame-old');
    await stale;

    // The late arrival of the older render must not leave it as the frame that
    // the next request reuses.
    render.mockImplementationOnce(async () => 'frame-newest');
    await expect(cache.get('fp-new', {})).resolves.toBe('frame-new');
  });

  it('does not cache a failed render, and retries next time', async () => {
    const render = vi.fn()
      .mockRejectedValueOnce(new Error('render exploded'))
      .mockResolvedValueOnce('frame-a');
    const cache = createFrameCache({ render });

    await expect(cache.get('fp-a', {})).rejects.toThrow('render exploded');
    await expect(cache.get('fp-a', {})).resolves.toBe('frame-a');
    expect(render).toHaveBeenCalledTimes(2);
  });

  it('defaults to a 15 s reuse window', () => {
    expect(DEFAULT_REUSE_MS).toBe(15_000);
  });
});
