import { expect, it } from 'vitest';
import { render } from '../test/setup.js';
import { Avatar, AVATAR_COLORS, avatarColor, avatarInitial } from './Avatar.js';

it('draws the stored shape and color with the first letter of the name', async () => {
  const container = await render(<Avatar name="release notes" picture={{ shape: 'hexagon', color: '#123456' }} size={30} />);
  const avatar = container.querySelector('.ui-avatar') as HTMLElement;
  expect(avatar.getAttribute('aria-hidden')).toBe('true');
  expect(avatar.dataset.shape).toBe('hexagon');
  expect(avatar.textContent).toBe('R');
  expect(avatar.getAttribute('style')).toContain('#123456');
  expect(avatar.getAttribute('style')).toContain('30px');
});

it('picks a stable palette color for a bot without a picture, and ignores invalid colors', async () => {
  expect(avatarColor('API caching')).toBe(avatarColor('API caching'));
  expect(AVATAR_COLORS).toContain(avatarColor('API caching'));
  const container = await render(<Avatar name="API caching" picture={{ shape: 'circle', color: 'red;background:url(x)' }} />);
  expect(container.querySelector('.ui-avatar')?.getAttribute('style')).toContain(avatarColor('API caching'));
});

it('draws no letter for a nameless picture', async () => {
  const container = await render(<Avatar name="" />);
  expect(container.querySelector('.ui-avatar')?.textContent).toBe('');
});

it('chooses a readable letter ink for any stored color', async () => {
  const yellow = await render(<Avatar name="Notes" picture={{ shape: 'circle', color: '#ffeb3b' }} />);
  expect(yellow.querySelector('.ui-avatar')?.getAttribute('data-ink')).toBe('dark');
  const blue = await render(<Avatar name="Notes" picture={{ shape: 'circle', color: '#0071e3' }} />);
  expect(blue.querySelector('.ui-avatar')?.getAttribute('data-ink')).toBe('light');
});

it('accepts uppercase hex and normalizes it to lowercase', async () => {
  const container = await render(<Avatar name="Notes" picture={{ shape: 'circle', color: '#0071E3' }} />);
  expect(container.querySelector('.ui-avatar')?.getAttribute('style')).toContain('#0071e3');
});

it('takes the first letter or number after leading punctuation and whitespace', () => {
  expect(avatarInitial('[draft] notes')).toBe('D');
  expect(avatarInitial('  中文')).toBe('中');
  expect(avatarInitial('2024 plan')).toBe('2');
  expect(avatarInitial('')).toBe('');
  expect(avatarInitial('...')).toBe('');
});

it('keeps the original letter when uppercasing would produce two characters', () => {
  expect(avatarInitial('ß')).toBe('ß');
});
