/**
 * Assistant avatars: a flat soft shape in one palette colour with two dark oval eyes looking one of six ways. A recipe is
 * a pure function of the assistant's id (its bot view id), so every device draws the same avatar; a stored picture
 * overrides it field by field. Pure: no DOM, clock or random numbers.
 */
import type { BotPicture } from '@orchardworks/agent-remote-protocol';
import { avatarPalette, orchardMotion } from './tokens.js';

export type AvatarShape = 'circle' | 'squircle' | 'triangle' | 'sideways';
/** Up-left, up-right, left, right, down-left, down-right. */
export type AvatarGaze = 0 | 1 | 2 | 3 | 4 | 5;
/** `outlineSeconds` is the outline's flow cycle and `phase` in [0, 1) where in it this assistant starts. */
export interface AvatarRecipe { shape: AvatarShape; color: string; gaze: AvatarGaze; outlineSeconds: number; phase: number }
export type AvatarMood = 'idle' | 'working' | 'needs_you' | 'resting';

export const avatarShapeNames: readonly AvatarShape[] = ['circle', 'squircle', 'triangle', 'sideways'];
export const avatarGazes: readonly AvatarGaze[] = [0, 1, 2, 3, 4, 5];
/** The eye's ellipse radii in the 64-unit viewBox. */
export const avatarEye = { rx: 3.6, ry: 6.2 } as const;
/** How far the eyes move from the shape's centre for each gaze, so an assistant always looks somewhere. */
export const gazeOffsets: Readonly<Record<AvatarGaze, readonly [number, number]>> = {
  0: [-3.5, -3], 1: [3.5, -3], 2: [-4.5, 0], 3: [4.5, 0], 4: [-3.5, 3], 5: [3.5, 3],
};

/**
 * 64 × 64 path data, absolute M, C and Z only: the resting outline, the three outlines its flow passes through (the
 * first is the resting one), and the eye centres before the gaze offset, about the shape's visual centre.
 */
export const avatarShapes: Readonly<Record<AvatarShape, { base: string; keyframes: readonly [string, string, string]; eyes: readonly [readonly [number, number], readonly [number, number]] }>> = {
  circle: {
    base: 'M32 7C46 7 57 18 57 32C57 46 46 57 32 57C18 57 7 46 7 32C7 18 18 7 32 7Z',
    keyframes: [
      'M32 7C46 7 57 18 57 32C57 46 46 57 32 57C18 57 7 46 7 32C7 18 18 7 32 7Z',
      'M33 6C48 8 58 19 56 33C55 47 45 58 31 57C17 56 7 45 8 31C9 17 19 5 33 6Z',
      'M31 8C45 6 58 17 58 31C58 45 47 56 33 58C19 59 6 47 6 33C6 19 17 9 31 8Z',
    ],
    eyes: [[26, 32], [38, 32]],
  },
  squircle: {
    base: 'M33 8C50 8 56 15 56 32C56 50 49 56 31 56C14 56 8 49 8 31C8 14 15 8 33 8Z',
    keyframes: [
      'M33 8C50 8 56 15 56 32C56 50 49 56 31 56C14 56 8 49 8 31C8 14 15 8 33 8Z',
      'M34 7C51 9 57 16 56 33C55 51 48 57 30 56C13 55 7 48 8 30C9 13 16 6 34 7Z',
      'M32 9C49 7 57 14 57 31C57 49 50 55 32 57C15 58 7 50 7 32C7 15 14 10 32 9Z',
    ],
    eyes: [[26, 32], [38, 32]],
  },
  triangle: {
    base: 'M45 30C52 43 52 55 32 55C12 55 12 43 19 30C26 17 38 17 45 30Z',
    keyframes: [
      'M45 30C52 43 52 55 32 55C12 55 12 43 19 30C26 17 38 17 45 30Z',
      'M46 31C54 44 50 56 31 56C13 55 10 44 18 31C25 16 39 18 46 31Z',
      'M44 29C51 42 53 54 33 55C11 56 13 42 20 29C27 18 37 16 44 29Z',
    ],
    eyes: [[27, 39], [37, 39]],
  },
  sideways: {
    base: 'M12 14C12 6 20 6 28 10C44 18 56 24 56 32C56 40 44 46 28 54C20 58 12 58 12 50C12 38 12 26 12 14Z',
    keyframes: [
      'M12 14C12 6 20 6 28 10C44 18 56 24 56 32C56 40 44 46 28 54C20 58 12 58 12 50C12 38 12 26 12 14Z',
      'M11 15C11 5 21 7 29 11C45 19 57 25 56 33C55 41 43 46 27 53C19 57 11 57 11 49C11 37 11 27 11 15Z',
      'M13 13C13 7 19 5 27 9C43 17 55 23 57 31C57 39 45 45 29 55C21 59 13 59 13 51C13 39 13 25 13 13Z',
    ],
    eyes: [[25, 32], [35, 32]],
  },
};

