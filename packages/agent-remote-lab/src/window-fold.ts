import { primaryWindowViews, type WindowOperation, type WindowView, type WorkspaceWindow } from '@orchardworks/agent-remote-protocol';

/** Whether `viewId` is `ancestorId` or attached below it. */
function within(window: WorkspaceWindow, viewId: string, ancestorId: string): boolean {
  const seen = new Set<string>();
  let view = window.views.find(item => item.id === viewId);
  while (view && !seen.has(view.id)) {
    if (view.id === ancestorId) return true;
    seen.add(view.id);
    view = view.attachedTo ? window.views.find(item => item.id === view!.attachedTo) : undefined;
  }
  return false;
}

/**
 * Closing a bot's pane folds it. When the selection was in the folded pane it moves on, as a close would: a Side's to
 * its source, anything else's to the nearest primary group still open (the one before it first), or else to an open
 * dock. Selecting a pane unfolds it, so the selection never moves to a folded one; with nothing else open it stays.
 */
export function foldOperation(window: WorkspaceWindow, viewId: string): WindowOperation {
  const collapse: WindowOperation = { type: 'view.collapse', viewId, collapsed: true };
  const view = window.views.find(item => item.id === viewId);
  if (!view || !window.selectedViewId || !within(window, window.selectedViewId, viewId)) return collapse;
  const open = (item: WindowView) => item.id !== viewId && !item.collapsed;
  const primaries = primaryWindowViews(window);
  const index = primaries.findIndex(item => item.id === viewId);
  const source = view.attachedTo ? window.views.find(item => item.id === view.attachedTo) : undefined;
  const primary = index >= 0 ? primaries.slice(0, index).reverse().find(open) ?? primaries.slice(index + 1).find(open)
    : primaries.find(item => item.id === window.selectedPrimaryViewId && open(item)) ?? primaries.find(open);
  // With every primary group folded, an open dock takes the selection.
  const next = source ?? primary ?? window.views.find(item => open(item) && item.placement === 'dock' && !item.attachedTo);
  return next ? { type: 'batch', operations: [collapse, { type: 'view.select', viewId: next.id }] } : collapse;
}
