import { useLayoutEffect, useRef, useState, type CSSProperties, type HTMLAttributes } from 'react';

export interface Position { x: number; y: number }
export interface FloatingPosition {
  move(next: Position, persist?: boolean): Position | undefined;
  current(): Position | undefined;
}
const margin = 12;
const gap = 8;

function viewport() {
  const view = window.visualViewport;
  return { x: view?.offsetLeft ?? 0, y: view?.offsetTop ?? 0, width: view?.width ?? window.innerWidth, height: view?.height ?? window.innerHeight };
}
type View = ReturnType<typeof viewport>;
function clamp(next: Position, size: { width: number; height: number }, view: View): Position {
  return {
    x: Math.max(view.x + margin, Math.min(next.x, view.x + view.width - size.width - margin)),
    y: Math.max(view.y + margin, Math.min(next.y, view.y + view.height - size.height - margin)),
  };
}

interface FloatingEntry {
  element: HTMLElement;
  /** Where the owner put the entry, relative to the visible area; only the owner changes it. */
  placement?: Position;
  /** The fixed CSS point of an entry being dragged, which the arrangement leaves in place. */
  held(): Position | undefined;
  show(point: Position, view: View): void;
}
const entries = new Set<FloatingEntry>();

/**
 * The stylesheet places an entry on the unobscured screen, as the owner does. A hidden entry has no laid-out
 * position yet, so its placement is read once it is shown and before it is ever positioned inline.
 */
function stylesheetPlacement(element: HTMLElement): Position | undefined {
  const resolved = getComputedStyle(element);
  if (resolved.display === 'none') return undefined;
  const rect = element.getBoundingClientRect(), left = parseFloat(resolved.left), top = parseFloat(resolved.top);
  // Fixed CSS coordinates and client rect coordinates differ in WebKit when
  // the keyboard moves the visual viewport. Keep positioning in CSS space.
  return { x: Number.isFinite(left) ? left : rect.left, y: Number.isFinite(top) ? top : rect.top };
}

/**
 * Shows every entry at its placement within the visible area, which the software keyboard shrinks and pans.
 * An entry the visible area moves pushes the entries above it upward instead of covering them, so the
 * column keeps its order; entries the owner placed over each other stay where they are. The shell also calls
 * this when it samples keyboard bounds that WebKit exposes after its viewport events.
 */
export function arrangeFloatingEntries() {
  const view = viewport();
  const items = [...entries].flatMap(entry => {
    const placement = entry.placement ??= stylesheetPlacement(entry.element);
    if (!placement) return [];
    const { width, height } = entry.element.getBoundingClientRect(), size = { width, height };
    const held = entry.held();
    const desired = held ?? { x: view.x + placement.x, y: view.y + placement.y };
    const point = clamp(desired, size, view);
    return [{ entry, size, desired, point, held: !!held, moved: point.x !== desired.x || point.y !== desired.y,
      solid: width > 0 && height > 0 && getComputedStyle(entry.element).visibility !== 'hidden' }];
  }).sort((a, b) => b.desired.y + b.size.height - a.desired.y - a.size.height);
  type Item = typeof items[number];
  const overlaps = (a: Item, b: Item) => a.point.x < b.point.x + b.size.width && b.point.x < a.point.x + a.size.width
    && a.point.y < b.point.y + b.size.height + gap && b.point.y < a.point.y + a.size.height + gap;
  const placed: Item[] = [];
  for (const item of items) {
    const below = () => placed.find(other => (item.moved || other.moved) && overlaps(item, other));
    for (let other = item.solid && !item.held ? below() : undefined; other; other = below()) {
      const y = Math.max(view.y + margin, other.point.y - item.size.height - gap);
      if (y === item.point.y) break;
      item.point = { x: item.point.x, y }; item.moved = true;
    }
    if (item.solid) placed.push(item);
    if (!item.held) item.entry.show(item.point, view);
  }
}

