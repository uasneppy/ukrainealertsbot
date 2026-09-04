/**
 * The same ballistic risk reaches the bot twice — as a NEPTUN marker over the
 * city and as the Air Force's own message. Both are true; one message is the
 * warning, the second is the bot repeating itself.
 */
import { describe, it, expect, vi } from 'vitest';

import { createChatNotifier } from '../neptun/chatNotifier.js';

function make({ settings = {}, dedupeMs = 60_000 } = {}) {
  const sendTo = vi.fn();
  let clock = 1_000_000;
  const notifier = createChatNotifier({
    sendTo,
    getSettings: (chatId) => settings[chatId] ?? {},
    dedupeMs,
    now: () => clock,
  });
  return { notifier, sendTo, advance: (ms) => { clock += ms; } };
}

describe('createChatNotifier', () => {
  it('requires its dependencies', () => {
    expect(() => createChatNotifier()).toThrow('sendTo is required');
    expect(() => createChatNotifier({ sendTo() {} })).toThrow('getSettings is required');
  });

  it('sends to every chat that has not muted the category', () => {
    const { notifier, sendTo } = make({ settings: { 2: { kalibr: false } } });
    const result = notifier.deliver({ category: 'kalibr', text: 'x', chatIds: ['1', '2', '3'] });

    expect(result).toMatchObject({ sent: ['1', '3'], muted: ['2'] });
    expect(sendTo).toHaveBeenCalledTimes(2);
  });

  it('always sends when no key is given — alerts are never deduplicated', () => {
    const { notifier, sendTo } = make();
    notifier.deliver({ category: 'alert', text: 'a', chatIds: ['1'] });
    notifier.deliver({ category: 'alert', text: 'a', chatIds: ['1'] });
    expect(sendTo).toHaveBeenCalledTimes(2);
  });

  it('sends a keyed message once per chat per window', () => {
    const { notifier, sendTo, advance } = make({ dedupeMs: 60_000 });
    notifier.deliver({ category: 'ballistic', key: 'ballistic_threat', text: 'a', chatIds: ['1'] });
    const second = notifier.deliver({ category: 'ballistic', key: 'ballistic_threat', text: 'b', chatIds: ['1'] });
    expect(second.deduped).toEqual(['1']);

    advance(61_000);
    notifier.deliver({ category: 'ballistic', key: 'ballistic_threat', text: 'c', chatIds: ['1'] });
    expect(sendTo).toHaveBeenCalledTimes(2);
  });

  it('a nationwide warning silences the regional variant, not the other way round', () => {
    const { notifier, sendTo } = make();
    notifier.deliver({ category: 'ballistic', key: 'ballistic_threat', text: 'national', chatIds: ['1'] });
    notifier.deliver({ category: 'ballistic', key: 'ballistic_threat|c:київ', text: 'kyiv', chatIds: ['1'] });
    expect(sendTo).toHaveBeenCalledTimes(1);

    const other = make();
    other.notifier.deliver({ category: 'ballistic', key: 'ballistic_threat|c:київ', text: 'kyiv', chatIds: ['1'] });
    other.notifier.deliver({ category: 'ballistic', key: 'ballistic_threat', text: 'national', chatIds: ['1'] });
    expect(other.sendTo).toHaveBeenCalledTimes(2);
  });

  it('keeps regions independent of each other', () => {
    const { notifier, sendTo } = make();
    notifier.deliver({ category: 'ballistic', key: 'ballistic_threat|c:київ', text: 'a', chatIds: ['1'] });
    notifier.deliver({ category: 'ballistic', key: 'ballistic_threat|c:харків', text: 'b', chatIds: ['1'] });
    expect(sendTo).toHaveBeenCalledTimes(2);
  });

  it('keeps chats independent of each other', () => {
    const { notifier, sendTo } = make();
    notifier.deliver({ category: 'mig31k', key: 'mig31k_takeoff', text: 'a', chatIds: ['1'] });
    notifier.deliver({ category: 'mig31k', key: 'mig31k_takeoff', text: 'a', chatIds: ['2'] });
    expect(sendTo).toHaveBeenCalledTimes(2);
  });
});
