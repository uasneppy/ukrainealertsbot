/**
 * callback_data is capped at 64 *bytes* and every region key here is Cyrillic,
 * so a naive length check passes while Telegram rejects the payload.
 */
import { describe, it, expect } from 'vitest';

import {
  mapKeyboard,
  encodeCallback,
  decodeCallback,
  CALLBACK_REFRESH,
  CALLBACK_SUBSCRIBE,
  CALLBACK_UNSUBSCRIBE,
} from '../neptun/keyboards.js';
import { resolveRegion, regionFromCacheKey } from '../neptun/regionResolver.js';

describe('callback encoding', () => {
  it('round-trips an action and a Cyrillic region key', () => {
    const data = encodeCallback(CALLBACK_SUBSCRIBE, 'o:київська');

    expect(decodeCallback(data)).toEqual({ action: 's', cacheKey: 'o:київська' });
  });

  it('handles the national map, which has no region', () => {
    expect(decodeCallback(encodeCallback(CALLBACK_REFRESH, ''))).toEqual({ action: 'r', cacheKey: '' });
  });

  it('refuses payloads over 64 bytes rather than letting Telegram reject them', () => {
    expect(encodeCallback('s', 'x'.repeat(70))).toBeNull();
    // Cyrillic is two bytes a character: 40 characters already exceeds the cap.
    expect(encodeCallback('s', 'я'.repeat(40))).toBeNull();
  });

  it('fits every real region key', () => {
    // The longest is "автономна республіка крим".
    for (const phrase of ['київ', 'автономна республіка крим', 'івано-франківська область', 'дніпропетровщина']) {
      const region = resolveRegion(phrase);
      expect(encodeCallback(CALLBACK_SUBSCRIBE, region.cacheKey)).not.toBeNull();
    }
  });

  it('decodes junk without throwing', () => {
    expect(decodeCallback(undefined)).toEqual({ action: null, cacheKey: '' });
    expect(decodeCallback('nonsense')).toEqual({ action: null, cacheKey: '' });
  });
});

describe('mapKeyboard', () => {
  it('offers refresh only for the national map', () => {
    const markup = mapKeyboard({});

    expect(markup.inline_keyboard[0]).toHaveLength(1);
    expect(markup.inline_keyboard[0][0].text).toContain('Оновити');
  });

  it('offers subscribe for a region the chat does not follow', () => {
    const markup = mapKeyboard({ cacheKey: 'o:київська', subscribed: false });
    const labels = markup.inline_keyboard[0].map((b) => b.text);

    expect(labels[1]).toContain('Підписатися');
    expect(decodeCallback(markup.inline_keyboard[0][1].callback_data).action).toBe(CALLBACK_SUBSCRIBE);
  });

  it('offers unsubscribe once the chat follows it', () => {
    const markup = mapKeyboard({ cacheKey: 'o:київська', subscribed: true });

    expect(markup.inline_keyboard[0][1].text).toContain('Відписатися');
    expect(decodeCallback(markup.inline_keyboard[0][1].callback_data).action).toBe(CALLBACK_UNSUBSCRIBE);
  });
});

describe('regionFromCacheKey', () => {
  it('reverses what the button carries back into a region', () => {
    for (const phrase of ['київ', 'харківщина', 'ар крим', 'львові']) {
      const region = resolveRegion(phrase);
      expect(regionFromCacheKey(region.cacheKey)).toMatchObject({ name: region.name });
    }
  });

  it('returns null for an unknown key instead of guessing', () => {
    expect(regionFromCacheKey('o:атлантида')).toBeNull();
    expect(regionFromCacheKey('')).toBeNull();
  });
});

describe('settingsKeyboard', () => {
  it('shows one toggle per category with its state, and a payload that fits', async () => {
    const { settingsKeyboard, CALLBACK_TOGGLE } = await import('../neptun/keyboards.js');
    const { NOTIFY_CATEGORIES } = await import('../neptun/chatSettings.js');
    const settings = Object.fromEntries(NOTIFY_CATEGORIES.map((c) => [c.key, c.key !== 'uav']));

    const markup = settingsKeyboard(settings, NOTIFY_CATEGORIES);

    expect(markup.inline_keyboard).toHaveLength(NOTIFY_CATEGORIES.length);
    const uav = markup.inline_keyboard.find((row) => row[0].callback_data === `${CALLBACK_TOGGLE}|uav`);
    expect(uav[0].text).toMatch(/^🔕/);
    expect(markup.inline_keyboard[0][0].text).toMatch(/^✅/);
    for (const row of markup.inline_keyboard) {
      expect(Buffer.byteLength(row[0].callback_data, 'utf8')).toBeLessThanOrEqual(64);
      expect(decodeCallback(row[0].callback_data).action).toBe(CALLBACK_TOGGLE);
    }
  });
});

describe('night button', () => {
  it('is offered under a region map only when asked for', async () => {
    const { mapKeyboard, CALLBACK_NIGHT } = await import('../neptun/keyboards.js');
    const withNight = mapKeyboard({ cacheKey: 'c:київ', subscribed: false, night: true });
    expect(withNight.inline_keyboard).toHaveLength(2);
    expect(withNight.inline_keyboard[1][0]).toMatchObject({ text: '🌙 Що було за ніч', callback_data: `${CALLBACK_NIGHT}|c:київ` });
    expect(mapKeyboard({ cacheKey: 'c:київ' }).inline_keyboard).toHaveLength(1);
    expect(mapKeyboard({ night: true }).inline_keyboard).toHaveLength(1); // national map: no region
  });
});
