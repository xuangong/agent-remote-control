import { expect, it } from 'vitest';
import type { AvatarMood } from './avatar.js';
import { avatarMotion, markMotion } from './motion.js';

const moods: readonly AvatarMood[] = ['idle', 'working', 'needs_you', 'resting'];
/** Section 4.4's rule written out as a table row: what each fact combination must give. */
function expected(reducedMotion: boolean, pageVisible: boolean, size: number, mood: AvatarMood) {
  const allowed = !reducedMotion && pageVisible && size >= 24;
  return { outline: allowed && mood !== 'resting', bob: allowed && mood === 'working', pop: allowed && mood === 'needs_you', grey: mood === 'resting' };
}
const rows = [true, false].flatMap(reducedMotion => [true, false].flatMap(pageVisible => [16, 23, 24, 84].flatMap(size => moods.map(mood =>
  [reducedMotion, pageVisible, size, mood] as const))));

it.each(rows)('avatar: reduced %s, visible %s, %i px, %s', (reducedMotion, pageVisible, size, mood) => {
  expect(avatarMotion({ reducedMotion, pageVisible, size, mood })).toEqual(expected(reducedMotion, pageVisible, size, mood));
});

it('spot-checks the table: a working 24 px avatar bobs, a 23 px one and a hidden page do not, and resting is grey and still', () => {
  expect(avatarMotion({ reducedMotion: false, pageVisible: true, size: 24, mood: 'working' })).toEqual({ outline: true, bob: true, pop: false, grey: false });
  expect(avatarMotion({ reducedMotion: false, pageVisible: true, size: 23, mood: 'working' })).toEqual({ outline: false, bob: false, pop: false, grey: false });
  expect(avatarMotion({ reducedMotion: false, pageVisible: false, size: 84, mood: 'needs_you' })).toEqual({ outline: false, bob: false, pop: false, grey: false });
  expect(avatarMotion({ reducedMotion: true, pageVisible: true, size: 84, mood: 'resting' })).toEqual({ outline: false, bob: false, pop: false, grey: true });
  expect(avatarMotion({ reducedMotion: false, pageVisible: true, size: 84, mood: 'resting' })).toEqual({ outline: false, bob: false, pop: false, grey: true });
});

it.each([
  [32, false, true, false], [33, false, true, true], [64, true, true, false], [64, false, false, false], [64, false, true, true],
] as const)('mark at %i px (reduced %s, visible %s) moves: %s', (size, reducedMotion, pageVisible, moving) => {
  expect(markMotion({ reducedMotion, pageVisible, size })).toEqual({ glance: moving, sway: moving });
});
