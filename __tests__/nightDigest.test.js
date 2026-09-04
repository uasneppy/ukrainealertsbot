/**
 * The digest must never say more than the log holds: tracks are counted
 * against the region's geometry, swarms by their size, launches once per
 * wave, and the fallback answers even with no AI.
 */
import { describe, it, expect } from 'vitest';

import {
  classifyTrack, buildNightFacts, formatNightLine, describeNightFacts, formatNightFallback, nightFactsFingerprint,
} from '../neptun/nightDigest.js';
import { resolveRegion } from '../neptun/regionResolver.js';
import { buildNightPrompt } from '../geminiAnalysis.js';

const KYIV = resolveRegion('київ');
const NOW = Date.parse('2026-09-04T23:00:00Z'); // 02:00 Kyiv → window since 15:00 UTC
const at = (h, m = 0) => Date.parse(`2026-09-04T${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}:00Z`);

const track = (id, type, samples, extra = {}) => ({
  id, type, title: '', count: 1, firstAt: samples[0][2], lastAt: samples[samples.length - 1][2], samples, localities: [], advisory: false, ...extra,
});
const fakeLog = ({ tracks = [], messages = [] } = {}) => ({
  tracksSince: (s) => tracks.filter((t) => t.lastAt >= s),
  messagesSince: (s) => messages.filter((m) => m.at >= s).sort((a, b) => b.at - a.at),
});

describe('classifyTrack', () => {
  it('reads "in" if any position was inside the city radius, "near" if within reach', () => {
    expect(classifyTrack(track('a', 'uav', [[49.55, 30.52, at(19)], [50.45, 30.52, at(19, 30)]]), KYIV, {})).toBe('in');
    expect(classifyTrack(track('b', 'uav', [[49.55, 30.52, at(19)]]), KYIV, {})).toBe('near');
    expect(classifyTrack(track('c', 'uav', [[46.48, 30.72, at(19)]]), KYIV, {})).toBeNull();
  });

  it('uses the oblast polygon for an oblast', () => {
    const region = resolveRegion('тестова область') ?? { kind: 'oblast', geoKey: 'тестова', name: 'Тестова область', cacheKey: 'o:тестова' };
    const geo = { oblasts: { features: [{ properties: { key: 'тестова' }, geometry: { type: 'Polygon', coordinates: [[[30, 50], [31, 50], [31, 51], [30, 51], [30, 50]]] } }] } };
    expect(classifyTrack(track('in', 'uav', [[50.5, 30.5, at(19)]]), region, geo)).toBe('in');
    expect(classifyTrack(track('near', 'uav', [[50.5, 31.5, at(19)]]), region, geo)).toBe('near');
    expect(classifyTrack(track('far', 'uav', [[45, 35, at(19)]]), region, geo)).toBeNull();
  });
});

