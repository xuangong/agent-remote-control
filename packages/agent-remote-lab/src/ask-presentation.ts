import type { WindowView, WorkspaceWindow } from '@orchardworks/agent-remote-protocol';

export function isAskSelected(window: WorkspaceWindow | undefined, view: WindowView | undefined): boolean {
  let selectedView = window?.views.find(candidate => candidate.id === window.selectedViewId);
  const selectedAncestors = new Set<string>();
  while (selectedView && !selectedAncestors.has(selectedView.id)) {
    selectedAncestors.add(selectedView.id);
    selectedView = window?.views.find(candidate => candidate.id === selectedView!.attachedTo);
  }
  return !!view && selectedAncestors.has(view.id);
}

/** Rendering and read receipts share the same global Ask visibility boundary. */
export function resolveAskPresentation({ window, view, visible, expanded, compact }: {
  window?: WorkspaceWindow;
  view?: WindowView;
  visible: boolean;
  expanded: boolean;
  compact: boolean;
}): { shown: boolean; selected: boolean } {
  const selected = isAskSelected(window, view);
  return {
    selected,
    shown: visible && expanded && !view?.collapsed && (!window || !compact || !view || selected),
  };
}
