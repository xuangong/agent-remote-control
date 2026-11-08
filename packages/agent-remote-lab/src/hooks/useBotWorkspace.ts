import { useEffect, useMemo, useRef, useSyncExternalStore } from 'react';
import { groupBotViews, isBotView } from '@orchardworks/agent-remote-protocol';
import type { BotPlace } from '../workbench-mode.js';
import { windowBindingKey, windowSuccessionLayout } from '../window-composition.js';
import type { useSessionSuccession } from './useSessionSuccession.js';
import type { GroupHandle, useWindowWorkspace } from './useWindowWorkspace.js';

type Workspace = ReturnType<typeof useWindowWorkspace>;
type Succession = Pick<ReturnType<typeof useSessionSuccession>, 'document' | 'ensureWindowView' | 'save' | 'refresh' | 'discovering'>;
export function useBotWorkspace(workspace: Workspace, succession: Succession, place: BotPlace | undefined, enabled: boolean) {
  const latest = useRef({ workspace, succession, enabled }); latest.current = { workspace, succession, enabled };
  const runtime = useMemo(() => {
    const listeners = new Set<() => void>();
    const state = { active: false, version: 0, leases: new Map<string, { handle: GroupHandle; unsubscribe(): void }>(), pending: new Map<string, symbol>(), errors: new Map<string, string>(), enrolled: new Set<string>(), layouts: new Set<string>(),
      emit: () => { if (state.active) { state.version++; for (const listener of listeners) listener(); } },
      subscribe: (listener: () => void) => { listeners.add(listener); return () => { listeners.delete(listener); }; }, getSnapshot: () => state.version,
    }; return state;
  }, [workspace.acquireGroup, succession.document.scope]);
  useSyncExternalStore(runtime.subscribe, runtime.getSnapshot);
  const selectedId = place?.kind === 'bot' || place?.kind === 'section' ? place.groupId : undefined;
  const deleted = selectedId ? workspace.deletedWindowIds.includes(selectedId) : false;
  const ids = enabled ? [...new Set([...workspace.groups.filter(group => group.bots && !workspace.deletedWindowIds.includes(group.window.id)).map(group => group.window.id), ...(selectedId && !deleted ? [selectedId] : [])])].sort() : [];
  const idsKey = JSON.stringify(ids);
  useEffect(() => {
    runtime.active = true;
    return () => {
      runtime.active = false; runtime.pending.clear();
      for (const lease of runtime.leases.values()) { lease.unsubscribe(); lease.handle.release(); } runtime.leases.clear();
    };
  }, [runtime]);
  const acquire = async (id: string): Promise<void> => {
    const token = Symbol(id); runtime.pending.set(id, token); runtime.errors.delete(id); runtime.emit();
    try {
      const handle = await latest.current.workspace.acquireGroup(id);
      if (!runtime.active || !latest.current.enabled || runtime.pending.get(id) !== token) { handle.release(); return; }
      runtime.pending.delete(id); const unsubscribe = handle.subscribe(runtime.emit); runtime.leases.set(id, { handle, unsubscribe }); runtime.emit();
    } catch (error) {
      if (!runtime.active || runtime.pending.get(id) !== token) return;
      runtime.pending.delete(id); runtime.errors.set(id, error instanceof Error ? error.message : String(error)); runtime.emit();
    }
  };
  useEffect(() => {
    const wanted = new Set(ids);
    for (const [id, lease] of runtime.leases) if (!wanted.has(id)) { lease.unsubscribe(); lease.handle.release(); runtime.leases.delete(id); }
    for (const id of runtime.pending.keys()) if (!wanted.has(id)) runtime.pending.delete(id);
    for (const id of ids) {
      if (runtime.leases.has(id) || runtime.pending.has(id)) continue;
      void acquire(id);
    }
    runtime.emit();
  }, [runtime, idsKey]);
  useEffect(() => {
    if (!enabled) return;
    let active = true;
    const refreshCatalog = () => { void latest.current.workspace.refreshGroups().catch(error => {
      if (active && runtime.active && selectedId) { runtime.errors.set(selectedId, error instanceof Error ? error.message : String(error)); runtime.emit(); }
    }); };
    refreshCatalog(); addEventListener('focus', refreshCatalog);
    return () => { active = false; removeEventListener('focus', refreshCatalog); };
  }, [runtime, enabled]);
  const handle = enabled && !deleted && selectedId ? runtime.leases.get(selectedId)?.handle : undefined;
  const group = handle?.getGroup();
  const candidate = place?.kind === 'bot' && group?.bots ? group.window.views.find(view => view.id === place.viewId && isBotView(view) && !group.bots!.members[view.id]?.hidden) : undefined;
  const view = candidate && isBotView(candidate) ? candidate : undefined;
  const locatorSet = group ? JSON.stringify(groupBotViews(group).map(view => [view.id, view.binding])) : '';
  useEffect(() => {
    if (!enabled || !group || !runtime.active) return;
    const current = latest.current.succession, before = current.document.editRevision;
    try {
      for (const view of groupBotViews(group)) current.ensureWindowView(group.window.id, view.id, view.binding);
      if (current.document.editRevision !== before) { current.save(); runtime.emit(); }
      const enrollment = JSON.stringify([current.document.scope, group.window.id, locatorSet]);
      if (!runtime.enrolled.has(enrollment)) {
        runtime.enrolled.add(enrollment);
        void current.refresh().catch(error => {
          if (runtime.active && latest.current.enabled && runtime.leases.get(group.window.id)?.handle === handle) { runtime.errors.set(group.window.id, String(error instanceof Error ? error.message : error)); runtime.emit(); }
        });
      }
    } catch (error) { runtime.errors.set(group.window.id, String(error instanceof Error ? error.message : error)); runtime.emit(); }
  }, [runtime, group?.window.id, locatorSet, enabled, succession.document]);
  useEffect(() => {
    if (!enabled || !group || succession.discovering || !runtime.active) return;
    const current = latest.current.workspace.readGroup(group.window.id);
    if (!current || current.window.revision !== group.window.revision) return;
    const document = latest.current.succession.document, before = document.editRevision;
    const operation = windowSuccessionLayout(document, current.window);
    if (document.editRevision !== before) { latest.current.succession.save(); runtime.emit(); }
    if (!operation) return;
    const key = JSON.stringify([current.window.id, current.window.revision, operation]);
    if (runtime.layouts.has(key)) return;
    runtime.layouts.add(key);
    void latest.current.workspace.operateGroup(current.window.id, operation).catch(error => {
      if (runtime.active && latest.current.enabled && runtime.leases.get(current.window.id)?.handle === handle) { runtime.errors.set(current.window.id, error instanceof Error ? error.message : String(error)); runtime.emit(); }
    });
  }, [runtime, group?.window.id, group?.window.revision, locatorSet, succession.document, succession.document.editRevision, succession.discovering, enabled]);
  const slotId = view && group ? succession.document.windowBindings?.find(entry => entry.windowId === group.window.id && entry.viewId === view.id && entry.bindingKey === windowBindingKey(view.binding))?.slotId : undefined;
  const slot = slotId ? succession.document.slots.find(slot => slot.id === slotId) : undefined;
  const loading = enabled && !!selectedId && !deleted && runtime.pending.has(selectedId);
  const error = !enabled || !selectedId ? undefined : deleted ? 'This bot or section is unavailable.' : runtime.errors.get(selectedId) ?? (!loading && (!group || place?.kind === 'bot' && !view) ? 'This bot or section is unavailable.' : undefined);
  return { group, view, slot, loading, error, saveState: handle?.getSyncState(),
    retry: async () => {
      if (handle) { await handle.retry(); if (selectedId) runtime.errors.delete(selectedId); runtime.emit(); }
      else if (selectedId && enabled && !deleted && !runtime.pending.has(selectedId)) await acquire(selectedId);
    },
    refresh: async () => { if (!enabled) return; await latest.current.workspace.refreshGroups(); await latest.current.succession.refresh(); },
  };
}
