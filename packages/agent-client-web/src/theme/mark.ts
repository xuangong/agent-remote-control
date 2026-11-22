/**
 * The Orchard mark: an orange mochi-shaped farmer on a dark rounded tile, tilted, cropped by the tile's bottom edge,
 * looking up and to the left, with one sprout leaf. One drawing for every size: OrchardMark renders it with brand
 * tokens, and markSvg() with brand literals is the favicon's and the icons' source. Pure.
 */
import { brandColors } from './tokens.js';

/** The head's tilt: degrees about a pivot in the 64-unit viewBox. */
const TILT = { degrees: -14, x: 32, y: 44 } as const;

export const markDrawing = {
  /** The tile's corner radius in the 64-unit viewBox: 15/64 of the size. */
  tileRadius: 15,
  tilt: `rotate(${TILT.degrees} ${TILT.x} ${TILT.y})`,
  stem: 'M33 20c0-4 1-7 4-9',
  stemWidth: 3.2,
  leaf: 'M37 11.5c2-7 10-9 15-6-2 6-10 8-15 6z',
  body: 'M33 19c-17 0-29 12-29 28 0 10 4 19 8 24h42c4-5 8-14 8-24 0-16-12-28-29-28z',
  eyes: [{ cx: 25, cy: 35, rx: 3.9, ry: 6 }, { cx: 36, cy: 35, rx: 3.9, ry: 6 }],
} as const;

/**
 * How an icon is cut from the mark:
 * - `tile`: the rounded tile, for the favicon and the browser's own icons;
 * - `square`: the tile without its corners, for platforms that round an icon themselves (iOS's home screen);
 * - `maskable`: the square with the drawing scaled into the safe zone (the centred circle of 40% radius that every mask keeps), still
 *   cropped by the bottom edge, for platforms that cut an icon to their own shape (Android);
 * - `monochrome`: the drawing alone in one colour with the eyes cut out, scaled as `maskable`, for platforms that tint an icon.
 */
export type MarkVariant = 'tile' | 'square' | 'maskable' | 'monochrome';

/** The drawing's scale in `maskable` and `monochrome`, about the bottom centre, so the leaf and the eyes sit inside the safe zone. */
export const maskableScale = 0.8;
const MASKABLE_ANCHOR = { x: 32, y: 64 } as const;

/** The static mark as a standalone SVG document, with the brand colours as literals. */
export function markSvg(variant: MarkVariant = 'tile'): string {
  const { tileRadius, tilt, stem, stemWidth, leaf, body, eyes } = markDrawing;
  const scaled = variant === 'maskable' || variant === 'monochrome';
  const scale = scaled ? `translate(${MASKABLE_ANCHOR.x} ${MASKABLE_ANCHOR.y}) scale(${maskableScale}) translate(${-MASKABLE_ANCHOR.x} ${-MASKABLE_ANCHOR.y}) ` : '';
  const corner = variant === 'tile' ? ` rx="${tileRadius}"` : '';
  if (variant === 'monochrome') {
    // One ink: the body with its eyes cut out, the leaf and the stem; the platform paints it.
    const ink = '#000000';
    const holes = eyes.map(eye => `<ellipse cx="${eye.cx}" cy="${eye.cy}" rx="${eye.rx}" ry="${eye.ry}" fill="#000000"/>`).join('');
    return '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64">'
      + `<defs><clipPath id="tile"><rect width="64" height="64"/></clipPath><mask id="eyes" maskUnits="userSpaceOnUse" x="-32" y="-32" width="128" height="128"><rect x="-32" y="-32" width="128" height="128" fill="#ffffff"/>${holes}</mask></defs>`
      + `<g clip-path="url(#tile)"><g transform="${scale}${tilt}">`
      + `<path d="${stem}" stroke="${ink}" stroke-width="${stemWidth}" stroke-linecap="round" fill="none"/>`
      + `<path d="${leaf}" fill="${ink}"/><path d="${body}" fill="${ink}" mask="url(#eyes)"/></g></g></svg>\n`;
  }
  const eyeTags = eyes.map(eye => `<ellipse cx="${eye.cx}" cy="${eye.cy}" rx="${eye.rx}" ry="${eye.ry}" fill="${brandColors.eye}"/>`).join('');
  return '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64">'
    + `<defs><clipPath id="tile"><rect width="64" height="64"${corner}/></clipPath></defs>`
    + `<g clip-path="url(#tile)"><rect width="64" height="64" fill="${brandColors.tile}"/><g transform="${scale}${tilt}">`
    + `<path d="${stem}" stroke="${brandColors.stem}" stroke-width="${stemWidth}" stroke-linecap="round" fill="none"/>`
    + `<path d="${leaf}" fill="${brandColors.leaf}"/><path d="${body}" fill="${brandColors.body}"/>${eyeTags}</g></g></svg>\n`;
}

/** Where a point of the drawing lands in an icon of `variant`, in the 64-unit box: the tilt, then the safe-zone scale. */
export function markPoint(point: { x: number; y: number }, variant: MarkVariant): { x: number; y: number } {
  const angle = TILT.degrees * Math.PI / 180;
  const dx = point.x - TILT.x, dy = point.y - TILT.y;
  const tilted = { x: TILT.x + dx * Math.cos(angle) - dy * Math.sin(angle), y: TILT.y + dx * Math.sin(angle) + dy * Math.cos(angle) };
  if (variant !== 'maskable' && variant !== 'monochrome') return tilted;
  return { x: MASKABLE_ANCHOR.x + (tilted.x - MASKABLE_ANCHOR.x) * maskableScale, y: MASKABLE_ANCHOR.y + (tilted.y - MASKABLE_ANCHOR.y) * maskableScale };
}
