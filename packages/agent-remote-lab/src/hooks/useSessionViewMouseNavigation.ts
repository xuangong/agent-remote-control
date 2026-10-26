import { useEffect, useRef, type RefObject } from 'react';

/** Mouse buttons that browsers use for history navigation. */
const BACK = 3, FORWARD = 4;

/**
 * The session view beside the selected one, in on-screen order within the rail. Nested elements can name the same
 * view (a window and its root pane); the innermost one stands for it. A rail without the selected view starts at
 * its first view going forward and its last going back.
 */
export function adjacentSessionView(rail: Element, selectedId: string | null | undefined, step: -1 | 1): HTMLElement | undefined {
  const views = new Map<string, HTMLElement>();
  for (const element of rail.querySelectorAll<HTMLElement>('[data-view-id]')) {
    const id = element.dataset.viewId;
    if (!id || element.closest('[hidden]') || !element.getClientRects().length) continue;
    views.set(id, element);
  }
  const ordered = [...views.values()].sort((a, b) => a.getBoundingClientRect().left - b.getBoundingClientRect().left);
  const index = ordered.findIndex(element => element.dataset.viewId === selectedId);
  return index < 0 ? (step > 0 ? ordered[0] : ordered.at(-1)) : ordered[index + step];
}

/** Whether an element scrolls sideways itself and has room left in the direction of the step. */
function scrollsSideways(element: Element, step: number) {
  const { overflowX } = getComputedStyle(element);
  if (overflowX !== 'auto' && overflowX !== 'scroll') return false;
  const room = element.scrollWidth - element.clientWidth;
  return room > 0 && (step > 0 ? element.scrollLeft < room - 1 : element.scrollLeft > 0);
}

/**
 * How far a sideways wheel scrolls the rail, in pixels, or 0 when the browser should handle it. Content between the
 * pointer and the rail that scrolls sideways itself, such as a table or code block with room left, keeps the wheel.
 * A vertical wheel with Shift held scrolls sideways, as browsers do.
 */
export function railWheelStep(rail: Element, event: WheelEvent): number {
  if (event.ctrlKey || event.defaultPrevented) return 0;
  const delta = Math.abs(event.deltaX) > Math.abs(event.deltaY) ? event.deltaX : event.shiftKey && !event.deltaX ? event.deltaY : 0;
  if (!delta) return 0;
  const step = event.deltaMode === WheelEvent.DOM_DELTA_LINE ? delta * 16 : event.deltaMode === WheelEvent.DOM_DELTA_PAGE ? delta * rail.clientWidth : delta;
  for (let node = event.target instanceof Element ? event.target : null; node && node !== rail; node = node.parentElement) {
    if (scrollsSideways(node, step)) return 0;
  }
  return scrollsSideways(rail, step) ? step : 0;
}

/**
 * A sideways wheel anywhere over the rail scrolls the rail. Panes contain their vertical overscroll, and browsers
 * differ in whether such containment also stops a sideways wheel from reaching the rail, so the rail scrolls itself.
 */
export function useSessionRailWheel(rail: RefObject<HTMLElement>) {
  useEffect(() => {
    const element = rail.current;
    if (!element) return;
    const wheel = (event: WheelEvent) => {
      const step = railWheelStep(element, event);
      if (!step) return;
      event.preventDefault();
      element.scrollBy({ left: step, behavior: 'instant' });
    };
    element.addEventListener('wheel', wheel, { passive: false });
    return () => element.removeEventListener('wheel', wheel);
  }, [rail]);
}

/**
 * The mouse back and forward buttons select the previous or next session view in the rail and scroll it into view,
 * instead of leaving the page through browser history. Inactive while a dialog is open or the rail is not shown.
 */
export function useSessionViewMouseNavigation(rail: RefObject<HTMLElement>, enabled: boolean, selectedId: string | null | undefined, select: (viewId: string) => void) {
  const latest = useRef({ selectedId, select }); latest.current = { selectedId, select };
  useEffect(() => {
    if (!enabled) return;
    const applies = (event: MouseEvent) => {
      const element = rail.current;
      return (event.button === BACK || event.button === FORWARD) && !!element?.isConnected && element.getClientRects().length > 0
        && !element.closest('[hidden],[inert]') && !document.querySelector('dialog[open]');
    };
    // Pressing the button over a pane must not select that pane first, so the press stops here. Cancelling the
    // pointerdown would also suppress the mouseup, and only a cancelled mouseup stops history navigation.
    const isolate = (event: MouseEvent) => { if (applies(event)) event.stopPropagation(); };
    const suppress = (event: MouseEvent) => { if (applies(event)) { event.preventDefault(); event.stopPropagation(); } };
    const navigate = (event: MouseEvent) => {
      if (!applies(event)) return;
      event.preventDefault();
      const target = adjacentSessionView(rail.current!, latest.current.selectedId, event.button === BACK ? -1 : 1);
      const id = target?.dataset.viewId;
      if (!target || !id) return;
      if (id !== latest.current.selectedId) latest.current.select(id);
      const reduced = globalThis.matchMedia?.('(prefers-reduced-motion: reduce)').matches;
      target.scrollIntoView?.({ block: 'nearest', inline: 'nearest', behavior: reduced ? 'auto' : 'smooth' });
    };
    window.addEventListener('pointerdown', isolate, true);
    window.addEventListener('mousedown', suppress, true);
    window.addEventListener('mouseup', navigate, true);
    window.addEventListener('auxclick', suppress, true);
    return () => {
      window.removeEventListener('pointerdown', isolate, true);
      window.removeEventListener('mousedown', suppress, true);
      window.removeEventListener('mouseup', navigate, true);
      window.removeEventListener('auxclick', suppress, true);
    };
  }, [rail, enabled]);
}
