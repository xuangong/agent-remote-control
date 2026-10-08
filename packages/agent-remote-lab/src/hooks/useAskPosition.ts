import { useLayoutEffect, type RefObject } from 'react';
import { conversationLocalStorage } from '../conversation-storage.js';

interface Position { x: number; y: number }
interface WindowSize { width: number; height: number }
const margin = 12;
const floatingWidth = 600;
const floatingHeight = 440;
const isPosition = (value: unknown): value is Position => !!value && typeof value === 'object'
  && 'x' in value && typeof value.x === 'number' && Number.isFinite(value.x)
  && 'y' in value && typeof value.y === 'number' && Number.isFinite(value.y);
const isSize = (value: unknown): value is WindowSize => !!value && typeof value === 'object'
  && 'width' in value && typeof value.width === 'number' && Number.isFinite(value.width) && value.width > 0
  && 'height' in value && typeof value.height === 'number' && Number.isFinite(value.height) && value.height > 0;

/** Ask stays within its source view, retaining that view's floating geometry when space allows. */
export function useAskPosition(panel: RefObject<HTMLElement>, anchor: RefObject<HTMLElement>, storageScope: string) {
  useLayoutEffect(() => {
    const element = panel.current;
    const trigger = anchor.current;
    const viewport = element?.parentElement;
    if (!element || !trigger || !viewport) return;
    const positionKey = `agent-remote-ask:${storageScope}:window-position`;
    const sizeKey = `agent-remote-ask:${storageScope}:window-size`;
    let floating = false;
    let manual: Position | undefined;
    let preferredSize: WindowSize | undefined;
    let appliedSize: WindowSize | undefined;
    let drag: { id: number; start: Position; origin: Position; moved: boolean } | undefined;
    let resize: { id: number; start: Position; origin: Position; size: WindowSize; preferred: WindowSize; moved: boolean } | undefined;
    try {
      const saved: unknown = JSON.parse(conversationLocalStorage.getItem(positionKey) ?? 'null');
      if (isPosition(saved)) manual = saved;
    } catch { /* Keep usable defaults when storage is unavailable. */ }
    try {
      const saved: unknown = JSON.parse(conversationLocalStorage.getItem(sizeKey) ?? 'null');
      if (isSize(saved)) preferredSize = saved;
    } catch { /* Keep usable defaults when storage is unavailable. */ }

    const positionWindow = (next: Position) => {
      const bounds = viewport.getBoundingClientRect();
      const size = appliedSize ?? element.getBoundingClientRect();
      const point = {
        x: Math.max(margin, Math.min(next.x, bounds.width - size.width - margin)),
        y: Math.max(margin, Math.min(next.y, bounds.height - size.height - margin)),
      };
      element.style.setProperty('--ask-left', point.x + 'px');
      element.style.setProperty('--ask-top', point.y + 'px');
      return point;
    };
    const sizeWindow = (next: WindowSize, origin: Position = { x: margin, y: margin }) => {
      const bounds = viewport.getBoundingClientRect();
      const size = {
        width: Math.min(Math.max(0, bounds.width - origin.x - margin), Math.max(360, next.width)),
        height: Math.min(Math.max(0, bounds.height - origin.y - margin), Math.max(320, next.height)),
      };
      element.style.setProperty('--ask-width', size.width + 'px');
      element.style.setProperty('--ask-height', size.height + 'px');
      appliedSize = size;
      return size;
    };
    const resizeWindow = (next: WindowSize, origin: Position, delta: Position, previous: WindowSize) => {
      const size = sizeWindow({ width: delta.x === 0 ? previous.width : next.width, height: delta.y === 0 ? previous.height : next.height }, origin);
      preferredSize = { width: delta.x === 0 ? previous.width : size.width, height: delta.y === 0 ? previous.height : size.height };
      manual = positionWindow(origin);
    };
    const clearGesture = () => {
      const gesture = drag ?? resize;
      drag = undefined;
      resize = undefined;
      delete element.dataset.dragging;
      delete element.dataset.resizing;
      if (gesture && element.hasPointerCapture(gesture.id)) element.releasePointerCapture(gesture.id);
    };
    const place = () => {
      const bounds = viewport.getBoundingClientRect();
      floating = bounds.width >= floatingWidth && bounds.height >= floatingHeight;
      viewport.dataset.presentation = floating ? 'floating' : 'overlay';
      if (!floating) { clearGesture(); return; }
      if (drag || resize) return;
      const size = sizeWindow(preferredSize ?? { width: 440, height: 560 });
      const button = trigger.getBoundingClientRect();
      positionWindow(manual ?? { x: bounds.width - size.width - margin, y: button.top - bounds.top });
    };
    const persist = () => {
      try {
        if (manual) conversationLocalStorage.setItem(positionKey, JSON.stringify(manual));
        if (preferredSize) conversationLocalStorage.setItem(sizeKey, JSON.stringify(preferredSize));
      } catch { /* Keep the geometry for this mounted view. */ }
    };
    const finish = (event: PointerEvent) => {
      const gesture = drag ?? resize;
      if (!gesture || event.pointerId !== gesture.id) return;
      const moved = gesture.moved;
      clearGesture();
      if (moved) persist();
      place();
    };
    const down = (event: PointerEvent) => {
      if (!floating || !event.isPrimary || event.button !== 0 || !(event.target instanceof Element) || drag || resize) return;
      const handle = event.target.closest<HTMLButtonElement>('.lab-ask-resize');
      if (!handle && (!event.target.closest('.lab-workbench-heading, .lab-ask-heading')
        || event.target.closest('button, a, input, textarea, select, [role="button"], [contenteditable]'))) return;
      const bounds = viewport.getBoundingClientRect();
      const rect = element.getBoundingClientRect();
      const start = { x: event.clientX, y: event.clientY };
      const origin = { x: rect.left - bounds.left, y: rect.top - bounds.top };
      event.preventDefault();
      element.setPointerCapture(event.pointerId);
      if (handle) {
        handle.focus({ preventScroll: true });
        const size = { width: rect.width, height: rect.height };
        resize = { id: event.pointerId, start, origin, size, preferred: preferredSize ?? size, moved: false };
      } else drag = { id: event.pointerId, start, origin, moved: false };
    };
    const move = (event: PointerEvent) => {
      const gesture = drag ?? resize;
      if (!gesture || event.pointerId !== gesture.id) return;
      const dx = event.clientX - gesture.start.x, dy = event.clientY - gesture.start.y;
      if (!gesture.moved && Math.hypot(dx, dy) < 6) return;
      gesture.moved = true;
      event.preventDefault();
      if (resize) {
        element.dataset.resizing = 'true';
        resizeWindow({ width: resize.size.width + dx, height: resize.size.height + dy }, resize.origin, { x: dx, y: dy }, resize.preferred);
      } else if (drag) {
        element.dataset.dragging = 'true';
        manual = positionWindow({ x: drag.origin.x + dx, y: drag.origin.y + dy });
      }
    };
    const keydown = (event: KeyboardEvent) => {
      if (!floating || drag || resize || event.altKey || event.ctrlKey || event.metaKey
        || !(event.target instanceof Element) || !event.target.closest('.lab-ask-resize')) return;
      const direction: Record<string, Position> = { ArrowLeft: { x: -1, y: 0 }, ArrowRight: { x: 1, y: 0 }, ArrowUp: { x: 0, y: -1 }, ArrowDown: { x: 0, y: 1 } };
      const delta = direction[event.key];
      if (!delta) return;
      event.preventDefault();
      event.stopPropagation();
      const bounds = viewport.getBoundingClientRect();
      const rect = element.getBoundingClientRect();
      const origin = { x: rect.left - bounds.left, y: rect.top - bounds.top };
      const step = event.shiftKey ? 40 : 10;
      const size = appliedSize ?? rect;
      resizeWindow({ width: size.width + delta.x * step, height: size.height + delta.y * step }, origin, delta, preferredSize ?? size);
      persist();
    };
    place();
    const observer = new ResizeObserver(place);
    observer.observe(trigger);
    observer.observe(viewport);
    element.addEventListener('pointerdown', down);
    element.addEventListener('pointermove', move);
    element.addEventListener('pointerup', finish);
    element.addEventListener('pointercancel', finish);
    element.addEventListener('lostpointercapture', finish);
    element.addEventListener('keydown', keydown);
    return () => {
      observer.disconnect();
      element.removeEventListener('pointerdown', down);
      element.removeEventListener('pointermove', move);
      element.removeEventListener('pointerup', finish);
      element.removeEventListener('pointercancel', finish);
      element.removeEventListener('lostpointercapture', finish);
      element.removeEventListener('keydown', keydown);
      clearGesture();
    };
  }, [panel, anchor, storageScope]);
}
