import { createWindowView, type WindowOperation, type WorkspaceWindow } from '@orchardworks/agent-remote-protocol';
import type { SessionAttributionTarget } from '@orchardworks/agent-remote-web';
import { sessionKey } from './session-tree.js';

/** Descriptions identify sessions; only the container decides where they appear. */
export function attributionWindowOperation(window: WorkspaceWindow, target: Extract<SessionAttributionTarget, { kind: 'session' }>, title: string, newViewId: string): WindowOperation {
  const matches = window.views.filter(view => view.binding && sessionKey(view.binding) === sessionKey(target)
    && view.binding.sessionIntent === target.sessionIntent);
  const existing = matches.find(view => view.id === window.selectedViewId) ?? matches[0];
  if (existing) return { type: 'view.select', viewId: existing.id };
  const view = createWindowView(newViewId, { hostId: target.hostId ?? 'local', providerId: target.providerId,
    nativeSessionId: target.nativeSessionId, title, ...(target.parentNativeSessionId ? { parentNativeSessionId: target.parentNativeSessionId } : {}),
    ...(target.sessionIntent ? { sessionIntent: target.sessionIntent } : {}) });
  return { type: 'batch', operations: [{ type: 'view.create', view }, { type: 'view.select', viewId: view.id }] };
}
