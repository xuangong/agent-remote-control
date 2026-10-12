import { createContext, useCallback, useContext, useEffect, useLayoutEffect, useMemo, useRef, useState, type PointerEvent as ReactPointerEvent, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import './session-dock.css';

const defaultWidth = 440, minimumWidth = 320, maximumWidth = 1600;
interface DockItem { id: string; title: string; host: HTMLElement; visible: boolean; width: number }
interface DockContext {
  enabled: boolean; items: DockItem[];
  add(item: Omit<DockItem, 'width'>): void;
  remove(id: string, host: HTMLElement): void;
  update(id: string, title: string, visible: boolean): void;
  move(id: string, offset: number): void;
  reorder(id: string, before: string): void;
  resize(id: string, width: number): void;
}
const Context = createContext<DockContext | undefined>(undefined);

export function SessionDockProvider({ enabled, children }: { enabled: boolean; children: ReactNode }) {
  const [items, setItems] = useState<DockItem[]>([]);
  const add = useCallback((item: Omit<DockItem, 'width'>) => setItems(current => current.some(value => value.id === item.id) ? current : [...current, { ...item, width: defaultWidth }]), []);
  const remove = useCallback((id: string, host: HTMLElement) => setItems(current => current.some(item => item.id === id && item.host === host) ? current.filter(item => item.id !== id || item.host !== host) : current), []);
  const update = useCallback((id: string, title: string, visible: boolean) => setItems(current => {
    const previous = current.find(item => item.id === id);
    return !previous || previous.title === title && previous.visible === visible ? current : current.map(item => item.id === id ? { ...item, title, visible } : item);
  }), []);
  const move = useCallback((id: string, offset: number) => setItems(current => {
    const index = current.findIndex(item => item.id === id), next = Math.max(0, Math.min(current.length - 1, index + offset));
    if (index < 0 || index === next) return current;
    const result = [...current]; result.splice(next, 0, result.splice(index, 1)[0]!); return result;
  }), []);
  const reorder = useCallback((id: string, before: string) => setItems(current => {
    const source = current.findIndex(item => item.id === id), target = current.findIndex(item => item.id === before);
    if (source < 0 || target < 0 || source === target) return current;
    const result = [...current]; result.splice(target, 0, result.splice(source, 1)[0]!); return result;
  }), []);
  const resize = useCallback((id: string, width: number) => setItems(current => current.map(item => item.id === id ? { ...item, width: Math.max(minimumWidth, Math.min(maximumWidth, width)) } : item)), []);
  const value = useMemo(() => ({ enabled, items, add, remove, update, move, reorder, resize }), [enabled, items, add, remove, update, move, reorder, resize]);
  return <Context.Provider value={value}>{children}</Context.Provider>;
}

/** The portal target is stable: moving its DOM host does not remount the Session View. */
function moveHost(host: HTMLElement, parent: HTMLElement) {
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
  const item = dock?.items.find(item => item.id === id);
  const docked = !!dock?.enabled && !!item && visible;
  const remove = dock?.remove, update = dock?.update;
  useLayoutEffect(() => {
    if (!docked && home.current) moveHost(host, home.current);
    setMounted(true);
  }, [host, docked]);
  useLayoutEffect(() => { update?.(id, title, visible); }, [update, id, title, visible]);
  useEffect(() => () => { remove?.(id, host); host.remove(); }, [remove, id, host]);
  const controls = dock?.enabled ? <>
    {docked ? <DockMove id={id} title={title} /> : null}
    <button type="button" className="lab-session-dock-toggle" aria-label={`${docked ? 'Float' : 'Dock'} ${title}`} title={docked ? 'Return to floating window' : 'Dock to the right of the conversations'}
      onClick={() => docked ? dock.remove(id, host) : dock.add({ id, title, host, visible })}>
      <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" aria-hidden="true"><rect x={docked ? '5' : '3'} y={docked ? '5' : '4'} width="16" height="16" rx="2" />{docked ? <path d="M3 16V3h13" /> : <path d="M13 4v16" />}</svg>
    </button>
  </> : null;
  return <><div ref={home} className="lab-session-placement-home" />{mounted ? createPortal(children({ docked, controls }), host) : null}</>;
}

export function SessionDockRail({ children, minimumBaseWidth = minimumWidth }: { children: ReactNode; minimumBaseWidth?: number }) {
  const dock = useContext(Context);
  const rail = useRef<HTMLDivElement>(null);
  const [width, setWidth] = useState(0);
  const [preferredBaseWidth, setBaseWidth] = useState<number>();
  const active = dock?.enabled ? dock.items.filter(item => item.visible) : [];
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
    <div className="lab-session-dock-base" style={active.length ? { flexBasis: baseWidth } : undefined}>{children}
      {active.length ? <DockResize title="Main conversation area" width={baseWidth} minimum={minimumBaseWidth} onResize={setBaseWidth} /> : null}
    </div>
    {[...active].sort((a, b) => a.id.localeCompare(b.id)).map(item => <DockPane key={item.id} item={item} order={active.indexOf(item) + 1} />)}
  </div>;
}

function DockPane({ item, order }: { item: DockItem; order: number }) {
  const target = useRef<HTMLDivElement>(null);
  const dock = useContext(Context)!;
  useLayoutEffect(() => {
    const element = target.current!;
    moveHost(item.host, element);
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
  return !!dock?.enabled && dock.items.some(item => item.id === id);
}
