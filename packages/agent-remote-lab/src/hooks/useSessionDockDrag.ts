import { useEffect, useRef } from 'react';
import { flushSync } from 'react-dom';
import type { SessionTitleInteraction } from '../components/SessionTitleInteraction.js';

const duration = 200;
const easing = 'cubic-bezier(.2,.8,.2,1)';
interface PanePosition { element: HTMLElement; id: string; left: number; layoutLeft: number; width: number; order: string }
interface Gesture {
  pointerId: number; target: HTMLElement; rail: HTMLElement; pane: HTMLElement;
  panes: PanePosition[]; source: number; destination: number;
  startX: number; startY: number; x: number; scrollLeft: number; active: boolean; frame?: number;
  detach(): void;
}

function panesIn(rail: HTMLElement): HTMLElement[] {
  return [...rail.querySelectorAll<HTMLElement>(':scope > .lab-session-dock-pane')].sort((a, b) => Number(a.style.order) - Number(b.style.order));
}
function contentLeft(pane: HTMLElement, rail: HTMLElement) {
  return pane.getBoundingClientRect().left - rail.getBoundingClientRect().left + rail.scrollLeft;
}
function animateToLayout(panes: PanePosition[], rail: HTMLElement, change: () => void) {
  const before = panes.map(({ element }) => contentLeft(element, rail));
  for (const { element } of panes) element.style.removeProperty('transform');
  delete rail.dataset.dockReordering;
  flushSync(change);
  if (window.matchMedia?.('(prefers-reduced-motion: reduce)').matches) return;
  panes.forEach(({ element }, index) => {
    const delta = before[index]! - contentLeft(element, rail);
    if (Math.abs(delta) < 1 || !element.animate || !element.isConnected) return;
    element.animate([{ transform: `translate3d(${delta}px, 0, 0)` }, { transform: 'translate3d(0, 0, 0)' }], { duration, easing });
  });
}

