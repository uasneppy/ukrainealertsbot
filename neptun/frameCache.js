/**
 * Reuse of a rendered frame, gated on the data behind it.
 *
 * Two rules, and the second is the one that bites:
 *
 *  1. A frame is reused only while the fingerprint of the underlying data is
 *     unchanged (and not for longer than `reuseMs`). Identical data means an
 *     identical picture; anything else is a new render.
 *  2. Concurrent renders are shared only when they are rendering the *same*
 *     data. Coalescing on "a render is already running" hands a caller that
 *     just fetched newer positions the picture built from the previous ones —
 *     which is worst exactly when threats move fast and several people ask at
 *     once, i.e. during a ballistic-missile alert.
 */

export const DEFAULT_REUSE_MS = 15_000;

export function createFrameCache({ render, reuseMs = DEFAULT_REUSE_MS, now = () => Date.now() } = {}) {
  if (typeof render !== 'function') throw new Error('render is required');

  let cached = null; // { fp, value, takenAt }
  let inFlight = null; // { fp, promise }

  // Renders don't finish in the order they start — a render of older data can
  // land after a newer one and would otherwise overwrite it, leaving the cache
  // holding the older picture. Each render carries a sequence number and may
  // only publish if nothing newer has published already.
  let sequence = 0;
  let publishedSequence = -1;

  return {
    /**
     * @param {string} fp    fingerprint of the data being rendered
     * @param {*} input      passed straight to `render`
     */
    async get(fp, input) {
      if (cached && cached.fp === fp && now() - cached.takenAt < reuseMs) {
        return cached.value;
      }
      if (inFlight && inFlight.fp === fp) {
        return inFlight.promise;
      }

      const mySequence = (sequence += 1);
      const promise = (async () => {
        const value = await render(input);
        if (mySequence > publishedSequence) {
          cached = { fp, value, takenAt: now() };
          publishedSequence = mySequence;
        }
        return value;
      })().finally(() => {
        // Only retract our own entry; a render of newer data may have replaced it.
        if (inFlight?.fp === fp) inFlight = null;
      });

      inFlight = { fp, promise };
      return promise;
    },

    stats() {
      return { cachedFp: cached?.fp ?? null, inFlightFp: inFlight?.fp ?? null };
    },
  };
}
