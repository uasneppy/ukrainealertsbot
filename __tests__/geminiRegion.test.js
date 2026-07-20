import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { analyzeRegionQuery, buildRegionPrompt } from '../geminiAnalysis.js';

describe('buildRegionPrompt', () => {
  it('embeds the user query, region name and NEPTUN report verbatim', () => {
    const prompt = buildRegionPrompt({
      userQuery: 'чому тривога в Києві?',
      regionName: 'м. Київ',
      regionReport: '📍 м. Київ\n🔴 Тривога у м. Київ (з 21:05)',
      channelMessages: ['Пуски КР з Ту-95МС', 'БпЛА курсом на Київ'],
    });
    expect(prompt).toContain('«чому тривога в Києві?»');
    expect(prompt).toContain('Регіон запиту: м. Київ.');
    expect(prompt).toContain('🔴 Тривога у м. Київ (з 21:05)');
    expect(prompt).toContain('1. Пуски КР з Ту-95МС');
    expect(prompt).toContain('2. БпЛА курсом на Київ');
    expect(prompt).toContain('без markdown');
  });

  it('caps channel messages at 15 items and 400 chars each', () => {
    const messages = Array.from({ length: 30 }, (_, i) => `msg-${i}-${'x'.repeat(500)}`);
    const prompt = buildRegionPrompt({
      userQuery: 'q', regionName: 'R', regionReport: 'report', channelMessages: messages,
    });
    expect(prompt).toContain('1. msg-0-');
    expect(prompt).toContain('15. msg-14-');
    expect(prompt).not.toContain('16. msg-15-');
    const firstLine = prompt.split('\n').find((l) => l.startsWith('1. msg-0-'));
    expect(firstLine.length).toBeLessThanOrEqual(3 + 400);
  });

  it('notes when channel messages are unavailable', () => {
    const prompt = buildRegionPrompt({ userQuery: 'q', regionName: 'R', regionReport: 'report', channelMessages: [] });
    expect(prompt).toContain('Повідомлення каналу Повітряних сил зараз недоступні.');
  });
});

describe('analyzeRegionQuery', () => {
  let savedKey;

  beforeEach(() => {
    savedKey = process.env.GEMINI_API_KEY;
    delete process.env.GEMINI_API_KEY;
  });

  afterEach(() => {
    if (savedKey === undefined) delete process.env.GEMINI_API_KEY;
    else process.env.GEMINI_API_KEY = savedKey;
  });

  it('throws without GEMINI_API_KEY (bot falls back to the NEPTUN report)', async () => {
    await expect(
      analyzeRegionQuery({ userQuery: 'q', regionName: 'R', regionReport: 'report', channelMessages: [] })
    ).rejects.toThrow('GEMINI_API_KEY is required');
  });
});
