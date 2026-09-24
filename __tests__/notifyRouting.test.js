/**
 * bot.js helpers that decide where a notification goes and how env knobs are
 * read — exported precisely so they don't need a Telegram token to test.
 */
import { describe, it, expect } from 'vitest';

import { advisoryRoute, parseListEnv, formatSubscribeReply, formatSubscriptionList, formatHelp, OFFICIAL_ALERTS_NOTE } from '../bot.js';
import { stripHtml } from '../neptun/telegramFormat.js';

describe('advisoryRoute', () => {
  it('routes a ballistic advisory to the ballistic category under the nationwide key', () => {
    expect(advisoryRoute('ballistic', 'c:київ')).toEqual({ category: 'ballistic', key: 'ballistic_threat|c:київ' });
  });

  it('routes any other advisory to targets with its own key', () => {
    expect(advisoryRoute('kab', 'o:харківська')).toEqual({ category: 'targets', key: 'kab_advisory|o:харківська' });
  });
});

describe('parseListEnv', () => {
  it('keeps the default for unset or empty (docker compose passes "")', () => {
    expect(parseListEnv(undefined, 'dflt')).toBe('dflt');
    expect(parseListEnv('', 'dflt')).toBe('dflt');
    expect(parseListEnv('   ', 'dflt')).toBe('dflt');
  });

  it('turns none/off into an empty list and splits a comma list', () => {
    expect(parseListEnv('none', 'dflt')).toEqual([]);
    expect(parseListEnv('OFF', 'dflt')).toEqual([]);
    expect(parseListEnv('@KPSZSU, rozvidkaneba ,', 'dflt')).toEqual(['@kpszsu', 'rozvidkaneba']);
  });
});

describe('subscription replies point at /settings', () => {
  it('after subscribing', () => {
    expect(formatSubscribeReply({ ok: true, region: { name: 'Київ' } }, 'київ')).toContain('/settings');
  });

  it('in the subscription list', () => {
    expect(formatSubscriptionList([{ name: 'Київ' }])).toContain('/settings');
  });
});

describe('not an official warning system', () => {
  // NEPTUN's API terms (§5): a service about people's safety must say so and
  // point at the official signal. /start is where a new user first looks.
  it('says so in /start and /help', () => {
    const text = stripHtml(formatHelp());
    expect(text).toContain('не офіційна система оповіщення');
    expect(text).toContain('офіційний сигнал повітряної тривоги');
    expect(text).toContain('neptun.in.ua');
    expect(text).toContain('/subscribe');
  });

  it('says so when someone subscribes — the moment they start relying on it', () => {
    expect(stripHtml(formatSubscribeReply({ ok: true, region: { name: 'Київ' } }, 'київ'))).toContain(OFFICIAL_ALERTS_NOTE);
  });

  it('keeps the help text valid Telegram HTML', () => {
    // "<регіон>" unescaped would make Telegram reject the whole message.
    expect(formatHelp()).not.toMatch(/<регіон>/);
  });
});
