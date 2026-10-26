import { expect, it } from 'vitest';
import { adjacentSessionView, railWheelStep } from './useSessionViewMouseNavigation.js';

function rail(views: Array<{ id: string; left: number; hidden?: boolean; inner?: boolean }>) {
  const root = document.createElement('div');
  for (const view of views) {
    const element = document.createElement('section');
    element.dataset.viewId = view.id;
    element.hidden = !!view.hidden;
    element.getClientRects = () => (view.hidden ? [] : [{}]) as unknown as DOMRectList;
    element.getBoundingClientRect = () => ({ left: view.left }) as DOMRect;
    // A window and its root pane name the same view.
    if (view.inner) {
      const inner = element.cloneNode() as HTMLElement;
      inner.getClientRects = element.getClientRects; inner.getBoundingClientRect = () => ({ left: view.left + 1 }) as DOMRect;
      inner.dataset.inner = 'true'; element.append(inner);
    }
    root.append(element);
  }
  return root;
}

it('steps through visible session views in on-screen order, using the innermost element of a view', () => {
  const root = rail([{ id: 'dock', left: 900, inner: true }, { id: 'main', left: 0 }, { id: 'gone', left: 500, hidden: true }, { id: 'child', left: 400 }]);
  expect(adjacentSessionView(root, 'main', 1)?.dataset.viewId).toBe('child');
  const dock = adjacentSessionView(root, 'child', 1)!;
  expect([dock.dataset.viewId, dock.dataset.inner]).toEqual(['dock', 'true']);
  expect(adjacentSessionView(root, 'dock', 1)).toBeUndefined();
  expect(adjacentSessionView(root, 'main', -1)).toBeUndefined();
  // Without the selected view, forward starts at the first view and back at the last.
  expect(adjacentSessionView(root, 'gone', 1)?.dataset.viewId).toBe('main');
  expect(adjacentSessionView(root, undefined, -1)?.dataset.viewId).toBe('dock');
});

function scroller(element: HTMLElement, overflowX: string, scrollWidth: number, clientWidth: number, scrollLeft = 0) {
  element.style.overflowX = overflowX;
  Object.defineProperties(element, { scrollWidth: { value: scrollWidth }, clientWidth: { value: clientWidth } });
  element.scrollLeft = scrollLeft;
  return element;
}

function wheel(target: Element, init: WheelEventInit) {
  const event = new WheelEvent('wheel', { bubbles: true, cancelable: true, ...init });
  Object.defineProperty(event, 'target', { value: target });
  return event;
}

it('scrolls the rail with a sideways wheel unless content under the pointer scrolls sideways itself', () => {
  const root = scroller(document.createElement('div'), 'auto', 2000, 1000, 500);
  // A conversation that only scrolls vertically, as a timeline does.
  const timeline = scroller(document.createElement('div'), 'auto', 400, 400);
  const table = scroller(document.createElement('div'), 'auto', 900, 300);
  const cell = document.createElement('span');
  table.append(cell); timeline.append(table); root.append(timeline);
  expect(railWheelStep(root, wheel(timeline, { deltaX: 120 }))).toBe(120);
  expect(railWheelStep(root, wheel(timeline, { deltaX: -3, deltaMode: WheelEvent.DOM_DELTA_LINE }))).toBe(-48);
  expect(railWheelStep(root, wheel(timeline, { deltaY: 100, shiftKey: true }))).toBe(100);
  // Vertical scrolling and zooming stay with the browser.
  expect(railWheelStep(root, wheel(timeline, { deltaY: 100, deltaX: 20 }))).toBe(0);
  expect(railWheelStep(root, wheel(timeline, { deltaX: 120, ctrlKey: true }))).toBe(0);
  // The table keeps the wheel while it has room left, then passes it on.
  expect(railWheelStep(root, wheel(cell, { deltaX: 120 }))).toBe(0);
  expect(railWheelStep(root, wheel(cell, { deltaX: -120 }))).toBe(-120);
  table.scrollLeft = 600;
  expect(railWheelStep(root, wheel(cell, { deltaX: 120 }))).toBe(120);
  // A rail at its end leaves the wheel to the browser.
  root.scrollLeft = 1000;
  expect(railWheelStep(root, wheel(timeline, { deltaX: 120 }))).toBe(0);
  expect(railWheelStep(root, wheel(timeline, { deltaX: -120 }))).toBe(-120);
});
