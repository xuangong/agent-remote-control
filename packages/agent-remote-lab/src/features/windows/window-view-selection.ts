import type { WindowOperation, WindowView } from '@orchardworks/agent-remote-protocol';

/** Selecting a view of the open Window: a collapsed view expands in the same edit. */
export function viewSelection(view: Pick<WindowView, 'id' | 'collapsed'>): WindowOperation {
  const select: WindowOperation = { type: 'view.select', viewId: view.id };
  return view.collapsed ? { type: 'batch', operations: [{ type: 'view.collapse', viewId: view.id, collapsed: false }, select] } : select;
}

/** Brings a view's pane into view on the next frame, since the pane may render or expand only then. */
export function revealView(viewId: string): void {
  requestAnimationFrame(() => [...document.querySelectorAll<HTMLElement>('[data-view-id]')].find(element => element.dataset.viewId === viewId)
    ?.scrollIntoView?.({ block: 'nearest', inline: 'nearest' }));
}
