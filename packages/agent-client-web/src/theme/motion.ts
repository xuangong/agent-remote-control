/**
 * When avatars and the mark move. Motion stops under reduced motion, on a hidden page and below a size threshold;
 * a resting avatar is grey whatever the motion. Pure: the facts come from the MotionProvider's port.
 */
import type { AvatarMood } from './avatar.js';

export interface MotionFacts { reducedMotion: boolean; pageVisible: boolean; size: number; mood: AvatarMood }
export interface AvatarMotion { outline: boolean; bob: boolean; pop: boolean; grey: boolean }

/** Avatars smaller than this many pixels never move. */
export const AVATAR_MOTION_MIN_SIZE = 24;
/** The mark is static at this many pixels and below. */
export const MARK_STATIC_MAX_SIZE = 32;

/** The device's motion choice: follow the system (absent or unknown), or always reduce. */
export type MotionChoice = 'system' | 'reduce';
/** The localStorage key of the choice, per device; a display choice, so clearing conversations keeps it. */
export const MOTION_STORAGE_KEY = 'agent-remote:motion';

export function readMotionChoice(stored: string | null | undefined): MotionChoice {
  return stored === 'reduce' ? 'reduce' : 'system';
}

/** Motion is reduced when the system asks for it or the device's choice does; the choice cannot add motion the system refused. */
export function reducesMotion(choice: MotionChoice, system: boolean): boolean {
  return system || choice === 'reduce';
}

export function avatarMotion({ reducedMotion, pageVisible, size, mood }: MotionFacts): AvatarMotion {
  const moving = !reducedMotion && pageVisible && size >= AVATAR_MOTION_MIN_SIZE && mood !== 'resting';
  return { outline: moving, bob: moving && mood === 'working', pop: moving && mood === 'needs_you', grey: mood === 'resting' };
}

export function markMotion({ reducedMotion, pageVisible, size }: Omit<MotionFacts, 'mood'>): { glance: boolean; sway: boolean } {
  const moving = !reducedMotion && pageVisible && size > MARK_STATIC_MAX_SIZE;
  return { glance: moving, sway: moving };
}
