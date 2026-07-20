/**
 * Tests channelMessages.js module.
 * Verifies HTML parsing, formatting, and fetching behaviors.
 * Run with `npm test`.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';

import {
  cleanMessageText,
  extractMessageContents,
  fetchLatestChannelMessages,
  formatChannelMessages,
} from '../channelMessages.js';

describe('channelMessages utilities', () => {
  const sampleHtml = `
    <div class="tgme_widget_message_text js-message_text">
      Перший рядок<br>другий рядок &amp; більше деталей
      <a href="https://example.com">лінк</a>
    </div>
    <div class="tgme_widget_message_text js-message_text">
      <p>Третє повідомлення&nbsp;з <strong>жирним</strong> текстом</p>
      <ul><li>пункт 1</li><li>пункт 2</li></ul>
    </div>
  `;

  beforeEach(() => {
    // Ensure regex state is reset between tests
    extractMessageContents('', 1);
  });

  describe('cleanMessageText', () => {
    it('converts HTML fragments into clean readable text', () => {
      const html = '<p>Тест<br>рядок &amp; дані</p>';
      expect(cleanMessageText(html)).toBe('Тест\nрядок & дані');
    });

    it('throws when provided value is not a string', () => {
      expect(() => cleanMessageText(null)).toThrow('rawHtml must be a string');
    });
  });

  describe('extractMessageContents', () => {
    it('extracts up to the requested number of messages', () => {
      const result = extractMessageContents(sampleHtml, 1);
      expect(result).toEqual(['Третє повідомлення з жирним текстом\n• пункт 1\n• пункт 2']);
    });

    it('returns multiple cleaned messages respecting the limit', () => {
      const result = extractMessageContents(sampleHtml, 5);
      expect(result).toEqual([
        'Третє повідомлення з жирним текстом\n• пункт 1\n• пункт 2',
        'Перший рядок\nдругий рядок & більше деталей лінк',
      ]);
    });

    it('returns the latest messages when limit is lower than total entries', () => {
      const extraHtml = `
        ${sampleHtml}
        <div class="tgme_widget_message_text js-message_text">Фінальне</div>
      `;
      const result = extractMessageContents(extraHtml, 2);
      expect(result).toEqual([
        'Фінальне',
        'Третє повідомлення з жирним текстом\n• пункт 1\n• пункт 2',
      ]);
    });

    it('throws when html is not a string', () => {
      expect(() => extractMessageContents(undefined, 2)).toThrow('html must be a string');
    });
  });

  describe('fetchLatestChannelMessages', () => {
    it('fetches and parses channel messages via provided fetch implementation', async () => {
      const mockFetch = vi.fn().mockResolvedValue({
        ok: true,
        text: async () => sampleHtml,
      });

      const messages = await fetchLatestChannelMessages({ limit: 2, fetchFn: mockFetch, url: 'https://example.com' });

      expect(mockFetch).toHaveBeenCalledWith(
        'https://example.com',
        expect.objectContaining({ signal: expect.any(AbortSignal) })
      );
      expect(messages).toHaveLength(2);
    });

    it('aborts the request once the timeout elapses', async () => {
      // Never-settling fetch that only rejects when its signal fires — the
      // exact shape of a half-open connection to t.me.
      const mockFetch = vi.fn((_url, { signal }) => new Promise((_resolve, reject) => {
        signal.addEventListener('abort', () => reject(signal.reason));
      }));

      await expect(
        fetchLatestChannelMessages({ fetchFn: mockFetch, url: 'https://example.com', timeoutMs: 20 })
      ).rejects.toThrow('timed out after 20 ms');
    });

    it('fails when fetch returns a non-ok response', async () => {
      const mockFetch = vi.fn().mockResolvedValue({ ok: false, status: 500, text: async () => '' });

      await expect(
        fetchLatestChannelMessages({ fetchFn: mockFetch })
      ).rejects.toThrow('Failed to load channel feed (status 500)');
    });

    it('validates custom fetch implementations', async () => {
      await expect(fetchLatestChannelMessages({ fetchFn: null })).rejects.toThrow('fetchFn must be a function');
    });
  });

  describe('formatChannelMessages', () => {
    it('formats an empty set into a friendly message', () => {
      expect(formatChannelMessages([], '@custom')).toBe('Немає нових повідомлень з каналу @custom.');
    });

    it('enumerates provided messages in order', () => {
      const result = formatChannelMessages(['Перше', 'Друге']);
      expect(result).toBe('Останні повідомлення з каналу @kpszsu:\n\n1. Перше\n\n2. Друге');
    });

    it('throws when messages is not an array', () => {
      expect(() => formatChannelMessages(null)).toThrow('messages must be an array');
    });
  });
});
