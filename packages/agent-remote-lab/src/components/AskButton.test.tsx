import { act, useRef } from 'react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { render, unmount } from '../test/setup.js';
import { conversationLocalStorage } from '../conversation-storage.js';
import { AskButton } from './AskButton.js';

const rect = (x: number, y: number, width: number, height: number) => ({ x, y, left: x, top: y, right: x + width, bottom: y + height, width, height, toJSON: () => ({}) });
const sizes = new Map<string, { width: number; height: number }>();
const observers = new Set<() => void>();
beforeEach(() => {
  conversationLocalStorage.clear();
  sizes.clear();
  vi.stubGlobal('ResizeObserver', class {
    constructor(private callback: () => void) { observers.add(callback); }
    observe() {}
    disconnect() { observers.delete(this.callback); }
  });
  vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockImplementation(function (this: HTMLElement) {
    const owner = this.closest<HTMLElement>('[data-owner]');
    if (!owner) return rect(0, 0, 0, 0);
    const { width, height } = sizes.get(owner.dataset.owner!) ?? { width: 800, height: 600 };
    if (this === owner) return rect(200, 100, width, height);
    const dock = this.closest<HTMLElement>('.lab-ask-floating')!;
    const x = 200 + width - 72 + parseFloat(dock.style.getPropertyValue('--ask-dock-offset') || '0');
    const y = 100 + parseFloat(dock.style.getPropertyValue('--ask-dock-top') || String(Math.max(64, Math.min(height * .28, 160))));
    return rect(x, y, 72, 44);
  });
});
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); conversationLocalStorage.clear(); localStorage.clear(); });

function Harness({ scope = 'main', onOpen = () => {}, disabled = false }: { scope?: string; onOpen?(): void; disabled?: boolean }) {
  const trigger = useRef<HTMLButtonElement>(null);
  return <div data-owner={scope}><AskButton triggerRef={trigger} storageScope={scope} hidden={false} disabled={disabled} onOpen={onOpen} /></div>;
}
function capture(button: HTMLButtonElement) {
  let id: number | undefined;
  button.setPointerCapture = value => { id = value; };
  button.hasPointerCapture = value => id === value;
  button.releasePointerCapture = () => { id = undefined; };
}
async function pointer(button: HTMLButtonElement, type: string, x: number, y = 280, pointerType = 'mouse') {
  await act(async () => { button.dispatchEvent(Object.assign(new MouseEvent(type, { bubbles: true, cancelable: true, button: 0, clientX: x, clientY: y }),
    { pointerId: 1, pointerType, isPrimary: true })); });
}
async function click(button: HTMLButtonElement, detail = 1) {
  await act(async () => { button.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true, detail })); });
}
async function key(button: HTMLButtonElement, value: string, shiftKey = false) {
  await act(async () => { button.dispatchEvent(new KeyboardEvent('keydown', { bubbles: true, cancelable: true, key: value, shiftKey })); });
}

it('moves freely in its source view, docks at the released height, and opens only on the following deliberate click', async () => {
  const onOpen = vi.fn();
  const container = await render(<Harness onOpen={onOpen} />);
  const button = container.querySelector('button')!;
  capture(button);
  await pointer(button, 'pointerdown', 964);
  await pointer(button, 'pointermove', 350, 400);
  expect(button.getBoundingClientRect()).toMatchObject({ left: 314, top: 380 });
  await pointer(button, 'pointerup', 350, 400);
  await click(button);
  expect(onOpen).not.toHaveBeenCalled();
  expect(button.hasPointerCapture(1)).toBe(false);
  expect(button.getBoundingClientRect()).toMatchObject({ left: 200, top: 380 });
  await pointer(button, 'pointerdown', 232, 400);
  await pointer(button, 'pointerup', 232, 400);
  await click(button);
  expect(onOpen).toHaveBeenCalledOnce();
});

it('keeps touch taps clickable and cancels a dragged touch without opening Ask', async () => {
  const onOpen = vi.fn();
  const container = await render(<Harness onOpen={onOpen} />);
  const button = container.querySelector('button')!;
  capture(button);
  await pointer(button, 'pointerdown', 964, 280, 'touch');
  await pointer(button, 'pointermove', 966, 281, 'touch');
  await pointer(button, 'pointerup', 966, 281, 'touch');
  await click(button);
  expect(onOpen).toHaveBeenCalledOnce();
  await pointer(button, 'pointerdown', 964, 280, 'touch');
  await pointer(button, 'pointermove', 350, 180, 'touch');
  await pointer(button, 'pointercancel', 350, 180, 'touch');
  await click(button);
  expect(onOpen).toHaveBeenCalledOnce();
  expect(button.getBoundingClientRect()).toMatchObject({ left: 200, top: 160 });
  await click(button, 0);
  expect(onOpen).toHaveBeenCalledTimes(2);
});

