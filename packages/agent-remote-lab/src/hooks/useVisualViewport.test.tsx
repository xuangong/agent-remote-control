import { act } from 'react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { render } from '../test/setup';
import { useVisualViewport } from './useVisualViewport';

let viewport: EventTarget & { height: number; offsetTop: number; scale: number };
const descriptors: Array<[object, string, PropertyDescriptor | undefined]> = [];
function property(target: object, key: string, value: unknown) {
  descriptors.push([target, key, Object.getOwnPropertyDescriptor(target, key)]);
  Object.defineProperty(target, key, { configurable: true, value });
}
function Harness() {
  const ref = useVisualViewport();
  return <main ref={ref}><textarea defaultValue="Keep this draft" /></main>;
}
async function advance(ms: number) {
  await act(async () => { vi.advanceTimersByTime(ms); });
}
async function mount() {
  const container = await render(<Harness />);
  await advance(1000);
  return container.querySelector('main')!;
}
function height(shell: HTMLElement) { return shell.style.getPropertyValue('--lab-viewport-height'); }

beforeEach(() => {
  vi.useFakeTimers();
  viewport = Object.assign(new EventTarget(), { height: 844, offsetTop: 0, scale: 1 });
  property(window, 'visualViewport', viewport);
  property(window, 'innerHeight', 844);
  property(window, 'innerWidth', 390);
  property(document.documentElement, 'clientHeight', 844);
  property(document, 'hidden', false);
  property(window, 'matchMedia', () => ({ matches: true }));
});
afterEach(() => {
  while (descriptors.length) {
    const [target, key, descriptor] = descriptors.pop()!;
    if (descriptor) Object.defineProperty(target, key, descriptor);
    else Reflect.deleteProperty(target, key);
  }
  vi.useRealTimers();
});

it('catches delayed keyboard bounds after returning to the foreground with an existing draft', async () => {
  const shell = await mount();
  shell.querySelector('textarea')!.focus();
  property(document, 'hidden', true);
  document.dispatchEvent(new Event('visibilitychange'));
  await advance(2000);
  property(document, 'hidden', false);
  document.dispatchEvent(new Event('visibilitychange'));
  await advance(1100);
  // WebKit may update the bounds after the foreground event without another resize.
  viewport.height = 400;
  await advance(1600);
  expect(height(shell)).toBe('400px');
  expect(shell.dataset.viewportOccluded).toBe('true');
  expect(shell.querySelector('textarea')!.value).toBe('Keep this draft');
});

it('remeasures when the window regains focus without a viewport resize', async () => {
  const shell = await mount();
  await advance(3000);
  viewport.height = 400;
  window.dispatchEvent(new Event('focus'));
  await advance(32);
  expect(height(shell)).toBe('400px');
});

it('fits a resized window while visual viewport bounds are stale and restores after dismissal', async () => {
  const shell = await mount();
  shell.querySelector('textarea')!.focus();
  property(window, 'innerHeight', 400);
  window.dispatchEvent(new Event('resize'));
  await advance(32);
  expect(height(shell)).toBe('400px');
  expect(shell.dataset.viewportOccluded).toBe('true');
  property(window, 'innerHeight', 844);
  window.dispatchEvent(new Event('resize'));
  await advance(32);
  expect(height(shell)).toBe('844px');
  expect(shell.dataset.viewportOccluded).toBe('false');
});

it('preserves pinch zoom and does not treat hardware keyboard focus as occlusion', async () => {
  const shell = await mount();
  shell.querySelector('textarea')!.focus();
  await advance(32);
  expect(shell.dataset.viewportOccluded).toBe('false');
  viewport.height = 400;
  viewport.scale = 2;
  viewport.dispatchEvent(new Event('resize'));
  await advance(32);
  expect(height(shell)).toBe('844px');
});

it('stops sampling after settling and while hidden', async () => {
  const shell = await mount();
  await advance(3000);
  viewport.height = 400;
  await advance(10000);
  expect(height(shell)).toBe('844px');
  property(document, 'hidden', true);
  document.dispatchEvent(new Event('visibilitychange'));
  viewport.dispatchEvent(new Event('resize'));
  await advance(10000);
  expect(height(shell)).toBe('844px');
});
