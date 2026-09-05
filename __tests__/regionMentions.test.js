/**
 * Channel posts name regions in every declension and slang form; the digest
 * for Kyiv must pick up «Київщина: …» and skip «Сумщина: …».
 */
import { describe, it, expect } from 'vitest';

import { mentionedRegions, relevantRegionKeys, messageConcerns } from '../neptun/regionMentions.js';
import { resolveRegion } from '../neptun/regionResolver.js';

describe('mentionedRegions', () => {
  it('finds regions in headings, prepositional phrases and colloquial forms', () => {
    expect([...mentionedRegions('Київщина: реактивний БпЛА курсом на Бровари')]).toEqual(['o:київська']);
    expect([...mentionedRegions('Київ:\nРеактивний БпЛА курсом на Козин')]).toEqual(['c:київ']);
    expect([...mentionedRegions('Балістика з Криму на Одещину!')].sort()).toEqual(['o:автономна республіка крим', 'o:одеська']);
    expect([...mentionedRegions('на Буковині тихо')]).toEqual(['o:чернівецька']);
  });

  it('finds several regions in one multi-section post', () => {
    const keys = mentionedRegions('Сумщина:\nБпЛА курсом на Шостку\n\nПолтавщина:\nРеактивний БпЛА');
    expect([...keys].sort()).toEqual(['o:полтавська', 'o:сумська']);
  });

  it('finds nothing in a post without regions', () => {
    expect(mentionedRegions('Пуски КР з Ту-95МС').size).toBe(0);
    expect(mentionedRegions('').size).toBe(0);
    expect(mentionedRegions(null).size).toBe(0);
  });
});

describe('relevantRegionKeys / messageConcerns', () => {
  it('pairs Kyiv city with Київщина and an oblast with its cities', () => {
    expect([...relevantRegionKeys(resolveRegion('київ'))]).toEqual(expect.arrayContaining(['c:київ', 'o:київська']));
    expect([...relevantRegionKeys(resolveRegion('харківщина'))]).toEqual(expect.arrayContaining(['o:харківська', 'c:харків']));
    expect([...relevantRegionKeys(resolveRegion('київщина'))]).toEqual(expect.arrayContaining(['o:київська', 'c:київ', 'c:біла церква']));
  });

  it('a Sumy post does not concern Kyiv', () => {
    const kyiv = relevantRegionKeys(resolveRegion('київ'));
    expect(messageConcerns({ regions: ['o:сумська'] }, kyiv)).toBe(false);
    expect(messageConcerns({ regions: ['o:київська'] }, kyiv)).toBe(true);
    expect(messageConcerns({}, kyiv)).toBe(false);
  });
});

describe('mentionedRegions — hostile input', () => {
  // A post with stylised Unicode letters (two code units each) once looped
  // forever: the scanner stepped one unit into the pair, the /u regex snapped
  // back, and the bot sat at 100% CPU with its heartbeat frozen for hours.
  it('terminates on astral-plane letters and still finds regions around them', () => {
    const start = Date.now();
    expect([...mentionedRegions('𝐊𝐢𝐢𝐯 test 𝗕𝗽𝗟𝗔 над Києвом 🇺🇦 𝓞𝓭𝓮𝓼𝓪')]).toEqual(['c:київ']);
    expect(mentionedRegions('𝐀'.repeat(200)).size).toBe(0);
    expect(mentionedRegions('😀'.repeat(50) + ' Харків').has('c:харків')).toBe(true);
    expect(Date.now() - start).toBeLessThan(2000);
  });
});
