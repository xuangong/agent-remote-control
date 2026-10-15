import { useEffect, useRef, useState } from 'react';
import { conversationSessionStorage } from '../conversation-storage.js';
import { sessionKey } from '../session-tree.js';
import { bindCompositionView, compositionSelection, createCompositionView, SESSION_VIEW_LIMIT,
  type CompositionDocument, type CompositionSlot, type CompositionWindow } from '../session-composition.js';

export interface SessionWindowTarget { teamId?: string; teamMemberId?: string; hostId: string; providerId: string; nativeSessionId: string; title: string; parentNativeSessionId?: string }
export interface SessionWindowEntry extends CompositionWindow { target?: SessionWindowTarget; dockRequest?: string }
interface CompositionAccess {
  document: CompositionDocument;
  ensureView(target: SessionWindowTarget): CompositionSlot;
  save(): unknown;
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
    if (document.windows !== undefined) return;
    let saved: unknown;
    try { saved = JSON.parse(conversationSessionStorage.getItem(keyFor(scope)) ?? '[]'); } catch { saved = []; }
    document.windows = [];
    for (const value of (Array.isArray(saved) ? saved : []).slice(-SESSION_VIEW_LIMIT)) {
      if (!validTarget(value?.target) || document.windows.some(view => view.id === legacyId(value.target))) continue;
      const slot = ensureView(value.target);
      document.windows.push({ id: legacyId(value.target), slotId: slot.id, managed: !!(value.groupId || value.closeWith),
        ...(typeof value.closeWith === 'string' && value.closeWith ? { closeWith: value.closeWith } : {}), ...(typeof value.groupId === 'string' && value.groupId ? { groupId: value.groupId } : {}) });
    }
    for (const view of document.windows) if (view.closeWith === view.id || !document.windows.some(parent => parent.id === view.closeWith)) delete view.closeWith;
    document.editRevision++; save();
    // The old key is retired only after the shared document has been persisted.
    // Its presence is harmless: an existing windows field is the migration marker.
  }, [scope, access.document]);
  const { document } = access;
  const entries: SessionWindowEntry[] = (document.windows ?? []).map(view => {
    const slot = document.slots.find(slot => slot.id === view.slotId);
    const selected = slot && compositionSelection(slot);
    return { ...view, ...(selected ? { target: { ...selected, hostId: selected.hostId ?? 'local' } } : {}), dockRequest: requests[view.id] };
  });
  const activeId = entries.find(view => view.id === document.activeWindow && !view.managed)?.id;
  function focus(id?: string) {
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
    const { document, save } = latest.current;
    const view = createCompositionView(document);
    document.activeWindow = view.id; save(); requestDock([view.id]); return view.id;
  }
  function bind(id: string, target: SessionWindowTarget) {
    const { document, ensureView, save } = latest.current;
    const view = document.windows?.find(view => view.id === id);
    if (!view || view.managed) throw new Error('This session view is closed or managed by its feature.');
    if (!validTarget(target)) throw new Error('The selected session identity is incomplete.');
    bindCompositionView(document, id, ensureView(target).id); save();
  }
  function uniqueTargets(targets: SessionWindowTarget[]) {
    if (targets.some(target => !validTarget(target))) throw new Error('The selected session identity is incomplete.');
    return [...new Map(targets.map(target => [sessionKey(target), target])).values()];
  }
  function matchesTarget(view: CompositionWindow, target: SessionWindowTarget) {
    const slot = latest.current.document.slots.find(slot => slot.id === view.slotId);
    return slot && sessionKey(compositionSelection(slot)) === sessionKey(target);
  }
  function checkCapacity(missing: number) {
    if ((latest.current.document.windows?.length ?? 0) + missing > SESSION_VIEW_LIMIT) {
      throw new Error(`Close a session view before opening more than ${SESSION_VIEW_LIMIT}.`);
    }
  }
  function open(targets: SessionWindowTarget[], groupRoot?: SessionWindowTarget, groupId?: string) {
    const { document, ensureView, save } = latest.current;
    const windows = document.windows ??= [];
    const ordered = uniqueTargets(groupRoot ? [groupRoot, ...targets] : targets);
    const existingRoot = groupRoot && windows.find(view => view.managed && view.groupId === groupId && matchesTarget(view, groupRoot));
    const matches = (target: SessionWindowTarget) => windows.find(view => !!view.managed === !!groupRoot
      && (!groupRoot || existingRoot && (view.id === existingRoot.id || view.closeWith === existingRoot.id)) && matchesTarget(view, target));
    checkCapacity(ordered.filter(target => !matches(target)).length);
    const ids: string[] = [];
    let rootId: string | undefined;
    for (const target of ordered) {
      let view = matches(target);
      if (!view) {
        const slot = ensureView(target);
        view = createCompositionView(document);
        bindCompositionView(document, view.id, slot.id);
        view.managed = !!groupRoot;
      }
      if (target.teamMemberId) view.teamMemberId = target.teamMemberId;
      if (groupRoot && sessionKey(target) === sessionKey(groupRoot)) { rootId = view.id; view.groupId = groupId; }
      else if (rootId) view.closeWith = rootId;
      ids.push(view.id);
    }
    document.editRevision++; save(); requestDock(ids);
  }
  function gather(root: SessionWindowEntry, targets: SessionWindowTarget[]) {
    const { document, ensureView, save } = latest.current;
    if (!document.windows?.some(view => view.managed && view.id === root.id && view.groupId === root.groupId)) return;
    const ordered = uniqueTargets(targets);
    const matches = (target: SessionWindowTarget) => document.windows!.find(view => view.managed
      && (view.id === root.id || view.closeWith === root.id) && matchesTarget(view, target));
    checkCapacity(ordered.filter(target => !matches(target)).length);
    const added: string[] = [];
    for (const target of ordered) {
      let view = matches(target);
      if (!view) {
        const slot = ensureView(target);
        view = createCompositionView(document); bindCompositionView(document, view.id, slot.id);
        view.managed = true; added.push(view.id);
      }
      if (target.teamMemberId) view.teamMemberId = target.teamMemberId;
      if (view.id !== root.id) view.closeWith = root.id;
    }
    document.editRevision++; save(); if (added.length) requestDock(added);
  }
  function close(id: string) {
    const { document, save } = latest.current;
    document.windows = (document.windows ?? []).filter(view => view.id !== id && view.closeWith !== id);
    if (!document.windows.some(view => view.id === document.activeWindow)) document.activeWindow = undefined;
    document.editRevision++; save();
    setRequests(current => Object.fromEntries(Object.entries(current).filter(([id]) => document.windows!.some(view => view.id === id))));
  }
  return { entries, activeId, create, bind, focus, open, close, gather };
}
