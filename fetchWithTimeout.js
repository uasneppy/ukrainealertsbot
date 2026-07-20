/**
 * `fetch` with a hard deadline.
 *
 * Every outbound call in this bot sits on a user-visible path (a "тривога"
 * reply) or on a cache-refresh path guarded by an in-flight promise. A bare
 * `fetch` against a half-open connection never settles, which either hangs the
 * reply or wedges the refresh forever — so nothing here is allowed to run
 * without a deadline.
 */

export const DEFAULT_FETCH_TIMEOUT_MS = 10_000;

/**
 * @param {string} url
 * @param {object} [options]
 * @param {number}   [options.timeoutMs]  Deadline in ms (default 10 s).
 * @param {Function} [options.fetchFn]    Injectable fetch (tests).
 * @param {...any}   [options.init]       Any other standard `fetch` init fields.
 * @returns {Promise<Response>}
 * @throws {Error} A plain Error (not AbortError) when the deadline expires, so
 *                 callers/logs get the URL instead of a bare "aborted".
 */
export async function fetchWithTimeout(
  url,
  { timeoutMs = DEFAULT_FETCH_TIMEOUT_MS, fetchFn = globalThis.fetch, ...init } = {}
) {
  if (typeof fetchFn !== 'function') {
    throw new Error('fetchFn must be a function');
  }

  try {
    return await fetchFn(url, { ...init, signal: AbortSignal.timeout(timeoutMs) });
  } catch (error) {
    // Node throws TimeoutError for AbortSignal.timeout; AbortError covers
    // callers that pass their own signal through `init`.
    if (error?.name === 'TimeoutError' || error?.name === 'AbortError') {
      throw new Error(`Request to ${url} timed out after ${timeoutMs} ms`);
    }
    throw error;
  }
}
