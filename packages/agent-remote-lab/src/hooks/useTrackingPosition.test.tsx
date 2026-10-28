import { act, useState } from 'react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { render } from '../test/setup.js';
import { useTrackingPosition } from './useTrackingPosition.js';

const rect = (x: number, y: number, width: number, height: number) => ({ x, y, left: x, top: y, right: x + width, bottom: y + height, width, height, toJSON: () => ({}) });
let viewport: EventTarget & { offsetLeft: number; offsetTop: number; width: number; height: number };
beforeEach(() => {
  localStorage.clear();
  vi.stubGlobal('innerWidth', 400);
  vi.stubGlobal('innerHeight', 800);
  viewport = Object.assign(new EventTarget(), { offsetLeft: 0, offsetTop: 0, width: 400, height: 800 });
  vi.stubGlobal('visualViewport', viewport);
  vi.stubGlobal('ResizeObserver', class { observe() {} disconnect() {} });
  vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockImplementation(function (this: HTMLElement) {
    const root = this.closest<HTMLElement>('.lab-tracking-floating');
    return root ? rect(parseFloat(root.style.left || '0'), parseFloat(root.style.top || '0'), 80, 44) : rect(0, 0, 400, 800);
  });
  HTMLElement.prototype.setPointerCapture = vi.fn();
  HTMLElement.prototype.hasPointerCapture = vi.fn(() => false);
});
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); localStorage.clear(); });

function Entry({ name, className = '' }: { name: string; className?: string }) {
  const { root, style, handlers } = useTrackingPosition(name);
  return <div ref={root} style={style} {...handlers} className={`lab-tracking-floating ${className}`} data-name={name}>
    <button type="button" className="lab-session-popover-trigger">{name}</button>
  </div>;
}
function place(name: string, x: number, y: number) { localStorage.setItem(name, JSON.stringify({ x, y })); }
async function view(change: Partial<typeof viewport>) {
  Object.assign(viewport, change);
  await act(async () => { viewport.dispatchEvent(new Event('resize')); });
}
const top = (container: HTMLElement, name: string) => parseFloat(container.querySelector<HTMLElement>(`[data-name="${name}"]`)!.style.top);
async function pointer(button: HTMLButtonElement, type: string, x: number, y: number) {
  await act(async () => { button.dispatchEvent(Object.assign(new MouseEvent(type, { bubbles: true, cancelable: true, button: 0, clientX: x, clientY: y }),
    { pointerId: 1, pointerType: 'touch', isPrimary: true })); });
}

it('returns to its placement when the keyboard closes', async () => {
  place('a', 300, 600);
  const container = await render(<Entry name="a" />);
  expect(top(container, 'a')).toBe(600);
  await view({ height: 400 });
  expect(top(container, 'a')).toBe(344);
  await view({ height: 800 });
  expect(top(container, 'a')).toBe(600);
  expect(JSON.parse(localStorage.getItem('a')!)).toEqual({ x: 300, y: 600 });
});

it('keeps entries the keyboard moves clear of each other and in their order', async () => {
  place('a', 300, 500); place('b', 300, 600);
  const container = await render(<><Entry name="a" /><Entry name="b" /></>);
  await view({ height: 400 });
  expect(top(container, 'b')).toBe(344);
  expect(top(container, 'a')).toBe(292);
  await view({ height: 800 });
  expect([top(container, 'a'), top(container, 'b')]).toEqual([500, 600]);
});

it('keeps its spot in the visible area when the keyboard pans the viewport', async () => {
  place('a', 300, 100);
  const container = await render(<Entry name="a" />);
  await view({ offsetTop: 300, height: 400 });
  expect(top(container, 'a')).toBe(400);
  const button = container.querySelector('button')!;
  await pointer(button, 'pointerdown', 340, 120);
  await pointer(button, 'pointermove', 340, 170);
  await pointer(button, 'pointerup', 340, 170);
  expect(top(container, 'a')).toBe(450);
  expect(JSON.parse(localStorage.getItem('a')!)).toEqual({ x: 300, y: 150 });
  await view({ offsetTop: 0, height: 800 });
  expect(top(container, 'a')).toBe(150);
});

it('leaves entries the owner placed over each other where they are', async () => {
  place('a', 300, 200); place('b', 300, 200);
  const container = await render(<><Entry name="a" /><Entry name="b" /></>);
  await view({ height: 400 });
  expect([top(container, 'a'), top(container, 'b')]).toEqual([200, 200]);
});

it('does not move entries for one that is not shown', async () => {
  const css = document.createElement('style');
  css.textContent = '.lab-tracking-floating.unseen { visibility: hidden; }';
  document.head.append(css);
  try {
    place('a', 300, 500); place('b', 300, 600);
    const container = await render(<><Entry name="a" /><Entry name="b" className="unseen" /></>);
    await view({ height: 400 });
    expect([top(container, 'a'), top(container, 'b')]).toEqual([344, 344]);
  } finally { css.remove(); }
});

let setLate: (value: { shown: boolean; hidden: boolean }) => void = () => {};
function Late({ name }: { name: string }) {
  const [{ shown, hidden }, set] = useState({ shown: false, hidden: false });
  setLate = set;
  const { root, style, handlers } = useTrackingPosition(name);
  if (!shown) return null;
  return <div ref={root} style={style} {...handlers} className="lab-tracking-floating" data-name={name} hidden={hidden}>
    <button type="button" className="lab-session-popover-trigger">{name}</button>
  </div>;
}

it('positions and moves a root rendered after mounting, as Team once workspace access is confirmed', async () => {
  place('late', 300, 500);
  const container = await render(<Late name="late" />);
  await act(async () => setLate({ shown: true, hidden: false }));
  expect(top(container, 'late')).toBe(500);
  const button = container.querySelector('button')!;
  await pointer(button, 'pointerdown', 340, 520);
  await pointer(button, 'pointermove', 340, 570);
  await pointer(button, 'pointerup', 340, 570);
  expect(top(container, 'late')).toBe(550);
  await view({ height: 400 });
  expect(top(container, 'late')).toBe(344);
  // Rendered again, as after foreground recovery, it keeps the owner's placement.
  await act(async () => setLate({ shown: false, hidden: false }));
  await act(async () => setLate({ shown: true, hidden: false }));
  await view({ height: 800 });
  expect(top(container, 'late')).toBe(550);
});

it('reads the stylesheet placement of an entry first rendered hidden once it is shown', async () => {
  const css = document.createElement('style');
  css.textContent = '.lab-tracking-floating[data-name="hidden"] { position: fixed; left: 280px; top: 114px; } [hidden] { display: none; }';
  document.head.append(css);
  try {
    const container = await render(<Late name="hidden" />);
    await act(async () => setLate({ shown: true, hidden: true }));
    expect(container.querySelector<HTMLElement>('[data-name="hidden"]')!.style.top).toBe('');
    await act(async () => setLate({ shown: true, hidden: false }));
    await view({});
    expect(container.querySelector<HTMLElement>('[data-name="hidden"]')!.style.left).toBe('280px');
    expect(top(container, 'hidden')).toBe(114);
  } finally { css.remove(); }
});
