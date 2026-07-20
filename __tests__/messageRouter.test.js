/**
 * Precedence here decides whether someone asking about their own city gets a
 * national map instead — and it used to live inside the live-bot block, where
 * no test could reach it.
 */
import { describe, it, expect } from 'vitest';

import { routeMessage } from '../neptun/messageRouter.js';

describe('routeMessage', () => {
  it('ignores ordinary chatter', () => {
    for (const text of ['привіт', 'як справи', '', null, undefined, 'тривожність зросла']) {
      expect(routeMessage(text)).toMatchObject({ kind: null, cooldownKey: null });
    }
  });

  it('routes a bare trigger to the national map', () => {
    expect(routeMessage('тривога')).toMatchObject({ kind: 'national-map', region: null });
    expect(routeMessage('ТРИВОГА!!')).toMatchObject({ kind: 'national-map' });
    expect(routeMessage('що там, тривога?')).toMatchObject({ kind: 'national-map' });
  });

  it('routes a region query to the region map', () => {
    const result = routeMessage('тривога в києві');

    expect(result.kind).toBe('region-map');
    expect(result.region).toMatchObject({ kind: 'city', name: 'Київ' });
    expect(result.cooldownKey).toBe('map:c:київ');
  });

  it('prefers the region-scoped answer over the generic one', () => {
    // "чому тривога в харкові" contains the generic "чому тривога" trigger too;
    // answering with the national channel summary would ignore the question.
    const result = routeMessage('чому тривога в харкові');

    expect(result.kind).toBe('region-why');
    expect(result.region).toMatchObject({ name: 'Харків' });
  });

  it('routes the generic why-question to the channel summary', () => {
    expect(routeMessage('чому тривога')).toMatchObject({ kind: 'channel-why', region: null });
    expect(routeMessage('чому тривога взагалі')).toMatchObject({ kind: 'channel-why' });
  });

  it('treats the whole country as the national map, not a region', () => {
    expect(routeMessage('тривога в україні')).toMatchObject({ kind: 'national-map', region: null });
  });

  it('never handles commands — they have their own handlers', () => {
    // Double-replying to "/map тривога" was the bug this guard prevents.
    expect(routeMessage('/map київ')).toMatchObject({ kind: null });
    expect(routeMessage('/subscribe тривога')).toMatchObject({ kind: null });
  });

  it('handles declined and colloquial region forms', () => {
    expect(routeMessage('тривога на харківщині').region).toMatchObject({
      kind: 'oblast',
      name: 'Харківська область',
    });
    expect(routeMessage('чому тривога в львівській області')).toMatchObject({
      kind: 'region-why',
    });
  });

  it('scopes the cooldown key per region and per kind', () => {
    // A generic "тривога" must not silence a deliberate question seconds later.
    const generic = routeMessage('тривога');
    const kyiv = routeMessage('тривога в києві');
    const kyivWhy = routeMessage('чому тривога в києві');
    const lviv = routeMessage('тривога у львові');

    const keys = [generic, kyiv, kyivWhy, lviv].map((r) => r.cooldownKey);
    expect(new Set(keys).size).toBe(4);
  });

  it('falls back to the national map when the region is unrecognisable', () => {
    expect(routeMessage('тривога в мордорі')).toMatchObject({ kind: 'national-map' });
  });
});
