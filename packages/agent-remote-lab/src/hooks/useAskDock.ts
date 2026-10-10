import { useLayoutEffect, type RefObject } from 'react';
import { clearCacheOnClose, conversationLocalStorage } from '../conversation-storage.js';
import { recoveryGeneration } from '../conversation-recovery.js';
import { askGeometryRecoveryScope } from './useAskPosition.js';

type DockEdge = 'left' | 'right';
interface Position { x: number; y: number }
export interface AskDockSnapshot { status: 'ready' | 'failed' | 'cancelled' | 'pending'; revision: number; edge: DockEdge; top?: number; retention: 'page' | 'local' }
interface DockEntry extends AskDockSnapshot { initialized: boolean; dirty: boolean; generation: number; moving: boolean }
const docks = new Map<string, DockEntry>();
function readDock(scope: string): { edge: DockEdge; top?: number } {
  const edge = conversationLocalStorage.getItem(`agent-remote-ask:${scope}:dock-edge`);
  const top = conversationLocalStorage.getItem(`agent-remote-ask:${scope}:dock-top`);
  if (edge !== null && edge !== 'left' && edge !== 'right' || top !== null && (top.trim() === '' || !Number.isFinite(Number(top)) || Number(top) < 0)) throw new Error('Invalid Ask dock.');
  return { edge: edge === 'left' ? 'left' : 'right', ...(top === null ? {} : { top: Number(top) }) };
}
function dockEntry(scope: string): DockEntry {
  const generation = recoveryGeneration(askGeometryRecoveryScope(scope));
  const previous = docks.get(scope);
  if (previous?.generation === generation && (previous.dirty || previous.moving)) return previous;
  const entry: DockEntry = previous?.generation === generation ? previous : { edge: 'right', revision: 0, status: 'ready', retention: clearCacheOnClose() ? 'page' : 'local', initialized: false, dirty: false, generation, moving: false };
  try {
    const saved = readDock(scope);
    if (entry.initialized && (entry.edge !== saved.edge || entry.top !== saved.top)) entry.revision++;
    entry.edge = saved.edge; entry.top = saved.top; entry.initialized = true; entry.status = 'ready';
  } catch { entry.initialized = false; entry.status = 'failed'; entry.retention = 'page'; }
  docks.set(scope, entry); return entry;
}
function dockSnapshot(entry: DockEntry): AskDockSnapshot { return { status: entry.moving ? 'pending' : entry.status, revision: entry.revision, edge: entry.edge, ...(entry.top === undefined ? {} : { top: entry.top }), retention: entry.retention }; }
export function inspectAskDock(scope: string): AskDockSnapshot { return dockSnapshot(dockEntry(scope)); }
export function flushAskDock(scope: string, revision: number, isCurrent: () => boolean): AskDockSnapshot {
  const entry = dockEntry(scope), current = () => isCurrent() && entry.generation === recoveryGeneration(askGeometryRecoveryScope(scope)) && entry.revision === revision && docks.get(scope) === entry;
  if (!current()) return { ...dockSnapshot(entry), status: 'cancelled', retention: 'page' };
  if (entry.moving) return { ...dockSnapshot(entry), status: 'pending', retention: 'page' };
  try {
    if (!entry.initialized) { readDock(scope); entry.initialized = true; }
    if (entry.dirty) {
      conversationLocalStorage.setItem(`agent-remote-ask:${scope}:dock-edge`, entry.edge);
      if (!current()) return { ...dockSnapshot(entry), status: 'cancelled', retention: 'page' };
      if (entry.top !== undefined) conversationLocalStorage.setItem(`agent-remote-ask:${scope}:dock-top`, String(entry.top));
    }
    if (!current()) return { ...dockSnapshot(entry), status: 'cancelled', retention: 'page' };
    entry.dirty = false; entry.status = 'ready'; entry.retention = clearCacheOnClose() ? 'page' : 'local';
  } catch { entry.initialized = false; entry.status = 'failed'; entry.retention = 'page'; }
  return dockSnapshot(entry);
}

/** The minimized Ask moves within its source view and docks at the released height. */
export function useAskDock(dock: RefObject<HTMLDivElement>, trigger: RefObject<HTMLButtonElement>, storageScope: string, unavailable: boolean) {
  useLayoutEffect(() => {
    const element = dock.current, button = trigger.current;
    const viewport = element?.parentElement;
    if (!element || !button || !viewport) return;
    const retained = dockEntry(storageScope);
    const current = () => retained.generation === recoveryGeneration(askGeometryRecoveryScope(storageScope));
    let edge: DockEdge = retained.edge;
    let preferredTop: number | undefined = retained.top;
    let suppressClick = false;
    let gesture: { id: number; startX: number; startY: number; origin: Position; position: Position; moved: boolean } | undefined;

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
      if (current()) {
        const entry = dockEntry(storageScope); entry.edge = edge; entry.top = preferredTop; entry.revision++; entry.dirty = true; entry.moving = false;
        flushAskDock(storageScope, entry.revision, current);
      }
    };
    const release = () => {
      const id = gesture?.id;
      gesture = undefined;
      const retained = docks.get(storageScope); if (retained) retained.moving = false;
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
      if (current()) { const retained = dockEntry(storageScope); retained.moving = true; retained.revision++; }
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
      const point = gesture?.moved ? gesture.position : undefined;
      release();
      if (point) { preferredTop = point.y; settle(point.x < availableWidth() / 2 ? 'left' : 'right'); }
    };
  }, [dock, trigger, storageScope, unavailable]);
}
