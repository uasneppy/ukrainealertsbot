/**
 * Which regions a monitoring-channel post talks about.
 *
 * "Київщина: реактивний БпЛА курсом на Бровари" concerns Kyiv oblast and, for
 * anyone in Kyiv, the city. The resolver already knows every declension and
 * colloquial form ("Одещину", "на Буковині"); this walks a post word by word
 * and asks it. Done once per post as it is recorded, never per query.
 */

import { resolveRegion, __testables } from './regionResolver.js';

const { CITY_DEFS } = __testables;

// Word starts, including after punctuation — "Київ:" and "(Сумщина)" count.
const WORD_START_RE = /(?<![\p{L}'])(?=\p{L})/gu;

/** @returns {Set<string>} cacheKeys of regions mentioned in the text */
export function mentionedRegions(text) {
  const norm = String(text ?? '')
    .normalize('NFC')
    .toLowerCase()
    .replace(/[’ʼ`´]/g, "'")
    .replace(/[^\p{L}\p{N}'\s-]/gu, ' ');
  const keys = new Set();
  let m;
  let from = 0;
  WORD_START_RE.lastIndex = 0;
  while ((m = WORD_START_RE.exec(norm)) !== null) {
    const region = resolveRegion(norm.slice(m.index));
    if (region && region.kind !== 'country') keys.add(region.cacheKey);
    // Advance by a whole code point. Stylised letters channels love (𝐁𝐩𝐋𝐀)
    // are two code units; stepping one unit lands inside the pair, the /u
    // regex snaps back to its start, and the loop never ends — which pinned
    // the bot at 100% CPU for hours with its heartbeat frozen. The guard
    // makes any future non-advancing step a stopped scan, not a wedged bot.
    const next = m.index + (norm.codePointAt(m.index) > 0xffff ? 2 : 1);
    if (next <= from) break;
    from = next;
    WORD_START_RE.lastIndex = from;
  }
  WORD_START_RE.lastIndex = 0;
  return keys;
}

/**
 * The mention keys that matter for a region: itself, its parent oblast for a
 * city (a post about Київщина matters in Kyiv), and its cities for an oblast.
 * Kyiv is its own alert unit but everyone says "Київщина" for its surroundings,
 * so the two are paired explicitly.
 *
 * @returns {Set<string>}
 */
export function relevantRegionKeys(region) {
  const keys = new Set([region.cacheKey]);
  if (region.kind === 'city') {
    if (region.oblastGeoKey) keys.add(`o:${region.oblastGeoKey}`);
    if (region.name === 'Київ') keys.add('o:київська');
  } else if (region.kind === 'oblast') {
    for (const c of CITY_DEFS) if (c.oblastGeoKey === region.geoKey) keys.add(`c:${c.name.toLowerCase()}`);
    if (region.geoKey === 'київська') keys.add('c:київ');
  }
  return keys;
}

/** True when a recorded message (with its `regions` list) concerns the region. */
export function messageConcerns(message, relevantKeys) {
  return (message?.regions ?? []).some((k) => relevantKeys.has(k));
}
