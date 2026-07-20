/**
 * Decides what a chat message asks for — and nothing else.
 *
 * This lived inside the `if (token && !isTestEnv)` block in bot.js, which made
 * the precedence rules (region-why before generic-why, region-map before the
 * national map) structurally untestable: you needed a Telegram token and a live
 * bot to exercise them. They are the rules that decide whether someone asking
 * about their own city gets a national map instead, so they deserve tests.
 */

import { parseRegionQuery, resolveRegion } from './regionResolver.js';

export const CHANNEL_MESSAGE_TRIGGER = 'чому тривога';

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

  const query = parseRegionQuery(text);
  const match = query ? resolveRegion(query.regionText) : null;
  // "тривога в Україні" is the national map, not a region — the resolver
  // recognises the country but there is no country-shaped focus view.
  const region = match && match.kind !== 'country' ? match : null;

  if (region && query.why) {
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