export function useTrackingPosition(storageKey = 'agent-remote-tracking-position', triggerSelector = '.lab-session-popover-trigger') {
  const root = useRef<HTMLDivElement>(null);
  /** The point shown, in fixed CSS coordinates. */
  const position = useRef<Position>();
  const entry = useRef<FloatingEntry>();
  const drag = useRef<{ id: number; start: Position; origin: Position; moved: boolean }>();
  const suppressClick = useRef(false);
  const shownStyle = useRef<string>();
  // A consumer can render its root after mounting, as Team does once workspace access is confirmed.
  const [element, setElement] = useState<HTMLDivElement | null>(null);
  useLayoutEffect(() => { if (root.current !== element) setElement(root.current); });
  /** A root rendered again keeps its placement; its inline style no longer shows the stylesheet's. */
  const kept = useRef<{ storageKey: string; placement: Position }>();
  const [style, setStyle] = useState<CSSProperties>({});
  const [edge, setEdge] = useState<'right'>();

  function show(point: Position, view: View) {
    const element = root.current;
    if (!element) return;
    const rect = element.getBoundingClientRect();
    position.current = point;
    setEdge(point.x + rect.width >= view.x + view.width - margin - 1 ? 'right' : undefined);
    const below = view.y + view.height - point.y - rect.height - margin - 8;
    const above = point.y - view.y - margin - 8;
    const openAbove = above > below;
    const next = { left: point.x, top: point.y, right: 'auto',
      '--tracking-panel-left': `${Math.max(view.x + margin, Math.min(point.x, view.x + view.width - Math.min(360, view.width - 2 * margin) - margin))}px`,
      '--tracking-panel-top': openAbove ? 'auto' : `${point.y + rect.height + 8}px`,
      '--tracking-panel-bottom': openAbove ? `${window.innerHeight - point.y + 8}px` : 'auto',
      '--tracking-panel-height': `${Math.max(0, Math.min(560, openAbove ? above : below))}px`,
      '--tracking-panel-width': `${Math.min(360, view.width - 2 * margin)}px`,
    } as CSSProperties;
    // Every entry arranges the others on a viewport change; render only what changed.
    const key = JSON.stringify(next);
    if (key !== shownStyle.current) { shownStyle.current = key; setStyle(next); }
  }

  /** Moves the entry for its owner; a persisted move sets its placement within the visible area. */
  function move(next: Position, persist = false) {
    const element = root.current;
    if (!element) return;
    const view = viewport(), point = clamp(next, element.getBoundingClientRect(), view);
    show(point, view);
    if (persist && entry.current) {
      entry.current.placement = { x: point.x - view.x, y: point.y - view.y };
      try { localStorage.setItem(storageKey, JSON.stringify(entry.current.placement)); } catch { /* Position remains usable without storage. */ }
      arrangeFloatingEntries();
    }
    return point;
  }

  useLayoutEffect(() => {
    if (!element) return;
    let placement: Position | undefined;
    try {
      const saved: unknown = JSON.parse(localStorage.getItem(storageKey) ?? 'null');
      if (saved && typeof saved === 'object' && 'x' in saved && 'y' in saved
        && typeof saved.x === 'number' && Number.isFinite(saved.x) && typeof saved.y === 'number' && Number.isFinite(saved.y)) placement = { x: saved.x, y: saved.y };
    } catch { /* Ignore invalid saved positions. */ }
    placement ??= kept.current?.storageKey === storageKey ? kept.current.placement : undefined;
    const current: FloatingEntry = { element, placement, held: () => drag.current && position.current, show };
    entry.current = current;
    entries.add(current);
    arrangeFloatingEntries();
    const resize = () => {
      const previous = position.current, value = drag.current;
      if (value && previous) {
        const next = move(previous);
        if (next) {
          value.origin.x += next.x - previous.x;
          value.origin.y += next.y - previous.y;
        }
      }
      arrangeFloatingEntries();
    };
    window.addEventListener('resize', resize);
    window.visualViewport?.addEventListener('resize', resize);
    window.visualViewport?.addEventListener('scroll', resize);
    const observer = typeof ResizeObserver === 'undefined' ? undefined : new ResizeObserver(resize);
    observer?.observe(element);
    return () => {
      if (current.placement) kept.current = { storageKey, placement: current.placement };
      entries.delete(current);
      entry.current = undefined;
      observer?.disconnect();
      window.removeEventListener('resize', resize);
      window.visualViewport?.removeEventListener('resize', resize);
      window.visualViewport?.removeEventListener('scroll', resize);
      arrangeFloatingEntries();
    };
  }, [storageKey, element]);

  const isTrigger = (target: EventTarget) => target instanceof Element && !!target.closest(triggerSelector);
  const handlers: HTMLAttributes<HTMLDivElement> = {
    onPointerDownCapture(event) {
      if (!isTrigger(event.target) || event.button !== 0 || !event.isPrimary) return;
      if (!position.current) return;
      suppressClick.current = false;
      if (event.target instanceof Element) event.target.closest('button')?.setPointerCapture(event.pointerId);
      drag.current = { id: event.pointerId, start: { x: event.clientX, y: event.clientY }, origin: { ...position.current }, moved: false };
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
  /** `edge` reports a position held against the right viewport margin. */
  return { root, style, handlers, edge, move, current: () => position.current };
}
