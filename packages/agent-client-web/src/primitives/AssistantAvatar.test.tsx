// @vitest-environment jsdom
import { act } from 'react';
import { expect, it } from 'vitest';
import { render, rerender } from '../test/setup.js';
import { stubMotionPort } from '../test/motion-port.js';
import { avatarFor } from '../theme/avatar.js';
import type { AvatarMood } from '../theme/avatar.js';
import { AssistantAvatar } from './AssistantAvatar.js';
import { MotionProvider } from './MotionProvider.js';

const avatar = (container: HTMLElement) => container.querySelector<HTMLElement>('.orchard-avatar')!;

it('flows its outline from the recipe\'s phase while motion is allowed', async () => {
  const { port } = stubMotionPort();
  const container = await render(<MotionProvider port={port}><AssistantAvatar id="A1" size={40} /></MotionProvider>);
  const animations = container.querySelectorAll('animate');
  expect(animations).toHaveLength(1);
  const recipe = avatarFor('A1');
  expect(animations[0]!.getAttribute('attributeName')).toBe('d');
  expect(animations[0]!.getAttribute('dur')).toBe(`${recipe.outlineSeconds}s`);
  expect(Number.parseFloat(animations[0]!.getAttribute('begin')!)).toBeCloseTo(-recipe.phase * recipe.outlineSeconds, 2);
  expect(avatar(container).dataset.shape).toBe(recipe.shape);
});

it.each([
  ['reduced motion', { reducedMotion: true }, 40], ['a hidden page', { pageVisible: false }, 40], ['23 px', {}, 23],
] as const)('renders no animate element under %s', async (_case, facts, size) => {
  const { port } = stubMotionPort(facts);
  const container = await render(<MotionProvider port={port}><AssistantAvatar id="A1" size={size} /></MotionProvider>);
  expect(container.querySelectorAll('animate')).toHaveLength(0);
});

it('stops when the page is hidden and flows again when it is visible', async () => {
  const motion = stubMotionPort();
  const container = await render(<MotionProvider port={motion.port}><AssistantAvatar id="A1" size={40} mood="working" /></MotionProvider>);
  expect(avatar(container).hasAttribute('data-bob')).toBe(true);
  await act(async () => motion.set({ pageVisible: false }));
  expect(container.querySelectorAll('animate')).toHaveLength(0);
  expect(avatar(container).hasAttribute('data-bob')).toBe(false);
  await act(async () => motion.set({ pageVisible: true }));
  expect(container.querySelectorAll('animate')).toHaveLength(1);
});

it('stays still without a provider', async () => {
  const container = await render(<AssistantAvatar id="A1" size={84} mood="working" />);
  expect(container.querySelectorAll('animate')).toHaveLength(0);
  expect(avatar(container).hasAttribute('data-bob')).toBe(false);
});

it('turns grey and still when resting', async () => {
  const { port } = stubMotionPort();
  const container = await render(<MotionProvider port={port}><AssistantAvatar id="A1" size={40} mood="resting" /></MotionProvider>);
  expect(avatar(container).dataset.mood).toBe('resting');
  expect(container.querySelector<SVGPathElement>('.orchard-avatar-body')!.style.fill).toBe('var(--orchard-avatar-resting)');
  expect(container.querySelectorAll('animate')).toHaveLength(0);
});

it('pops once when it comes to need you, not again on a render with the same mood', async () => {
  const { port } = stubMotionPort();
  const view = (mood: AvatarMood) => <MotionProvider port={port}><AssistantAvatar id="A1" size={40} mood={mood} /></MotionProvider>;
  const container = await render(view('idle'));
  expect(avatar(container).hasAttribute('data-pop')).toBe(false);
  await rerender(container, view('needs_you'));
  expect(avatar(container).dataset.pop).toBe('1');
  await rerender(container, view('needs_you'));
  expect(avatar(container).dataset.pop).toBe('1');
  await rerender(container, view('idle'));
  await rerender(container, view('needs_you'));
  expect(avatar(container).dataset.pop).toBe('2');
});

it('draws a stored picture: its shape and colour win', async () => {
  const container = await render(<AssistantAvatar id="A1" size={40} picture={{ shape: 'triangle', color: '#123456', gaze: 2 }} />);
  expect(avatar(container).dataset.shape).toBe('triangle');
  expect(container.querySelector<SVGPathElement>('.orchard-avatar-body')!.style.fill).toBe('#123456');
});

it('is hidden from assistive technology unless a label names it', async () => {
  const hidden = await render(<AssistantAvatar id="A1" size={40} />);
  expect(avatar(hidden).getAttribute('aria-hidden')).toBe('true');
  expect(avatar(hidden).hasAttribute('role')).toBe(false);
  const named = await render(<AssistantAvatar id="A1" size={40} label="Chief" />);
  expect(avatar(named).getAttribute('role')).toBe('img');
  expect(avatar(named).getAttribute('aria-label')).toBe('Chief');
  expect(avatar(named).hasAttribute('aria-hidden')).toBe(false);
});
