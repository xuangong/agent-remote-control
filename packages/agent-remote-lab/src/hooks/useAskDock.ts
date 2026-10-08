import { useLayoutEffect, type RefObject } from 'react';
import { conversationLocalStorage } from '../conversation-storage.js';

type DockEdge = 'left' | 'right';
interface Position { x: number; y: number }

/** The minimized Ask moves within its source view and docks at the released height. */
export function useAskDock(dock: RefObject<HTMLDivElement>, trigger: RefObject<HTMLButtonElement>, storageScope: string, unavailable: boolean) {
  useLayoutEffect(() => {
    const element = dock.current, button = trigger.current;
    const viewport = element?.parentElement;
    if (!element || !button || !viewport) return;
    const storageKey = `agent-remote-ask:${storageScope}:dock-edge`;
    const topKey = `agent-remote-ask:${storageScope}:dock-top`;
    let edge: DockEdge = 'right';
    let preferredTop: number | undefined;
    let suppressClick = false;
    let gesture: { id: number; startX: number; startY: number; origin: Position; position: Position; moved: boolean } | undefined;
    try {
      if (conversationLocalStorage.getItem(storageKey) === 'left') edge = 'left';
      const savedTop = conversationLocalStorage.getItem(topKey);
      if (savedTop !== null && savedTop.trim() !== '' && Number.isFinite(Number(savedTop)) && Number(savedTop) >= 0) preferredTop = Number(savedTop);
    }
    catch { /* Retain a usable dock when storage is unavailable. */ }

    const availableWidth = () => Math.max(0, viewport.getBoundingClientRect().width - element.getBoundingClientRect().width);
    const position = ({ x, y }: Position) => {
      const bounds = viewport.getBoundingClientRect(), rect = element.getBoundingClientRect();
      const width = Math.max(0, bounds.width - rect.width), height = Math.max(0, bounds.height - rect.height);
      const next = { x: Math.max(0, Math.min(x, width)), y: Math.max(0, Math.min(y, height)) };
      element.style.setProperty('--ask-dock-offset', `${next.x - width}px`);
      element.style.setProperty('--ask-dock-top', `${next.y}px`);
      return next;
    };
    const place = () => {
      if (gesture) { gesture.position = position(gesture.position); return; }
      element.dataset.dock = edge;
      if (preferredTop === undefined) element.style.removeProperty('--ask-dock-top');
      const y = preferredTop ?? element.getBoundingClientRect().top - viewport.getBoundingClientRect().top;
      position({ x: edge === 'left' ? 0 : availableWidth(), y });
    };
    const settle = (next: DockEdge) => {
      edge = next;
      element.dataset.settling = 'true';
      place();
      try {
        conversationLocalStorage.setItem(storageKey, edge);
        if (preferredTop !== undefined) conversationLocalStorage.setItem(topKey, String(preferredTop));
      }
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
      const { moved, position: point } = gesture;
      suppressClick = moved;
      release();
      if (moved) {
        preferredTop = point.y;
        settle(point.x < availableWidth() / 2 ? 'left' : 'right');
      }
      else place();
    };
    const down = (event: PointerEvent) => {
      if (unavailable || gesture || !event.isPrimary || event.button !== 0) return;
      suppressClick = false;
      const bounds = viewport.getBoundingClientRect(), rect = element.getBoundingClientRect();
      delete element.dataset.settling;
      const origin = position({ x: rect.left - bounds.left, y: rect.top - bounds.top });
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
      gesture.position = position({ x: gesture.origin.x + dx, y: gesture.origin.y + dy });
    };
    const click = (event: MouseEvent) => {
      if (!suppressClick || event.detail === 0) return;
      suppressClick = false;
      event.preventDefault();
      event.stopPropagation();
    };
    const keydown = (event: KeyboardEvent) => {
      if (unavailable || gesture || event.altKey || event.ctrlKey || event.metaKey
        || !['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown'].includes(event.key)) return;
      event.preventDefault();
      event.stopPropagation();
      if (event.key === 'ArrowUp' || event.key === 'ArrowDown') {
        const bounds = viewport.getBoundingClientRect(), rect = element.getBoundingClientRect();
        const delta = (event.shiftKey ? 40 : 10) * (event.key === 'ArrowUp' ? -1 : 1);
        preferredTop = position({ x: rect.left - bounds.left, y: rect.top - bounds.top + delta }).y;
        settle(edge);
      } else settle(event.key === 'ArrowLeft' ? 'left' : 'right');
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
