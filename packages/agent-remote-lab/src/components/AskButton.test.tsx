import { act, useRef } from 'react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { render, unmount } from '../test/setup.js';
import { conversationLocalStorage } from '../conversation-storage.js';
import { AskButton } from './AskButton.js';

const rect = (x: number, width: number) => ({ x, y: 100, left: x, top: 100, right: x + width, bottom: 144, width, height: 44, toJSON: () => ({}) });
const sizes = new Map<string, number>();
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
    if (!owner) return rect(0, 0);
    const width = sizes.get(owner.dataset.owner!) ?? 800;
    if (this === owner) return rect(200, width);
    const dock = this.closest<HTMLElement>('.lab-ask-floating')!;
    return rect(200 + width - 72 + parseFloat(dock.style.getPropertyValue('--ask-dock-offset') || '0'), 72);
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
async function pointer(button: HTMLButtonElement, type: string, x: number, y = 120, pointerType = 'mouse') {
  await act(async () => { button.dispatchEvent(Object.assign(new MouseEvent(type, { bubbles: true, cancelable: true, button: 0, clientX: x, clientY: y }),
    { pointerId: 1, pointerType, isPrimary: true })); });
}
async function click(button: HTMLButtonElement, detail = 1) {
  await act(async () => { button.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true, detail })); });
}
async function key(button: HTMLButtonElement, value: string) {
  await act(async () => { button.dispatchEvent(new KeyboardEvent('keydown', { bubbles: true, cancelable: true, key: value })); });
}

it('clamps a drag to its source row and opens only on the following deliberate click', async () => {
  const onOpen = vi.fn();
  const container = await render(<Harness onOpen={onOpen} />);
  const button = container.querySelector('button')!;
  capture(button);
  await pointer(button, 'pointerdown', 964);
  await pointer(button, 'pointermove', 120, 260);
  expect(button.getBoundingClientRect()).toMatchObject({ left: 200, top: 100 });
  await pointer(button, 'pointerup', 120, 260);
  await click(button);
  expect(onOpen).not.toHaveBeenCalled();
  expect(button.hasPointerCapture(1)).toBe(false);
  expect(button.getBoundingClientRect().left).toBe(200);
  await pointer(button, 'pointerdown', 232);
  await pointer(button, 'pointerup', 232);
  await click(button);
  expect(onOpen).toHaveBeenCalledOnce();
});

it('keeps touch taps clickable and cancels a dragged touch without opening Ask', async () => {
  const onOpen = vi.fn();
  const container = await render(<Harness onOpen={onOpen} />);
  const button = container.querySelector('button')!;
  capture(button);
  await pointer(button, 'pointerdown', 964, 120, 'touch');
  await pointer(button, 'pointermove', 966, 121, 'touch');
  await pointer(button, 'pointerup', 966, 121, 'touch');
  await click(button);
  expect(onOpen).toHaveBeenCalledOnce();
  await pointer(button, 'pointerdown', 964, 120, 'touch');
  await pointer(button, 'pointermove', 350, 120, 'touch');
  await pointer(button, 'pointercancel', 350, 120, 'touch');
  await click(button);
  expect(onOpen).toHaveBeenCalledOnce();
  expect(button.getBoundingClientRect().left).toBe(200);
  await click(button, 0);
  expect(onOpen).toHaveBeenCalledTimes(2);
});

it('retains source-specific edges across remounts and adapts each edge to resized views', async () => {
  const first = await render(<Harness />);
  await key(first.querySelector('button')!, 'ArrowLeft');
  await unmount(first);
  const restored = await render(<><Harness /><Harness scope="side" /></>);
  const main = restored.querySelector<HTMLButtonElement>('[data-owner="main"] button')!;
  const side = restored.querySelector<HTMLButtonElement>('[data-owner="side"] button')!;
  expect(main.getBoundingClientRect().left).toBe(200);
  expect(side.getBoundingClientRect().right).toBe(1000);
  sizes.set('main', 390); sizes.set('side', 600);
  await act(async () => { for (const update of observers) update(); });
  expect(main.getBoundingClientRect().left).toBe(200);
  expect(side.getBoundingClientRect().right).toBe(800);
  await key(main, 'ArrowRight');
  expect(main.getBoundingClientRect().right).toBe(590);
});
