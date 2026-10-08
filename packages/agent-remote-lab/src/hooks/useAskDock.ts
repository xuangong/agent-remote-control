import { useLayoutEffect, type RefObject } from 'react';
import { conversationLocalStorage } from '../conversation-storage.js';

type DockEdge = 'left' | 'right';

/** The minimized Ask travels along one row inside its source Session View. */
export function useAskDock(dock: RefObject<HTMLDivElement>, trigger: RefObject<HTMLButtonElement>, storageScope: string, unavailable: boolean) {
  useLayoutEffect(() => {
    const element = dock.current, button = trigger.current;
    const viewport = element?.parentElement;
    if (!element || !button || !viewport) return;
    const storageKey = `agent-remote-ask:${storageScope}:dock-edge`;
    let edge: DockEdge = 'right';
    let suppressClick = false;
    let gesture: { id: number; startX: number; startY: number; origin: number; position: number; moved: boolean } | undefined;
    try { if (conversationLocalStorage.getItem(storageKey) === 'left') edge = 'left'; }
    catch { /* Retain a usable dock when storage is unavailable. */ }

    const availableWidth = () => Math.max(0, viewport.getBoundingClientRect().width - element.getBoundingClientRect().width);
    const position = (x: number) => {
      const width = availableWidth();
      const next = Math.max(0, Math.min(x, width));
      element.style.setProperty('--ask-dock-offset', `${next - width}px`);
      return next;
    };
    const place = () => {
      if (gesture) { gesture.position = position(gesture.position); return; }
      element.dataset.dock = edge;
      position(edge === 'left' ? 0 : availableWidth());
    };
    const settle = (next: DockEdge) => {
      edge = next;
      element.dataset.settling = 'true';
      place();
      try { conversationLocalStorage.setItem(storageKey, edge); }
      catch { /* The current source view can still retain its dock. */ }
    };
    const release = () => {
      const id = gesture?.id;
      gesture = undefined;
      delete element.dataset.dragging;
      if (id !== undefined && button.hasPointerCapture(id)) button.releasePointerCapture(id);
    };
    const finish = (event: PointerEvent) => {
      if (!gesture || event.pointerId !== gesture.id) return;
      const { moved, position: x } = gesture;
      suppressClick = moved;
      release();
      if (moved) settle(x < availableWidth() / 2 ? 'left' : 'right');
      else place();
    };
    const down = (event: PointerEvent) => {
      if (unavailable || gesture || !event.isPrimary || event.button !== 0) return;
      suppressClick = false;
      const bounds = viewport.getBoundingClientRect(), rect = element.getBoundingClientRect();
      delete element.dataset.settling;
      const origin = position(rect.left - bounds.left);
      gesture = { id: event.pointerId, startX: event.clientX, startY: event.clientY, origin, position: origin, moved: false };
      button.setPointerCapture(event.pointerId);
    };
    const move = (event: PointerEvent) => {
      if (!gesture || event.pointerId !== gesture.id) return;
      const dx = event.clientX - gesture.startX, dy = event.clientY - gesture.startY;
      if (!gesture.moved && Math.hypot(dx, dy) < 6) return;
      gesture.moved = true;
      event.preventDefault();
      event.stopPropagation();
      element.dataset.dragging = 'true';
      gesture.position = position(gesture.origin + dx);
    };
    const click = (event: MouseEvent) => {
      if (!suppressClick || event.detail === 0) return;
      suppressClick = false;
      event.preventDefault();
      event.stopPropagation();
    };
    const keydown = (event: KeyboardEvent) => {
      if (unavailable || gesture || event.altKey || event.ctrlKey || event.metaKey
        || (event.key !== 'ArrowLeft' && event.key !== 'ArrowRight')) return;
      event.preventDefault();
      event.stopPropagation();
      settle(event.key === 'ArrowLeft' ? 'left' : 'right');
    };
    const settled = (event: TransitionEvent) => {
      if (event.target === element && event.propertyName === 'transform') delete element.dataset.settling;
    };
    place();
    const observer = new ResizeObserver(place);
    observer.observe(viewport);
    observer.observe(element);
    button.addEventListener('pointerdown', down);
    button.addEventListener('pointermove', move);
    button.addEventListener('pointerup', finish);
    button.addEventListener('pointercancel', finish);
    button.addEventListener('lostpointercapture', finish);
    button.addEventListener('click', click, true);
    button.addEventListener('keydown', keydown);
    element.addEventListener('transitionend', settled);
    return () => {
      observer.disconnect();
      button.removeEventListener('pointerdown', down);
      button.removeEventListener('pointermove', move);
      button.removeEventListener('pointerup', finish);
      button.removeEventListener('pointercancel', finish);
      button.removeEventListener('lostpointercapture', finish);
      button.removeEventListener('click', click, true);
      button.removeEventListener('keydown', keydown);
      element.removeEventListener('transitionend', settled);
      release();
    };
  }, [dock, trigger, storageScope, unavailable]);
}