describe('buildNightFacts', () => {
  const log = fakeLog({
    tracks: [
      track('u1', 'uav', [[50.45, 30.52, at(20)]]),
      track('swarm', 'uav', [[50.40, 30.60, at(21)]], { count: 5 }),
      track('m1', 'missile', [[49.55, 30.52, at(22)]]),               // near only
      track('old', 'uav', [[50.45, 30.52, at(10)]]),                   // before the window
      track('adv', 'ballistic', [[50.45, 30.52, at(22, 30)]], { advisory: true, title: 'Балістична загроза' }),
      track('odesa', 'uav', [[46.48, 30.72, at(22)]]),
    ],
    messages: [
      { channel: '@kpszsu', text: 'Пуск ~20 шахедів з Курська', at: at(19), regions: [] },
      { channel: '@rozvidkaneba', text: 'Стартували близько 20 шахедів з Курська', at: at(19, 5), regions: [] },
      { channel: '@kpszsu', text: 'Пуск ще ~15 шахедів з Приморсько-Ахтарська', at: at(21), regions: [] },
      { channel: '@kpszsu', text: 'Зліт МіГ-31К', at: at(22), regions: [] },
      { channel: '@hyperlocal', text: 'Пуск 100 шахедів (чутки)', at: at(22, 10), regions: [] },
      { channel: '@rozvidkaneba', text: 'Київщина: БпЛА курсом на Бровари', at: at(21, 30), regions: ['o:київська'] },
      { channel: '@sumy', text: 'Сумщина: БпЛА курсом на Шостку', at: at(21, 40), regions: ['o:сумська'] },
    ],
  });
  const facts = buildNightFacts({ region: KYIV, log, geo: {}, eventChannels: new Set(['@kpszsu', '@rozvidkaneba']), now: NOW });

  it('tallies tracks by where they were, counting a swarm by its size', () => {
    expect(facts.tally.in.uav).toEqual({ tracks: 2, units: 6 });
    expect(facts.tally.near.missile).toEqual({ tracks: 1, units: 1 });
    expect(facts.tally.in.missile).toBeUndefined();
    expect(facts.advisories).toHaveLength(1);
  });

  it('counts a launch wave once however many channels report it, and ignores untrusted channels', () => {
    expect(facts.uavLaunched).toBe(35);
    expect(facts.events.map((e) => e.kind)).toContain('mig31k_takeoff');
    expect(facts.events.some((e) => e.count === 100)).toBe(false);
  });

  it('keeps only the posts that concern the region', () => {
    expect(facts.regionMessages.map((m) => m.text)).toEqual(['Київщина: БпЛА курсом на Бровари']);
  });

  it('renders the caption line, the facts text and the fallback from the same facts', () => {
    const line = formatNightLine(facts);
    expect(line).toContain('🌙 За ніч (з 18:00) — над регіоном: БпЛА 6');
    expect(line).toContain('поблизу: Ракета 1');
    expect(line).toContain('⚠️ попереджень: 1');
    expect(line).toContain('пуски БпЛА ≈35');
    expect(line).toContain('МіГ-31К');

    const text = describeNightFacts(facts);
    expect(text).toContain('над регіоном: БпЛА 6');
    expect(text).toContain('Зліт МіГ-31К');
    expect(text).toContain('Київщина: БпЛА курсом на Бровари');
    expect(text).not.toContain('Сумщина');

    const fallback = formatNightFallback(facts);
    expect(fallback).toContain('🌙 Київ — за ніч');
    expect(fallback).toContain('пуски ударних БпЛА: ≈35');
    expect(fallback).toContain('/map Київ');
  });

  it('says so when the night was quiet', () => {
    const quiet = buildNightFacts({ region: KYIV, log: fakeLog(), geo: {}, now: NOW });
    expect(formatNightLine(quiet)).toContain('цілей над регіоном не зафіксовано');
    expect(formatNightFallback(quiet)).toContain('цілей не зафіксовано');
  });

  it('fingerprints change when something new comes in', () => {
    const a = nightFactsFingerprint(facts);
    const more = buildNightFacts({
      region: KYIV,
      log: fakeLog({ tracks: [track('u9', 'uav', [[50.45, 30.52, at(22, 50)]])] }),
      geo: {}, now: NOW,
    });
    expect(nightFactsFingerprint(more)).not.toBe(a);
    expect(nightFactsFingerprint(buildNightFacts({ region: KYIV, log, geo: {}, eventChannels: new Set(['@kpszsu', '@rozvidkaneba']), now: NOW }))).toBe(a);
  });
});

describe('buildNightPrompt', () => {
  it('embeds the facts and the no-invention rules', () => {
    const prompt = buildNightPrompt({ regionName: 'Київ', factsText: 'над регіоном: БпЛА 6' });
    expect(prompt).toContain('«Київ»');
    expect(prompt).toContain('над регіоном: БпЛА 6');
    expect(prompt).toContain('ТІЛЬКИ на наведені дані');
    expect(prompt).toContain('Без markdown');
    expect(prompt).toContain('🌙 Київ — за ніч');
  });
});
