/**
 * Built-in default marker icons for threat types — inline SVG "badges"
 * (coloured circle + white glyph), shipped as data URLs.
 *
 * Why SVG instead of emoji: the map is rendered inside headless Chromium,
 * and emoji coverage there depends on installed system fonts (missing ones
 * show as tofu boxes □). Inline SVG needs no fonts at all.
 *
 * User files from the icons/ folder always override these defaults
 * (see neptun/threatIcons.js).
 */

const GLYPH_STYLE = 'fill="#ffffff" stroke="#0d1524" stroke-width="1.5"';

const GLYPHS = {
  // Delta-wing drone (Shahed-style silhouette)
  uav: `<path d="M32 11 L54 49 L32 40 L10 49 Z" ${GLYPH_STYLE}/>`,

  // Quadcopter: X-frame, 4 rotors, centre body
  fpv: `<path d="M21 21 L43 43 M43 21 L21 43" stroke="#ffffff" stroke-width="6" stroke-linecap="round" fill="none"/>
    <circle cx="17" cy="17" r="6" ${GLYPH_STYLE}/><circle cx="47" cy="17" r="6" ${GLYPH_STYLE}/>
    <circle cx="17" cy="47" r="6" ${GLYPH_STYLE}/><circle cx="47" cy="47" r="6" ${GLYPH_STYLE}/>
    <circle cx="32" cy="32" r="7" ${GLYPH_STYLE}/>`,

  // Rocket pointing up
  missile: `<path d="M32 7 C39 15 39 32 36 44 L28 44 C25 32 25 15 32 7 Z" ${GLYPH_STYLE}/>
    <path d="M28 44 L19 55 L28 51 Z" ${GLYPH_STYLE}/>
    <path d="M36 44 L45 55 L36 51 Z" ${GLYPH_STYLE}/>`,

  // Warhead diving down with speed lines
  ballistic: `<path d="M32 56 L21 30 C21 16 43 16 43 30 Z" ${GLYPH_STYLE}/>
    <path d="M25 9 L25 18 M39 9 L39 18 M32 6 L32 14" stroke="#ffffff" stroke-width="4" stroke-linecap="round" fill="none"/>`,

  // Guided bomb: round body + tail
  kab: `<circle cx="32" cy="40" r="13" ${GLYPH_STYLE}/>
    <path d="M27 17 L37 17 L34 29 L30 29 Z" ${GLYPH_STYLE}/>
    <path d="M32 8 L32 17 M25 11 L39 11" stroke="#ffffff" stroke-width="3.5" stroke-linecap="round" fill="none"/>`,

  // Reconnaissance: eye
  recon: `<ellipse cx="32" cy="32" rx="19" ry="12" ${GLYPH_STYLE}/>
    <circle cx="32" cy="32" r="6.5" fill="#0d1524"/>`,

  // Fighter jet silhouette
  mig31k: `<path d="M32 7 L36 22 L54 42 L36 37 L35 47 L42 55 L32 51 L22 55 L29 47 L28 37 L10 42 L28 22 Z" ${GLYPH_STYLE}/>`,

  // Unknown: question mark (ASCII — safe in any font setup)
  unknown: `<text x="32" y="43" text-anchor="middle" font-family="DejaVu Sans, Liberation Sans, sans-serif" font-size="32" font-weight="700" fill="#ffffff">?</text>`,
};

function badgeSvg(color, glyph) {
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64">`
    + `<circle cx="32" cy="32" r="29" fill="${color}" stroke="rgba(8,14,26,0.9)" stroke-width="3"/>`
    + glyph
    + `</svg>`;
}

let _cache = null;

/**
 * Builds { <type>: <svg data URL> } for every type in GLYPHS.
 * @param {Record<string,string>} colors — badge colour per type (THREAT_COLORS)
 */
export function getDefaultIconDataUrls(colors = {}) {
  if (_cache) return _cache;
  const out = {};
  for (const [type, glyph] of Object.entries(GLYPHS)) {
    const svg = badgeSvg(colors[type] ?? colors.unknown ?? '#9aa7b5', glyph);
    out[type] = `data:image/svg+xml;base64,${Buffer.from(svg, 'utf8').toString('base64')}`;
  }
  _cache = out;
  return _cache;
}
