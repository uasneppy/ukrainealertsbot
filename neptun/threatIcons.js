/**
 * Loads user-supplied threat icons from the bot's `icons/` folder.
 *
 * Drop a file named `<type>.<ext>` into `icons/` to override the marker for
 * that threat type, e.g. `icons/uav.png`, `icons/fpv.webp`, `icons/missile.svg`.
 * Supported: png, jpg, jpeg, webp, gif, svg. Recommended size: 64–128 px square.
 *
 * The folder is re-read on every render, so icons can be swapped while the
 * bot is running — no restart needed. Missing folder / no files → the renderer
 * falls back to built-in emoji markers.
 */

import fs from 'fs/promises';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DEFAULT_DIR = path.resolve(__dirname, '..', 'icons');

const MIME_BY_EXT = {
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.gif': 'image/gif',
  '.svg': 'image/svg+xml',
};

/** Files bigger than this are skipped (payload goes into the render page). */
const MAX_ICON_BYTES = 1_000_000;

export function getIconsDir() {
  return process.env.THREAT_ICONS_DIR || DEFAULT_DIR;
}

/**
 * Scans the icons folder and returns { <type>: <dataURL> } for every valid
 * image file. Filename (without extension, lowercased) is the threat type.
 * Never throws — a missing/unreadable folder yields {}.
 *
 * @param {string} [dir] Override the folder (used by tests).
 * @returns {Promise<Record<string, string>>}
 */
export async function loadThreatIcons(dir = getIconsDir()) {
  const icons = {};

  let entries;
  try {
    entries = await fs.readdir(dir, { withFileTypes: true });
  } catch {
    return icons; // folder absent — use built-in markers
  }

  // Sort for deterministic precedence when a type has several files
  // (last one alphabetically wins, e.g. uav.png beats uav.gif).
  entries.sort((a, b) => a.name.localeCompare(b.name));

  for (const entry of entries) {
    if (!entry.isFile()) continue;
    const ext = path.extname(entry.name).toLowerCase();
    const mime = MIME_BY_EXT[ext];
    if (!mime) continue;

    const type = path.basename(entry.name, ext).toLowerCase().trim();
    if (!type) continue;

    const filePath = path.join(dir, entry.name);
    try {
      const stat = await fs.stat(filePath);
      if (stat.size > MAX_ICON_BYTES) {
        console.warn(`[threatIcons] Skipping ${entry.name} — file is larger than 1 MB`);
        continue;
      }
      const buf = await fs.readFile(filePath);
      icons[type] = `data:${mime};base64,${buf.toString('base64')}`;
    } catch (err) {
      console.warn(`[threatIcons] Failed to read ${entry.name}:`, err.message);
    }
  }

  return icons;
}
