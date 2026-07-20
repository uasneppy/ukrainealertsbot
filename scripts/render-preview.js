/**
 * Renders preview PNGs without Telegram — for local verification of the map.
 *
 * Usage:
 *   node scripts/render-preview.js mock [out.png] [регіон]   — synthetic scenario
 *   node scripts/render-preview.js live [out.png] [регіон]   — current NEPTUN data
 *
 * Examples:
 *   node scripts/render-preview.js mock /tmp/kyiv.png "київ"
 *   node scripts/render-preview.js live /tmp/kharkiv.png "харківська область"
 */

import fs from 'fs/promises';
import { renderNeptunMap } from '../neptun/mapRenderer.js';
import { fetchSnapshot } from '../neptun/neptunApi.js';
import { resolveRegion } from '../neptun/regionResolver.js';

const mode = process.argv[2] ?? 'mock';
const out = process.argv[3] ?? `/tmp/preview-${mode}.png`;
const regionArg = process.argv[4] ?? null;

const MOCK = {
  threats: [
    { id: 'm1', type: 'uav',      title: 'БпЛА',           lat: 50.62, lon: 29.25, locality: 'Малин',    region: 'Житомирська область', heading: 120 },
    { id: 'm2', type: 'uav',      title: 'БпЛА',           lat: 51.05, lon: 31.90, locality: 'Ніжин',    region: 'Чернігівська область', heading: 200 },
    { id: 'm3', type: 'fpv',      title: 'FPV-дрон',       lat: 49.95, lon: 36.45, locality: 'Чугуїв',   region: 'Харківська область' },
    { id: 'm4', type: 'missile',  title: 'Крилата ракета', lat: 48.55, lon: 31.95, locality: 'Новоукраїнка', region: 'Кіровоградська область', heading: 315 },
    { id: 'm5', type: 'ballistic', title: 'Балістика',     lat: 49.25, lon: 34.10, locality: 'Кобеляки', region: 'Полтавська область', heading: 290 },
    { id: 'm6', type: 'kab',      title: 'КАБ',            lat: 49.70, lon: 37.60, locality: 'Ізюм',     region: 'Харківська область' },
    { id: 'm7', type: 'recon',    title: 'Розвідник',      lat: 51.30, lon: 33.40, locality: 'Конотоп',  region: 'Сумська область' },
    { id: 'm8', type: 'mig31k',   title: 'МіГ-31К',        lat: 46.10, lon: 33.60 },
    { id: 'm9', type: 'shahed-x', title: 'Новий тип',      lat: 47.60, lon: 34.30 },
    // Kyiv-area scenario for region previews (with trails, as in the live feed):
    {
      id: 'k1', type: 'uav', title: 'БпЛА', lat: 50.5111, lon: 30.7909,
      locality: 'Бровари', region: 'Київська область', heading: 262,
      trail: [
        { lat: 50.545, lon: 31.05, t: '2026-07-18T18:20:00Z' },
        { lat: 50.532, lon: 30.95, t: '2026-07-18T18:24:00Z' },
        { lat: 50.520, lon: 30.87, t: '2026-07-18T18:28:00Z' },
      ],
    },
    {
      id: 'k2', type: 'missile', title: 'Крилата ракета', lat: 49.80, lon: 30.12,
      locality: 'Біла Церква', region: 'Київська область', heading: 20,
      trail: [
        { lat: 49.62, lon: 30.02, t: '2026-07-18T18:26:00Z' },
        { lat: 49.71, lon: 30.07, t: '2026-07-18T18:28:00Z' },
      ],
    },
  ],
  alerts: {
    oblasts: [
      { key: 'харківська', name: 'Харківська область', since: '2026-07-18T17:20:00Z' },
      { key: 'луганська',  name: 'Луганська область',  since: '2022-04-04T16:45:00Z' },
      { key: 'автономна республіка крим', name: 'АР Крим', since: '2022-12-10T22:22:00Z' },
      { key: 'м. київ',    name: 'м. Київ',            since: '2026-07-18T18:05:00Z' },
    ],
    raions: [
      { key: 'кременчуцький', name: 'Кременчуцький район', oblast: 'Полтавська область', since: '2026-07-18T18:10:00Z' },
      { key: 'одеський',      name: 'Одеський район',      oblast: 'Одеська область',    since: '2026-07-18T18:12:00Z' },
      { key: 'сумський',      name: 'Сумський район',      oblast: 'Сумська область',    since: '2026-07-18T18:14:00Z' },
      { key: 'дніпровський',  name: 'Дніпровський район',  oblast: 'Дніпропетровська область', since: '2026-07-18T18:16:00Z' },
      { key: 'львівський',    name: 'Львівський район',    oblast: 'Львівська область',  since: '2026-07-18T18:18:00Z' },
      { key: 'чернігівський', name: 'Чернігівський район', oblast: 'Чернігівська область', since: '2026-07-18T18:20:00Z' },
      // Kyiv oblast raions (for the region previews):
      { key: 'бориспільський', name: 'Бориспільський район', oblast: 'Київська область', since: '2026-07-18T18:06:00Z' },
      { key: 'броварський',    name: 'Броварський район',    oblast: 'Київська область', since: '2026-07-18T18:07:00Z' },
      // In a fully-alerted oblast — must be suppressed (covered by oblast red):
      { key: 'харківський',   name: 'Харківський район',   oblast: 'Харківська область', since: '2026-07-18T17:20:00Z' },
    ],
  },
};

const focus = regionArg ? resolveRegion(regionArg) : null;
if (regionArg && (!focus || focus.kind === 'country')) {
  console.error(`Не вдалося розпізнати регіон: "${regionArg}"`);
  process.exit(1);
}

const data = mode === 'live' ? await fetchSnapshot() : MOCK;
const { buffer, caption } = await renderNeptunMap({ ...data, focus });
await fs.writeFile(out, buffer);
console.log('WROTE', out, `(${buffer.length} bytes)`);
if (focus) console.log('FOCUS', JSON.stringify(focus));
console.log('--- CAPTION ---');
console.log(caption);
process.exit(0); // the shared browser singleton would otherwise keep the process alive
