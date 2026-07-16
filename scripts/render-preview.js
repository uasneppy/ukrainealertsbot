/**
 * Renders preview PNGs without Telegram — for local verification of the map.
 *
 * Usage:
 *   node scripts/render-preview.js mock [out.png]   — synthetic scenario
 *   node scripts/render-preview.js live [out.png]   — current NEPTUN data
 */

import fs from 'fs/promises';
import { renderNeptunMap } from '../neptun/mapRenderer.js';
import { fetchSnapshot } from '../neptun/neptunApi.js';

const mode = process.argv[2] ?? 'mock';
const out = process.argv[3] ?? `/tmp/preview-${mode}.png`;

const MOCK = {
  threats: [
    { id: 'm1', type: 'uav',      title: 'БпЛА',           lat: 50.62, lon: 29.25 },
    { id: 'm2', type: 'uav',      title: 'БпЛА',           lat: 51.05, lon: 31.90 },
    { id: 'm3', type: 'fpv',      title: 'FPV-дрон',       lat: 49.95, lon: 36.45 },
    { id: 'm4', type: 'missile',  title: 'Крилата ракета', lat: 48.55, lon: 31.95 },
    { id: 'm5', type: 'ballistic', title: 'Балістика',     lat: 49.25, lon: 34.10 },
    { id: 'm6', type: 'kab',      title: 'КАБ',            lat: 49.70, lon: 37.60 },
    { id: 'm7', type: 'recon',    title: 'Розвідник',      lat: 51.30, lon: 33.40 },
    { id: 'm8', type: 'mig31k',   title: 'МіГ-31К',        lat: 46.10, lon: 33.60 },
    { id: 'm9', type: 'shahed-x', title: 'Новий тип',      lat: 47.60, lon: 34.30 },
  ],
  alerts: {
    oblasts: [
      { key: 'харківська', name: 'Харківська область', since: '' },
      { key: 'луганська',  name: 'Луганська область',  since: '' },
      { key: 'автономна республіка крим', name: 'АР Крим', since: '' },
    ],
    raions: [
      { key: 'кременчуцький', name: 'Кременчуцький район', oblast: 'Полтавська область' },
      { key: 'одеський',      name: 'Одеський район',      oblast: 'Одеська область' },
      { key: 'сумський',      name: 'Сумський район',      oblast: 'Сумська область' },
      { key: 'дніпровський',  name: 'Дніпровський район',  oblast: 'Дніпропетровська область' },
      { key: 'львівський',    name: 'Львівський район',    oblast: 'Львівська область' },
      { key: 'чернігівський', name: 'Чернігівський район', oblast: 'Чернігівська область' },
      // In a fully-alerted oblast — must be suppressed (covered by oblast red):
      { key: 'харківський',   name: 'Харківський район',   oblast: 'Харківська область' },
    ],
  },
};

const data = mode === 'live' ? await fetchSnapshot() : MOCK;
const { buffer, caption } = await renderNeptunMap(data);
await fs.writeFile(out, buffer);
console.log('WROTE', out, `(${buffer.length} bytes)`);
console.log('--- CAPTION ---');
console.log(caption);
process.exit(0); // the shared browser singleton would otherwise keep the process alive
