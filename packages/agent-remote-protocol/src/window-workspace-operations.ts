import { isWindowOperation, isWorkspaceWindow, type WindowEdit, type WindowOperation, type WindowSessionBinding, type WindowView, type WorkspaceWindow } from './window-workspace.js';

export class WindowLayoutError extends Error {
  constructor(readonly code: string, message: string) { super(message); this.name = 'WindowLayoutError'; }
}
function fail(code: string, message: string): never { throw new WindowLayoutError(code, message); }
const clone = <T>(value: T): T => JSON.parse(JSON.stringify(value));
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
  window.views = window.views.filter(view => !ids.has(view.id));
  if (ids.has(window.selectedViewId)) window.selectedViewId = window.primaryViewId;
  if (!window.views.some(view => view.placement === 'dock')) window.mainMinimized = false;
}
function edit(window: WorkspaceWindow, operation: WindowEdit): void {
  if (operation.type === 'rename') { window.title = operation.title; return; }
  if (operation.type === 'layout.apply') { Object.assign(window, clone(operation.layout)); return; }
  if (operation.type === 'main.minimize') {
    if (operation.minimized && !window.views.some(view => view.placement === 'dock')) fail('no_docked_view', 'Open a docked view before minimizing the main area.');
    window.mainMinimized = operation.minimized; return;
  }
  if (operation.type === 'view.create') {
    if (window.views.some(view => view.id === operation.view.id)) fail('view_exists', 'This view identity already exists.');
    if (operation.view.placement === 'primary') fail('invalid_primary', 'A Window already has its primary view.');
    const view = clone(operation.view);
    if (view.attachedTo) {
      if (!window.views.some(item => item.id === view.attachedTo)) fail('view_not_found', 'The source view no longer exists.');
      const group = descendants(window, view.attachedTo);
      const index = window.views.reduce((last, item, index) => group.has(item.id) ? index : last, -1);
      window.views.splice(index + 1, 0, view);
    } else window.views.push(view);
    return;
  }
  const view = window.views.find(view => view.id === operation.viewId);
  if (!view) fail('view_not_found', 'This view no longer exists.');
  switch (operation.type) {
    case 'view.bind': {
      if (view.bindingPolicy === 'managed') fail('managed_view', 'This view has a managed binding. Open another view to select a different session.');
      const previous = view.binding;
      if (!previous || previous.hostId !== operation.binding.hostId || previous.providerId !== operation.binding.providerId || previous.nativeSessionId !== operation.binding.nativeSessionId) {
        const children = descendants(window, view.id); children.delete(view.id);
        for (const child of [...children]) for (const dependent of descendants(window, child, true)) children.add(dependent);
        remove(window, children);
      }
      view.binding = clone(operation.binding); return;
    }
    case 'view.close':
      if (view.id === window.primaryViewId) fail('primary_view_required', 'Replace the main session or delete the Window instead of closing its primary view.');
      remove(window, descendants(window, view.id, true)); return;
    case 'view.select': window.selectedViewId = view.id; view.collapsed = false; return;
    case 'view.resize': view.width = operation.width; return;
    case 'view.display': view.display = clone(operation.display); return;
    case 'view.geometry': view.geometry = clone(operation.geometry); return;
    case 'view.collapse': view.collapsed = operation.collapsed; return;
    case 'view.place':
      if (view.id === window.primaryViewId || view.attachedTo) fail('attached_view', 'Move the source view with its attached views.');
      view.placement = operation.placement;
      if (!window.views.some(item => item.placement === 'dock')) window.mainMinimized = false;
      return;
    case 'view.move': {
      if (view.id === window.primaryViewId || view.attachedTo) fail('attached_view', 'Move the source view with its attached views.');
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
