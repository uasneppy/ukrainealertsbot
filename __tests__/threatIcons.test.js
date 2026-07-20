/**
 * Icons are read from disk on every render so they can be swapped without a
 * restart — which means a bad file in the folder must degrade to the built-in
 * badge rather than break the map.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'fs/promises';
import path from 'path';
import os from 'os';

import { loadThreatIcons, getIconsDir } from '../neptun/threatIcons.js';
import { getDefaultIconDataUrls } from '../neptun/defaultIcons.js';
import { THREAT_COLORS } from '../neptun/threatMeta.js';

let dir;

beforeEach(async () => {
  dir = await fs.mkdtemp(path.join(os.tmpdir(), 'icons-'));
});

afterEach(async () => {
  await fs.rm(dir, { recursive: true, force: true });
  delete process.env.THREAT_ICONS_DIR;
});

describe('loadThreatIcons', () => {
  it('returns an empty map when the folder does not exist', async () => {
    await expect(loadThreatIcons(path.join(dir, 'nope'))).resolves.toEqual({});
  });

  it('loads supported image types as data URLs keyed by filename', async () => {
    await fs.writeFile(path.join(dir, 'uav.png'), Buffer.from([0x89, 0x50, 0x4e, 0x47]));
    await fs.writeFile(path.join(dir, 'missile.svg'), '<svg/>');

    const icons = await loadThreatIcons(dir);

    expect(Object.keys(icons).sort()).toEqual(['missile', 'uav']);
    expect(icons.uav).toMatch(/^data:image\/png;base64,/);
    expect(icons.missile).toMatch(/^data:image\/svg\+xml;base64,/);
    expect(Buffer.from(icons.missile.split(',')[1], 'base64').toString()).toBe('<svg/>');
  });

  it('ignores unsupported extensions and directories', async () => {
    await fs.writeFile(path.join(dir, 'README.md'), '# not an icon');
    await fs.writeFile(path.join(dir, 'notes.txt'), 'hello');
    await fs.mkdir(path.join(dir, 'uav.png.d'));

    await expect(loadThreatIcons(dir)).resolves.toEqual({});
  });

  it('skips files larger than the 1 MB cap', async () => {
    await fs.writeFile(path.join(dir, 'kab.png'), Buffer.alloc(1_000_001));
    await fs.writeFile(path.join(dir, 'fpv.png'), Buffer.alloc(16));

    const icons = await loadThreatIcons(dir);

    expect(icons).not.toHaveProperty('kab');
    expect(icons).toHaveProperty('fpv');
  });

  it('lowercases the type and resolves duplicates alphabetically last', async () => {
    await fs.writeFile(path.join(dir, 'UAV.gif'), Buffer.from('gif'));
    await fs.writeFile(path.join(dir, 'uav.png'), Buffer.from('png'));

    const icons = await loadThreatIcons(dir);

    // uav.png sorts after UAV.gif, so the png wins.
    expect(icons.uav).toMatch(/^data:image\/png;base64,/);
  });

  it('honours THREAT_ICONS_DIR', async () => {
    process.env.THREAT_ICONS_DIR = dir;
    expect(getIconsDir()).toBe(dir);

    await fs.writeFile(path.join(dir, 'recon.webp'), Buffer.from('webp'));
    await expect(loadThreatIcons()).resolves.toHaveProperty('recon');
  });
});

describe('getDefaultIconDataUrls', () => {
  it('provides a badge for every known threat type plus unknown', async () => {
    const icons = getDefaultIconDataUrls(THREAT_COLORS);

    for (const type of ['uav', 'fpv', 'missile', 'ballistic', 'kab', 'recon', 'mig31k', 'unknown']) {
      expect(icons[type]).toMatch(/^data:image\/svg\+xml;base64,/);
    }
  });

  it('embeds the threat colour so types stay distinguishable on the map', () => {
    const icons = getDefaultIconDataUrls(THREAT_COLORS);
    const svg = Buffer.from(icons.uav.split(',')[1], 'base64').toString();

    expect(svg).toContain(THREAT_COLORS.uav);
    expect(svg).toContain('<svg');
  });

  it('uses no text glyphs except the ASCII unknown marker', () => {
    // Emoji/text in headless Chromium depends on installed fonts; the badges
    // are inline SVG paths precisely so they never render as tofu.
    const icons = getDefaultIconDataUrls(THREAT_COLORS);
    const decode = (u) => Buffer.from(u.split(',')[1], 'base64').toString();

    for (const type of ['uav', 'fpv', 'missile', 'ballistic', 'kab', 'recon', 'mig31k']) {
      expect(decode(icons[type])).not.toContain('<text');
    }
    expect(decode(icons.unknown)).toContain('>?<');
  });
});
