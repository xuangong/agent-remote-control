import { act, useRef } from 'react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { render, unmount } from '../test/setup.js';
import { AskButton } from './AskButton.js';

const rect = (x: number, y: number, width: number, height: number) => ({ x, y, left: x, top: y, right: x + width, bottom: y + height, width, height, toJSON: () => ({}) });
beforeEach(() => {
  localStorage.clear();
  vi.stubGlobal('innerWidth', 800);
  vi.stubGlobal('innerHeight', 600);
  vi.stubGlobal('visualViewport', undefined);
  vi.stubGlobal('ResizeObserver', class { observe() {} disconnect() {} });
  vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockImplementation(function (this: HTMLElement) {
    const root = this.closest<HTMLElement>('.lab-ask-floating');
    return root ? rect(parseFloat(root.style.left || '716'), parseFloat(root.style.top || '276'), 72, 44) : rect(0, 0, 800, 600);
  });
  HTMLElement.prototype.setPointerCapture = vi.fn();
  HTMLElement.prototype.hasPointerCapture = vi.fn(() => false);
});
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); localStorage.clear(); });

function Harness({ onOpen = () => {}, disabled = false, sourceTitle = 'Source' }: { onOpen?(): void; disabled?: boolean; sourceTitle?: string }) {
  const trigger = useRef<HTMLButtonElement>(null);
  return <AskButton triggerRef={trigger} sourceTitle={sourceTitle} disabled={disabled} onOpen={onOpen} />;
}
async function pointer(button: HTMLButtonElement, type: string, x: number, y: number, pointerType = 'mouse') {
  await act(async () => { button.dispatchEvent(Object.assign(new MouseEvent(type, { bubbles: true, cancelable: true, button: 0, clientX: x, clientY: y }),
    { pointerId: 1, pointerType, isPrimary: true })); });
}
async function click(button: HTMLButtonElement) {
  await act(async () => { button.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true, detail: 1 })); });
}
async function key(button: HTMLButtonElement, value: string, shiftKey = false) {
  await act(async () => { button.dispatchEvent(new KeyboardEvent('keydown', { bubbles: true, cancelable: true, key: value, shiftKey })); });
}

it('keeps the released position without snapping and opens only on a deliberate click', async () => {
  const onOpen = vi.fn();
  const container = await render(<Harness onOpen={onOpen} />);
  const button = container.querySelector('button')!;
  await pointer(button, 'pointerdown', 750, 296);
  await pointer(button, 'pointermove', 400, 360);
  await pointer(button, 'pointerup', 400, 360);
  expect(button.getBoundingClientRect()).toMatchObject({ left: 366, top: 340 });
  await click(button);
  expect(onOpen).not.toHaveBeenCalled();
  await pointer(button, 'pointerdown', 400, 360);
  await pointer(button, 'pointerup', 400, 360);
  await click(button);
  expect(onOpen).toHaveBeenCalledOnce();
});

it('retains one global position across source changes and clamps to the viewport', async () => {
  const first = await render(<Harness sourceTitle="First" />);
  const button = first.querySelector('button')!;
  await key(button, 'ArrowLeft', true);
  await key(button, 'ArrowDown');
  expect(button.getBoundingClientRect()).toMatchObject({ left: 676, top: 286 });
  await unmount(first);
  const restored = await render(<Harness sourceTitle="Second" />);
  const next = restored.querySelector('button')!;
  expect(next.getBoundingClientRect()).toMatchObject({ left: 676, top: 286 });
  vi.stubGlobal('innerWidth', 390); vi.stubGlobal('innerHeight', 240);
  await act(async () => { window.dispatchEvent(new Event('resize')); });
  expect(next.getBoundingClientRect()).toMatchObject({ right: 378, bottom: 228 });
});

it('uses the common floating button style and preserves touch taps', async () => {
  const onOpen = vi.fn();
  const container = await render(<Harness onOpen={onOpen} />);
  const button = container.querySelector('button')!;
  expect(container.querySelector('.lab-tracking-floating > .lab-session-popover-trigger')).toBe(button);
  expect(button.parentElement?.hasAttribute('data-pane-selection-ignore')).toBe(true);
  await pointer(button, 'pointerdown', 750, 296, 'touch');
  await pointer(button, 'pointermove', 751, 297, 'touch');
  await pointer(button, 'pointerup', 751, 297, 'touch');
  await click(button);
  expect(onOpen).toHaveBeenCalledOnce();
});

it('does not open when the selected view has no available source', async () => {
  const onOpen = vi.fn();
  const container = await render(<Harness onOpen={onOpen} disabled />);
  const button = container.querySelector('button')!;
  expect(button.disabled).toBe(true);
  await act(async () => button.click());
  expect(onOpen).not.toHaveBeenCalled();
});
