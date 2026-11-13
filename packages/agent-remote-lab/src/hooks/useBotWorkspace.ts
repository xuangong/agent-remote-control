import { useEffect, useMemo, useRef, useSyncExternalStore } from 'react';
import { botViews, hasBotAppearance, isBotView, type WindowGroup } from '@orchardworks/agent-remote-protocol';
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
  // Only the selected group is kept live; the roster reads every other group from the catalog.
  const ids = enabled && selectedId && !deleted ? [selectedId] : [];
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
  const candidate = place?.kind === 'bot' && group && hasBotAppearance(group) ? group.window.views.find(view => view.id === place.viewId && isBotView(view) && !group.bots?.members[view.id]?.hidden) : undefined;
  const view = candidate && isBotView(candidate) ? candidate : undefined;
  // Every group Bot mode shows, the live selected one in place of its catalog copy: their bots are enrolled so a handoff
  // resolves to the current session for status, and a verified handoff is written into each group's layout.
  const enrolledGroups: WindowGroup[] = !enabled ? [] : [...new Map([...workspace.groups, ...(group ? [group] : [])]
    .filter(item => hasBotAppearance(item) && !workspace.deletedWindowIds.includes(item.window.id)).map(item => [item.window.id, item])).values()];
  const locatorSet = JSON.stringify(enrolledGroups.map(item => [item.window.id, item.window.revision, botViews(item).map(bot => [bot.id, bot.binding])]));
  useEffect(() => {
    if (!enabled || !runtime.active || !enrolledGroups.length) return;
    const current = latest.current.succession, before = current.document.editRevision;
    try {
      for (const item of enrolledGroups) for (const bot of botViews(item)) current.ensureWindowView(item.window.id, bot.id, bot.binding);
      if (current.document.editRevision !== before) { current.save(); runtime.emit(); }
      const identities = JSON.stringify([current.document.scope, enrolledGroups.map(item => [item.window.id, botViews(item).map(bot => [bot.id, bot.binding])])]);
      if (!runtime.enrolled.has(identities)) {
        runtime.enrolled.add(identities);
        void current.refresh().catch(error => {
          if (runtime.active && latest.current.enabled && selectedId && runtime.leases.get(selectedId)?.handle === handle) { runtime.errors.set(selectedId, String(error instanceof Error ? error.message : error)); runtime.emit(); }
        });
      }
    } catch (error) { if (selectedId) { runtime.errors.set(selectedId, String(error instanceof Error ? error.message : error)); runtime.emit(); } }
  }, [runtime, locatorSet, enabled, succession.document]);
  useEffect(() => {
    if (!enabled || succession.discovering || !runtime.active) return;
    for (const item of enrolledGroups) {
      const current = latest.current.workspace.readGroup(item.window.id) ?? (item.window.id === group?.window.id ? group : undefined);
      if (!current || current.window.revision !== item.window.revision) continue;
      const document = latest.current.succession.document, before = document.editRevision;
      const operation = windowSuccessionLayout(document, current.window);
      if (document.editRevision !== before) { latest.current.succession.save(); runtime.emit(); }
      if (!operation) continue;
      const key = JSON.stringify([current.window.id, current.window.revision, operation]);
      if (runtime.layouts.has(key)) continue;
      runtime.layouts.add(key);
      const selected = current.window.id === selectedId;
      void latest.current.workspace.operateGroup(current.window.id, operation).catch(error => {
        // Only the selected group's failure is the selected bot's error; another group retries when it changes or is opened.
        if (selected && runtime.active && latest.current.enabled && runtime.leases.get(current.window.id)?.handle === handle) { runtime.errors.set(current.window.id, error instanceof Error ? error.message : String(error)); runtime.emit(); }
      });
    }
  }, [runtime, locatorSet, succession.document, succession.document.editRevision, succession.discovering, enabled]);
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
