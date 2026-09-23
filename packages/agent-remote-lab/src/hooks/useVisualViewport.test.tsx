import { act } from 'react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { render } from '../test/setup';
import { useVisualViewport } from './useVisualViewport';

let viewport: EventTarget & { width: number; height: number; offsetTop: number; scale: number };
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
  viewport = Object.assign(new EventTarget(), { width: 390, height: 844, offsetTop: 0, scale: 1 });
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
  expect(height(shell)).toBe('');
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
  expect(height(shell)).toBe('');
});

it('stops sampling after settling and while hidden', async () => {
  const shell = await mount();
  await advance(3000);
  viewport.height = 400;
  await advance(10000);
  expect(height(shell)).toBe('');
  property(document, 'hidden', true);
  document.dispatchEvent(new Event('visibilitychange'));
  viewport.dispatchEvent(new Event('resize'));
  await advance(10000);
  expect(height(shell)).toBe('');
});

for (const first of ['window', 'visualViewport'] as const) {
  it(`does not apply stale landscape height or keyboard occlusion when ${first} rotates first`, async () => {
    property(window, 'innerWidth', 844);
    property(window, 'innerHeight', 390);
    property(document.documentElement, 'clientHeight', 390);
    Object.assign(viewport, { width: 844, height: 390 });
    const shell = await mount();
    const rotateWindow = () => {
      property(window, 'innerWidth', 390);
      property(window, 'innerHeight', 844);
      property(document.documentElement, 'clientHeight', 844);
      window.dispatchEvent(new Event('resize'));
    };
    const rotateVisualViewport = () => {
      Object.assign(viewport, { width: 390, height: 844 });
      viewport.dispatchEvent(new Event('resize'));
    };
    (first === 'window' ? rotateWindow : rotateVisualViewport)();
    window.dispatchEvent(new Event('orientationchange'));
    await advance(32);
    expect(height(shell)).toBe('');
    expect(shell.dataset.viewportOccluded).toBe('false');
    (first === 'window' ? rotateVisualViewport : rotateWindow)();
    await advance(32);
    expect(height(shell)).toBe('');
    expect(shell.dataset.viewportOccluded).toBe('false');
  });
}

for (const first of ['window', 'visualViewport'] as const) {
  it(`retains keyboard safe-area suppression while ${first} rotates first`, async () => {
    property(window, 'innerWidth', 844);
    property(window, 'innerHeight', 390);
    property(document.documentElement, 'clientHeight', 390);
    Object.assign(viewport, { width: 844, height: 390 });
    const shell = await mount();
    shell.querySelector('textarea')!.focus();
    viewport.height = 200;
    viewport.dispatchEvent(new Event('resize'));
    await advance(32);
    expect(shell.dataset.viewportOccluded).toBe('true');
    const rotateWindow = () => {
      property(window, 'innerWidth', 390);
      property(window, 'innerHeight', 844);
      property(document.documentElement, 'clientHeight', 844);
      window.dispatchEvent(new Event('resize'));
    };
    const rotateViewport = () => {
      Object.assign(viewport, { width: 390, height: 500 });
      viewport.dispatchEvent(new Event('resize'));
    };
    (first === 'window' ? rotateWindow : rotateViewport)();
    window.dispatchEvent(new Event('orientationchange'));
    await advance(32);
    expect(shell.dataset.viewportOccluded).toBe('true');
    expect(height(shell)).toBe('200px');
    (first === 'window' ? rotateViewport : rotateWindow)();
    await advance(32);
    expect(height(shell)).toBe('500px');
    expect(shell.dataset.viewportOccluded).toBe('true');
    viewport.height = 844;
    viewport.dispatchEvent(new Event('resize'));
    await advance(32);
    expect(shell.dataset.viewportOccluded).toBe('false');
  });
}
