import { describe, expect, it } from 'vitest';
import { avatarEye, avatarEyes, avatarFor, avatarGazes, avatarShapeNames, avatarShapes, avatarWith, distinctAvatar, type AvatarShape } from './avatar.js';
import { avatarPalette } from './tokens.js';

describe('avatarFor', () => {
  it('gives the same recipe for the same id, pinned by golden ids so a refactor cannot re-roll everyone', () => {
    expect(avatarFor('A1')).toEqual(avatarFor('A1'));
    expect(['A1', 'main', 'view-1', 'bot:review', '团团'].map(id => avatarFor(id))).toEqual(GOLDEN);
  });

  it('spreads shapes, colours and gazes evenly over 10,000 ids, with outline and phase in range', () => {
    const recipes = Array.from({ length: 10_000 }, (_, index) => avatarFor(`view-${index}`));
    const share = <T,>(values: readonly T[], pick: (recipe: (typeof recipes)[number]) => T) => values.map(value => {
      const count = recipes.filter(recipe => pick(recipe) === value).length;
      return [value, count / (recipes.length / values.length)] as const;
    });
    const uneven = [...share(avatarShapeNames, recipe => recipe.shape), ...share(avatarPalette.map(entry => entry.value), recipe => recipe.color),
      ...share(avatarGazes, recipe => recipe.gaze)].filter(([, ratio]) => ratio < 0.8 || ratio > 1.2);
    expect(uneven).toEqual([]);
    expect(recipes.every(recipe => recipe.outlineSeconds >= 5 && recipe.outlineSeconds <= 7)).toBe(true);
    expect(recipes.every(recipe => recipe.phase >= 0 && recipe.phase < 1)).toBe(true);
    expect(new Set(recipes.map(recipe => recipe.phase)).size, 'phases differ').toBeGreaterThan(900);
  });
});

describe('avatarWith', () => {
  it('takes the stored shape, colour and gaze', () => {
    expect(avatarWith('A1', { shape: 'sideways', color: '#123456', gaze: 4 })).toMatchObject({ shape: 'sideways', color: '#123456', gaze: 4 });
  });

  it('fills an absent gaze, the outline and the phase from the id', () => {
    const generated = avatarFor('A1');
    expect(avatarWith('A1', { shape: 'circle', color: '#123456' })).toEqual({ ...generated, shape: 'circle', color: '#123456' });
    expect(avatarWith('A1', undefined)).toEqual(generated);
  });

  it('keeps the id\'s own field for anything stored that is not a valid shape, colour or gaze', () => {
    const generated = avatarFor('A1');
    const stored = { shape: 'hexagon', color: 'red;background:url(x)', gaze: 9 } as unknown as Parameters<typeof avatarWith>[1];
    expect(avatarWith('A1', stored)).toEqual(generated);
    expect(avatarWith('A1', { shape: 'circle', color: '#0071E3' }).color).toBe('#0071e3');
  });
});

describe('distinctAvatar', () => {
  const allPairs = avatarShapeNames.flatMap(shape => avatarPalette.map(entry => ({ shape, color: entry.value })));

  it('keeps the id\'s own pair when it is free, and its gaze and timing in any case', () => {
    const own = avatarFor('A1');
    expect(distinctAvatar('A1', [])).toEqual(own);
    const moved = distinctAvatar('A1', [{ shape: own.shape, color: own.color.toUpperCase() }]);
    expect([moved.shape, moved.color]).not.toEqual([own.shape, own.color]);
    expect(moved).toMatchObject({ gaze: own.gaze, outlineSeconds: own.outlineSeconds, phase: own.phase });
  });

  it('returns the one free pair when 31 are taken, and the id\'s own when all 32 are', () => {
    for (const free of [allPairs[0]!, allPairs[17]!, allPairs[31]!]) {
      const result = distinctAvatar('A1', allPairs.filter(pair => pair !== free));
      expect({ shape: result.shape, color: result.color }).toEqual(free);
    }
    expect(distinctAvatar('A1', allPairs)).toEqual(avatarFor('A1'));
  });
});

