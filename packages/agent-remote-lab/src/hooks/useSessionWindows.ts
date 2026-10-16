import { createWindowFeature, parseWindowFeature } from '../window-feature-views.js';
import { windowSessionBinding } from '../window-workspace.js';
import { createWindowView, type WindowOperation } from '@orchardworks/agent-remote-protocol';
import type { WindowLayoutAuthority } from '../window-workspace-context.js';
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
        ...(typeof value.target.teamMemberId === 'string' && value.target.teamMemberId ? { teamMemberId: value.target.teamMemberId } : {}),
        ...(typeof value.closeWith === 'string' && value.closeWith ? { closeWith: value.closeWith } : {}), ...(typeof value.groupId === 'string' && value.groupId ? { groupId: value.groupId } : {}) });
    }
    for (const view of document.windows) if (view.closeWith === view.id || !document.windows.some(parent => parent.id === view.closeWith)) delete view.closeWith;
    document.editRevision++; save();
    // The old key is retired only after the shared document has been persisted.
    // Its presence is harmless: an existing windows field is the migration marker.
  }, [scope, access.document]);
  const { document, shared } = access;
  const sharedEntries: SessionWindowEntry[] | undefined = shared?.window.views.filter(view => {
    const feature = parseWindowFeature(view.feature);
    return view.placement !== 'primary' && !view.attachedTo && (!feature || feature.kind === 'team');
  }).map(view => {
    const feature = parseWindowFeature(view.feature);
    const team = feature?.kind === 'team' ? feature : undefined;
    const slot = view.binding ? (access.ensureWindowView?.(shared!.window.id, view.id, view.binding) ?? access.ensureView(view.binding)) : undefined;
    if (slot && team) slot.metadata = { title: slot.metadata?.title ?? view.binding!.title, ...slot.metadata, teamId: team.id, ...(team.memberId ? { teamMemberId: team.memberId } : {}) };
    return {
      id: view.id, slotId: slot?.id, managed: view.bindingPolicy === 'managed',
      target: view.binding ? { ...view.binding, ...(team ? { teamId: team.id, teamMemberId: team.memberId } : {}) } : undefined,
      ...(team?.memberId ? { teamMemberId: team.memberId } : {}),
      closeWith: view.closeWith, groupId: team?.id, dockRequest: requests[view.id],
    };
  });
  const entries: SessionWindowEntry[] = sharedEntries ?? (document.windows ?? []).map(view => {
    const slot = document.slots.find(slot => slot.id === view.slotId);
    const selected = slot && compositionSelection(slot);
    return { ...view, ...(selected ? { target: { ...selected, hostId: selected.hostId ?? 'local' } } : {}), dockRequest: requests[view.id] };
  });
  let selectedId = shared?.window.selectedViewId ?? document.activeWindow;
  if (shared) { let selected = shared.window.views.find(view => view.id === selectedId); while (selected?.attachedTo) selected = shared.window.views.find(view => view.id === selected!.attachedTo); selectedId = selected?.id; }
  const activeId = entries.find(view => view.id === selectedId && !view.managed)?.id;
  function focus(id?: string) {
    if (latest.current.shared) {
      const authority = latest.current.shared, window = authority.readWindow?.() ?? authority.window;
      const viewId = id ?? window.selectedPrimaryViewId;
      if (window.selectedViewId === viewId && !window.views.find(view => view.id === viewId)?.collapsed) return;
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
    if (latest.current.shared) {
      const authority = latest.current.shared;
      const window = authority.readWindow?.() ?? authority.window;
      const operations: WindowOperation[] = [];
      let rootId: string | undefined;
      for (const target of uniqueTargets(groupRoot ? [groupRoot, ...targets] : targets)) {
        const existing = window.views.find(view => {
          if (!view.binding) return false;
          const feature = parseWindowFeature(view.feature);
          return groupRoot && target.teamMemberId
            ? feature?.kind === 'team' && feature.id === groupId && feature.memberId === target.teamMemberId
            : sessionKey(view.binding) === sessionKey(target) && (!groupRoot || feature?.id === groupId);
        });
        const view = existing ?? createWindowView(crypto.randomUUID(), windowSessionBinding(target));
        if (groupRoot && sessionKey(target) === sessionKey(groupRoot)) rootId = view.id;
        if (!existing) {
          if (groupId) {
            view.feature = createWindowFeature({ kind: 'team', id: groupId,
              ...(target.teamMemberId ? { memberId: target.teamMemberId } : {}), role: rootId === view.id ? 'leader' : 'member' });
            view.bindingPolicy = 'managed';
          }
          if (rootId && rootId !== view.id) view.closeWith = rootId;
          operations.push({ type: 'view.create', view });
        }
      }
      if (operations.length) authority.operate({ type: 'batch', operations: operations as any });
      return;
    }
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
    if (latest.current.shared) { if (root.target) open(targets, root.target, root.groupId); return; }
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
    if (latest.current.shared) { latest.current.shared.operate({ type: 'view.close', viewId: id }); return; }
    const { document, save } = latest.current;
    document.windows = (document.windows ?? []).filter(view => view.id !== id && view.closeWith !== id);
    if (!document.windows.some(view => view.id === document.activeWindow)) document.activeWindow = undefined;
    document.editRevision++; save();
    setRequests(current => Object.fromEntries(Object.entries(current).filter(([id]) => document.windows!.some(view => view.id === id))));
  }
  return { entries, activeId, selectedId, create, bind, focus, open, close, gather };
}
