/**
 * Nationwide events come from sentences in monitoring channels. Every phrasing
 * here is a real one (or a real trap), and the asymmetry matters: a missed
 * take-off is covered by the siren that follows; a false "Kalibr launched" at
 * 3 a.m. gets the bot muted, after which it warns nobody.
 */
import { describe, it, expect } from 'vitest';

import { detectEvents, formatEventNotification, quoteMessage, EVENT_KINDS } from '../neptun/eventDetector.js';

const kinds = (text) => detectEvents(text).map((e) => e.kind);
const one = (text) => {
  const events = detectEvents(text);
  expect(events).toHaveLength(1);
  return events[0];
};

describe('detectEvents — MiG-31K / Kinzhal', () => {
  it('take-off with the standard Air Force wording', () => {
    expect(kinds('⚠️ Зліт МіГ-31К з аеродрому «Савастлейка». Загроза застосування авіаційного ракетного комплексу «Кинджал»!'))
      .toEqual(['mig31k_takeoff']);
  });

  it('counts the aircraft', () => {
    expect(one('Зліт 2х МіГ-31К зі Саваслейки')).toMatchObject({ kind: 'mig31k_takeoff', count: 2 });
    expect(one('Пара МіГ-31К в повітрі')).toMatchObject({ kind: 'mig31k_takeoff', count: 2 });
  });

  it('a Kinzhal launch is its own event', () => {
    expect(kinds('Зафіксовано пуск Кинджалів у напрямку Хмельниччини')).toEqual(['kinzhal_launch']);
    expect(kinds('Пуск Кинджала з МіГ-31К')).toEqual(['kinzhal_launch']);
  });

  it('a landing is not a take-off, and an expired threat is not a threat', () => {
    expect(kinds('МіГ-31К здійснив посадку. Загроза застосування Кинджалів минула.')).toEqual([]);
    expect(kinds('МіГ-31К приземлився на аеродромі базування')).toEqual([]);
  });

  it('reads the Russian spelling some channels use', () => {
    expect(kinds('Взлет МиГ-31К с аэродрома Саваслейка. Угроза применения Кинжалов!')).toEqual(['mig31k_takeoff']);
  });
});

describe('detectEvents — strategic aviation and cruise missiles', () => {
  it('take-off, with the number of aircraft', () => {
    expect(one('Зафіксовано зліт 7 бортів стратегічної авіації Ту-95МС з аеродрому Оленья (Мурманська обл.)'))
      .toMatchObject({ kind: 'strategic_takeoff', count: 7 });
    expect(one('Пара Ту-160 злетіла з Енгельса')).toMatchObject({ kind: 'strategic_takeoff', count: 2 });
  });

  it('does not read a designation as a count', () => {
    expect(one('Ту-95МС в повітрі').count).toBeNull();
    expect(one('Зліт Ту-160 з Енгельса').count).toBeNull();
  });

  it('aircraft on the ground are not an event', () => {
    expect(kinds('Стратегічна авіація: 7 бортів Ту-95 на аеродромі Оленья')).toEqual([]);
  });

  it('cruise missile launches from aircraft', () => {
    expect(kinds('Пуски КР з літаків стратегічної авіації Ту-95МС.')).toEqual(['cruise_launch']);
    expect(kinds('Пуски крилатих ракет Х-101 із Ту-95МС')).toEqual(['cruise_launch']);
  });

  it('judges each sentence on its own — a negated launch does not cancel a take-off', () => {
    expect(kinds('Пусків крилатих ракет не зафіксовано. Стратегічна авіація в повітрі.')).toEqual(['strategic_takeoff']);
  });
});

describe('detectEvents — Kalibr', () => {
  it('carriers at sea', () => {
    expect(kinds('Носії Калібрів вийшли в море: 2 Buyan-M, 8 Kalibr')).toEqual(['kalibr_carriers']);
    expect(kinds('У Чорному морі на бойовому чергуванні носії крилатих ракет')).toEqual(['kalibr_carriers']);
  });

  it('launches, including the sea-launched phrasing without the word Kalibr', () => {
    expect(kinds('Пуски Калібрів!')).toEqual(['kalibr_launch']);
    expect(kinds('Пуски крилатих ракет з акваторії Чорного моря!')).toEqual(['kalibr_launch']);
  });
});

describe('detectEvents — ballistics', () => {
  it('"threat of use" wording is a threat', () => {
    expect(kinds('Загроза застосування балістичного озброєння для областей, де оголошено повітряну тривогу!'))
      .toEqual(['ballistic_threat']);
    expect(kinds('Балістична загроза для Києва! Перейдіть в укриття!')).toEqual(['ballistic_threat']);
  });

  it('a concrete report is a launch', () => {
    expect(kinds('Швидкісна ціль на Київ!')).toEqual(['ballistic_launch']);
    expect(kinds('Балістика з Криму на Одещину!')).toEqual(['ballistic_launch']);
    expect(kinds('Пуск балістики з Таганрога')).toEqual(['ballistic_launch']);
  });
});

