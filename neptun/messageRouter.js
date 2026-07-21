/**
 * Decides what a chat message asks for — and nothing else.
 *
 * This lived inside the `if (token && !isTestEnv)` block in bot.js, which made
 * the precedence rules (region-why before generic-why, region-map before the
 * national map) structurally untestable: you needed a Telegram token and a live
 * bot to exercise them. They are the rules that decide whether someone asking
 * about their own city gets a national map instead, so they deserve tests.
 *
 * Triggers, in order of how much the user has to type:
 *   "тривога в києві" / "тривога київ"   → region map   (explicit)
 *   "київ" / "києві" / "київщина"        → region map   (whole message IS a region)
 *   "карта харкова" / "мапа києва"       → region map   (leading request word)
 *   "чому тривога в києві" / "чому київ"  → region why
 *   "чому тривога"                       → channel summary
 *   "тривога"                            → national map
 *
 * The bare-region forms use resolveRegionStrict, which fires only when the
 * whole message is a region — so "їду в київ" or "харків тримайся" (a city
 * merely mentioned mid-sentence) never triggers a map.
 */

import { parseRegionQuery, resolveRegion, resolveRegionStrict } from './regionResolver.js';

export const CHANNEL_MESSAGE_TRIGGER = 'чому тривога';

// JS \b is ASCII-only and never matches around Cyrillic; use lookarounds.
const WHY_RE = /(?<![а-яґєіїa-z])(?:чому|чого|почему)(?![а-яґєіїa-z])/u;

// Bot-directed request words that may lead a bare-region message: "карта київ",
// "покажи львів". Kept to clearly imperative words so ordinary sentences that
// happen to start with one are still rejected by the strict region match.
const REQUEST_PREFIX_RE = /^\s*(?:покажи|показати|карта|карту|мапа|мапу|дай)\s+/u;

const nonCountry = (region) => (region && region.kind !== 'country' ? region : null);

/**
 * @param {string} rawText
 * @returns {{
 *   kind: 'region-why'|'channel-why'|'region-map'|'national-map'|null,
 *   region: object|null,
 *   cooldownKey: string|null,
 * }}
 */
export function routeMessage(rawText) {
  const text = String(rawText ?? '').toLowerCase();
  const none = { kind: null, region: null, cooldownKey: null };

  // Commands have their own handlers; matching them here too would double-reply
  // to a command whose text happens to contain a trigger word.
  if (text.startsWith('/')) return none;

  const why = WHY_RE.test(text);

  // 1) Explicit "тривога [в] X" / "чому тривога в X" — needs the word тривога.
  const query = parseRegionQuery(text);
  let region = query ? nonCountry(resolveRegion(query.regionText)) : null;

  // 2) Bare region as (essentially) the whole message: "київ", "київщина",
  //    "чому харків", "карта києва". Strict, so a sentence that merely mentions
  //    a city never fires. Only attempted when there was no explicit query.
  if (!region && !query) {
    const bare = text.replace(WHY_RE, ' ').replace(REQUEST_PREFIX_RE, '').trim();
    const strict = resolveRegionStrict(bare);
    if (strict?.kind === 'country') {
      return { kind: 'national-map', region: null, cooldownKey: 'map' };
    }
    if (strict) region = strict;
  }

  if (region && why) {
    return { kind: 'region-why', region, cooldownKey: `why:${region.cacheKey}` };
  }
  if (text.includes(CHANNEL_MESSAGE_TRIGGER)) {
    return { kind: 'channel-why', region: null, cooldownKey: 'why' };
  }
  if (region) {
    return { kind: 'region-map', region, cooldownKey: `map:${region.cacheKey}` };
  }
  if (text.includes('тривога')) {
    return { kind: 'national-map', region: null, cooldownKey: 'map' };
  }
  return none;
}
