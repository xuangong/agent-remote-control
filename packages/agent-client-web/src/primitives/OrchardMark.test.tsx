// @vitest-environment jsdom
import { expect, it } from 'vitest';
import { render } from '../test/setup.js';
import { stubMotionPort } from '../test/motion-port.js';
import { markSvg } from '../theme/mark.js';
import { MotionProvider } from './MotionProvider.js';
import { OrchardMark } from './OrchardMark.js';
import { Wordmark } from './Wordmark.js';

it('keeps the mark static at 32 px and lets it glance and sway at 64 px', async () => {
  const { port } = stubMotionPort();
  const small = await render(<MotionProvider port={port}><OrchardMark size={32} /></MotionProvider>);
  expect(small.querySelectorAll('.orchard-mark-glance, .orchard-mark-sway')).toHaveLength(0);
  const large = await render(<MotionProvider port={port}><OrchardMark size={64} /></MotionProvider>);
  expect(large.querySelectorAll('.orchard-mark-glance')).toHaveLength(1);
  expect(large.querySelectorAll('.orchard-mark-sway')).toHaveLength(1);
});

it('keeps a large mark static under reduced motion', async () => {
  const { port } = stubMotionPort({ reducedMotion: true });
  const container = await render(<MotionProvider port={port}><OrchardMark size={150} /></MotionProvider>);
  expect(container.querySelectorAll('.orchard-mark-glance, .orchard-mark-sway')).toHaveLength(0);
});

it('names the mark when given a title, and hides it otherwise', async () => {
  const named = await render(<OrchardMark size={32} title="Orchard" />);
  expect(named.querySelector('svg')!.getAttribute('aria-label')).toBe('Orchard');
  const plain = await render(<OrchardMark size={32} />);
  expect(plain.querySelector('svg')!.getAttribute('aria-hidden')).toBe('true');
});

it('writes the static mark as a standalone SVG with brand literals', () => {
  const svg = markSvg();
  expect(svg).not.toContain('var(');
  const document = new DOMParser().parseFromString(svg, 'image/svg+xml');
  expect(document.querySelector('parsererror')).toBeNull();
  expect(document.documentElement.getAttribute('viewBox')).toBe('0 0 64 64');
  expect(document.querySelectorAll('ellipse')).toHaveLength(2);
  expect(svg).toContain('#ff7f45');
});

it('writes the wordmark in lowercase beside the mark', async () => {
  const container = await render(<Wordmark />);
  expect(container.querySelector('.orchard-wordmark-text')!.textContent).toBe('orchard');
  expect(container.querySelector('.orchard-wordmark .orchard-mark')).not.toBeNull();
});
