import { act, useState } from 'react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { render, unmount } from '../test/setup.js';
import { SessionDockProvider, SessionDockRail, SessionViewPlacement } from './SessionDock.js';
import { SessionHeading } from './SessionHeading.js';
import { SessionTitle } from './SessionTitle.js';

beforeEach(() => vi.stubGlobal('ResizeObserver', class { observe() {} disconnect() {} }));
afterEach(() => vi.unstubAllGlobals());

async function setup(widths = [440, 440, 440]) {
  const rename = vi.fn();
  let enable!: (value: boolean) => void;
  function Harness() {
    const [enabled, setEnabled] = useState(true); enable = setEnabled;
    return <SessionDockProvider enabled={enabled}><SessionDockRail />
      {['One', 'Two', 'Three'].map(id => <SessionViewPlacement key={id} id={id} title={id} visible dockRequest="open">
        {({ controls }) => <><SessionHeading trailing={controls}><SessionTitle title={id} onRename={rename} /></SessionHeading><input defaultValue={`${id} draft`} /></>}
      </SessionViewPlacement>)}
    </SessionDockProvider>;
  }
  const view = await render(<Harness />);
  const rail = view.querySelector<HTMLElement>('.lab-session-dock-rail')!;
  rail.getBoundingClientRect = () => new DOMRect(0, 0, 1320, 800);
  const panes = [...view.querySelectorAll<HTMLElement>('[data-dock-id]')].sort((a, b) => Number(a.style.order) - Number(b.style.order));
  const animation = vi.fn();
  for (const pane of panes) {
    pane.getBoundingClientRect = () => new DOMRect(panes.reduce((left, other, index) => left + (Number(other.style.order) < Number(pane.style.order) ? widths[index]! : 0), 0) - rail.scrollLeft
      + (Number(pane.style.transform.match(/translate3d\(([-.\d]+)px/)?.[1]) || 0), 0, widths[panes.indexOf(pane)]!, 800);
    Object.assign(pane, { animate: animation });
  }
  let frame!: FrameRequestCallback;
  vi.stubGlobal('requestAnimationFrame', (callback: FrameRequestCallback) => { frame = callback; return 1; });
  vi.stubGlobal('cancelAnimationFrame', () => {});
  const title = (id: string) => view.querySelector<HTMLElement>(`[data-dock-id="${id}"] .agent-session-title`)!;
  const pointer = async (target: EventTarget, type: string, x: number) => act(async () => {
    const event = new MouseEvent(type, { bubbles: true, cancelable: true, button: 0, clientX: x, clientY: 20 });
    Object.defineProperty(event, 'pointerId', { value: 1 });
    target.dispatchEvent(event);
  });
  return { view, rail, panes, title, rename, animation, enable, pointer, frame: async () => act(async () => frame(0)) };
}

it('keeps clicks and rename intact below the threshold, then commits one drop while retaining the view', async () => {
  const { view, rail, panes, title, rename, animation, pointer } = await setup();
  const heading = title('Two'), editor = panes[1]!.querySelector('input');
  await pointer(heading, 'pointerdown', 660);
  await pointer(window, 'pointermove', 663);
  await pointer(window, 'pointerup', 663);
  await act(async () => heading.dispatchEvent(new MouseEvent('dblclick', { bubbles: true })));
  expect(rename).toHaveBeenCalledTimes(1);
  expect(rail.dataset.dockReordering).toBeUndefined();
  await pointer(heading, 'pointerdown', 660);
  await pointer(window, 'pointermove', 200);
  expect(rail.dataset.dockReordering).toBe('true');
  expect(panes[1]!.style.transform).toContain('-440px');
  expect(panes[1]!.style.order).toBe('2');
  expect(panes[0]!.style.transform).toContain('440px');
  await pointer(window, 'pointerup', 200);
  expect(panes[1]!.style.order).toBe('1');
  expect(panes[0]!.style.order).toBe('2');
  expect(panes[1]!.querySelector('input')).toBe(editor);
  expect(editor?.value).toBe('Two draft');
  expect(rail.dataset.dockReordering).toBeUndefined();
  expect(panes.every(pane => !pane.style.transform)).toBe(true);
  // A drag-generated double-click must not rename the session.
  await act(async () => heading.dispatchEvent(new MouseEvent('dblclick', { bubbles: true })));
  expect(rename).toHaveBeenCalledTimes(1);
  expect(view.querySelector('button[aria-label="Move Two"]')).toBeNull();
  expect(animation.mock.calls.every(call => call[1].duration === 200)).toBe(true);
});

it.each(['pointercancel', 'escape', 'blur', 'resize', 'unmount'])('cancels a title drag on %s without saving its preview', async reason => {
  const { view, rail, panes, title, pointer, enable } = await setup();
  await pointer(title('Two'), 'pointerdown', 660);
  await pointer(window, 'pointermove', 200);
  if (reason === 'escape') await act(async () => window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })));
  else if (reason === 'blur') await act(async () => window.dispatchEvent(new Event('blur')));
  else if (reason === 'resize') await act(async () => enable(false));
  else if (reason === 'unmount') await unmount(view);
  else await pointer(window, 'pointercancel', 200);
  expect(panes.map(pane => pane.style.order)).toEqual(['1', '2', '3']);
  expect(panes.every(pane => !pane.style.transform && !pane.dataset.dragging)).toBe(true);
  expect(rail.dataset.dockReordering).toBeUndefined();
});

