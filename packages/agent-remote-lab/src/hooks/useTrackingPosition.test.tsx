import { act, useState } from 'react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { render } from '../test/setup.js';
import { arrangeFloatingEntries, useTrackingPosition } from './useTrackingPosition.js';

const rect = (x: number, y: number, width: number, height: number) => ({ x, y, left: x, top: y, right: x + width, bottom: y + height, width, height, toJSON: () => ({}) });
let appBarBottom = 0, toolsBottom = 0, askHeadingBottom = 0, composerTop = 0, composerBottom = 0;
let viewport: EventTarget & { offsetLeft: number; offsetTop: number; width: number; height: number };
beforeEach(() => {
  localStorage.clear();
  appBarBottom = 0; toolsBottom = 0; askHeadingBottom = 0; composerTop = 0; composerBottom = 0;
  vi.stubGlobal('innerWidth', 400);
  vi.stubGlobal('innerHeight', 800);
  viewport = Object.assign(new EventTarget(), { offsetLeft: 0, offsetTop: 0, width: 400, height: 800 });
  vi.stubGlobal('visualViewport', viewport);
  vi.stubGlobal('ResizeObserver', class { observe() {} unobserve() {} disconnect() {} });
  vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockImplementation(function (this: HTMLElement) {
    if (this.matches('.lab-app-bar')) return rect(0, 0, 400, appBarBottom);
    if (this.matches('.lab-composer-dock')) return rect(10, composerTop, 380, composerBottom - composerTop);
    if (this.matches('.lab-timeline-tools')) return rect(10, 57, 390, toolsBottom - 57);
    if (this.matches('.lab-workbench-heading-group')) return rect(0, 49, 400, askHeadingBottom - 49);
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
function Docked({ name }: { name: string }) {
  const { root, style } = useTrackingPosition(name, undefined, { enabled: false });
  return <div ref={root} style={style} className="lab-sidebar-shortcut" data-name={name}>
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

it('leaves a docked entry unpositioned and out of the floating arrangement', async () => {
  place('docked', 20, 300);
  place('floating', 20, 300);
  const container = await render(<><Docked name="docked" /><Entry name="floating" /></>);
  const docked = container.querySelector<HTMLElement>('[data-name="docked"]')!;
  expect(docked.getAttribute('style')).toBeNull();
  expect(top(container, 'floating')).toBe(300);
  await act(async () => { arrangeFloatingEntries(); });
  await act(async () => { window.dispatchEvent(new Event('resize')); });
  await view({ height: 700 });
  expect(docked.getAttribute('style')).toBeNull();
  expect(top(container, 'floating')).toBe(300);
});

function AppBarAndEntry({ name }: { name: string }) {
  return <><header className="lab-app-bar" /><Entry name={name} /></>;
}
function stubAppBar(bottom: number) { appBarBottom = bottom; }
function stylesheetDefault(top: number) {
  const style = document.createElement('style');
  style.textContent = `.lab-tracking-floating { position: fixed; left: 300px; top: ${top}px; }`;
  document.head.append(style);
  return () => style.remove();
}

it('starts a default placement below an app bar of several rows, and below a one-row bar where it was', async () => {
  const remove = stylesheetDefault(114);
  try {
    stubAppBar(162);
    const tall = await render(<AppBarAndEntry name="a" />);
    expect(top(tall, 'a')).toBe(114 + 162 + 8 - 60);
  } finally { remove(); }
  const again = stylesheetDefault(114);
  try {
    stubAppBar(48);
    const one = await render(<AppBarAndEntry name="b" />);
    expect(top(one, 'b')).toBe(114);
  } finally { again(); }
});

it('measures the app bar against the visible area, so a keyboard that pans it out of view adds no clearance', async () => {
  const remove = stylesheetDefault(114);
  try {
    // The app bar is fixed in the layout viewport; with the visible area panned 160 px down, its bottom (140) is above it.
    stubAppBar(140);
    Object.assign(viewport, { offsetTop: 160, height: 420 });
    const panned = await render(<AppBarAndEntry name="a" />);
    expect(top(panned, 'a')).toBe(160 + 114);
  } finally { remove(); }
});

it('does not move an entry the owner placed', async () => {
  const remove = stylesheetDefault(114);
  try {
    stubAppBar(162); place('a', 300, 114);
    const container = await render(<AppBarAndEntry name="a" />);
    expect(top(container, 'a')).toBe(114);
  } finally { remove(); }
});

it('moves the default placement below a timeline toolbar that mounts after the entry', async () => {
  const remove = stylesheetDefault(60);
  const observed: Array<() => void> = [];
  vi.stubGlobal('ResizeObserver', class { constructor(private readonly callback: () => void) {} observe(target: Element) { if (target.matches('.lab-timeline-tools')) observed.push(this.callback); } unobserve() {} disconnect() {} });
  try {
    const container = await render(<Entry name="a" />);
    expect(top(container, 'a')).toBe(60);
    toolsBottom = 107;
    expect(observed).toHaveLength(0);
    await act(async () => {
      const tools = document.createElement('div');
      tools.className = 'lab-timeline-tools';
      document.body.append(tools);
      await new Promise(resolve => requestAnimationFrame(() => resolve(undefined)));
      for (const callback of observed) callback();
    });
    expect(observed.length).toBeGreaterThan(0);
    expect(top(container, 'a')).toBe(107 + 8);
  } finally { document.querySelector('.lab-timeline-tools')?.remove(); remove(); }
});

it('starts a default placement below the heading of a full-screen Ask', async () => {
  const remove = stylesheetDefault(114);
  try {
    askHeadingBottom = 310;
    const container = await render(<><div className="lab-ask-viewport" data-presentation="overlay"><div className="lab-workbench-heading-group" /></div><Entry name="a" /></>);
    expect(top(container, 'a')).toBe(114 + 310 + 8 - 60);
  } finally { remove(); }
});

it('ignores the heading of a floating Ask', async () => {
  const remove = stylesheetDefault(114);
  try {
    askHeadingBottom = 310;
    const container = await render(<><div className="lab-ask-viewport" data-presentation="floating"><div className="lab-workbench-heading-group" /></div><Entry name="b" /></>);
    expect(top(container, 'b')).toBe(114);
  } finally { remove(); }
});

function Composer() { return <div className="lab-composer-dock" />; }

it('keeps a default column above the composer when a keyboard leaves a short visible area', async () => {
  const remove = stylesheetDefault(230);
  try {
    // The visible area is 340 px tall from y 80; the composer fills its lower half, so the bottom of the area would push the column over it.
    composerTop = 300; composerBottom = 420;
    Object.assign(viewport, { offsetTop: 80, height: 340 });
    const container = await render(<><Composer /><Entry name="a" /><Entry name="b" /></>);
    for (const name of ['a', 'b']) expect(top(container, name) + 44 + 8).toBeLessThanOrEqual(composerTop);
    expect(top(container, 'a')).not.toBe(top(container, 'b'));
  } finally { remove(); }
});

it('leaves a default column where it was when the composer is outside the visible area', async () => {
  const remove = stylesheetDefault(330);
  try {
    // The composer is above the visible area, which the keyboard panned down.
    composerTop = 200; composerBottom = 260;
    Object.assign(viewport, { offsetTop: 300, height: 400 });
    const container = await render(<><Composer /><Entry name="a" /></>);
    expect(top(container, 'a')).toBe(300 + 330);
  } finally { remove(); }
});

it('does not move an entry the owner placed above a composer', async () => {
  const remove = stylesheetDefault(114);
  try {
    composerTop = 300; composerBottom = 420;
    Object.assign(viewport, { offsetTop: 80, height: 340 });
    place('a', 300, 250);
    const container = await render(<><Composer /><Entry name="a" /></>);
    expect(top(container, 'a')).toBe(330);
  } finally { remove(); }
});
