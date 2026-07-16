import { describe, it, expect } from 'vitest';
import {
  normalizeAlertKey,
  extractAlertKeys,
  computeAlertKeySets,
} from '../neptun/mapRenderer.js';

describe('normalizeAlertKey', () => {
  it('takes .key from NEPTUN object entries', () => {
    expect(normalizeAlertKey({ key: 'бахмутський', name: 'Бахмутський район', oblast: 'Донецька область' }))
      .toBe('бахмутський');
  });

  it('falls back to .name when .key is an empty string', () => {
    expect(normalizeAlertKey({ key: '', name: 'Бахмутський район' })).toBe('бахмутський');
  });

  it('falls back to .oblast when .key and .name are missing', () => {
    expect(normalizeAlertKey({ oblast: 'Донецька область' })).toBe('донецька');
  });

  it('normalises plain strings: lowercase + strips "область"/"район" suffixes', () => {
    expect(normalizeAlertKey('Донецька область')).toBe('донецька');
    expect(normalizeAlertKey('Кременчуцький район')).toBe('кременчуцький');
    expect(normalizeAlertKey('  ХАРКІВСЬКА ОБЛ.  ')).toBe('харківська');
  });

  it('keeps multi-word keys intact', () => {
    expect(normalizeAlertKey({ key: 'автономна республіка крим' })).toBe('автономна республіка крим');
    expect(normalizeAlertKey('Севастополь')).toBe('севастополь');
  });

  it('returns empty string for null/undefined/empty/malformed input', () => {
    expect(normalizeAlertKey(null)).toBe('');
    expect(normalizeAlertKey(undefined)).toBe('');
    expect(normalizeAlertKey('')).toBe('');
    expect(normalizeAlertKey({})).toBe('');
    expect(normalizeAlertKey({ key: '', name: '' })).toBe('');
  });
});

describe('extractAlertKeys', () => {
  it('deduplicates and drops empty entries', () => {
    expect(extractAlertKeys([
      { key: 'луганська' },
      'Луганська область',
      null,
      {},
      { key: 'харківська' },
    ])).toEqual(['луганська', 'харківська']);
  });

  it('handles undefined/empty input', () => {
    expect(extractAlertKeys(undefined)).toEqual([]);
    expect(extractAlertKeys([])).toEqual([]);
  });
});

describe('computeAlertKeySets', () => {
  it('suppresses raions whose parent oblast is fully alerted', () => {
    const { oblastKeys, raionKeys } = computeAlertKeySets({
      oblasts: [{ key: 'харківська', name: 'Харківська область' }],
      raions: [
        { key: 'харківський', name: 'Харківський район', oblast: 'Харківська область' }, // suppressed
        { key: 'одеський', name: 'Одеський район', oblast: 'Одеська область' },          // kept
      ],
    });
    expect(oblastKeys).toEqual(['харківська']);
    expect(raionKeys).toEqual(['одеський']);
  });

  it('keeps string raion entries (no parent info to suppress by)', () => {
    const { raionKeys } = computeAlertKeySets({
      oblasts: [{ key: 'полтавська' }],
      raions: ['Кременчуцький район'],
    });
    expect(raionKeys).toEqual(['кременчуцький']);
  });

  it('handles Crimea/Sevastopol style oblast entries', () => {
    const { oblastKeys } = computeAlertKeySets({
      oblasts: [
        { key: 'автономна республіка крим', name: 'АР Крим', oblast: 'Автономна Республіка Крим' },
        { key: 'севастополь', name: 'Севастополь', oblast: 'Автономна Республіка Крим' },
      ],
      raions: [],
    });
    expect(oblastKeys).toEqual(['автономна республіка крим', 'севастополь']);
  });

  it('tolerates missing/empty alerts object', () => {
    expect(computeAlertKeySets()).toEqual({ oblastKeys: [], raionKeys: [] });
    expect(computeAlertKeySets({})).toEqual({ oblastKeys: [], raionKeys: [] });
  });
});