it('does not overwrite a concurrent layout edit and disables title gestures in compact presentation', async () => {
  const { view, rail, panes, title, pointer, frame, enable } = await setup();
  await pointer(title('Two'), 'pointerdown', 660);
  await pointer(window, 'pointermove', 200);
  panes[2]!.style.order = '0';
  await frame();
  expect(rail.dataset.dockReordering).toBeUndefined();
  await pointer(window, 'pointerup', 200);
  expect(panes[1]!.style.order).toBe('2');
  expect(panes[2]!.style.order).toBe('0');
  await act(async () => enable(false));
  expect(view.querySelector('[data-session-title-draggable]')).toBeNull();
  expect(view.querySelectorAll('.agent-session-title')).toHaveLength(3);
});

it('uses an explicit keyboard shortcut for ordering and honors reduced motion', async () => {
  const { title, panes, animation } = await setup();
  vi.stubGlobal('matchMedia', () => ({ matches: true }));
  await act(async () => title('Two').dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowLeft', bubbles: true })));
  expect(panes[1]!.style.order).toBe('2');
  await act(async () => title('Two').dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowLeft', altKey: true, bubbles: true })));
  expect(panes[1]!.style.order).toBe('1');
  expect(animation).not.toHaveBeenCalled();
});


it.each([[440, 440, 440], [1080, 240, 440]])('moves the left family right across different pane widths (%s, %s, %s)', async (first, second, third) => {
  const { title, panes, pointer } = await setup([first, second, third]);
  const start = first / 2;
  await pointer(title('One'), 'pointerdown', start);
  await pointer(window, 'pointermove', start + second * .75);
  expect(panes[0]!.style.order).toBe('1');
  await pointer(window, 'pointerup', start + second * .75);
  expect(panes[0]!.style.order).toBe('2');
  expect(panes[1]!.style.order).toBe('1');
});

it('uses the final pointer position even when no animation frame runs before release', async () => {
  const { title, panes, pointer, animation } = await setup();
  await pointer(title('One'), 'pointerdown', 220);
  await pointer(window, 'pointermove', 230);
  await pointer(window, 'pointerup', 550);
  expect(panes[0]!.style.order).toBe('2');
  expect(animation).toHaveBeenCalled();
});


it('cancels when another layout edit shifts the dock group during a drag', async () => {
  const { title, panes, rail, pointer, frame } = await setup();
  await pointer(title('Two'), 'pointerdown', 660);
  await pointer(window, 'pointermove', 200);
  Object.defineProperty(panes[0], 'offsetLeft', { configurable: true, value: 120 });
  await frame();
  await pointer(window, 'pointerup', 200);
  expect(rail.dataset.dockReordering).toBeUndefined();
  expect(panes.map(pane => pane.style.order)).toEqual(['1', '2', '3']);
});
