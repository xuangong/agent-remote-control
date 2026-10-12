import { createContext, useCallback, useContext, useEffect, useId, useLayoutEffect, useMemo, useRef, useState, type PointerEvent as ReactPointerEvent, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import './session-dock.css';
import { conversationSessionStorage } from '../conversation-storage.js';

const defaultWidth = 440, minimumWidth = 320, maximumWidth = 1600;
interface DockItem { id: string; title: string; host: HTMLElement; visible: boolean; width: number }
interface DockLayout { panes: Array<{ id: string; width: number }>; baseWidth?: number; mainMinimized?: boolean }
interface DockContext {
  enabled: boolean; items: DockItem[]; layout: DockLayout;
  register(item: Omit<DockItem, 'width'>): void;
  unregister(id: string, host: HTMLElement): void;
  add(id: string): void;
  remove(id: string): void;
  move(id: string, offset: number): void;
  reorder(id: string, before: string): void;
  resize(id: string, width: number): void;
  resizeBase(width: number): void;
  minimizeMain(minimized: boolean): void;
}
const Context = createContext<DockContext | undefined>(undefined);
const clampWidth = (width: number) => Math.max(minimumWidth, Math.min(maximumWidth, width));
function readLayout(key?: string): DockLayout {
  try {
    const saved = key && JSON.parse(conversationSessionStorage.getItem(key) ?? 'null');
    if (!saved || !Array.isArray(saved.panes)) return { panes: [] };
    const seen = new Set<string>();
    const panes = saved.panes.filter((pane: { id?: unknown; width?: unknown }) => {
      if (!pane || typeof pane.id !== 'string' || !pane.id || seen.has(pane.id) || typeof pane.width !== 'number' || !Number.isFinite(pane.width)) return false;
      seen.add(pane.id); return true;
    }).slice(-20).map((pane: { id: string; width: number }) => ({ id: pane.id, width: clampWidth(pane.width) }));
    return { panes, mainMinimized: saved.mainMinimized === true, ...(typeof saved.baseWidth === 'number' && Number.isFinite(saved.baseWidth) ? { baseWidth: clampWidth(saved.baseWidth) } : {}) };
  } catch { return { panes: [] }; }
}

/** Placement preferences outlive DOM registrations and main-session navigation. */
export function SessionDockProvider({ enabled, storageScope, children }: { enabled: boolean; storageScope?: string; children: ReactNode }) {
  const key = storageScope ? `agent-remote:recovery:${storageScope}:workspace-dock` : undefined;
  const [layout, setLayout] = useState<DockLayout>(() => readLayout(key));
  const [registered, setRegistered] = useState<Array<Omit<DockItem, 'width'>>>([]);
  const hadVisibleDock = useRef(false);
  const register = useCallback((item: Omit<DockItem, 'width'>) => setRegistered(current => {
    const previous = current.find(value => value.id === item.id);
    return previous?.host === item.host && previous.title === item.title && previous.visible === item.visible ? current
      : [...current.filter(value => value.id !== item.id), item];
  }), []);
  const unregister = useCallback((id: string, host: HTMLElement) => setRegistered(current => current.some(item => item.id === id && item.host === host)
    ? current.filter(item => item.id !== id || item.host !== host) : current), []);
  const add = useCallback((id: string) => setLayout(current => current.panes.some(item => item.id === id) ? current : { ...current, panes: [...current.panes, { id, width: defaultWidth }] }), []);
  const remove = useCallback((id: string) => setLayout(current => {
    const panes = current.panes.filter(item => item.id !== id);
    return { ...current, panes, mainMinimized: panes.length > 0 && current.mainMinimized };
  }), []);
  const move = useCallback((id: string, offset: number) => setLayout(current => {
    const index = current.panes.findIndex(item => item.id === id), next = Math.max(0, Math.min(current.panes.length - 1, index + offset));
    if (index < 0 || index === next) return current;
    const panes = [...current.panes]; panes.splice(next, 0, panes.splice(index, 1)[0]!); return { ...current, panes };
  }), []);
  const reorder = useCallback((id: string, before: string) => setLayout(current => {
    const source = current.panes.findIndex(item => item.id === id), target = current.panes.findIndex(item => item.id === before);
    if (source < 0 || target < 0 || source === target) return current;
    const panes = [...current.panes]; panes.splice(target, 0, panes.splice(source, 1)[0]!); return { ...current, panes };
  }), []);
  const resize = useCallback((id: string, width: number) => setLayout(current => ({ ...current, panes: current.panes.map(item => item.id === id ? { ...item, width: clampWidth(width) } : item) })), []);
  const resizeBase = useCallback((width: number) => setLayout(current => ({ ...current, baseWidth: clampWidth(width) })), []);
  const minimizeMain = useCallback((mainMinimized: boolean) => setLayout(current => ({ ...current, mainMinimized })), []);
  useEffect(() => { if (key) try { conversationSessionStorage.setItem(key, JSON.stringify(layout)); } catch { /* Layout remains usable without storage. */ } }, [key, layout]);
  const items = useMemo(() => layout.panes.flatMap(pane => { const item = registered.find(item => item.id === pane.id); return item ? [{ ...item, width: pane.width }] : []; }), [layout, registered]);
  useEffect(() => {
    const visible = enabled && items.some(item => item.visible);
    // Empty registrations during reload or narrow presentation do not mean a dock was closed.
    if (enabled && layout.mainMinimized && !visible && (hadVisibleDock.current || items.length === layout.panes.length)) minimizeMain(false);
    hadVisibleDock.current = visible;
  }, [enabled, items, layout.mainMinimized, layout.panes.length, minimizeMain]);
  const value = useMemo(() => ({ enabled, items, layout, register, unregister, add, remove, move, reorder, resize, resizeBase, minimizeMain }), [enabled, items, layout, register, unregister, add, remove, move, reorder, resize, resizeBase, minimizeMain]);
  return <Context.Provider value={value}>{children}</Context.Provider>;
}

/** The portal target is stable: moving its DOM host does not remount the Session View. */
export function moveSessionHost(host: HTMLElement, parent: HTMLElement) {
  if (host.parentElement === parent) return;
  const focus = document.activeElement instanceof HTMLElement && host.contains(document.activeElement) ? document.activeElement : undefined;
  const selection = document.getSelection();
  const range = selection?.rangeCount && host.contains(selection.anchorNode) ? selection.getRangeAt(0).cloneRange() : undefined;
  const target = parent as HTMLElement & { moveBefore?(node: Node, child: Node | null): void };
  if (host.isConnected && target.isConnected && target.moveBefore) target.moveBefore(host, null);
  else parent.appendChild(host);
  if (focus && document.activeElement !== focus) focus.focus({ preventScroll: true });
  if (range && selection) { selection.removeAllRanges(); selection.addRange(range); }
}

export function SessionViewPlacement({ id, title, visible, children }: {
  id: string; title: string; visible: boolean; children(placement: { docked: boolean; controls: ReactNode }): ReactNode;
}) {
  const dock = useContext(Context);
  const [host] = useState(() => { const element = document.createElement('div'); element.className = 'lab-session-placement'; return element; });
  const home = useRef<HTMLDivElement>(null);
  const [mounted, setMounted] = useState(false);
  const item = dock?.layout.panes.find(item => item.id === id);
  const docked = !!dock?.enabled && !!item && visible;
  const unregister = dock?.unregister, register = dock?.register;
  useLayoutEffect(() => {
    if (!docked && home.current) moveSessionHost(host, home.current);
    setMounted(true);
  }, [host, docked]);
  useLayoutEffect(() => { register?.({ id, title, host, visible }); }, [register, id, title, host, visible]);
  useLayoutEffect(() => () => { unregister?.(id, host); host.remove(); }, [unregister, id, host]);
  const controls = dock?.enabled ? <>
    {docked ? <DockMove id={id} title={title} /> : null}
    <button type="button" className="lab-session-dock-toggle" aria-label={`${docked ? 'Float' : 'Dock'} ${title}`} title={docked ? 'Return to floating window' : 'Dock to the right of the conversations'}
      onClick={() => docked ? dock.remove(id) : dock.add(id)}>
      <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" aria-hidden="true"><rect x={docked ? '5' : '3'} y={docked ? '5' : '4'} width="16" height="16" rx="2" />{docked ? <path d="M3 16V3h13" /> : <path d="M13 4v16" />}</svg>
    </button>
  </> : null;
  return <><div ref={home} className="lab-session-placement-home" />{mounted ? createPortal(children({ docked, controls }), host) : null}</>;
}

export function MinimizeMainSession() {
  const dock = useContext(Context);
  if (!dock?.enabled || !dock.items.some(item => item.visible)) return null;
  return <button type="button" className="lab-session-main-minimize" aria-label="Minimize main session area" title="Minimize main session and subagents"
    onClick={event => { event.stopPropagation(); dock.minimizeMain(true); }}>
    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" aria-hidden="true"><rect x="3" y="4" width="18" height="16" rx="2" /><path d="M8 4v16m8-12-4 4 4 4" /></svg>
  </button>;
}

export function SessionDockRail({ children, mainTitle = 'Main session', minimumBaseWidth = minimumWidth }: { children: ReactNode; mainTitle?: string; minimumBaseWidth?: number }) {
  const dock = useContext(Context);
  const rail = useRef<HTMLDivElement>(null);
  const [width, setWidth] = useState(0);
  const content = useRef<HTMLDivElement>(null);
  const restore = useRef<HTMLButtonElement>(null);
  const restoreFocus = useRef(false);
  const contentId = useId();
  const preferredBaseWidth = dock?.layout.baseWidth;
  const active = dock?.enabled ? dock.items.filter(item => item.visible) : [];
  const minimized = active.length > 0 && dock?.layout.mainMinimized === true;
  useLayoutEffect(() => {
    if (minimized && content.current?.contains(document.activeElement)) restore.current?.focus({ preventScroll: true });
    if (!minimized && restoreFocus.current) {
      content.current?.querySelector<HTMLButtonElement>('.lab-session-main-minimize')?.focus({ preventScroll: true });
      restoreFocus.current = false;
    }
  }, [minimized]);
  useLayoutEffect(() => {
    const element = rail.current;
    if (!element) return;
    const measure = () => setWidth(element.clientWidth);
    measure();
    if (typeof ResizeObserver === 'undefined') { window.addEventListener('resize', measure); return () => window.removeEventListener('resize', measure); }
    const observer = new ResizeObserver(measure); observer.observe(element);
    return () => observer.disconnect();
  }, []);
  const baseWidth = Math.max(minimumBaseWidth, preferredBaseWidth ?? width - defaultWidth);
  return <div ref={rail} className="lab-session-dock-rail" data-docked={active.length > 0 || undefined}>
    <div className="lab-session-dock-base" data-minimized={minimized || undefined} style={active.length ? { flexBasis: minimized ? 44 : baseWidth } : undefined}>
      <div ref={content} id={contentId} className="lab-session-dock-main-content" hidden={minimized}>{children}</div>
      {minimized ? <button ref={restore} type="button" className="lab-session-main-restore" aria-label={`Restore main session: ${mainTitle}`} title={`Restore main session: ${mainTitle}`} aria-expanded={false} aria-controls={contentId}
        onClick={() => { restoreFocus.current = true; dock?.minimizeMain(false); }}>
        <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" aria-hidden="true"><path d="m9 6 6 6-6 6" /></svg>
        <span className="lab-session-main-label">Main</span><span className="lab-session-main-title">{mainTitle}</span>
      </button> : null}
      {active.length && !minimized ? <DockResize title="Main conversation area" width={baseWidth} minimum={minimumBaseWidth} onResize={width => dock?.resizeBase(width)} /> : null}
    </div>
    {[...active].sort((a, b) => a.id.localeCompare(b.id)).map(item => <DockPane key={item.id} item={item} order={active.indexOf(item) + 1} />)}
  </div>;
}

function DockPane({ item, order }: { item: DockItem; order: number }) {
  const target = useRef<HTMLDivElement>(null);
  const dock = useContext(Context)!;
  useLayoutEffect(() => {
    const element = target.current!;
    moveSessionHost(item.host, element);
    const frame = requestAnimationFrame(() => element.scrollIntoView?.({ block: 'nearest', inline: 'nearest' }));
    return () => cancelAnimationFrame(frame);
  }, [item.host]);
  return <section className="lab-session-dock-pane" data-dock-id={item.id} aria-label={`Docked ${item.title}`} style={{ width: item.width, order }}>
    <div ref={target} className="lab-session-dock-content" />
    <DockResize title={item.title} width={item.width} onResize={width => dock.resize(item.id, width)} />
  </section>;
}

function DockResize({ title, width, minimum = minimumWidth, onResize }: { title: string; width: number; minimum?: number; onResize(width: number): void }) {
  const drag = useRef<{ x: number; width: number }>();
  const resize = (value: number) => onResize(Math.max(minimum, Math.min(maximumWidth, value)));
  const stop = (event: ReactPointerEvent<HTMLElement>) => {
    drag.current = undefined;
    if (event.currentTarget.hasPointerCapture(event.pointerId)) event.currentTarget.releasePointerCapture(event.pointerId);
  };
  return <div className="lab-session-dock-resize" role="separator" tabIndex={0} aria-label={`${title} width`} aria-orientation="vertical"
    aria-valuemin={minimum} aria-valuemax={maximumWidth} aria-valuenow={Math.round(width)} aria-valuetext={`${Math.round(width)} pixels`}
    title="Drag to resize. Arrow keys adjust width. Double-click to reset."
    onDoubleClick={() => resize(defaultWidth)}
    onPointerDown={event => { if (event.button !== 0) return; event.preventDefault(); event.stopPropagation(); event.currentTarget.focus({ preventScroll: true }); drag.current = { x: event.clientX, width }; event.currentTarget.setPointerCapture(event.pointerId); }}
    onPointerMove={event => { if (drag.current) resize(drag.current.width + event.clientX - drag.current.x); }}
    onPointerUp={stop} onPointerCancel={stop} onLostPointerCapture={() => { drag.current = undefined; }}
    onKeyDown={event => {
      const step = event.shiftKey ? 40 : 10;
      const next = event.key === 'ArrowRight' ? width + step : event.key === 'ArrowLeft' ? width - step : event.key === 'Home' ? minimum : event.key === 'Enter' ? defaultWidth : undefined;
      if (next !== undefined) { event.preventDefault(); event.stopPropagation(); resize(next); }
    }} />;
}

function DockMove({ id, title }: { id: string; title: string }) {
  const dock = useContext(Context)!;
  const gesture = useRef<{ x: number; rail: HTMLElement; pane: HTMLElement; frame: number }>();
  const stop = () => { if (gesture.current) { cancelAnimationFrame(gesture.current.frame); delete gesture.current.pane.dataset.dragging; gesture.current = undefined; } };
  useEffect(() => stop, []);
  const tick = () => {
    const drag = gesture.current;
    if (!drag) return;
    const bounds = drag.rail.getBoundingClientRect();
    const edge = 48;
    const speed = drag.x < bounds.left + edge ? -12 : drag.x > bounds.right - edge ? 12 : 0;
    if (speed) drag.rail.scrollLeft += speed;
    const origin = Number(drag.pane.style.order);
    for (const pane of drag.rail.querySelectorAll<HTMLElement>('.lab-session-dock-pane')) {
      const rect = pane.getBoundingClientRect(), order = Number(pane.style.order);
      if (pane === drag.pane || drag.x < rect.left || drag.x > rect.right) continue;
      if (order > origin && drag.x > rect.left + rect.width / 2 || order < origin && drag.x < rect.left + rect.width / 2) dock.reorder(id, pane.dataset.dockId!);
    }
    drag.frame = requestAnimationFrame(tick);
  };
  return <button type="button" className="lab-session-dock-move" aria-label={`Move ${title}`} title="Drag to reorder docked views. Arrow keys move left or right."
    onPointerDown={event => {
      if (event.button !== 0) return;
      const pane = event.currentTarget.closest<HTMLElement>('.lab-session-dock-pane'), rail = pane?.parentElement;
      if (!pane || !rail) return;
      event.preventDefault(); event.stopPropagation(); event.currentTarget.focus({ preventScroll: true });
      stop(); pane.dataset.dragging = 'true'; gesture.current = { x: event.clientX, rail, pane, frame: requestAnimationFrame(tick) };
      event.currentTarget.setPointerCapture(event.pointerId);
    }} onPointerMove={event => { if (gesture.current) gesture.current.x = event.clientX; }}
    onPointerUp={event => { stop(); if (event.currentTarget.hasPointerCapture(event.pointerId)) event.currentTarget.releasePointerCapture(event.pointerId); }}
    onPointerCancel={stop} onLostPointerCapture={stop}
    onKeyDown={event => { if (event.key === 'ArrowLeft' || event.key === 'ArrowRight') { event.preventDefault(); event.stopPropagation(); dock.move(id, event.key === 'ArrowLeft' ? -1 : 1); } }}>
    <svg width="14" height="16" viewBox="0 0 14 16" fill="currentColor" aria-hidden="true"><path d="M4 3h2v2H4zm4 0h2v2H8zM4 7h2v2H4zm4 0h2v2H8zM4 11h2v2H4zm4 0h2v2H8z" /></svg>
  </button>;
}

export function useSessionDocked(id: string): boolean {
  const dock = useContext(Context);
  return !!dock?.enabled && dock.layout.panes.some(item => item.id === id);
}