describe('detectEvents — drones', () => {
  it('launches with counts in every common form', () => {
    expect(one('Пуск шахедів з Приморсько-Ахтарська, орієнтовно 30 одиниць')).toMatchObject({ kind: 'uav_launch', count: 30 });
    expect(one('Стартували ~40 шахедів з Курська')).toMatchObject({ kind: 'uav_launch', count: 40 });
    expect(one('Рій БпЛА (5+) стартував з Курська')).toMatchObject({ kind: 'uav_launch', count: 5 });
    expect(one('Запуск ударних БпЛА, близько 20 шт')).toMatchObject({ kind: 'uav_launch', count: 20 });
  });

  it('a drone already flying is not a launch', () => {
    expect(kinds('🏍 Реактивний БпЛА курсом на Київ з півдня.')).toEqual([]);
    expect(kinds('Ударні БпЛА на півночі Сумщини, курсом на захід.')).toEqual([]);
    expect(kinds('У районі ТЕЦ — активність дрона типу «Молнія»')).toEqual([]);
  });

  it('a city siren notice is not a nationwide event', () => {
    expect(kinds('🛸 Нікополь (Дніпропетровська обл.)\nЗагроза застосування БПЛА. Перейдіть в укриття!')).toEqual([]);
    expect(kinds('💥 Нікополь (Дніпропетровська обл.)\nЗагроза обстрілу! Перейдіть в укриття!')).toEqual([]);
  });
});

describe('detectEvents — status digests', () => {
  // The hourly «Ситуація станом на…» post restates the whole night; "пуски
  // зафіксовано" in it is a summary, not a new launch — and quoting it
  // produced a truncated wall of bullet points in the chat.
  const digest = [
    '💀Ситуація станом на 00:00 05.09.2026',
    '• Авіація:',
    '✈️Стратегічна авіація не активна',
    '🛩Тактична авіація не активна',
    '💣Впродовж доби ворог застосував керовані авіаційні бомби по лінії бойового зіткнення',
    '• БпЛА:',
    '🛸Зафіксовано пуски ударних БпЛА типу "Shahed". Тривають польоти по всій країні.',
  ].join('\n');

  it('is not an event source', () => {
    expect(detectEvents(digest)).toEqual([]);
    expect(detectEvents('Підсумок доби: пуски БпЛА, зліт МіГ-31К о 22:40')).toEqual([]);
  });

  it('"не активна" is not activity', () => {
    expect(detectEvents('Стратегічна авіація не активна')).toEqual([]);
    expect(detectEvents('Стратегічна авіація активна, борти в повітрі')).toEqual([{ kind: 'strategic_takeoff', count: null, sentence: 'Стратегічна авіація активна, борти в повітрі' }]);
  });
});

describe('detectEvents — plumbing', () => {
  it('returns nothing for empty or irrelevant text', () => {
    expect(detectEvents('')).toEqual([]);
    expect(detectEvents(null)).toEqual([]);
    expect(detectEvents('Відбій тривоги у Львівській області')).toEqual([]);
  });

  it('returns the triggering sentence in the channel\'s own casing, without bullets', () => {
    const post = '🛸 Зафіксовано пуски ударних БпЛА типу "Shahed" з Курська, ~25 одиниць.\nСтежте за тривогою.\n\n✙ Розвідка неба ✙';
    expect(detectEvents(post)[0].sentence).toBe('Зафіксовано пуски ударних БпЛА типу "Shahed" з Курська, ~25 одиниць');
  });

  it('every kind it can emit has metadata', () => {
    for (const kind of Object.keys(EVENT_KINDS)) {
      expect(EVENT_KINDS[kind]).toMatchObject({ category: expect.any(String), title: expect.any(String) });
    }
  });
});

describe('quoteMessage / formatEventNotification', () => {
  it('drops channel boilerplate and trims', () => {
    const q = quoteMessage('Зафіксовано зліт Ту-95МС з Оленьї\n\n✙ Розвідка неба ✙\n✙Підтримати канал✙\nhttps://t.me/x\n🇺🇦 Підписатись');
    expect(q).toBe('Зафіксовано зліт Ту-95МС з Оленьї');
    expect(quoteMessage('a'.repeat(400)).length).toBeLessThanOrEqual(280);
  });

  it('cuts a long quote at a sentence or line boundary, never mid-word', () => {
    const long = 'Перше речення. Друге речення досить довге. '.repeat(12);
    const q = quoteMessage(long);
    expect(q.length).toBeLessThanOrEqual(280);
    expect(q.endsWith('.…')).toBe(true);
  });

  it('names the event, quotes the source and shows Kyiv time', () => {
    const text = formatEventNotification({
      kind: 'strategic_takeoff', count: 7, quote: 'Зліт 7 бортів', channel: '@kpszsu', date: '2026-09-04T19:07:13Z',
    });
    expect(text).toContain('✈️ Зліт стратегічної авіації (×7)');
    expect(text).toContain('«Зліт 7 бортів»');
    expect(text).toContain('@kpszsu · 22:07');
  });

  it('phrases a drone count as an approximate number', () => {
    expect(formatEventNotification({ kind: 'uav_launch', count: 30 })).toContain('Пуски ударних БпЛА — ≈30');
  });
});
