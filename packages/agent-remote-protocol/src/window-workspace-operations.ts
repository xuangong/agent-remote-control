import { isWindowOperation, isWorkspaceWindow, primaryWindowViews, windowPrimaryViewId, type WindowEdit, type WindowOperation, type WindowSessionBinding, type WindowView, type WorkspaceWindow } from './window-workspace.js';

export class WindowLayoutError extends Error {
  constructor(readonly code: string, message: string) { super(message); this.name = 'WindowLayoutError'; }
}
function fail(code: string, message: string): never { throw new WindowLayoutError(code, message); }
const clone = <T>(value: T): T => JSON.parse(JSON.stringify(value));
function sameBindingTarget(current: WindowSessionBinding | undefined, expected: WindowSessionBinding | null): boolean {
  if (expected === null) return current === undefined;
  return !!current && current.hostId === expected.hostId && current.providerId === expected.providerId
    && current.nativeSessionId === expected.nativeSessionId && current.parentNativeSessionId === expected.parentNativeSessionId
    && current.sessionIntent === expected.sessionIntent;
}
export function createWindowView(id: string, binding?: WindowSessionBinding, placement: WindowView['placement'] = 'dock'): WindowView {
  return { id, ...(binding ? { binding: clone(binding) } : {}), placement, width: 440, collapsed: false, display: { mode: 'preview', lettersVisible: true } };
}
function descendants(window: WorkspaceWindow, root: string, cascadeClose = false): Set<string> {
  const ids = new Set([root]);
  for (let changed = true; changed;) {
    changed = false;
    for (const view of window.views) if (!ids.has(view.id) && (view.attachedTo && ids.has(view.attachedTo)
      || cascadeClose && view.closeWith && ids.has(view.closeWith))) {
      ids.add(view.id); changed = true;
    }
  }
  return ids;
}
function remove(window: WorkspaceWindow, ids: Set<string>) {
  const previousViews = window.views;
  const previousSelection = window.selectedViewId;
  window.views = window.views.filter(view => !ids.has(view.id));
  const surviving = new Set(window.views.map(view => view.id));
  if (previousSelection !== null && !surviving.has(previousSelection)) {
    let ancestor = previousViews.find(view => view.id === previousSelection)?.attachedTo;
    while (ancestor && !surviving.has(ancestor)) ancestor = previousViews.find(view => view.id === ancestor)?.attachedTo;
    const selectedIndex = previousViews.findIndex(view => view.id === previousSelection);
    const neighbor = previousViews.slice(0, selectedIndex).reverse().find(view => surviving.has(view.id))
      ?? previousViews.slice(selectedIndex + 1).find(view => surviving.has(view.id));
    window.selectedViewId = ancestor ?? neighbor?.id ?? null;
    if (window.selectedViewId !== null) expandSelection(window, window.selectedViewId);
  }
  reconcilePrimarySelection(window);
}
function reconcilePrimarySelection(window: WorkspaceWindow): void {
  const primaries = primaryWindowViews(window);
  window.selectedPrimaryViewId = windowPrimaryViewId(window, window.selectedViewId)
    ?? primaries.find(view => view.id === window.selectedPrimaryViewId)?.id ?? primaries[0]?.id ?? null;
}
function expandSelection(window: WorkspaceWindow, viewId: string): void {
  let view = window.views.find(view => view.id === viewId);
  while (view) {
    view.collapsed = false;
    view = view.attachedTo ? window.views.find(candidate => candidate.id === view!.attachedTo) : undefined;
  }
}
function edit(window: WorkspaceWindow, operation: WindowEdit): void {
  if (operation.type === 'rename') { window.title = operation.title; return; }
  if (operation.type === 'layout.apply') { Object.assign(window, clone(operation.layout)); return; }
  if (operation.type === 'view.create') {
    if (window.views.some(view => view.id === operation.view.id)) fail('view_exists', 'This view identity already exists.');
    const view = clone(operation.view);
    if (view.attachedTo) {
      if (!window.views.some(item => item.id === view.attachedTo)) fail('view_not_found', 'The source view no longer exists.');
      const group = descendants(window, view.attachedTo);
      const index = window.views.reduce((last, item, index) => group.has(item.id) ? index : last, -1);
      window.views.splice(index + 1, 0, view);
    } else window.views.push(view);
    if (window.selectedViewId === null) {
      window.selectedViewId = view.id;
      expandSelection(window, view.id);
    }
    reconcilePrimarySelection(window);
    return;
  }
  const view = window.views.find(view => view.id === operation.viewId);
  if (!view) fail('view_not_found', 'This view no longer exists.');
  switch (operation.type) {
    case 'view.bind': {
      if (view.bindingPolicy === 'managed') fail('managed_view', 'This view has a managed binding. Open another view to select a different session.');
      if (operation.expectedBinding !== undefined && !sameBindingTarget(view.binding, operation.expectedBinding)) {
        fail('view_binding_changed', 'The target session view changed. Choose it again before opening a session.');
      }
      const previous = view.binding;
      if (!previous || previous.hostId !== operation.binding.hostId || previous.providerId !== operation.binding.providerId || previous.nativeSessionId !== operation.binding.nativeSessionId) {
        const children = descendants(window, view.id); children.delete(view.id);
        for (const child of [...children]) for (const dependent of descendants(window, child, true)) children.add(dependent);
        remove(window, children);
      }
      view.binding = clone(operation.binding); return;
    }
    case 'view.close':
      remove(window, descendants(window, view.id, true)); return;
    case 'view.select': {
      window.selectedViewId = view.id;
      expandSelection(window, view.id);
      reconcilePrimarySelection(window);
      return;
    }
    case 'view.resize': view.width = operation.width; return;
    case 'view.display': view.display = clone(operation.display); return;
    case 'view.geometry': view.geometry = clone(operation.geometry); return;
    case 'view.collapse': view.collapsed = operation.collapsed; return;
    case 'view.place':
      if (view.placement === 'primary' || view.attachedTo) fail('attached_view', 'Move the source view with its attached views.');
      view.placement = operation.placement;
      return;
    case 'view.move': {
      if (view.attachedTo) fail('attached_view', 'Move the source view with its attached views.');
      const group = descendants(window, view.id);
      if (group.has(operation.afterId)) fail('invalid_destination', 'A view cannot move after its own group.');
      let after = window.views.find(item => item.id === operation.afterId);
      if (!after) fail('view_not_found', 'The destination view no longer exists.');
      while (after.attachedTo) after = window.views.find(item => item.id === after!.attachedTo)!;
      const destination = descendants(window, after.id);
      const moved = window.views.filter(item => group.has(item.id));
      window.views = window.views.filter(item => !group.has(item.id));
      const index = window.views.reduce((last, item, index) => destination.has(item.id) ? index : last, -1);
      window.views.splice(index + 1, 0, ...moved); return;
    }
  }
}

/** Apply one explicit command atomically. Native execution is never part of a layout transition. */
export function applyWindowOperation(source: WorkspaceWindow, operation: WindowOperation): WorkspaceWindow {
  if (!isWorkspaceWindow(source) || !isWindowOperation(operation)) fail('invalid_window_operation', 'The Window or operation is invalid.');
  if (source.revision >= Number.MAX_SAFE_INTEGER) fail('window_revision_limit', 'The Window revision limit has been reached.');
  const result = clone(source);
  for (const item of operation.type === 'batch' ? operation.operations : [operation]) {
    edit(result, item);
    if (!isWorkspaceWindow(result)) fail('invalid_window_layout', 'The resulting Window has invalid or unavailable view references.');
  }
  result.revision = source.revision + 1;
  if (!isWorkspaceWindow(result)) fail('invalid_window_layout', 'The resulting Window has invalid or unavailable view references.');
  return result;
}
