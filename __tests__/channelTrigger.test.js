/**
 * Tests the channel trigger handler in bot.js.
 * Covers successful dispatch, parameter validation, and default limit usage.
 * Run with `npm test`.
 */
import { describe, it, expect, vi } from 'vitest';

import { handleChannelMessageRequest, CHANNEL_MESSAGE_LIMIT } from '../bot.js';

describe('handleChannelMessageRequest', () => {
  it('fetches messages, formats them, and sends the digest', async () => {
    const mockBot = { sendMessage: vi.fn().mockResolvedValue() };
    const fetchMessages = vi.fn().mockResolvedValue(['m1', 'm2']);
    const formatMessages = vi.fn().mockReturnValue('formatted');

    await handleChannelMessageRequest({
      botInstance: mockBot,
      chatId: 42,
      limit: 5,
      fetchMessages,
      formatMessages,
    });

    expect(fetchMessages).toHaveBeenCalledWith({ limit: 5 });
    expect(formatMessages).toHaveBeenCalledWith(['m1', 'm2']);
    expect(mockBot.sendMessage).toHaveBeenCalledWith(42, 'formatted', { parse_mode: 'HTML', disable_web_page_preview: true });
  });

  it('defaults to the standard limit when not provided', async () => {
    const mockBot = { sendMessage: vi.fn().mockResolvedValue() };
    const fetchMessages = vi.fn().mockResolvedValue(['latest']);

    await handleChannelMessageRequest({ botInstance: mockBot, chatId: 1, fetchMessages, formatMessages: (msgs) => msgs.join(',') });

    expect(fetchMessages).toHaveBeenCalledWith({ limit: CHANNEL_MESSAGE_LIMIT });
  });

  it('throws when bot instance lacks sendMessage', async () => {
    await expect(handleChannelMessageRequest({ botInstance: null, chatId: 1 })).rejects.toThrow(
      'A Telegram bot instance with sendMessage is required'
    );
  });

  it('throws when chatId is missing', async () => {
    await expect(
      handleChannelMessageRequest({ botInstance: { sendMessage: vi.fn() } })
    ).rejects.toThrow('A valid chatId is required');
  });
});
