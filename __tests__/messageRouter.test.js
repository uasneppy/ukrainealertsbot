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

  it('still answers "why" when words sit between чому and тривога', () => {
    // The user asked *why* — a map is not an answer to that question.
    for (const text of ['чому зараз тривога', 'чому знову тривога?', 'чому тривоги', 'чому оголосили тривогу']) {
      expect(routeMessage(text), `"${text}"`).toMatchObject({ kind: 'channel-why' });
    }
  });

  it('does not read "тривожність" as a тривога question', () => {
    expect(routeMessage('чому така тривожність')).toMatchObject({ kind: null });
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

describe('routeMessage — bare region triggers (shorter forms)', () => {
  it('treats a lone region name as a region-map request', () => {
    for (const [text, name] of [
      ['київ', 'Київ'],
      ['києві', 'Київ'],
      ['харкова', 'Харків'],
      ['київщина', 'Київська область'],
      ['київська область', 'Київська область'],
      ['львівській області', 'Львівська область'],
      ['ар крим', 'АР Крим'],
    ]) {
      const r = routeMessage(text);
      expect(r.kind, `"${text}"`).toBe('region-map');
      expect(r.region.name, `"${text}"`).toBe(name);
    }
  });

  it('answers "чому <регіон>" as a region-why', () => {
    const r = routeMessage('чому харків');
    expect(r.kind).toBe('region-why');
    expect(r.region.name).toBe('Харків');
  });

  it('accepts a leading request word: "карта <регіон>"', () => {
    expect(routeMessage('карта києва')).toMatchObject({ kind: 'region-map' });
    expect(routeMessage('покажи львів')).toMatchObject({ kind: 'region-map' });
    expect(routeMessage('мапу харківщини')).toMatchObject({ kind: 'region-map' });
  });

  it('accepts "тривога <регіон>" without a preposition', () => {
    const r = routeMessage('тривога київ');
    expect(r.kind).toBe('region-map');
    expect(r.region.name).toBe('Київ');
  });

  it('does NOT fire when a city is merely mentioned in a sentence', () => {
    // The whole point: no map spam in a group chat.
    for (const text of ['їду в київ завтра', 'харків тримайся', 'київ найкраще місто', 'я з харкова родом']) {
      expect(routeMessage(text).kind, `"${text}"`).not.toBe('region-map');
    }
  });

  it('keeps ordinary chatter silent', () => {
    for (const text of ['привіт усім', 'як там справи', 'дякую за інфу']) {
      expect(routeMessage(text)).toMatchObject({ kind: null });
    }
  });

  it('still prefers the explicit forms and national fallback', () => {
    expect(routeMessage('тривога')).toMatchObject({ kind: 'national-map' });
    expect(routeMessage('чому тривога')).toMatchObject({ kind: 'channel-why' });
    expect(routeMessage('тривога в україні')).toMatchObject({ kind: 'national-map' });
    expect(routeMessage('україна')).toMatchObject({ kind: 'national-map' });
  });
});

describe('night questions', () => {
  it('routes a night question about a region to the digest', () => {
    for (const text of ['що за ніч у києві', 'ніч харків', 'київ вночі', 'Що було за ніч на Сумщині?', 'за ніч одеса']) {
      const result = routeMessage(text);
      expect(result.kind, text).toBe('region-night');
      expect(result.cooldownKey).toMatch(/^night:/);
    }
    expect(routeMessage('що за ніч у києві').region).toMatchObject({ name: 'Київ' });
  });

  it('does not fire on a night word without a region, or on a why-question', () => {
    expect(routeMessage('яка ніч').kind).toBeNull();
    expect(routeMessage('нічого не сталось').kind).toBeNull();
    expect(routeMessage('чому вночі тривога в києві').kind).toBe('region-why');
    expect(routeMessage('їду в київ на ніч').kind).toBeNull();
  });
});
