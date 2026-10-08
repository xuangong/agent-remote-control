import { useLayoutEffect, type RefObject } from 'react';
import type { FloatingPosition, Position } from './useTrackingPosition.js';

interface WindowPosition extends Position { anchor: Position }
interface WindowSize { width: number; height: number }
const storageKey = 'agent-remote-ask-window-position';
const sizeStorageKey = 'agent-remote-ask-window-size';
const margin = 12;
const isPosition = (value: unknown): value is Position => !!value && typeof value === 'object'
  && 'x' in value && typeof value.x === 'number' && Number.isFinite(value.x)
  && 'y' in value && typeof value.y === 'number' && Number.isFinite(value.y);
const isSize = (value: unknown): value is WindowSize => !!value && typeof value === 'object'
  && 'width' in value && typeof value.width === 'number' && Number.isFinite(value.width) && value.width > 0
  && 'height' in value && typeof value.height === 'number' && Number.isFinite(value.height) && value.height > 0;

/** Desktop dragging moves the window and its minimized trigger together. Resizing keeps the top-left corner fixed. */
export function useAskPosition(panel: RefObject<HTMLElement>, anchor: RefObject<HTMLElement>, control: RefObject<FloatingPosition>) {
  useLayoutEffect(() => {
    const element = panel.current;
    const trigger = anchor.current;
    const viewport = element?.parentElement;
    if (!element || !trigger || !viewport) return;
    const desktop = window.matchMedia('(min-width: 1181px)');
    let manual: Position | undefined;
    let preferredSize: WindowSize | undefined;
    let appliedSize: WindowSize | undefined;
    let drag: { id: number; start: Position; origin: Position; anchor: Position; moved: boolean } | undefined;
    let resize: { id: number; start: Position; origin: Position; size: WindowSize; preferred: WindowSize; moved: boolean } | undefined;
    try {
      const saved: unknown = JSON.parse(localStorage.getItem(storageKey) ?? 'null');
      const point = control.current?.current();
      if (isPosition(saved) && 'anchor' in saved && isPosition(saved.anchor) && point
        && Math.abs(saved.anchor.x - point.x) < 1 && Math.abs(saved.anchor.y - point.y) < 1) manual = saved;
    } catch { /* Ignore unavailable storage or invalid positions. */ }
    try {
      const saved: unknown = JSON.parse(localStorage.getItem(sizeStorageKey) ?? 'null');
      if (isSize(saved)) preferredSize = saved;
    } catch { /* Ignore unavailable storage or invalid sizes. */ }

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
      const maximumWidth = Math.max(0, bounds.width - origin.x - margin);
      const maximumHeight = Math.max(0, bounds.height - origin.y - margin);
      const size = {
        width: Math.min(maximumWidth, Math.max(360, next.width)),
        height: Math.min(maximumHeight, Math.max(320, next.height)),
      };
      element.style.setProperty('--ask-width', size.width + 'px');
      element.style.setProperty('--ask-height', size.height + 'px');
      element.dataset.resized = 'true';
      appliedSize = size;
      return size;
    };
    const resizeWindow = (next: WindowSize, origin: Position, delta: Position, previous: WindowSize) => {
      const size = sizeWindow({
        width: delta.x === 0 ? previous.width : next.width,
        height: delta.y === 0 ? previous.height : next.height,
      }, origin);
      preferredSize = {
        width: delta.x === 0 ? previous.width : size.width,
        height: delta.y === 0 ? previous.height : size.height,
      };
      manual = positionWindow(origin);
    };
    const place = () => {
      if (!desktop.matches || drag || resize) return;
      if (preferredSize) sizeWindow(preferredSize);
      if (manual) { positionWindow(manual); return; }
      const bounds = viewport.getBoundingClientRect();
      const button = trigger.getBoundingClientRect();
      const size = appliedSize ?? element.getBoundingClientRect();
      const below = bounds.bottom - button.bottom - 20;
      const above = button.top - bounds.top - 20;
      const top = below >= size.height || below >= above ? button.bottom + 8 : button.top - size.height - 8;
      positionWindow({ x: button.left - bounds.left, y: top - bounds.top });
    };
    const persist = () => {
      const point = control.current?.current();
      if (manual && point) {
        control.current?.move(point, true);
        const saved: WindowPosition = { ...manual, anchor: point };
        try { localStorage.setItem(storageKey, JSON.stringify(saved)); } catch { /* Keep the position for this window. */ }
      }
      if (preferredSize) {
        try { localStorage.setItem(sizeStorageKey, JSON.stringify(preferredSize)); } catch { /* Keep the size for this window. */ }
      }
    };
    const finish = (event: PointerEvent) => {
      const gesture = drag ?? resize;
      if (!gesture || event.pointerId !== gesture.id) return;
      const moved = gesture.moved;
      drag = undefined;
      resize = undefined;
      delete element.dataset.dragging;
      delete element.dataset.resizing;
      if (element.hasPointerCapture(event.pointerId)) element.releasePointerCapture(event.pointerId);
      if (moved) persist();
      place();
    };
    const down = (event: PointerEvent) => {
      if (!desktop.matches || !event.isPrimary || event.button !== 0 || !(event.target instanceof Element) || drag || resize) return;
      const handle = event.target.closest<HTMLButtonElement>('.lab-ask-resize');
      if (!handle && (!event.target.closest('.lab-workbench-heading, .lab-ask-heading')
        || event.target.closest('button, a, input, textarea, select, [role="button"], [contenteditable]'))) return;
      const point = control.current?.current();
      if (!point) return;
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
      } else drag = { id: event.pointerId, start, origin, anchor: point, moved: false };
    };
    const move = (event: PointerEvent) => {
      const gesture = drag ?? resize;
      if (!gesture || event.pointerId !== gesture.id) return;
      if (!desktop.matches) { finish(event); return; }
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
        control.current?.move({ x: drag.anchor.x + manual.x - drag.origin.x, y: drag.anchor.y + manual.y - drag.origin.y });
      }
    };
    const keydown = (event: KeyboardEvent) => {
      if (!desktop.matches || drag || resize || event.altKey || event.ctrlKey || event.metaKey
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
    observer.observe(element);
    observer.observe(trigger);
    observer.observe(viewport);
    element.addEventListener('pointerdown', down);
    element.addEventListener('pointermove', move);
    element.addEventListener('pointerup', finish);
    element.addEventListener('pointercancel', finish);
    element.addEventListener('lostpointercapture', finish);
    element.addEventListener('keydown', keydown);
    desktop.addEventListener('change', place);
    window.addEventListener('resize', place);
    window.visualViewport?.addEventListener('resize', place);
    window.visualViewport?.addEventListener('scroll', place);
    return () => {
      observer.disconnect();
      element.removeEventListener('pointerdown', down);
      element.removeEventListener('pointermove', move);
      element.removeEventListener('pointerup', finish);
      element.removeEventListener('pointercancel', finish);
      element.removeEventListener('lostpointercapture', finish);
      element.removeEventListener('keydown', keydown);
      desktop.removeEventListener('change', place);
      window.removeEventListener('resize', place);
      window.visualViewport?.removeEventListener('resize', place);
      window.visualViewport?.removeEventListener('scroll', place);
    };
  }, [panel, anchor, control]);
}
