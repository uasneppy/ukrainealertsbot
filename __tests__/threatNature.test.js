/**
 * NEPTUN uses the same threat types for a tracked object and for a warning
 * about one. Reading a «Балістична загроза» as a missile is how the bot told
 * Kyiv a ballistic was inbound on a night when nothing had been launched.
 */
import { describe, it, expect } from 'vitest';

import { threatNature, threatDisplayName, advisoryLabel } from '../neptun/threatMeta.js';

describe('threatNature', () => {
  it('reads a ballistic warning as an advisory, not a missile', () => {
    expect(threatNature({ type: 'ballistic', title: 'Балістична загроза' })).toBe('advisory');
    expect(threatNature({ type: 'ballistic', title: 'Загроза балістики' })).toBe('advisory');
    expect(threatNature({
      type: 'ballistic', title: 'Балістика',
      explanationShort: 'Висока ймовірність балістичного удару — реагуйте негайно.',
    })).toBe('advisory');
  });

  it('keeps a tracked ballistic a tracked ballistic', () => {
    expect(threatNature({ type: 'ballistic', title: 'Балістика', explanationShort: 'Балістика курсом на Київ. Підтверджень: 3.' })).toBe('tracked');
    expect(threatNature({ type: 'ballistic', title: 'Балістична ракета' })).toBe('tracked');
    expect(threatNature({ type: 'missile', title: 'Крилата ракета', explanationShort: 'Зафіксовано крилаті ракети' })).toBe('tracked');
    expect(threatNature({ type: 'uav', title: 'БпЛА', explanationShort: 'БпЛА курсом на Шостка. Підтверджень: 8.' })).toBe('tracked');
  });

  it('honours the explicit advisory flag over any wording', () => {
    expect(threatNature({ type: 'missile', title: 'Крилата ракета', advisory: true })).toBe('advisory');
    expect(threatNature({ type: 'ballistic', title: 'Балістична загроза', advisory: false })).toBe('tracked');
  });

  it('treats a MiG-31K marker as an advisory — the aircraft is never over Ukraine', () => {
    expect(threatNature({ type: 'mig31k', title: 'МіГ-31К' })).toBe('advisory');
  });

  it('is safe on junk', () => {
    expect(threatNature(null)).toBe('tracked');
    expect(threatNature({})).toBe('tracked');
  });
});

describe('threatDisplayName / advisoryLabel', () => {
  it('names an advisory as a warning and an object as itself', () => {
    expect(threatDisplayName({ type: 'ballistic', title: 'Балістична загроза' })).toBe('Загроза балістики');
    expect(threatDisplayName({ type: 'ballistic', title: 'Балістика' })).toBe('Балістика');
    expect(threatDisplayName({ type: 'kab', title: 'Загроза КАБ' })).toBe('Загроза КАБ');
    expect(threatDisplayName({ type: 'mig31k', title: 'МіГ-31К' })).toBe('Зліт МіГ-31К');
  });

  it('falls back to a generic label for an unknown advisory type', () => {
    expect(advisoryLabel('recon')).toBe('Загроза: Розвідник');
    expect(advisoryLabel('shahed-x')).toBe('Загроза: shahed-x');
  });
});
