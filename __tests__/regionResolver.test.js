import { describe, expect, it } from 'vitest';

import { parseRegionQuery, resolveRegion } from '../neptun/regionResolver.js';

describe('parseRegionQuery', () => {
  it('parses "Тривога в Києві"', () => {
    expect(parseRegionQuery('Тривога в Києві')).toEqual({ why: false, regionText: 'києві' });
  });

  it('parses "чому Тривога в київській області?" with the why flag', () => {
    expect(parseRegionQuery('чому Тривога в київській області?')).toEqual({
      why: true,
      regionText: 'київській області',
    });
  });

  it('supports the inverted word order "чому в харкові тривога"', () => {
    expect(parseRegionQuery('чому в харкові тривога')).toEqual({ why: true, regionText: 'харкові' });
  });

  it('returns null for bare "тривога" and "чому тривога"', () => {
    expect(parseRegionQuery('тривога')).toBeNull();
    expect(parseRegionQuery('чому тривога')).toBeNull();
    expect(parseRegionQuery('чому тривога?')).toBeNull();
  });

  it('returns null when there is no alert keyword at all', () => {
    expect(parseRegionQuery('привіт, як справи?')).toBeNull();
  });

  it('handles prepositions у/на/по and trailing punctuation', () => {
    expect(parseRegionQuery('ТРИВОГА У ЛЬВОВІ!')).toEqual({ why: false, regionText: 'львові' });
    expect(parseRegionQuery('тривога на харківщині')).toEqual({ why: false, regionText: 'харківщині' });
  });

  it('strips "м." from "тривога в м. Києві"', () => {
    expect(parseRegionQuery('тривога в м. Києві')).toEqual({ why: false, regionText: 'києві' });
  });

  it('drops trailing stopwords ("тривога в києві зараз")', () => {
    expect(parseRegionQuery('тривога в києві зараз')).toEqual({ why: false, regionText: 'києві' });
  });
});

describe('resolveRegion — cities', () => {
  it('resolves "києві" to the city of Kyiv with its own alert key', () => {
    const r = resolveRegion('києві');
    expect(r.kind).toBe('city');
    expect(r.name).toBe('Київ');
    expect(r.alertKey).toBe('м. київ');
    expect(r.lat).toBeCloseTo(50.4501, 3);
  });

  it('resolves city locatives', () => {
    expect(resolveRegion('львові')).toMatchObject({ kind: 'city', name: 'Львів' });
    expect(resolveRegion('харкові')).toMatchObject({ kind: 'city', name: 'Харків' });
    expect(resolveRegion('запоріжжі')).toMatchObject({ kind: 'city', name: 'Запоріжжя' });
    expect(resolveRegion('одесі')).toMatchObject({ kind: 'city', name: 'Одеса' });
    expect(resolveRegion('сумах')).toMatchObject({ kind: 'city', name: 'Суми' });
    expect(resolveRegion('дніпрі')).toMatchObject({ kind: 'city', name: 'Дніпро' });
  });

  it('resolves multi-word city names ("кривому розі")', () => {
    expect(resolveRegion('кривому розі')).toMatchObject({ kind: 'city', name: 'Кривий Ріг' });
  });

  it('resolves Sevastopol as a city with its own alert key', () => {
    expect(resolveRegion('севастополі')).toMatchObject({
      kind: 'city',
      name: 'Севастополь',
      alertKey: 'севастополь',
    });
  });

  it('city carries its raion and parent oblast keys', () => {
    expect(resolveRegion('харкові')).toMatchObject({
      raionKey: 'харківський',
      oblastGeoKey: 'харківська',
    });
  });
});

describe('resolveRegion — oblasts', () => {
  it('resolves adjective forms to oblasts', () => {
    expect(resolveRegion('київській області')).toMatchObject({ kind: 'oblast', geoKey: 'київська' });
    expect(resolveRegion('київська область')).toMatchObject({ kind: 'oblast', geoKey: 'київська' });
    expect(resolveRegion('львівській')).toMatchObject({ kind: 'oblast', geoKey: 'львівська' });
    expect(resolveRegion('запорізькій області')).toMatchObject({ kind: 'oblast', geoKey: 'запорізька' });
  });

  it('resolves "-щина" regional forms', () => {
    expect(resolveRegion('харківщині')).toMatchObject({ kind: 'oblast', geoKey: 'харківська' });
    expect(resolveRegion('київщині')).toMatchObject({ kind: 'oblast', geoKey: 'київська' });
    expect(resolveRegion('одещині')).toMatchObject({ kind: 'oblast', geoKey: 'одеська' });
    expect(resolveRegion('буковині')).toMatchObject({ kind: 'oblast', geoKey: 'чернівецька' });
  });

  it('resolves Crimea forms', () => {
    expect(resolveRegion('криму')).toMatchObject({ kind: 'oblast', geoKey: 'автономна республіка крим' });
    expect(resolveRegion('ар крим')).toMatchObject({ kind: 'oblast', geoKey: 'автономна республіка крим' });
  });

  it('builds display names', () => {
    expect(resolveRegion('київській області').name).toBe('Київська область');
    expect(resolveRegion('івано-франківській області').name).toBe('Івано-Франківська область');
    expect(resolveRegion('криму').name).toBe('АР Крим');
  });
});

describe('resolveRegion — city vs oblast disambiguation', () => {
  it('"донецьку" → city, "донецькій області" → oblast', () => {
    expect(resolveRegion('донецьку')).toMatchObject({ kind: 'city', name: 'Донецьк' });
    expect(resolveRegion('донецькій області')).toMatchObject({ kind: 'oblast', geoKey: 'донецька' });
  });

  it('adjective ending without the word "область" still means oblast', () => {
    expect(resolveRegion('донецькій')).toMatchObject({ kind: 'oblast', geoKey: 'донецька' });
    expect(resolveRegion('хмельницькій')).toMatchObject({ kind: 'oblast', geoKey: 'хмельницька' });
  });

  it('"хмельницькому" → city, "франківську" → city, "франківській" → oblast', () => {
    expect(resolveRegion('хмельницькому')).toMatchObject({ kind: 'city', name: 'Хмельницький' });
    expect(resolveRegion('франківську')).toMatchObject({ kind: 'city', name: 'Івано-Франківськ' });
    expect(resolveRegion('франківській')).toMatchObject({ kind: 'oblast', geoKey: 'івано-франківська' });
  });
});

describe('resolveRegion — misc', () => {
  it('"україні" resolves to the whole country', () => {
    expect(resolveRegion('україні')).toMatchObject({ kind: 'country' });
  });

  it('unknown region → null', () => {
    expect(resolveRegion('абракадабрі')).toBeNull();
    expect(resolveRegion('')).toBeNull();
    expect(resolveRegion(null)).toBeNull();
  });

  it('cache keys are stable and distinct', () => {
    expect(resolveRegion('києві').cacheKey).toBe('c:київ');
    expect(resolveRegion('київській області').cacheKey).toBe('o:київська');
  });
});
