import { createContext, useCallback, useContext, useEffect, useId, useLayoutEffect, useMemo, useRef, useState, type PointerEvent as ReactPointerEvent, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import './session-dock.css';
import { useWindowLayout } from '../window-workspace-context.js';
import { conversationSessionStorage } from '../conversation-storage.js';
import { SessionTitleInteractionContext } from './SessionTitleInteraction.js';
import { useSessionDockDrag } from '../hooks/useSessionDockDrag.js';

const defaultWidth = 440, minimumWidth = 320, maximumWidth = 1600;
interface DockItem { id: string; title: string; host: HTMLElement; visible: boolean; width: number; additionalWidth?: number }
interface DockLayout { panes: Array<{ id: string; width: number }>; baseWidth?: number; mainMinimized?: boolean }
interface DockContext {
  enabled: boolean; items: DockItem[]; layout: DockLayout;
  leadingControls?: ReactNode;
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
const HeadingStartContext = createContext<ReactNode>(undefined);

/** Layout controls belong to the first visible dock's root heading. */
export function SessionDockHeadingStart() {
  return <>{useContext(HeadingStartContext)}</>;
}
const clampWidth = (width: number, minimum = minimumWidth) => Math.max(minimum, Math.min(maximumWidth, width));
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
export function SessionDockProvider({ enabled, storageScope, leadingControls, children }: { enabled: boolean; storageScope?: string; leadingControls?: ReactNode; children: ReactNode }) {
  const key = storageScope ? `agent-remote:recovery:${storageScope}:workspace-dock` : undefined;
  const shared = useWindowLayout();
  const [localLayout, setLayout] = useState<DockLayout>(() => readLayout(key));
  const [registered, setRegistered] = useState<Array<Omit<DockItem, 'width'>>>([]);
  const resolve = (id: string) => shared?.resolveViewId?.(id) ?? id;
  const localId = (id: string) => registered.find(item => resolve(item.id) === id)?.id ?? id;
  const layout: DockLayout = shared ? { panes: shared.window.views.filter(view => view.placement === 'dock').map(view => ({ id: localId(view.id), width: view.width })), baseWidth: shared.window.views.find(view => view.id === shared.window.selectedPrimaryViewId)?.width, mainMinimized: shared.window.views.find(view => view.id === shared.window.selectedPrimaryViewId)?.collapsed } : localLayout;
  const hadVisibleDock = useRef(false);
  const register = useCallback((item: Omit<DockItem, 'width'>) => setRegistered(current => {
    const previous = current.find(value => value.id === item.id);
    return previous?.host === item.host && previous.title === item.title && previous.visible === item.visible && previous.additionalWidth === item.additionalWidth ? current
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
  useEffect(() => { if (!shared && key) try { conversationSessionStorage.setItem(key, JSON.stringify(layout)); } catch { /* Layout remains usable without storage. */ } }, [key, layout, shared]);
  const items = useMemo(() => layout.panes.flatMap(pane => { const item = registered.find(item => item.id === pane.id); return item ? [{ ...item, width: pane.width }] : []; }), [layout, registered]);
  useEffect(() => {
    const visible = enabled && items.some(item => item.visible);
    // Empty registrations during reload or narrow presentation do not mean a dock was closed.
    if (!shared && enabled && layout.mainMinimized && !visible && (hadVisibleDock.current || items.length === layout.panes.length)) minimizeMain(false);
    hadVisibleDock.current = visible;
  }, [enabled, items, layout.mainMinimized, layout.panes.length, minimizeMain]);
  function orderSharedDocks(panes: DockLayout['panes']) {
    if (!shared || !panes.length) return;
    const primary = shared.window.views.filter(view => view.placement === 'primary').at(-1);
    let afterId = primary?.id ?? resolve(panes[0]!.id);
    const operations = (primary ? panes : panes.slice(1)).map(pane => {
      const viewId = resolve(pane.id);
      const operation = { type: 'view.move' as const, viewId, afterId };
      afterId = viewId;
      return operation;
    });
    if (operations.length) shared.operate({ type: 'batch', operations });
  }
  const value: DockContext = shared ? { enabled, items, layout, leadingControls, register, unregister,
    add: id => shared.operate({ type: 'view.place', viewId: resolve(id), placement: 'dock' }),
    remove: id => shared.operate({ type: 'view.place', viewId: resolve(id), placement: 'float' }),
    resize: (id, width) => shared.operate({ type: 'view.resize', viewId: resolve(id), width: clampWidth(width, 240) }),
    resizeBase: width => { if (shared.window.selectedPrimaryViewId) shared.operate({ type: 'view.resize', viewId: shared.window.selectedPrimaryViewId, width: clampWidth(width, 240) }); },
    minimizeMain: minimized => { if (shared.window.selectedPrimaryViewId) shared.operate({ type: 'view.collapse', viewId: shared.window.selectedPrimaryViewId, collapsed: minimized }); },
    move: (id, offset) => {
      const index = layout.panes.findIndex(item => item.id === id), next = Math.max(0, Math.min(layout.panes.length - 1, index + offset));
      if (index < 0 || index === next) return;
      const panes = [...layout.panes]; panes.splice(next, 0, panes.splice(index, 1)[0]!);
      orderSharedDocks(panes);
    },
    reorder: (id, before) => {
      const source = layout.panes.findIndex(item => item.id === id), target = layout.panes.findIndex(item => item.id === before);
      if (source < 0 || target < 0 || source === target) return;
      const panes = [...layout.panes]; panes.splice(target, 0, panes.splice(source, 1)[0]!);
      orderSharedDocks(panes);
    },
  } : { enabled, items, layout, leadingControls, register, unregister, add, remove, move, reorder, resize, resizeBase, minimizeMain };
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

export function SessionViewPlacement({ id, title, visible, additionalWidth, dockRequest, children }: {
  id: string; title: string; visible: boolean; additionalWidth?: number; dockRequest?: string; children(placement: { docked: boolean; controls: ReactNode }): ReactNode;
}) {
  const dock = useContext(Context);
  const [host] = useState(() => { const element = document.createElement('div'); element.className = 'lab-session-placement'; return element; });
  const home = useRef<HTMLDivElement>(null);
  const [mounted, setMounted] = useState(false);
  const item = dock?.layout.panes.find(item => item.id === id);
  const docked = !!dock?.enabled && !!item && visible;
  const unregister = dock?.unregister, register = dock?.register;
  const addRef = useRef(dock?.add); addRef.current = dock?.add;
  useLayoutEffect(() => { if (dockRequest) addRef.current?.(id); }, [id, dockRequest]);
  useLayoutEffect(() => {
    if (!docked && home.current) moveSessionHost(host, home.current);
    setMounted(true);
  }, [host, docked]);
  useLayoutEffect(() => { register?.({ id, title, host, visible, additionalWidth }); }, [register, id, title, host, visible, additionalWidth]);
  useLayoutEffect(() => () => { unregister?.(id, host); host.remove(); }, [unregister, id, host]);
  const titleInteraction = useSessionDockDrag({ id, title, enabled: docked, move: dock?.move, reorder: dock?.reorder });
  const controls = dock?.enabled ? <>
    <button type="button" className="lab-session-dock-toggle" aria-label={`${docked ? 'Float' : 'Dock'} ${title}`} title={docked ? 'Return to floating window' : 'Dock to the right of the conversations'}
      onClick={() => docked ? dock.remove(id) : dock.add(id)}>
      <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" aria-hidden="true"><rect x={docked ? '5' : '3'} y={docked ? '5' : '4'} width="16" height="16" rx="2" />{docked ? <path d="M3 16V3h13" /> : <path d="M13 4v16" />}</svg>
    </button>
  </> : null;
  const headingStart = docked && dock.items.find(item => item.visible)?.id === id ? dock.leadingControls : undefined;
  return <><div ref={home} className="lab-session-placement-home" />{mounted ? createPortal(
    <SessionTitleInteractionContext.Provider value={titleInteraction}><HeadingStartContext.Provider value={headingStart}>
      {children({ docked, controls })}
    </HeadingStartContext.Provider></SessionTitleInteractionContext.Provider>, host) : null}</>;
}

export function MinimizeMainSession() {
  const dock = useContext(Context);
  if (!dock?.enabled || !dock.items.some(item => item.visible)) return null;
  return <button type="button" className="lab-session-main-minimize" aria-label="Minimize main session area" title="Minimize main session and subagents"
    onClick={event => { event.stopPropagation(); dock.minimizeMain(true); }}>
    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" aria-hidden="true"><rect x="3" y="4" width="18" height="16" rx="2" /><path d="M8 4v16m8-12-4 4 4 4" /></svg>
  </button>;
}

export interface PrimarySessionGroupPane {
  id: string; title: string; width: number; additionalWidth?: number;
  collapsed: boolean; selected: boolean; content: ReactNode;
}
interface SessionDockRailProps {
  children?: ReactNode; minimizedHeader?: ReactNode; mainTitle?: string; minimumBaseWidth?: number; onCreateView?(): void;
  compact?: boolean; primaryGroups?: readonly PrimarySessionGroupPane[];
  onSelectPrimaryGroup?(id: string): void;
  onResizePrimaryGroup?(id: string, width: number): void;
  onCollapsePrimaryGroup?(id: string, collapsed: boolean): void;
  onClosePrimaryGroup?(id: string): void;
}
export function SessionDockRail({ children, minimizedHeader, mainTitle = 'Main session', minimumBaseWidth = minimumWidth, onCreateView, compact = false, primaryGroups, onSelectPrimaryGroup, onResizePrimaryGroup, onCollapsePrimaryGroup, onClosePrimaryGroup }: SessionDockRailProps) {
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
  return <div ref={rail} className="lab-session-dock-rail" data-docked={active.length > 0 || primaryGroups && !compact || undefined} data-primary-groups={primaryGroups ? true : undefined} data-compact={compact || undefined}>
    {primaryGroups ? primaryGroups.map((group, index) => <PrimaryGroupPane key={group.id} group={group} compact={compact} minimizedHeader={index === 0 ? minimizedHeader : undefined} onSelect={onSelectPrimaryGroup} onResize={onResizePrimaryGroup} onCollapse={onCollapsePrimaryGroup} onClose={onClosePrimaryGroup} />) : <div className="lab-session-dock-base" data-minimized={minimized || undefined} style={active.length ? { flexBasis: minimized ? 44 : baseWidth } : undefined}>
      <div ref={content} id={contentId} className="lab-session-dock-main-content" hidden={minimized}>{children}</div>
      {minimized ? minimizedHeader : null}
      {minimized ? <button ref={restore} type="button" className="lab-session-main-restore" aria-label={`Restore main session: ${mainTitle}`} title={`Restore main session: ${mainTitle}`} aria-expanded={false} aria-controls={contentId}
        onClick={() => { restoreFocus.current = true; dock?.minimizeMain(false); }}>
        <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" aria-hidden="true"><path d="m9 6 6 6-6 6" /></svg>
        <span className="lab-session-main-label">Main</span><span className="lab-session-main-title">{mainTitle}</span>
      </button> : null}
      {active.length && !minimized ? <DockResize title="Main conversation area" width={baseWidth} minimum={minimumBaseWidth} onResize={width => dock?.resizeBase(width)} /> : null}
    </div>}
    {dock?.enabled && onCreateView ? <button type="button" className="lab-session-dock-add" style={{ order: active.length + 1 }} aria-label="New session view" title="New session view" onClick={onCreateView}>+</button> : null}
    {[...active].sort((a, b) => a.id.localeCompare(b.id)).map(item => <DockPane key={item.id} item={item} order={active.indexOf(item) + 1} />)}
  </div>;
}

function PrimaryGroupPane({ group, compact, minimizedHeader, onSelect, onResize, onCollapse, onClose }: {
  group: PrimarySessionGroupPane; compact: boolean; minimizedHeader?: ReactNode;
  onSelect?: SessionDockRailProps['onSelectPrimaryGroup'];
  onResize?: SessionDockRailProps['onResizePrimaryGroup'];
  onCollapse?: SessionDockRailProps['onCollapsePrimaryGroup'];
  onClose?: SessionDockRailProps['onClosePrimaryGroup'];
}) {
  const minimized = !compact && group.collapsed;
  const contentId = useId();
  const select = (event: { target: EventTarget }) => {
    if (event.target instanceof Element && event.target.closest('[data-pane-selection-ignore],.lab-session-family-pane')) return;
    onSelect?.(group.id);
  };
  return <section className="lab-primary-group" data-session-family-shell data-primary-group-id={group.id} data-selected={group.selected || undefined}
    data-minimized={minimized || undefined} hidden={compact && !group.selected} aria-label={`Primary group: ${group.title}`}
    style={compact ? undefined : { width: minimized ? 44 : group.width + (group.additionalWidth ?? 0) }}
    onPointerDownCapture={select} onFocusCapture={select}>
    <div id={contentId} className="lab-primary-group-content" hidden={minimized}>{group.content}</div>
    {minimized ? minimizedHeader : null}
    {minimized && onClose ? <button type="button" data-pane-selection-ignore className="lab-primary-group-close" aria-label={`Close primary group: ${group.title}`}
      title="Close this session view. Agent sessions keep running." onClick={() => onClose(group.id)}>×</button> : null}
    {minimized ? <button type="button" className="lab-session-main-restore" aria-label={`Restore primary group: ${group.title}`} aria-controls={contentId} aria-expanded={false}
      onClick={() => onCollapse?.(group.id, false)}><span className="lab-session-main-label">Group</span><span className="lab-session-main-title">{group.title}</span></button>
      : !compact && onCollapse ? <button type="button" className="lab-primary-group-minimize" aria-label={`Minimize primary group: ${group.title}`} aria-controls={contentId} aria-expanded={true}
        onClick={() => onCollapse(group.id, true)}>−</button> : null}
    {!compact && !minimized && onResize ? <DockResize title={group.title} width={group.width} additionalWidth={group.additionalWidth} minimum={240} onResize={width => onResize(group.id, width)} /> : null}
  </section>;
}

function DockPane({ item, order }: { item: DockItem; order: number }) {
  const target = useRef<HTMLDivElement>(null);
  const dock = useContext(Context)!;
  const shared = useWindowLayout();
  useLayoutEffect(() => {
    const element = target.current!;
    moveSessionHost(item.host, element);
    const frame = requestAnimationFrame(() => element.scrollIntoView?.({ block: 'nearest', inline: 'nearest' }));
    return () => cancelAnimationFrame(frame);
  }, [item.host]);
  return <section className="lab-session-dock-pane" data-session-family-shell data-dock-id={item.id} aria-label={`Docked ${item.title}`} style={{ width: item.width + (item.additionalWidth ?? 0), minWidth: shared ? 240 : undefined, order }}>
    <div ref={target} className="lab-session-dock-content" />
    <DockResize title={item.title} width={item.width} additionalWidth={item.additionalWidth} onResize={width => dock.resize(item.id, width)} />
  </section>;
}

export function DockResize({ title, width, additionalWidth = 0, minimum: preferredMinimum, onResize }: { title: string; width: number; additionalWidth?: number; minimum?: number; onResize(width: number): void }) {
  const shared = useWindowLayout();
  const minimum = preferredMinimum ?? (shared ? 240 : minimumWidth);
  const drag = useRef<{ x: number; width: number; preferred?: number;
    styles: Array<{ element: HTMLElement; property: string; original: string; width: number; preview?: string }> }>();
  const restorePreview = () => {
    const gesture = drag.current; drag.current = undefined;
    for (const style of gesture?.styles ?? []) {
      if (style.preview === undefined || style.element.style.getPropertyValue(style.property) !== style.preview) continue;
      if (style.original) style.element.style.setProperty(style.property, style.original);
      else style.element.style.removeProperty(style.property);
    }
    return gesture;
  };
  useEffect(() => () => { restorePreview(); }, []);
  const resize = (value: number) => onResize(Math.max(minimum, Math.min(maximumWidth, value)));
  const stop = (event: ReactPointerEvent<HTMLElement>) => {
    const gesture = restorePreview();
    if (gesture?.preferred !== undefined) resize(gesture.preferred);
    if (event.currentTarget.hasPointerCapture(event.pointerId)) event.currentTarget.releasePointerCapture(event.pointerId);
  };
  return <div className="lab-session-dock-resize" role="separator" tabIndex={0} aria-label={`${title} width`} aria-orientation="vertical"
    style={additionalWidth > 0 ? { left: `calc(var(--lab-session-family-root-width, ${width}px) - 6px)`, right: 'auto' } : undefined}
    aria-valuemin={minimum} aria-valuemax={maximumWidth} aria-valuenow={Math.round(width)} aria-valuetext={`${Math.round(width)} pixels`}
    title="Drag to resize. Arrow keys adjust width. Double-click to reset."
    onDoubleClick={() => resize(defaultWidth)}
    onPointerDown={event => {
      if (event.button !== 0 || drag.current) return;
      event.preventDefault(); event.stopPropagation(); event.currentTarget.focus({ preventScroll: true });
      const parent = event.currentTarget.parentElement!;
      const property = parent.classList.contains('lab-session-dock-base') ? 'flex-basis' : 'width';
      const styles = [{ element: parent, property, original: parent.style.getPropertyValue(property), width: width + additionalWidth }];
      const shell = parent.closest<HTMLElement>('[data-session-family-shell]');
      if (shell === parent) {
        const property = '--lab-session-family-root-width';
        styles.push({ element: shell, property, original: shell.style.getPropertyValue(property), width });
      } else if (shell) {
        styles.push({ element: shell, property: 'width', original: shell.style.width,
          width: Number.parseFloat(shell.style.width) || shell.getBoundingClientRect().width });
      }
      drag.current = { x: event.clientX, width, styles };
      event.currentTarget.setPointerCapture(event.pointerId);
    }}
    onPointerMove={event => {
      const gesture = drag.current; if (!gesture) return;
      const next = Math.max(minimum, Math.min(maximumWidth, gesture.width + event.clientX - gesture.x));
      if (!shared) resize(next);
      else {
        gesture.preferred = next;
        // Preview the pane and its family together without saving every pointer movement.
        for (const style of gesture.styles) {
          style.preview = `${style.width + next - gesture.width}px`;
          style.element.style.setProperty(style.property, style.preview);
        }
      }
    }}
    onPointerUp={stop} onPointerCancel={stop} onLostPointerCapture={stop}
    onKeyDown={event => {
      const step = event.shiftKey ? 40 : 10;
      const next = event.key === 'ArrowRight' ? width + step : event.key === 'ArrowLeft' ? width - step : event.key === 'Home' ? minimum : event.key === 'Enter' ? defaultWidth : undefined;
      if (next !== undefined) { event.preventDefault(); event.stopPropagation(); resize(next); }
    }} />;
}

export function useSessionDocked(id: string): boolean {
  const dock = useContext(Context);
  return !!dock?.enabled && dock.layout.panes.some(item => item.id === id);
}

/** Explicit window closure also retires its persisted placement. */
export function useRemoveSessionDocks() {
  const dock = useContext(Context);
  return (ids: readonly string[]) => { for (const id of ids) dock?.remove(id); };
}
