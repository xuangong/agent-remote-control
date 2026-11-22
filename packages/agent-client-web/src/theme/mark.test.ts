import { describe, expect, it } from 'vitest';
import { brandColors } from './tokens.js';
import { markDrawing, markPoint, markSvg, type MarkVariant } from './mark.js';

/** The points of the drawing that must stay whole in every icon: the leaf's tip, the leaf's base and both eyes' outer edges. */
const features = [{ x: 52, y: 5.5 }, { x: 37, y: 11.5 },
  ...markDrawing.eyes.flatMap(eye => [{ x: eye.cx - eye.rx, y: eye.cy - eye.ry }, { x: eye.cx + eye.rx, y: eye.cy + eye.ry }])];
/** The safe zone every icon mask keeps: a centred circle of 40% of the icon's size (the Web App Manifest's maskable icons). */
const insideSafeZone = (point: { x: number; y: number }) => Math.hypot(point.x - 32, point.y - 32) <= 0.4 * 64;

describe('the icons cut from the mark', () => {
  it('keeps the favicon\'s drawing: a rounded tile, the tilt, the brand colours', () => {
    const svg = markSvg();
    expect(svg).toBe(markSvg('tile'));
    expect(svg).toContain(`<rect width="64" height="64" rx="${markDrawing.tileRadius}"/>`);
    expect(svg).toContain(`<g transform="${markDrawing.tilt}">`);
    for (const color of Object.values(brandColors)) expect(svg).toContain(color);
  });

  it.each<[MarkVariant, boolean, boolean]>([
    // [variant, the tile shows, the drawing is scaled into the safe zone]
    ['square', true, false], ['maskable', true, true], ['monochrome', false, true],
  ])('cuts %s with square corners for the platform to shape', (variant, tile, scaled) => {
    const svg = markSvg(variant);
    expect(svg).toContain('<clipPath id="tile"><rect width="64" height="64"/></clipPath>');
    expect(svg.includes(`fill="${brandColors.tile}"`)).toBe(tile);
    expect(svg.includes('scale(')).toBe(scaled);
  });

  it('keeps the leaf and the eyes inside the safe zone of the maskable and monochrome icons, which the full drawing does not', () => {
    for (const variant of ['maskable', 'monochrome'] as const) for (const point of features) expect(insideSafeZone(markPoint(point, variant)), `${variant} ${JSON.stringify(point)}`).toBe(true);
    expect(features.every(point => insideSafeZone(markPoint(point, 'square')))).toBe(false);
  });

  it('paints the monochrome icon in one ink with the eyes cut out, and no tile', () => {
    const svg = markSvg('monochrome');
    const fills = new Set([...svg.matchAll(/(?:fill|stroke)="(#[0-9a-f]{6})"/g)].map(match => match[1]).filter(color => color !== '#ffffff'));
    expect([...fills]).toEqual(['#000000']);
    expect(svg).toContain('mask="url(#eyes)"');
    expect(svg).not.toContain(brandColors.tile);
  });
});
