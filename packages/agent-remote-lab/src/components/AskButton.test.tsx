import { act, useRef } from 'react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { render, unmount } from '../test/setup.js';
import { AskButton } from './AskButton.js';

const rect = (x: number, y: number, width: number, height: number) => ({ x, y, left: x, top: y, right: x + width, bottom: y + height, width, height, toJSON: () => ({}) });
let visualClientRects = false;
beforeEach(() => {
  visualClientRects = false;
  localStorage.clear();
  vi.stubGlobal('innerWidth', 800);
  vi.stubGlobal('innerHeight', 600);
  vi.stubGlobal('visualViewport', undefined);
  vi.stubGlobal('ResizeObserver', class { observe() {} disconnect() {} });
  vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockImplementation(function (this: HTMLElement) {
    const root = this.closest<HTMLElement>('.lab-ask-floating');
    const view = visualClientRects ? window.visualViewport : undefined;
    const css = root ? getComputedStyle(root) : undefined;
    return root ? rect(parseFloat(css?.left || '716') - (view?.offsetLeft ?? 0), parseFloat(css?.top || '276') - (view?.offsetTop ?? 0), 72, 44) : rect(0, 0, 800, 600);
  });
  HTMLElement.prototype.setPointerCapture = vi.fn();
  HTMLElement.prototype.hasPointerCapture = vi.fn(() => false);
});
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); localStorage.clear(); });

function Harness({ onOpen = () => {}, disabled = false, sourceTitle = 'Source', unavailable }: { onOpen?(): void; disabled?: boolean; sourceTitle?: string; unavailable?: string }) {
  const trigger = useRef<HTMLButtonElement>(null);
  return <AskButton triggerRef={trigger} sourceTitle={sourceTitle} disabled={disabled} unavailable={unavailable} onOpen={onOpen} />;
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

it('says why Ask cannot open for the selected session', async () => {
  const container = await render(<Harness disabled unavailable="waiting for the session to connect" />);
  const button = container.querySelector('button')!;
  expect(button.title).toBe('Ask about Source · waiting for the session to connect');
  expect(container.querySelector('[role="status"]')!.textContent).toBe('Ask about Source · waiting for the session to connect');
});

it.each([false, true])('keeps touch movement aligned with fixed coordinates when client rects use the visual viewport (%s)', async visual => {
  visualClientRects = visual;
  const viewport = Object.assign(new EventTarget(), { offsetLeft: 50, offsetTop: 200, width: 600, height: 300 });
  vi.stubGlobal('visualViewport', viewport);
  localStorage.setItem('agent-remote:ask-position', JSON.stringify({ x: 240, y: 60 }));
  const container = await render(<Harness />);
  const button = container.querySelector('button')!;
  const before = button.getBoundingClientRect();
  await pointer(button, 'pointerdown', before.left + 20, before.top + 20, 'touch');
  await pointer(button, 'pointermove', before.left + 35, before.top + 40, 'touch');
  await pointer(button, 'pointerup', before.left + 35, before.top + 40, 'touch');
  expect(button.getBoundingClientRect()).toMatchObject({ left: before.left + 15, top: before.top + 20 });
  // The saved placement is relative to the visible area, which the keyboard has panned.
  expect(JSON.parse(localStorage.getItem('agent-remote:ask-position')!)).toEqual({ x: 255, y: 80 });
});

it('places the resolved CSS position within the visible area when first mounted above an open keyboard', async () => {
  visualClientRects = true;
  vi.stubGlobal('visualViewport', Object.assign(new EventTarget(), { offsetLeft: 50, offsetTop: 200, width: 750, height: 350 }));
  const css = document.createElement('style');
  css.textContent = '.lab-ask-floating { position: fixed; left: 600px; top: 100px; }';
  document.head.append(css);
  try {
    const container = await render(<Harness />);
    const root = container.querySelector<HTMLElement>('.lab-ask-floating')!;
    expect(root.style.left).toBe('650px');
    expect(root.style.top).toBe('300px');
  } finally { css.remove(); }
});

it('continues dragging from the visible position after the keyboard clamps the button', async () => {
  const viewport = Object.assign(new EventTarget(), { offsetLeft: 0, offsetTop: 0, width: 800, height: 600 });
  vi.stubGlobal('visualViewport', viewport);
  localStorage.setItem('agent-remote:ask-position', JSON.stringify({ x: 240, y: 500 }));
  const container = await render(<Harness />);
  const button = container.querySelector('button')!;
  await pointer(button, 'pointerdown', 260, 520, 'touch');
  await pointer(button, 'pointermove', 280, 540, 'touch');
  viewport.height = 350;
  await act(async () => { viewport.dispatchEvent(new Event('resize')); });
  const afterClamp = button.getBoundingClientRect();
  expect(afterClamp.bottom).toBe(338);
  await pointer(button, 'pointermove', 285, 530, 'touch');
  expect(button.getBoundingClientRect()).toMatchObject({ left: afterClamp.left + 5, top: afterClamp.top - 10 });
});

it('reports when it rests against the right viewport edge', async () => {
  const container = await render(<Harness />);
  const root = container.querySelector<HTMLElement>('.lab-ask-floating')!;
  const button = container.querySelector('button')!;
  expect(root.dataset.edge).toBe('right');
  await key(button, 'ArrowLeft', true);
  expect(root.dataset.edge).toBeUndefined();
  await key(button, 'ArrowRight', true);
  expect(root.dataset.edge).toBe('right');
});
