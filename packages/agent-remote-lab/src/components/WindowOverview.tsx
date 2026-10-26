import './window-overview.css';
import { useEffect, useLayoutEffect, useRef, useState, type KeyboardEvent as ReactKeyboardEvent } from 'react';
import type { WindowView, WorkspaceWindow } from '@orchardworks/agent-remote-protocol';
import type { useWindowWorkspace } from '../hooks/useWindowWorkspace.js';
import { navigationArrow } from '../hooks/useSessionViewMouseNavigation.js';
import { byRecentUse } from '../window-recency.js';
import { viewTitle } from './WindowWorkspaces.js';

/** Width a collapsed view keeps in the rail. */
const COLLAPSED_WIDTH = 44;

export interface WindowThumbnailPane { id: string; title: string; providerId?: string; width: number; selected: boolean; collapsed: boolean; attached: boolean }

/**
 * The panes of a Window in the order its rail shows them: top-level views with the views attached to them, then dock
 * views with theirs. Floating views are only counted.
 */
export function windowThumbnail(window: WorkspaceWindow): { panes: WindowThumbnailPane[]; floating: number } {
  const attached = new Map<string, WindowView[]>();
  for (const view of window.views) if (view.attachedTo) attached.set(view.attachedTo, [...attached.get(view.attachedTo) ?? [], view]);
  const panes: WindowThumbnailPane[] = [], seen = new Set<string>();
  const visit = (view: WindowView) => {
    if (seen.has(view.id)) return;
    seen.add(view.id);
    panes.push({ id: view.id, title: viewTitle(view), providerId: view.binding?.providerId, width: view.collapsed ? COLLAPSED_WIDTH : view.width,
      selected: view.id === window.selectedViewId, collapsed: view.collapsed, attached: !!view.attachedTo });
    for (const child of attached.get(view.id) ?? []) visit(child);
  };
  for (const placement of ['primary', 'dock'] as const) for (const view of window.views) if (view.placement === placement) visit(view);
  return { panes, floating: window.views.filter(view => view.placement === 'float').length };
}

function WindowCard({ window, current, opening, onOpen }: { window: WorkspaceWindow; current: boolean; opening: boolean; onOpen(): void }) {
  const { panes, floating } = windowThumbnail(window);
  const count = window.views.length;
  return <button type="button" className="lab-window-card" data-window-card={window.id} aria-current={current || undefined} aria-busy={opening || undefined}
    aria-label={`${current ? 'Return to' : 'Open'} Window: ${window.title}`} onClick={onOpen}>
    <span className="lab-window-card-layout" aria-hidden="true">
      {panes.length ? panes.map(pane => <span key={pane.id} className="lab-window-card-pane" style={{ flexGrow: pane.width }}
        data-selected={pane.selected || undefined} data-collapsed={pane.collapsed || undefined} data-attached={pane.attached || undefined}>
        {pane.collapsed ? null : <><span className="lab-window-card-pane-title">{pane.title}</span>{pane.providerId ? <span className="lab-window-card-provider">{pane.providerId}</span> : null}</>}
      </span>) : <span className="lab-window-card-empty">No session views</span>}
    </span>
    <span className="lab-window-card-caption">
      <strong>{window.title}</strong>
      <small>{opening ? 'Opening…' : `${count} ${count === 1 ? 'session view' : 'session views'}${floating ? `, ${floating} floating` : ''}`}</small>
      {current ? <span className="lab-window-card-current">Current</span> : null}
    </span>
  </button>;
}

/**
 * Every Window side by side, most recently used first, to switch between them. Ctrl+Shift+Up opens it on wide
 * screens; arrow keys move between Windows, Enter opens one, and Escape or Ctrl+Shift+Down returns.
 */
