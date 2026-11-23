import { keyedError } from '@orchardworks/agent-client';
import { parseWindowFeature } from './window-feature-views.js';
import { windowSessionBinding } from './window-workspace.js';
import { createWindowView } from '@orchardworks/agent-remote-protocol';
import type { WindowLayoutAuthority } from './window-workspace-context.js';
import { useEffect, useRef, useState } from 'react';
import { conversationSessionStorage } from './conversation-storage.js';
import { sessionKey } from './session-tree.js';
import { bindCompositionView, compositionSelection, createCompositionView, SESSION_VIEW_LIMIT,
  type CompositionDocument, type CompositionSlot, type CompositionWindow } from './session-composition.js';

export interface SessionWindowTarget { hostId: string; providerId: string; nativeSessionId: string; title: string; parentNativeSessionId?: string }
export interface SessionWindowEntry extends CompositionWindow { target?: SessionWindowTarget; dockRequest?: string }
interface CompositionAccess {
  document: CompositionDocument;
  ensureView(target: SessionWindowTarget): CompositionSlot;
  ensureWindowView?(windowId: string, viewId: string, target: SessionWindowTarget): CompositionSlot;
  save(): unknown;
  shared?: WindowLayoutAuthority;
}
const legacyId = (target: SessionWindowTarget) => `session:${sessionKey(target)}`;
const keyFor = (scope: string) => `agent-remote:recovery:${scope}:session-windows`;
const validTarget = (target: SessionWindowTarget | undefined): target is SessionWindowTarget => !!target
  && ['hostId', 'providerId', 'nativeSessionId', 'title'].every(key => typeof target[key as keyof SessionWindowTarget] === 'string' && !!target[key as keyof SessionWindowTarget]);

/** Native references live in composition; windows own only placement and selection. */
export function useSessionWindows(scope: string, access: CompositionAccess) {
  const latest = useRef(access); latest.current = access;
  const [requests, setRequests] = useState<Record<string, string>>({});
  useEffect(() => {
    const { document, ensureView, save } = latest.current;
    if (latest.current.shared || document.windows !== undefined) return;
    let saved: unknown;
    try { saved = JSON.parse(conversationSessionStorage.getItem(keyFor(scope)) ?? '[]'); } catch { saved = []; }
    document.windows = [];
    for (const value of (Array.isArray(saved) ? saved : []).slice(-SESSION_VIEW_LIMIT)) {
      if (!validTarget(value?.target) || document.windows.some(view => view.id === legacyId(value.target))) continue;
      const slot = ensureView(value.target);
      document.windows.push({ id: legacyId(value.target), slotId: slot.id, managed: !!(value.groupId || value.closeWith),
        ...(typeof value.closeWith === 'string' && value.closeWith ? { closeWith: value.closeWith } : {}) });
    }
    for (const view of document.windows) if (view.closeWith === view.id || !document.windows.some(parent => parent.id === view.closeWith)) delete view.closeWith;
    document.editRevision++; save();
    // The old key is retired only after the shared document has been persisted.
    // Its presence is harmless: an existing windows field is the migration marker.
  }, [scope, access.document]);
  const { document, shared } = access;
  const sharedEntries: SessionWindowEntry[] | undefined = shared?.window.views.filter(view => {
    return view.placement !== 'primary' && !view.attachedTo && !parseWindowFeature(view.feature);
  }).map(view => {
    const slot = view.binding ? (access.ensureWindowView?.(shared!.window.id, view.id, view.binding) ?? access.ensureView(view.binding)) : undefined;
    return {
      id: view.id, slotId: slot?.id, managed: view.bindingPolicy === 'managed',
      target: view.binding ? { ...view.binding } : undefined,
      closeWith: view.closeWith, dockRequest: requests[view.id],
    };
  });
  const entries: SessionWindowEntry[] = sharedEntries ?? (document.windows ?? []).map(view => {
    const slot = document.slots.find(slot => slot.id === view.slotId);
    const selected = slot && compositionSelection(slot);
    return { ...view, ...(selected ? { target: { ...selected, hostId: selected.hostId ?? 'local' } } : {}), dockRequest: requests[view.id] };
  });
  let selectedId = shared ? shared.window.selectedViewId ?? undefined : document.activeWindow;
  if (shared) { let selected = shared.window.views.find(view => view.id === selectedId); while (selected?.attachedTo) selected = shared.window.views.find(view => view.id === selected!.attachedTo); selectedId = selected?.id; }
  const activeId = entries.find(view => view.id === selectedId && !view.managed)?.id;
  function focus(id?: string) {
    if (latest.current.shared) {
      const authority = latest.current.shared, window = authority.readWindow?.() ?? authority.window;
      const viewId = id ?? window.selectedPrimaryViewId;
      const view = window.views.find(view => view.id === viewId);
      if (!viewId || !view || window.selectedViewId === viewId && !view.collapsed) return;
      authority.operate({ type: 'view.select', viewId }); return;
    }
    const { document, save } = latest.current;
    const next = document.windows?.find(view => view.id === id && !view.managed)?.id;
    if (document.activeWindow === next) return;
    document.activeWindow = next; document.editRevision++; save();
  }
  function requestDock(ids: string[]) {
    const request = crypto.randomUUID();
    setRequests(current => ({ ...current, ...Object.fromEntries(ids.map(id => [id, request])) }));
  }
  function create(): string {
    if (latest.current.shared) { const view = createWindowView(crypto.randomUUID()); latest.current.shared.operate({ type: 'batch', operations: [{ type: 'view.create', view }, { type: 'view.select', viewId: view.id }] }); return view.id; }
    const { document, save } = latest.current;
    const view = createCompositionView(document);
    document.activeWindow = view.id; save(); requestDock([view.id]); return view.id;
  }
  function bind(id: string, target: SessionWindowTarget) {
    if (latest.current.shared) { latest.current.shared.operate({ type: 'view.bind', viewId: id, binding: windowSessionBinding(target) }); return; }
    const { document, ensureView, save } = latest.current;
    const view = document.windows?.find(view => view.id === id);
    if (!view || view.managed) throw keyedError('windows.error.viewManaged');
    if (!validTarget(target)) throw keyedError('windows.error.identityIncomplete');
    bindCompositionView(document, id, ensureView(target).id); save();
  }
  function close(id: string) {
    if (latest.current.shared) { latest.current.shared.operate({ type: 'view.close', viewId: id }); return; }
    const { document, save } = latest.current;
    document.windows = (document.windows ?? []).filter(view => view.id !== id && view.closeWith !== id);
    if (!document.windows.some(view => view.id === document.activeWindow)) document.activeWindow = undefined;
    document.editRevision++; save();
    setRequests(current => Object.fromEntries(Object.entries(current).filter(([id]) => document.windows!.some(view => view.id === id))));
  }
  return { entries, activeId, selectedId, create, bind, focus, close };
}
