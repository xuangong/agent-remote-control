import { useLayoutEffect, type RefObject } from 'react';
import type { FloatingPosition, Position } from './useTrackingPosition.js';

interface WindowPosition extends Position { anchor: Position }
const storageKey = 'agent-remote-ask-window-position';
const isPosition = (value: unknown): value is Position => !!value && typeof value === 'object'
  && 'x' in value && typeof value.x === 'number' && Number.isFinite(value.x)
  && 'y' in value && typeof value.y === 'number' && Number.isFinite(value.y);

/** Desktop dragging moves the window and its minimized trigger together. */
export function useAskPosition(panel: RefObject<HTMLElement>, anchor: RefObject<HTMLElement>, control: RefObject<FloatingPosition>) {
  useLayoutEffect(() => {
    const element = panel.current;
    const trigger = anchor.current;
    const viewport = element?.parentElement;
    if (!element || !trigger || !viewport) return;
    const desktop = window.matchMedia('(min-width: 1181px)');
    let manual: Position | undefined;
    let drag: { id: number; start: Position; origin: Position; anchor: Position; moved: boolean } | undefined;
    try {
      const saved: unknown = JSON.parse(localStorage.getItem(storageKey) ?? 'null');
      const point = control.current?.current();
      if (isPosition(saved) && 'anchor' in saved && isPosition(saved.anchor) && point
        && Math.abs(saved.anchor.x - point.x) < 1 && Math.abs(saved.anchor.y - point.y) < 1) manual = saved;
    } catch { /* Ignore unavailable storage or invalid positions. */ }

    const positionWindow = (next: Position) => {
      const bounds = viewport.getBoundingClientRect();
      const size = element.getBoundingClientRect();
      const point = {
        x: Math.max(12, Math.min(next.x, bounds.width - size.width - 12)),
        y: Math.max(12, Math.min(next.y, bounds.height - size.height - 12)),
      };
      element.style.setProperty('--ask-left', point.x + 'px');
      element.style.setProperty('--ask-top', point.y + 'px');
      return point;
    };
    const place = () => {
      if (!desktop.matches || drag) return;
      if (manual) { positionWindow(manual); return; }
      const bounds = viewport.getBoundingClientRect();
      const button = trigger.getBoundingClientRect();
      const size = element.getBoundingClientRect();
      const below = bounds.bottom - button.bottom - 20;
      const above = button.top - bounds.top - 20;
      const top = below >= size.height || below >= above ? button.bottom + 8 : button.top - size.height - 8;
      positionWindow({ x: button.left - bounds.left, y: top - bounds.top });
    };
    const finish = (event: PointerEvent) => {
      if (!drag || event.pointerId !== drag.id) return;
      const moved = drag.moved;
      drag = undefined;
      delete element.dataset.dragging;
      if (element.hasPointerCapture(event.pointerId)) element.releasePointerCapture(event.pointerId);
      const point = control.current?.current();
      if (moved && manual && point) {
        control.current?.move(point, true);
        const saved: WindowPosition = { ...manual, anchor: point };
        try { localStorage.setItem(storageKey, JSON.stringify(saved)); } catch { /* Keep the position for this window. */ }
      }
      place();
    };
    const down = (event: PointerEvent) => {
      if (!desktop.matches || !event.isPrimary || event.button !== 0 || !(event.target instanceof Element)
        || !event.target.closest('.lab-workbench-heading, .lab-ask-heading')
        || event.target.closest('button, a, input, textarea, select, [role="button"], [contenteditable]')) return;
      const point = control.current?.current();
      if (!point) return;
      const bounds = viewport.getBoundingClientRect();
      const rect = element.getBoundingClientRect();
      event.preventDefault();
      element.setPointerCapture(event.pointerId);
      drag = { id: event.pointerId, start: { x: event.clientX, y: event.clientY },
        origin: { x: rect.left - bounds.left, y: rect.top - bounds.top }, anchor: point, moved: false };
    };
    const move = (event: PointerEvent) => {
      if (!drag || event.pointerId !== drag.id) return;
      if (!desktop.matches) { finish(event); return; }
      const dx = event.clientX - drag.start.x, dy = event.clientY - drag.start.y;
      if (!drag.moved && Math.hypot(dx, dy) < 6) return;
      drag.moved = true;
      element.dataset.dragging = 'true';
      event.preventDefault();
      manual = positionWindow({ x: drag.origin.x + dx, y: drag.origin.y + dy });
      control.current?.move({ x: drag.anchor.x + manual.x - drag.origin.x, y: drag.anchor.y + manual.y - drag.origin.y });
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
    window.addEventListener('resize', place);
    window.visualViewport?.addEventListener('scroll', place);
    return () => {
      observer.disconnect();
      element.removeEventListener('pointerdown', down);
      element.removeEventListener('pointermove', move);
      element.removeEventListener('pointerup', finish);
      element.removeEventListener('pointercancel', finish);
      element.removeEventListener('lostpointercapture', finish);
      window.removeEventListener('resize', place);
      window.visualViewport?.removeEventListener('scroll', place);
    };
  }, [panel, anchor, control]);
}
