import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

import { parseRegionQuery, resolveRegion, __testables } from '../neptun/regionResolver.js';

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

describe('resolveRegion — false-positive guard', () => {
  it('does not hijack everyday words sharing a prefix with a region', () => {
    expect(resolveRegion('кримінальному провадженні')).toBeNull();
    expect(resolveRegion('криміналі')).toBeNull();
    expect(resolveRegion('автономному режимі')).toBeNull();
    expect(resolveRegion('арках')).toBeNull();
    expect(resolveRegion('києвлян')).toBeNull();
  });

  it('unrelated "тривога в ..." parses but resolves to null (falls through)', () => {
    const q = parseRegionQuery('тривога в кримінальному провадженні');
    expect(q).not.toBeNull();
    expect(resolveRegion(q.regionText)).toBeNull();
  });

  it('still accepts genuine declensions after the guard', () => {
    expect(resolveRegion('криму')).toMatchObject({ kind: 'oblast', geoKey: 'автономна республіка крим' });
    expect(resolveRegion('запоріжжі')).toMatchObject({ kind: 'city', name: 'Запоріжжя' });
    expect(resolveRegion('донецького')).toMatchObject({ kind: 'city', name: 'Донецьк' });
    expect(resolveRegion('автономній республіці крим')).toMatchObject({ kind: 'oblast', geoKey: 'автономна республіка крим' });
  });
});

const oblastsGeoPath = path.resolve('neptun/geo/oblasts.geojson');
const raionsGeoPath = path.resolve('neptun/geo/raions.geojson');

describe.skipIf(!fs.existsSync(oblastsGeoPath) || !fs.existsSync(raionsGeoPath))(
  'resolver keys match the cached NEPTUN GeoJSON',
  () => {
    it('every oblast geoKey, city oblastGeoKey and raionKey exists in the geo data', () => {
      const oblastKeys = new Set(
        JSON.parse(fs.readFileSync(oblastsGeoPath, 'utf8')).features.map((f) => String(f.properties.key).toLowerCase())
      );
      const raionKeys = new Set(
        JSON.parse(fs.readFileSync(raionsGeoPath, 'utf8')).features.map((f) => String(f.properties.key).toLowerCase())
      );
      for (const def of __testables.OBLAST_DEFS) {
        expect(oblastKeys.has(def.geoKey), `oblast geoKey missing: ${def.geoKey}`).toBe(true);
      }
      for (const c of __testables.CITY_DEFS) {
        expect(oblastKeys.has(c.oblastGeoKey), `city oblastGeoKey missing: ${c.oblastGeoKey}`).toBe(true);
        if (c.raionKey) expect(raionKeys.has(c.raionKey), `city raionKey missing: ${c.raionKey}`).toBe(true);
      }
    });
  }
);

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
