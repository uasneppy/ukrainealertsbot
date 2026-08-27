/**
 * Every degradation in this bot is invisible by design — a dead Gemini key
 * reads as "the AI had nothing to add". This report is the only place that
 * says so out loud, so its job is to not soften bad news.
 */
import { describe, it, expect } from 'vitest';

import { formatStatusReport } from '../neptun/statusReport.js';

const NOW = 1_700_000_000_000;
const base = {
  now: NOW,
  streamConnected: true,
  streamAgeMs: 4_000,
  apiOk: true,
  apiLatencyMs: 280,
  geoAgeMs: 3_600_000,
  ai: { configured: true, lastOkAt: NOW - 60_000, lastFailAt: 0, failures: 0, calls: 5 },
  renderQueue: { active: 0, queued: 0, limit: 2 },
  subscriptions: 2,
  watchedRegions: 7,
};

describe('formatStatusReport', () => {
  it('reports a healthy bot', () => {
    const text = formatStatusReport(base);

    expect(text).toContain('🟢 NEPTUN потік');
    expect(text).toContain('🟢 NEPTUN API');
    expect(text).toContain('🟢 AI-аналіз');
    expect(text).toContain('Підписки цього чату: 2');
    expect(text).toContain('Регіонів під наглядом: 7');
  });

  it('flags a stream that has gone quiet', () => {
    const text = formatStatusReport({ ...base, streamAgeMs: 120_000 });
    expect(text).toContain('🔴 NEPTUN потік');
  });

  it('flags an unreachable API with the reason', () => {
    const text = formatStatusReport({ ...base, apiOk: false, apiError: 'ECONNREFUSED' });

    expect(text).toContain('🔴 NEPTUN API');
    expect(text).toContain('ECONNREFUSED');
  });

  it('reports missing boundary files instead of "Infinity год тому"', () => {
    // geoCacheAgeMs() returns Infinity when any file is absent.
    const text = formatStatusReport({ ...base, geoAgeMs: Infinity });

    expect(text).toContain('🔴 Кеш меж: файли відсутні');
    expect(text).not.toContain('Infinity');
  });

  it('says plainly when the AI has never once succeeded', () => {
    // The case users can never see: the fallback text looks identical.
    const text = formatStatusReport({
      ...base,
      ai: { configured: true, lastOkAt: 0, lastFailAt: NOW - 1_000, failures: 12, lastError: '404 model not found' },
    });

    expect(text).toContain('🔴 AI-аналіз');
    expect(text).toContain('404 model not found');
  });

  it('distinguishes a recent blip from a total outage', () => {
    const text = formatStatusReport({
      ...base,
      ai: { configured: true, lastOkAt: NOW - 600_000, lastFailAt: NOW - 1_000, failures: 1, lastError: '429' },
    });

    expect(text).toContain('🟠 AI-аналіз');
  });

  it('says AI is off rather than broken when no key is configured', () => {
    const text = formatStatusReport({ ...base, ai: { configured: false } });

    expect(text).toContain('вимкнено');
    expect(text).not.toContain('🔴 AI');
  });

  it('survives missing facts', () => {
    expect(() => formatStatusReport()).not.toThrow();
    expect(formatStatusReport()).toContain('Стан бота');
  });
});
