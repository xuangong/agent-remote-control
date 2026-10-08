import { act, useRef } from 'react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { render, unmount } from '../test/setup.js';
import { conversationLocalStorage } from '../conversation-storage.js';
import { useAskPosition } from './useAskPosition.js';

const observers = new Set<() => void>();
const bounds = new Map<string, { width: number; height: number }>();
const rect = (x: number, y: number, width: number, height: number) => ({ x, y, left: x, top: y, right: x + width, bottom: y + height, width, height, toJSON: () => ({}) });

beforeEach(() => {
  conversationLocalStorage.clear();
  localStorage.clear();
  bounds.clear();
  vi.stubGlobal('ResizeObserver', class {
    constructor(callback: () => void) { this.callback = callback; observers.add(callback); }
    callback: () => void;
    observe() {}
    disconnect() { observers.delete(this.callback); }
  });
  vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockImplementation(function (this: HTMLElement) {
    const owner = this.closest<HTMLElement>('[data-owner]')!;
    const size = bounds.get(owner.dataset.owner!)!;
    if (this.classList.contains('lab-ask-viewport')) return rect(200, 80, size.width, size.height);
    if (this.tagName === 'SECTION') return rect(
      200 + parseFloat(this.style.getPropertyValue('--ask-left') || '0'),
      80 + parseFloat(this.style.getPropertyValue('--ask-top') || '0'),
      parseFloat(this.style.getPropertyValue('--ask-width') || '440'),
      parseFloat(this.style.getPropertyValue('--ask-height') || '560'),
    );
    return rect(200 + size.width - 60, 180, 60, 44);
  });
});
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); conversationLocalStorage.clear(); localStorage.clear(); });

function Harness({ scope }: { scope: string }) {
  const panel = useRef<HTMLElement>(null);
  const trigger = useRef<HTMLButtonElement>(null);
  useAskPosition(panel, trigger, scope);
  return <div data-owner={scope}><button ref={trigger}>Ask</button><div className="lab-ask-viewport"><section ref={panel}>
    <button className="lab-ask-resize">Resize</button>
  </section></div></div>;
}

const geometry = (element: Element) => {
  const style = (element as HTMLElement).style;
  return Object.fromEntries(['left', 'top', 'width', 'height'].map(key => [key, parseFloat(style.getPropertyValue(`--ask-${key}`))]));
};
async function key(element: Element, name: string, shiftKey = false) {
  await act(async () => { element.dispatchEvent(new KeyboardEvent('keydown', { key: name, shiftKey, bubbles: true, cancelable: true })); });
}

it('uses the owning view dimensions independently for floating and covered Ask views', async () => {
  bounds.set('main', { width: 1000, height: 800 });
  bounds.set('side', { width: 420, height: 800 });
  const container = await render(<><Harness scope="main" /><Harness scope="side" /></>);
  const main = container.querySelector('[data-owner="main"] .lab-ask-viewport')!;
  const side = container.querySelector('[data-owner="side"] .lab-ask-viewport')!;
  expect(main.getAttribute('data-presentation')).toBe('floating');
  expect(side.getAttribute('data-presentation')).toBe('overlay');
  bounds.set('main', { width: 1000, height: 400 });
  bounds.set('side', { width: 650, height: 800 });
  await act(async () => { for (const update of observers) update(); });
  expect(main.getAttribute('data-presentation')).toBe('overlay');
  expect(side.getAttribute('data-presentation')).toBe('floating');
});

it('preserves per-source geometry without sharing it with another Ask', async () => {
  bounds.set('main', { width: 1000, height: 800 });
  bounds.set('side', { width: 1000, height: 800 });
  const first = await render(<Harness scope="main" />);
  await key(first.querySelector('.lab-ask-resize')!, 'ArrowLeft');
  await key(first.querySelector('.lab-ask-resize')!, 'ArrowDown', true);
  const saved = geometry(first.querySelector('section')!);
  expect(saved).toMatchObject({ width: 430, height: 600 });
  await unmount(first);
  const restored = await render(<><Harness scope="main" /><Harness scope="side" /></>);
  expect(geometry(restored.querySelector('[data-owner="main"] section')!)).toEqual(saved);
  expect(geometry(restored.querySelector('[data-owner="side"] section')!)).toMatchObject({ width: 440, height: 560 });
});

it('keeps source-specific geometry in memory when clear-on-close protection is enabled', async () => {
  localStorage.setItem('agent-remote:clear-cache-on-close', 'true');
  bounds.set('private-main', { width: 1000, height: 800 });
  const first = await render(<Harness scope="private-main" />);
  await key(first.querySelector('.lab-ask-resize')!, 'ArrowLeft');
  await key(first.querySelector('.lab-ask-resize')!, 'ArrowDown', true);
  const saved = geometry(first.querySelector('section')!);
  expect(Object.keys(localStorage).some(key => key.includes('private-main'))).toBe(false);
  await unmount(first);
  const restored = await render(<Harness scope="private-main" />);
  expect(geometry(restored.querySelector('section')!)).toEqual(saved);
  expect(Object.keys(localStorage).some(key => key.includes('private-main'))).toBe(false);
});

it('clamps resized windows to the source view and restores preferred height after a short layout', async () => {
  bounds.set('main', { width: 1000, height: 800 });
  const container = await render(<Harness scope="main" />);
  const panel = container.querySelector('section')!;
  const handle = container.querySelector('.lab-ask-resize')!;
  await key(handle, 'ArrowLeft');
  await key(handle, 'ArrowDown', true);
  const saved = geometry(panel);
  bounds.set('main', { width: 650, height: 480 });
  await act(async () => { for (const update of observers) update(); });
  const compact = geometry(panel);
  expect(compact.left! + compact.width!).toBeLessThanOrEqual(638);
  expect(compact.top! + compact.height!).toBeLessThanOrEqual(468);
  await key(handle, 'ArrowLeft');
  bounds.set('main', { width: 1000, height: 800 });
  await act(async () => { for (const update of observers) update(); });
  expect(geometry(panel)).toMatchObject({ width: saved.width! - 10, height: saved.height });
  bounds.set('main', { width: 390, height: 800 });
  await act(async () => { for (const update of observers) update(); });
  const before = geometry(panel);
  await key(handle, 'ArrowRight');
  expect(geometry(panel)).toEqual(before);
});
