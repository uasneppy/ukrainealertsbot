import { describe, it, expect, vi } from 'vitest';

import { fetchWithTimeout, DEFAULT_FETCH_TIMEOUT_MS } from '../fetchWithTimeout.js';

describe('fetchWithTimeout', () => {
  it('attaches an AbortSignal and returns the response untouched', async () => {
    const response = { ok: true };
    const fetchFn = vi.fn().mockResolvedValue(response);

    await expect(fetchWithTimeout('https://x.test', { fetchFn })).resolves.toBe(response);

    const [url, init] = fetchFn.mock.calls[0];
    expect(url).toBe('https://x.test');
    expect(init.signal).toBeInstanceOf(AbortSignal);
  });

  it('forwards other init fields and keeps its own options out of them', async () => {
    const fetchFn = vi.fn().mockResolvedValue({ ok: true });

    await fetchWithTimeout('https://x.test', {
      fetchFn,
      timeoutMs: 500,
      method: 'POST',
      headers: { 'x-test': '1' },
    });

    const [, init] = fetchFn.mock.calls[0];
    expect(init.method).toBe('POST');
    expect(init.headers).toEqual({ 'x-test': '1' });
    expect(init).not.toHaveProperty('fetchFn');
    expect(init).not.toHaveProperty('timeoutMs');
  });

  it('rejects with a URL-bearing error when the deadline expires', async () => {
    // A request that only settles when aborted — i.e. a half-open connection.
    const fetchFn = (_url, { signal }) => new Promise((_resolve, reject) => {
      signal.addEventListener('abort', () => reject(signal.reason));
    });

    await expect(fetchWithTimeout('https://slow.test', { fetchFn, timeoutMs: 20 }))
      .rejects.toThrow('Request to https://slow.test timed out after 20 ms');
  });

  it('passes non-timeout failures through unchanged', async () => {
    const fetchFn = vi.fn().mockRejectedValue(new Error('ENOTFOUND'));

    await expect(fetchWithTimeout('https://x.test', { fetchFn })).rejects.toThrow('ENOTFOUND');
  });

  it('validates fetchFn', async () => {
    await expect(fetchWithTimeout('https://x.test', { fetchFn: null }))
      .rejects.toThrow('fetchFn must be a function');
  });

  it('defaults to a 10 s deadline', () => {
    expect(DEFAULT_FETCH_TIMEOUT_MS).toBe(10_000);
  });

  it("composes with a caller's signal instead of replacing it", async () => {
    // The caller aborts first — their reason must come back, not a fake
    // "timed out" message.
    const fetchFn = (_url, { signal }) => new Promise((_resolve, reject) => {
      signal.addEventListener('abort', () => reject(signal.reason));
    });
    const controller = new AbortController();

    const pending = fetchWithTimeout('https://x.test', {
      fetchFn,
      signal: controller.signal,
      timeoutMs: 60_000,
    });
    controller.abort(new Error('caller aborted'));

    await expect(pending).rejects.toThrow('caller aborted');
  });
});
