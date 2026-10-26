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
