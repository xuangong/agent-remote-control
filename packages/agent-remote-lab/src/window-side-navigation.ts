import { createWindowView, type WindowOperation, type WindowSessionBinding, type WorkspaceWindow } from '@orchardworks/agent-remote-protocol';
import { sessionKey } from './session-tree.js';

/** Side placement belongs to its source Pane, even when another Pane shows the same Session. */
export function sideWindowOperation(window: WorkspaceWindow | undefined, source: { windowId: string; viewId: string; binding: WindowSessionBinding }, target: WindowSessionBinding, newViewId: string): { operation: WindowOperation; viewId: string } {
  const origin = window?.views.find(view => view.id === source.viewId);
  if (!window || window.id !== source.windowId || !origin?.binding
    || sessionKey(origin.binding) !== sessionKey(source.binding) || origin.binding.sessionIntent !== source.binding.sessionIntent) {
    throw new Error('The source view changed. Open the Side session again.');
  }
  const previous = window.views.find(view => view.attachedTo === origin.id);
  if (previous?.binding && sessionKey(previous.binding) === sessionKey(target) && previous.binding.sessionIntent === target.sessionIntent) {
    return { operation: { type: 'view.select', viewId: previous.id }, viewId: previous.id };
  }
  const view = { ...createWindowView(newViewId, target, 'attached'), attachedTo: origin.id };
  return { viewId: view.id, operation: { type: 'batch', operations: [
    ...(previous ? [{ type: 'view.close' as const, viewId: previous.id }] : []),
    { type: 'view.create', view }, { type: 'view.select', viewId: view.id },
  ] } };
}