/** FNV-1a, 32 bits, over the id's UTF-16 code units. */
function fnv1a(text: string): number {
  let hash = 0x811c9dc5;
  for (let index = 0; index < text.length; index++) {
    hash ^= text.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash;
}
/** An independent 32-bit value from the hash for each field (`lane`), through the murmur3 finalizer. */
function lane(hash: number, index: number): number {
  let value = (hash + Math.imul(index, 0x9e3779b9)) >>> 0;
  value = Math.imul(value ^ (value >>> 16), 0x85ebca6b) >>> 0;
  value = Math.imul(value ^ (value >>> 13), 0xc2b2ae35) >>> 0;
  return (value ^ (value >>> 16)) >>> 0;
}
const unit = (value: number) => value / 2 ** 32;

/** The avatar an id gets without a stored picture. */
export function avatarFor(id: string): AvatarRecipe {
  const hash = fnv1a(id);
  const { min, max } = orchardMotion.outline;
  return {
    shape: avatarShapeNames[lane(hash, 1) % avatarShapeNames.length]!,
    color: avatarPalette[lane(hash, 2) % avatarPalette.length]!.value,
    gaze: avatarGazes[lane(hash, 3) % avatarGazes.length]!,
    outlineSeconds: Math.round((min + unit(lane(hash, 4)) * (max - min)) / 100) / 10,
    phase: Math.floor(unit(lane(hash, 5)) * 1000) / 1000,
  };
}

/** The avatar with a stored picture: each stored field wins; an absent gaze, the outline and the phase come from the id. */
export function avatarWith(id: string, picture: BotPicture | undefined): AvatarRecipe {
  const generated = avatarFor(id);
  if (!picture) return generated;
  // A picture from storage or another build may not match the schema; each field that does not is the id's own.
  return {
    ...generated,
    ...(avatarShapeNames.includes(picture.shape) ? { shape: picture.shape } : {}),
    ...(/^#[0-9a-f]{6}$/i.test(picture.color) ? { color: picture.color.toLowerCase() } : {}),
    ...(avatarGazes.includes(picture.gaze as AvatarGaze) ? { gaze: picture.gaze as AvatarGaze } : {}),
  };
}

/** The first shape and colour pair, from the id's own, that no avatar in `taken` uses; the id's own when all 32 are taken. */
export function distinctAvatar(id: string, taken: readonly Pick<AvatarRecipe, 'shape' | 'color'>[]): AvatarRecipe {
  const generated = avatarFor(id);
  const used = new Set(taken.map(pair => `${pair.shape}/${pair.color.toLowerCase()}`));
  const colors = avatarPalette.map(entry => entry.value);
  const count = avatarShapeNames.length * colors.length;
  const start = avatarShapeNames.indexOf(generated.shape) * colors.length + colors.indexOf(generated.color);
  for (let step = 0; step < count; step++) {
    const index = (start + step) % count;
    const shape = avatarShapeNames[Math.floor(index / colors.length)]!, color = colors[index % colors.length]!;
    if (!used.has(`${shape}/${color}`)) return { ...generated, shape, color };
  }
  return generated;
}

/** The two eye centres of a recipe, in the 64-unit viewBox. */
export function avatarEyes(shape: AvatarShape, gaze: AvatarGaze): readonly [readonly [number, number], readonly [number, number]] {
  const [dx, dy] = gazeOffsets[gaze];
  const [left, right] = avatarShapes[shape].eyes;
  return [[left[0] + dx, left[1] + dy], [right[0] + dx, right[1] + dy]];
}