/** Preview the whole family locally and commit one ordering operation on drop. */
export function useSessionDockDrag({ id, title, enabled, move, reorder }: {
  id: string; title: string; enabled: boolean;
  move?(id: string, offset: number): void; reorder?(id: string, target: string): void;
}): SessionTitleInteraction | undefined {
  const current = useRef({ id, move, reorder }); current.current = { id, move, reorder };
  const gesture = useRef<Gesture>();
  const suppressClickUntil = useRef(0);
  const stop = (commit: boolean, animate = true) => {
    const drag = gesture.current;
    if (!drag) return;
    gesture.current = undefined;
    drag.detach();
    if (drag.frame !== undefined) cancelAnimationFrame(drag.frame);
    if (drag.active) {
      suppressClickUntil.current = performance.now() + 400;
      const apply = () => {
        if (commit && drag.source !== drag.destination) current.current.reorder?.(current.current.id, drag.panes[drag.destination]!.id);
      };
      if (animate) animateToLayout(drag.panes, drag.rail, apply);
      else {
        for (const { element } of drag.panes) element.style.removeProperty('transform');
        delete drag.rail.dataset.dockReordering;
      }
    }
    delete drag.pane.dataset.dragging;
    if (drag.target.hasPointerCapture?.(drag.pointerId)) drag.target.releasePointerCapture(drag.pointerId);
  };
  useEffect(() => () => stop(false, false), [enabled, id]);
  if (!enabled) return undefined;
  return {
    'data-session-title-draggable': true,
    tabIndex: 0,
    'aria-label': `Move ${title}`,
    'aria-keyshortcuts': 'Alt+ArrowLeft Alt+ArrowRight',
    onPointerDown: event => {
      if (event.button !== 0 || event.isPrimary === false || gesture.current || !(event.target instanceof HTMLElement)
        || event.target.closest('input,textarea,select,[contenteditable="true"]')) return;
      const pane = event.currentTarget.closest<HTMLElement>('.lab-session-dock-pane'), rail = pane?.parentElement;
      if (!pane || !rail) return;
      const elements = panesIn(rail);
      for (const element of elements) element.getAnimations?.().forEach(animation => animation.cancel());
      const panes = elements.map(element => ({ element, id: element.dataset.dockId!, left: contentLeft(element, rail), layoutLeft: element.offsetLeft, width: element.getBoundingClientRect().width, order: element.style.order }));
      const source = panes.findIndex(item => item.element === pane);
      if (source < 0) return;
      const drag: Gesture = {
        pointerId: event.pointerId, target: event.target, pane, rail, panes, source, destination: source,
        startX: event.clientX, startY: event.clientY, x: event.clientX, scrollLeft: rail.scrollLeft, active: false, detach: () => {},
      };
      gesture.current = drag;
      const preview = (schedule = true) => {
        if (gesture.current !== drag) return;
        const live = panesIn(rail);
        // A concurrent layout edit invalidates this gesture instead of overwriting it.
        if (!pane.isConnected || live.length !== panes.length || panes.some((item, index) => live[index] !== item.element
          || item.order !== item.element.style.order || item.element.offsetLeft !== item.layoutLeft || Math.abs(item.element.getBoundingClientRect().width - item.width) > 1)) {
          stop(false); return;
        }
        const bounds = rail.getBoundingClientRect();
        const edge = 48;
        const speed = drag.x < bounds.left + edge ? -12 : drag.x > bounds.right - edge ? 12 : 0;
        if (schedule && speed) rail.scrollLeft += speed;
        const item = panes[source]!;
        const delta = Math.max(panes[0]!.left - item.left, Math.min(panes.at(-1)!.left + panes.at(-1)!.width - item.left - item.width,
          drag.x - drag.startX + rail.scrollLeft - drag.scrollLeft));
        drag.destination = source;
        // Cross the neighbor's midpoint with the moving edge, including unequal family widths.
        if (delta > 0) {
          for (let index = source + 1; index < panes.length; index++) {
            const neighbor = panes[index]!;
            if (item.left + item.width + delta > neighbor.left + neighbor.width / 2) drag.destination = index;
          }
        } else if (delta < 0) {
          for (let index = source - 1; index >= 0; index--) {
            const neighbor = panes[index]!;
            if (item.left + delta < neighbor.left + neighbor.width / 2) drag.destination = index;
          }
        }
        const ordered = panes.filter(other => other !== item);
        ordered.splice(drag.destination, 0, item);
        let left = panes[0]!.left;
        for (const next of ordered) {
          next.element.style.transform = `translate3d(${next === item ? delta : left - next.left}px, 0, 0)`;
          left += next.width;
        }
        if (schedule) drag.frame = requestAnimationFrame(() => preview());
      };
      const movePointer = (pointer: PointerEvent) => {
        if (pointer.pointerId !== drag.pointerId) return;
        drag.x = pointer.clientX;
        if (!drag.active) {
          if (Math.hypot(pointer.clientX - drag.startX, pointer.clientY - drag.startY) < 6) return;
          drag.active = true;
          pane.dataset.dragging = 'true'; rail.dataset.dockReordering = 'true';
          for (const item of panes) item.element.getAnimations?.().forEach(animation => animation.cancel());
          drag.target.setPointerCapture?.(drag.pointerId);
          preview();
        }
        pointer.preventDefault();
      };
      const finish = (pointer: PointerEvent) => {
        if (pointer.pointerId !== drag.pointerId) return;
        if (pointer.type === 'pointerup' && drag.active) { drag.x = pointer.clientX; preview(false); }
        stop(pointer.type === 'pointerup');
      };
      const escape = (key: KeyboardEvent) => { if (key.key === 'Escape') { key.preventDefault(); key.stopPropagation(); stop(false); } };
      const cancel = () => stop(false);
      window.addEventListener('pointermove', movePointer, { passive: false });
      window.addEventListener('pointerup', finish);
      window.addEventListener('pointercancel', finish);
      window.addEventListener('keydown', escape, true);
      window.addEventListener('blur', cancel);
      drag.target.addEventListener('lostpointercapture', cancel);
      drag.detach = () => {
        window.removeEventListener('pointermove', movePointer);
        window.removeEventListener('pointerup', finish);
        window.removeEventListener('pointercancel', finish);
        window.removeEventListener('keydown', escape, true);
        window.removeEventListener('blur', cancel);
        drag.target.removeEventListener('lostpointercapture', cancel);
      };
    },
    onClickCapture: event => { if (performance.now() < suppressClickUntil.current) { event.preventDefault(); event.stopPropagation(); } },
    onDoubleClickCapture: event => { if (performance.now() < suppressClickUntil.current) { event.preventDefault(); event.stopPropagation(); } },
    onKeyDown: event => {
      if (!event.altKey || event.ctrlKey || event.metaKey || !['ArrowLeft', 'ArrowRight'].includes(event.key) || gesture.current) return;
      const pane = event.currentTarget.closest<HTMLElement>('.lab-session-dock-pane'), rail = pane?.parentElement;
      if (!pane || !rail) return;
      event.preventDefault(); event.stopPropagation();
      const panes = panesIn(rail).map(element => ({ element, id: element.dataset.dockId!, left: contentLeft(element, rail), layoutLeft: element.offsetLeft, width: element.getBoundingClientRect().width, order: element.style.order }));
      animateToLayout(panes, rail, () => current.current.move?.(id, event.key === 'ArrowLeft' ? -1 : 1));
    },
  };
}