export function WindowOverview({ workspace, scope, enabled, open, onOpenChange }: {
  workspace: ReturnType<typeof useWindowWorkspace>; scope: string; enabled: boolean; open: boolean; onOpenChange(open: boolean): void;
}) {
  const dialog = useRef<HTMLDialogElement>(null);
  const grid = useRef<HTMLDivElement>(null);
  const [openingId, setOpeningId] = useState<string>();
  const [notice, setNotice] = useState<string>();
  const latest = useRef({ open, onOpenChange }); latest.current = { open, onOpenChange };
  const shown = open && enabled;
  const catalog = [...new Map([...workspace.windows, ...(workspace.window ? [workspace.window] : [])].map(window => [window.id, window])).values()];
  // The order is fixed while the overview is open, so cards do not move under the pointer.
  const [order, setOrder] = useState<string[]>([]);
  useEffect(() => { if (!enabled && open) onOpenChange(false); }, [enabled, open, onOpenChange]);
  useEffect(() => {
    if (!enabled) return;
    const key = (event: KeyboardEvent) => {
      if (event.defaultPrevented || navigationArrow(event) !== 'ArrowUp' || latest.current.open || document.querySelector('dialog[open]')) return;
      event.preventDefault();
      latest.current.onOpenChange(true);
    };
    window.addEventListener('keydown', key);
    return () => window.removeEventListener('keydown', key);
  }, [enabled]);
  useLayoutEffect(() => {
    if (!shown) return;
    // The dialog exists only while shown; focus returns where it was when the Window did not change.
    const returnFocus = document.activeElement instanceof HTMLElement ? document.activeElement : undefined;
    setOrder(byRecentUse(scope, catalog).map(window => window.id)); setNotice(undefined);
    if (!dialog.current?.open) dialog.current?.showModal();
    return () => queueMicrotask(() => {
      if (returnFocus?.isConnected && (!document.activeElement || document.activeElement === document.body)) returnFocus.focus({ preventScroll: true });
    });
  }, [shown]);
  useLayoutEffect(() => {
    if (!shown) return;
    const cards = grid.current?.querySelectorAll<HTMLElement>('[data-window-card]');
    const start = [...cards ?? []].find(card => card.getAttribute('aria-current') === 'true') ?? cards?.[0];
    start?.focus({ preventScroll: true });
    start?.scrollIntoView?.({ block: 'nearest' });
  }, [shown, order]);
  const windows = [...order.map(id => catalog.find(window => window.id === id)).filter((window): window is WorkspaceWindow => !!window),
    ...byRecentUse(scope, catalog.filter(window => !order.includes(window.id)))];
  async function choose(id: string) {
    if (id === workspace.window?.id) { onOpenChange(false); return; }
    setOpeningId(id); setNotice(undefined);
    try { await workspace.open(id); onOpenChange(false); }
    catch (error) { setNotice(error instanceof Error ? error.message : String(error)); }
    finally { setOpeningId(undefined); }
  }
  function move(event: ReactKeyboardEvent<HTMLDivElement>) {
    if (navigationArrow(event.nativeEvent, true) === 'ArrowDown') { event.preventDefault(); onOpenChange(false); return; }
    if (event.ctrlKey || event.metaKey || event.altKey || event.shiftKey) return;
    const cards = [...grid.current?.querySelectorAll<HTMLElement>('[data-window-card]') ?? []];
    const index = cards.indexOf(document.activeElement as HTMLElement);
    if (index < 0) return;
    // Columns without cards collapse to zero width.
    const columns = Math.max(1, getComputedStyle(grid.current!).gridTemplateColumns.split(' ').filter(track => track && parseFloat(track) > 0).length);
    const next = ({ ArrowLeft: index - 1, ArrowRight: index + 1, ArrowUp: index - columns, ArrowDown: index + columns, Home: 0, End: cards.length - 1 } as Record<string, number>)[event.key];
    if (next === undefined) return;
    event.preventDefault();
    const card = cards[Math.min(cards.length - 1, Math.max(0, next))];
    card?.focus({ preventScroll: true });
    card?.scrollIntoView?.({ block: 'nearest' });
  }
  if (!shown) return null;
  return <dialog ref={dialog} className="lab-window-overview" aria-label="All Windows" onCancel={event => { event.preventDefault(); onOpenChange(false); }}
    // A click beside the cards returns, as on the blurred page behind them.
    onClick={event => { if (event.target === event.currentTarget || (event.target as Element).matches('.lab-window-overview-body, .lab-window-overview-grid')) onOpenChange(false); }}>
    <div className="lab-window-overview-body">
      <div className="lab-window-overview-heading">
        <h2>Windows</h2>
        <span className="lab-window-overview-hint">Arrow keys move, Enter opens, Esc returns</span>
        <button type="button" aria-label="Return to the current Window" title="Return (Esc)" onClick={() => onOpenChange(false)}>×</button>
      </div>
      {notice ? <p className="lab-window-overview-notice" role="alert">{notice}</p> : null}
      <div ref={grid} className="lab-window-overview-grid" role="group" aria-label="Windows, most recently used first" onKeyDown={move}>
        {windows.map(window => <WindowCard key={window.id} window={window} current={window.id === workspace.window?.id} opening={openingId === window.id}
          onOpen={() => void choose(window.id)} />)}
      </div>
      {!windows.length ? <p className="lab-window-overview-notice">No Windows yet.</p> : null}
    </div>
  </dialog>;
}
