/**
 * The t.me preview fails per channel; one dead channel must not silence the
 * others, and a failure is a skipped poll that /status can see.
 */
import { describe, it, expect, vi } from 'vitest';

import { createChannelPoller } from '../neptun/channelPoller.js';
import { extractDatedMessages } from '../channelMessages.js';

describe('createChannelPoller', () => {
  it('requires its dependencies', () => {
    expect(() => createChannelPoller()).toThrow('fetchChannel is required');
    expect(() => createChannelPoller({ fetchChannel: async () => [] })).toThrow('onMessages is required');
  });

  it('polls every channel, tags messages with their handle, and isolates a failure', async () => {
    const fetchChannel = vi.fn(async (h) => {
      if (h === '@dead') throw new Error('HTTP 429');
      return [{ text: `from ${h}`, date: '2026-09-04T20:00:00Z' }];
    });
    const onMessages = vi.fn();
    const poller = createChannelPoller({ channels: ['@a', '@dead', '@a'], fetchChannel, onMessages, log: { warn() {} } });

    expect(await poller.tick()).toBe(1);
    expect(poller.channels()).toEqual(['@a', '@dead']);
    expect(onMessages).toHaveBeenCalledWith([{ text: 'from @a', date: '2026-09-04T20:00:00Z', channel: '@a' }]);
    const stats = poller.stats();
    expect(stats['@dead'].lastError).toBe('HTTP 429');
    expect(stats['@a'].lastError).toBeNull();
    expect(stats['@a'].received).toBe(1);
  });

  it('start/stop manage the interval and do nothing with no channels', async () => {
    vi.useFakeTimers();
    try {
      const fetchChannel = vi.fn(async () => []);
      const poller = createChannelPoller({ channels: ['@a'], fetchChannel, onMessages: vi.fn(), intervalMs: 1_000 });
      poller.start();
      await vi.advanceTimersByTimeAsync(2_500);
      expect(fetchChannel).toHaveBeenCalledTimes(2);
      poller.stop();
      await vi.advanceTimersByTimeAsync(3_000);
      expect(fetchChannel).toHaveBeenCalledTimes(2);

      const empty = createChannelPoller({ channels: [], fetchChannel, onMessages: vi.fn() });
      empty.start();
      await vi.advanceTimersByTimeAsync(3_000);
      expect(fetchChannel).toHaveBeenCalledTimes(2);
    } finally {
      vi.useRealTimers();
    }
  });
});

describe('extractDatedMessages', () => {
  const page = `
<section>
<div class="tgme_widget_message_wrap js-widget_message_wrap"><div class="tgme_widget_message" data-post="AerisRimor/83772">
  <div class="tgme_widget_message_text js-message_text" dir="auto">Весь ППУ окрім Донеччини - чисто.<br/>Далі тиша</div>
  <a class="tgme_widget_message_date" href="https://t.me/AerisRimor/83772"><time datetime="2026-09-04T19:16:37+00:00" class="time">19:16</time></a>
</div></div>
<div class="tgme_widget_message_wrap js-widget_message_wrap"><div class="tgme_widget_message" data-post="AerisRimor/83773">
  <div class="tgme_widget_message_text js-message_text" dir="auto">Наче мінус.</div>
  <a class="tgme_widget_message_date" href="https://t.me/AerisRimor/83773"><time datetime="2026-09-04T19:17:03+00:00" class="time">19:17</time></a>
</div></div>
<div class="tgme_widget_message_wrap js-widget_message_wrap"><div class="tgme_widget_message" data-post="AerisRimor/83774">
  <div class="tgme_widget_message_photo_wrap"></div>
</div></div>
</section>`;

  it('reads id, channel, cleaned text and ISO date per message, skipping text-less posts', () => {
    const msgs = extractDatedMessages(page);
    expect(msgs).toHaveLength(2);
    expect(msgs[0]).toEqual({
      id: 'AerisRimor/83772', channel: '@AerisRimor', text: 'Весь ППУ окрім Донеччини - чисто.\nДалі тиша', date: '2026-09-04T19:16:37.000Z',
    });
    expect(msgs[1].text).toBe('Наче мінус.');
  });

  it('rejects non-string input and returns nothing for an empty page', () => {
    expect(() => extractDatedMessages(null)).toThrow('html must be a string');
    expect(extractDatedMessages('<html></html>')).toEqual([]);
  });
});