it('retains source-specific edges and heights across remounts and clamps them to resized views', async () => {
  const first = await render(<Harness />);
  const firstButton = first.querySelector('button')!;
  capture(firstButton);
  await pointer(firstButton, 'pointerdown', 964);
  await pointer(firstButton, 'pointermove', 320, 540);
  await pointer(firstButton, 'pointerup', 320, 540);
  await unmount(first);
  const restored = await render(<><Harness /><Harness scope="side" /></>);
  const main = restored.querySelector<HTMLButtonElement>('[data-owner="main"] button')!;
  const side = restored.querySelector<HTMLButtonElement>('[data-owner="side"] button')!;
  expect(main.getBoundingClientRect()).toMatchObject({ left: 200, top: 520 });
  expect(side.getBoundingClientRect()).toMatchObject({ right: 1000, top: 260 });
  sizes.set('main', { width: 390, height: 240 }); sizes.set('side', { width: 600, height: 500 });
  await act(async () => { for (const update of observers) update(); });
  expect(main.getBoundingClientRect()).toMatchObject({ left: 200, bottom: 340 });
  expect(side.getBoundingClientRect()).toMatchObject({ right: 800, top: 240 });
  await key(main, 'ArrowRight');
  expect(main.getBoundingClientRect().right).toBe(590);
  sizes.set('main', { width: 800, height: 600 });
  await act(async () => { for (const update of observers) update(); });
  expect(main.getBoundingClientRect()).toMatchObject({ right: 1000, top: 520 });
});

it('clamps free dragging to all four edges of its source view', async () => {
  const container = await render(<Harness />);
  const button = container.querySelector('button')!;
  capture(button);
  await pointer(button, 'pointerdown', 964);
  await pointer(button, 'pointermove', 0, 0);
  expect(button.getBoundingClientRect()).toMatchObject({ left: 200, top: 100 });
  await pointer(button, 'pointerup', 0, 0);
  await pointer(button, 'pointerdown', 236, 120);
  await pointer(button, 'pointermove', 1400, 1200);
  expect(button.getBoundingClientRect()).toMatchObject({ right: 1000, bottom: 700 });
  await pointer(button, 'pointerup', 1400, 1200);
  expect(button.getBoundingClientRect()).toMatchObject({ right: 1000, bottom: 700 });
});

it('keeps an existing saved edge at the default height until the user moves it vertically', async () => {
  conversationLocalStorage.setItem('agent-remote-ask:main:dock-edge', 'left');
  const container = await render(<Harness />);
  const button = container.querySelector('button')!;
  expect(button.getBoundingClientRect()).toMatchObject({ left: 200, top: 260 });
  await key(button, 'ArrowRight');
  sizes.set('main', { width: 390, height: 240 });
  await act(async () => { for (const update of observers) update(); });
  expect(button.getBoundingClientRect().right).toBe(590);
  expect(button.getBoundingClientRect().top).toBeCloseTo(167.2);
  await key(button, 'ArrowDown');
  expect(button.getBoundingClientRect().top).toBeCloseTo(177.2);
  await key(button, 'ArrowUp', true);
  expect(button.getBoundingClientRect().top).toBeCloseTo(137.2);
  await key(button, 'ArrowLeft');
  expect(button.getBoundingClientRect()).toMatchObject({ left: 200 });
  expect(button.getBoundingClientRect().top).toBeCloseTo(137.2);
});

it('keeps restored heights reachable in a very short view', async () => {
  conversationLocalStorage.setItem('agent-remote-ask:main:dock-top', '800');
  sizes.set('main', { width: 320, height: 80 });
  const container = await render(<Harness />);
  const button = container.querySelector('button')!;
  expect(button.getBoundingClientRect()).toMatchObject({ right: 520, bottom: 180 });
  await key(button, 'ArrowDown', true);
  expect(button.getBoundingClientRect().bottom).toBe(180);
  await key(button, 'ArrowUp', true);
  expect(button.getBoundingClientRect().top).toBe(100);
});