type Point = readonly [number, number];
/** The outline as a polygon: each cubic segment of an absolute M/C/Z path sampled at 24 points. */
function flatten(path: string): Point[] {
  const tokens = path.match(/[MCZ]|-?\d+(?:\.\d+)?/g)!;
  const points: Point[] = [];
  let index = 0, current: Point = [0, 0];
  const number = () => Number(tokens[index++]);
  while (index < tokens.length) {
    const command = tokens[index++];
    if (command === 'M') { current = [number(), number()]; points.push(current); }
    else if (command === 'C') {
      const [a, b, c]: Point[] = [[number(), number()], [number(), number()], [number(), number()]];
      for (let step = 1; step <= 24; step++) {
        const t = step / 24, u = 1 - t;
        points.push([u ** 3 * current[0] + 3 * u * u * t * a![0] + 3 * u * t * t * b![0] + t ** 3 * c![0],
          u ** 3 * current[1] + 3 * u * u * t * a![1] + 3 * u * t * t * b![1] + t ** 3 * c![1]]);
      }
      current = c!;
    } else if (command !== 'Z') throw new Error(`unexpected ${command} in ${path}`);
  }
  return points;
}
function inside([x, y]: Point, polygon: readonly Point[]): boolean {
  let result = false;
  for (let i = 0, j = polygon.length - 1; i < polygon.length; j = i++) {
    const [xi, yi] = polygon[i]!, [xj, yj] = polygon[j]!;
    if ((yi > y) !== (yj > y) && x < (xj - xi) * (y - yi) / (yj - yi) + xi) result = !result;
  }
  return result;
}
function centroid(polygon: readonly Point[]): Point {
  let area = 0, cx = 0, cy = 0;
  for (let i = 0, j = polygon.length - 1; i < polygon.length; j = i++) {
    const [xi, yi] = polygon[i]!, [xj, yj] = polygon[j]!, cross = xj * yi - xi * yj;
    area += cross; cx += (xj + xi) * cross; cy += (yj + yi) * cross;
  }
  return [cx / (3 * area), cy / (3 * area)];
}

describe.each(avatarShapeNames)('the %s shape', (shape: AvatarShape) => {
  const outline = flatten(avatarShapes[shape].base);
  const centre = centroid(outline);

  it.each(avatarGazes)('looks somewhere with gaze %i: the eyes sit off-centre, wholly inside the shape', gaze => {
    const [left, right] = avatarEyes(shape, gaze);
    const midpoint: Point = [(left[0] + right[0]) / 2, (left[1] + right[1]) / 2];
    expect(Math.hypot(midpoint[0] - centre[0], midpoint[1] - centre[1])).toBeGreaterThanOrEqual(3);
    for (const [x, y] of [left, right]) {
      for (const edge of [[x - avatarEye.rx, y], [x + avatarEye.rx, y], [x, y - avatarEye.ry], [x, y + avatarEye.ry]] as const) {
        expect(inside(edge, outline), `${shape} gaze ${gaze}: eye edge ${edge}`).toBe(true);
      }
    }
  });

  it('flows through three outlines that start at the resting one and keep its commands', () => {
    const { base, keyframes } = avatarShapes[shape];
    expect(keyframes[0]).toBe(base);
    const commands = (path: string) => path.replace(/[^MCZ]/g, '');
    for (const frame of keyframes) expect(commands(frame)).toBe(commands(base));
  });
});

/** Recorded once from the FNV-1a recipe; a change here re-rolls every assistant without a stored picture. */
const GOLDEN = [
  { shape: 'sideways', color: '#ff8a3d', gaze: 5, outlineSeconds: 5.6, phase: 0.715 },
  { shape: 'sideways', color: '#3d8bff', gaze: 3, outlineSeconds: 6.6, phase: 0.318 },
  { shape: 'circle', color: '#3d8bff', gaze: 5, outlineSeconds: 5.9, phase: 0.019 },
  { shape: 'circle', color: '#ff6fa8', gaze: 3, outlineSeconds: 6.6, phase: 0.369 },
  { shape: 'squircle', color: '#ff6fa8', gaze: 3, outlineSeconds: 7, phase: 0.106 },
];
