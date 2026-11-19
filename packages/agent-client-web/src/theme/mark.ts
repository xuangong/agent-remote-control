/**
 * The Orchard mark: an orange mochi-shaped farmer on a dark rounded tile, tilted, cropped by the tile's bottom edge,
 * looking up and to the left, with one sprout leaf. One drawing for every size: OrchardMark renders it with brand
 * tokens, and markSvg() with brand literals is the favicon's and the icons' source. Pure.
 */
import { brandColors } from './tokens.js';

export const markDrawing = {
  /** The tile's corner radius in the 64-unit viewBox: 15/64 of the size. */
  tileRadius: 15,
  tilt: 'rotate(-14 32 44)',
  stem: 'M33 20c0-4 1-7 4-9',
  stemWidth: 3.2,
  leaf: 'M37 11.5c2-7 10-9 15-6-2 6-10 8-15 6z',
  body: 'M33 19c-17 0-29 12-29 28 0 10 4 19 8 24h42c4-5 8-14 8-24 0-16-12-28-29-28z',
  eyes: [{ cx: 25, cy: 35, rx: 3.9, ry: 6 }, { cx: 36, cy: 35, rx: 3.9, ry: 6 }],
} as const;

/** The static mark as a standalone SVG document, with the brand colours as literals. */
export function markSvg(): string {
  const { tileRadius, tilt, stem, stemWidth, leaf, body, eyes } = markDrawing;
  const eyeTags = eyes.map(eye => `<ellipse cx="${eye.cx}" cy="${eye.cy}" rx="${eye.rx}" ry="${eye.ry}" fill="${brandColors.eye}"/>`).join('');
  return '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64">'
    + `<defs><clipPath id="tile"><rect width="64" height="64" rx="${tileRadius}"/></clipPath></defs>`
    + `<g clip-path="url(#tile)"><rect width="64" height="64" fill="${brandColors.tile}"/><g transform="${tilt}">`
    + `<path d="${stem}" stroke="${brandColors.stem}" stroke-width="${stemWidth}" stroke-linecap="round" fill="none"/>`
    + `<path d="${leaf}" fill="${brandColors.leaf}"/><path d="${body}" fill="${brandColors.body}"/>${eyeTags}</g></g></svg>\n`;
}
