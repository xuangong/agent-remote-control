import { useLayoutEffect, useRef, useState, type CSSProperties, type HTMLAttributes } from 'react';

interface Position { x: number; y: number }
const storageKey = 'agent-remote-tracking-position';
const margin = 12;

function viewport() {
  const view = window.visualViewport;
  return { x: view?.offsetLeft ?? 0, y: view?.offsetTop ?? 0, width: view?.width ?? window.innerWidth, height: view?.height ?? window.innerHeight };
}

export function useTrackingPosition() {
  const root = useRef<HTMLDivElement>(null);
  const position = useRef<Position>();
  const drag = useRef<{ id: number; start: Position; origin: Position; moved: boolean }>();
  const suppressClick = useRef(false);
  const [style, setStyle] = useState<CSSProperties>({});

  function move(next: Position, persist = false) {
    const element = root.current;
    if (!element) return;
    const rect = element.getBoundingClientRect(), view = viewport();
    const point = {
      x: Math.max(view.x + margin, Math.min(next.x, view.x + view.width - rect.width - margin)),
      y: Math.max(view.y + margin, Math.min(next.y, view.y + view.height - rect.height - margin)),
    };
    position.current = point;
    const below = view.y + view.height - point.y - rect.height - margin - 8;
    const above = point.y - view.y - margin - 8;
    const openAbove = above > below;
    setStyle({ left: point.x, top: point.y, right: 'auto',
      '--tracking-panel-left': `${Math.max(view.x + margin, Math.min(point.x, view.x + view.width - Math.min(360, view.width - 2 * margin) - margin))}px`,
      '--tracking-panel-top': openAbove ? 'auto' : `${point.y + rect.height + 8}px`,
      '--tracking-panel-bottom': openAbove ? `${window.innerHeight - point.y + 8}px` : 'auto',
      '--tracking-panel-height': `${Math.max(0, Math.min(560, openAbove ? above : below))}px`,
      '--tracking-panel-width': `${Math.min(360, view.width - 2 * margin)}px`,
    } as CSSProperties);
    if (persist) { try { localStorage.setItem(storageKey, JSON.stringify(point)); } catch { /* Position remains usable without storage. */ } }
  }

  useLayoutEffect(() => {
    const rect = root.current?.getBoundingClientRect();
    if (!rect) return;
    let initial = { x: rect.left, y: rect.top };
    try {
      const saved: unknown = JSON.parse(localStorage.getItem(storageKey) ?? 'null');
      if (saved && typeof saved === 'object' && 'x' in saved && 'y' in saved
        && typeof saved.x === 'number' && Number.isFinite(saved.x) && typeof saved.y === 'number' && Number.isFinite(saved.y)) initial = { x: saved.x, y: saved.y };
    } catch { /* Ignore invalid saved positions. */ }
    move(initial);
    const resize = () => { if (position.current) move(position.current); };
    window.addEventListener('resize', resize);
    window.visualViewport?.addEventListener('resize', resize);
    window.visualViewport?.addEventListener('scroll', resize);
    const observer = typeof ResizeObserver === 'undefined' ? undefined : new ResizeObserver(resize);
    observer?.observe(root.current!);
    return () => {
      observer?.disconnect();
      window.removeEventListener('resize', resize);
      window.visualViewport?.removeEventListener('resize', resize);
      window.visualViewport?.removeEventListener('scroll', resize);
    };
  }, []);

  const isTrigger = (target: EventTarget) => target instanceof Element && !!target.closest('.lab-session-popover-trigger');
  const handlers: HTMLAttributes<HTMLDivElement> = {
    onPointerDownCapture(event) {
      if (!isTrigger(event.target) || event.button !== 0 || !event.isPrimary) return;
      const rect = event.currentTarget.getBoundingClientRect();
      suppressClick.current = false;
      if (event.target instanceof Element) event.target.closest('button')?.setPointerCapture(event.pointerId);
      drag.current = { id: event.pointerId, start: { x: event.clientX, y: event.clientY }, origin: { x: rect.left, y: rect.top }, moved: false };
    },
    onPointerMoveCapture(event) {
      const value = drag.current;
      if (!value || value.id !== event.pointerId) return;
      const dx = event.clientX - value.start.x, dy = event.clientY - value.start.y;
      if (!value.moved && Math.hypot(dx, dy) < 6) return;
      value.moved = true;
      event.preventDefault();
      move({ x: value.origin.x + dx, y: value.origin.y + dy });
    },
    onPointerUpCapture(event) {
      const value = drag.current;
      if (!value || value.id !== event.pointerId) return;
      suppressClick.current = value.moved;
      if (value.moved && position.current) move(position.current, true);
      if (event.currentTarget.hasPointerCapture(event.pointerId)) event.currentTarget.releasePointerCapture(event.pointerId);
      drag.current = undefined;
    },
    onPointerCancel() { drag.current = undefined; suppressClick.current = false; },
    onLostPointerCapture() { drag.current = undefined; },
    onClickCapture(event) {
      if (suppressClick.current) { event.preventDefault(); event.stopPropagation(); suppressClick.current = false; }
    },
    onKeyDownCapture(event) {
      if (!isTrigger(event.target) || event.altKey || event.ctrlKey || event.metaKey || !position.current) return;
      const direction: Record<string, Position> = { ArrowLeft: { x: -1, y: 0 }, ArrowRight: { x: 1, y: 0 }, ArrowUp: { x: 0, y: -1 }, ArrowDown: { x: 0, y: 1 } };
      const delta = direction[event.key];
      if (!delta) return;
      event.preventDefault(); event.stopPropagation();
      const step = event.shiftKey ? 40 : 10;
      move({ x: position.current.x + delta.x * step, y: position.current.y + delta.y * step }, true);
    },
  };
  return { root, style, handlers };
}
