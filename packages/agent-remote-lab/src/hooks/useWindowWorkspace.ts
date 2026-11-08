import { createWindowSessionBridge, resolveCompositionWindowViewId } from '../window-composition.js';
import { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react';
import { WindowWorkspaceClient, WindowMutationUnknownError, WindowRequestError, type WindowOperationIdentity, type WindowSnapshot } from '@orchardworks/agent-remote-web';
import type { WindowCreateRequest, WindowOperation, WindowSessionBinding, WorkspaceWindow } from '@orchardworks/agent-remote-protocol';
import { conversationLocalStorage, conversationSessionStorage } from '../conversation-storage.js';
import { captureImportedWindowComposition, restoreImportedWindowComposition, commitImportedWindowComposition, importCompositionWindow, WindowWorkspaceStore } from '../window-workspace.js';
import type { CompositionDocument } from '../session-composition.js';
import type { WorkbenchMode } from '../workbench-mode.js';
import type { WindowSaveState } from '../window-workspace-store.js';
import { applyGroupOperation, applyWindowOperation, createWindowView, decodeWindowGroup, decodeWorkspaceWindow, hasWindowAppearance, isWindowCreateRequest, isWindowGroupCreateRequest, toWindowGroup, windowPrimaryViewId, type WindowGroup, type WindowGroupOperation } from '@orchardworks/agent-remote-protocol';

interface PendingCreation { request: WindowCreateRequest; candidate: WorkspaceWindow; bindings: Array<[string, string]> }
interface CreatedWindow { candidate: WorkspaceWindow; snapshot: WindowSnapshot }
export interface GroupHandle {
  getGroup(): WindowGroup;
  getSyncState(): WindowSaveState;
  subscribe(listener: () => void): () => void;
  operate(operation: WindowGroupOperation): Promise<void>;
  retry(): Promise<void>;
  release(): void;
}
export interface WorkspaceNavigation { mode: WorkbenchMode; onSectionRoute(groupId: string): void }
interface PendingSectionCreation { group: WindowGroup; operationId: string; issuedAt: number }
export interface SectionCreationState { state: 'idle' | 'saving' | 'unknown' | 'error'; title?: string; error?: string }
const knownRejection = (error: unknown) => error instanceof WindowRequestError && (error.result?.status === 'rejected' || error.status >= 400 && error.status < 500);
const emptyWindow = (): WorkspaceWindow => ({ schemaVersion: 3, id: crypto.randomUUID(), revision: 0, title: 'Window', selectedPrimaryViewId: 'main', selectedViewId: 'main', views: [createWindowView('main', undefined, 'primary')] });

function sessionLinkOperation(window: WorkspaceWindow, binding: WindowSessionBinding): WindowOperation | undefined {
  const selected = window.views.find(view => view.id === window.selectedViewId);
  const matches = (view: WorkspaceWindow['views'][number]) => view.binding?.hostId === binding.hostId && view.binding.providerId === binding.providerId
    && view.binding.nativeSessionId === binding.nativeSessionId && view.binding.sessionIntent === binding.sessionIntent;
  const matching = selected && matches(selected) ? selected : window.views.find(matches);
  if (matching) return matching.id === selected?.id && !matching.collapsed ? undefined : { type: 'view.select', viewId: matching.id };
  if (!selected || selected.bindingPolicy === 'managed') {
    const view = createWindowView(crypto.randomUUID(), binding, selected ? 'dock' : 'primary');
    return { type: 'batch', operations: [{ type: 'view.create', view }, { type: 'view.select', viewId: view.id }] };
  }
  return { type: 'batch', operations: [
    { type: 'view.bind', viewId: selected.id, binding, expectedBinding: selected.binding ?? null },
    { type: 'view.select', viewId: selected.id },
  ] };
}

/** Product page catalog and URL selection; each chosen Window keeps its own store. */
export function useWindowWorkspace(scope: string, hosted: boolean, enabled: boolean, composition: CompositionDocument, participating = true, workspaceNavigation?: WorkspaceNavigation) {
  const client = useMemo(() => hosted ? new WindowWorkspaceClient(scope) : undefined, [scope, hosted]);
  const key = `agent-remote:recovery:${scope}:shared-window`;
  const creation = useMemo(() => ({ pending: undefined as PendingCreation | null | undefined, running: undefined as Promise<CreatedWindow> | undefined }), [key, client]);
  const sectionCreation = useMemo(() => {
    const listeners = new Set<() => void>();
    const runtime = { pending: undefined as PendingSectionCreation | null | undefined, running: undefined as Promise<string> | undefined, state: { state: 'idle' } as SectionCreationState,
      getSnapshot: (): SectionCreationState => runtime.state,
      subscribe: (listener: () => void) => { listeners.add(listener); return () => { listeners.delete(listener); }; },
      publish: (state: SectionCreationState) => { runtime.state = state; for (const listener of listeners) listener(); },
    }; return runtime;
  }, [key, client]);
  const sectionCreationState = useSyncExternalStore(sectionCreation.subscribe, sectionCreation.getSnapshot);
  const deletions = useMemo(() => new Map<string, { window?: WorkspaceWindow; identity: WindowOperationIdentity; dispatched: boolean; running?: Promise<void> }>(), [key, client]);
  const selection = useMemo(() => ({ generation: 0, active: true, deleted: new Set<string>() }), [key, client]);
  const stores = useMemo(() => new Map<string, WindowWorkspaceStore>(), [key, client]);
  const catalogSubscriptions = useMemo(() => new Map<string, () => void>(), [stores]);
  const watches = useMemo(() => new Map<WindowWorkspaceStore, { leases: Set<symbol>; abort: AbortController }>(), [stores]);
  const acquisitions = useMemo(() => new Map<string, Promise<WindowWorkspaceStore>>(), [stores]);
  const catalog = useMemo(() => ({ groups: [] as WindowGroup[], generation: 0 }), [stores]);
  const admission = useMemo(() => ({}), [stores, enabled, participating]);
  const currentAdmission = useRef(admission); currentAdmission.current = admission;
  const foreground = useRef(true); foreground.current = (workspaceNavigation?.mode ?? 'window') === 'window';
  const sectionRoute = useRef(workspaceNavigation?.onSectionRoute); sectionRoute.current = workspaceNavigation?.onSectionRoute;
  const access = useRef(enabled && participating); access.current = enabled && participating;
  const currentSelection = useRef(selection); currentSelection.current = selection;
  const inScope = () => selection.active && currentSelection.current === selection;
  const [store, setStore] = useState<WindowWorkspaceStore>();
  const currentStore = useRef<WindowWorkspaceStore>();
  useEffect(() => {
    selection.active = true;
    for (const saved of stores.values()) saved.setEnabled(access.current);
    return () => {
      selection.active = false; selection.generation++; currentStore.current = undefined;
      for (const watch of watches.values()) watch.abort.abort(); watches.clear();
      for (const saved of stores.values()) saved.setEnabled(false);
      // React may immediately replay effects; only a departed scope owns disposal.
      queueMicrotask(() => { if (!selection.active) {
        for (const unsubscribe of catalogSubscriptions.values()) unsubscribe(); catalogSubscriptions.clear();
        for (const saved of stores.values()) saved.dispose(); stores.clear();
      } });
    };
  }, [selection, stores, catalogSubscriptions, watches]);
  useEffect(() => {
    for (const saved of stores.values()) saved.setEnabled(enabled && participating);
    if (!enabled || !participating) { for (const watch of watches.values()) watch.abort.abort(); watches.clear(); }
  }, [stores, enabled, participating, watches]);
  const confirmedStores = useMemo(() => new WeakSet<WindowWorkspaceStore>(), [key, client]);
  const [unavailable, setUnavailable] = useState(false);
  const currentlyUnavailable = useRef(unavailable); currentlyUnavailable.current = unavailable;
  const readWindow = useCallback(() => currentlyUnavailable.current ? undefined : currentStore.current?.getSnapshot(), []);
  const [deleted, setDeleted] = useState(false);
  const selectStore = (next: WindowWorkspaceStore | undefined) => { currentStore.current = next; setStore(next); };
  const [groups, setGroups] = useState<WindowGroup[]>([]);
  // Only a group shown as a Window can be opened in the workbench; a section alone belongs to Bot mode.
  const windows = useMemo(() => groups.filter(hasWindowAppearance).map(group => group.window), [groups]);
  const [error, setError] = useState<string>();
  const [route, setRoute] = useState(() => globalThis.location.href);
  const navigation = useMemo(() => ({ url: globalThis.location.href }), [route, key]);
  useEffect(() => { const navigate = () => setRoute(globalThis.location.href); globalThis.addEventListener('popstate', navigate); return () => globalThis.removeEventListener('popstate', navigate); }, []);
  const cache = (group: WindowGroup) => {
    if (selection.deleted.has(group.window.id)) return;
    try {
      const previous = decodeWindowGroup(JSON.parse(conversationLocalStorage.getItem(`${key}:${group.window.id}`) ?? 'null'))?.window;
      if (!previous || previous.revision <= group.window.revision) persistLocal(group);
    } catch { /* The service remains authoritative when cache storage is unavailable. */ }
  };
  const persistLocal = (group: WindowGroup) => conversationLocalStorage.setItem(`${key}:${group.window.id}`, JSON.stringify(group));
  const choose = (group: WindowGroup, created = false, confirmed = true) => {
    const window = group.window;
    if (!inScope() || selection.deleted.has(window.id) || deletions.get(window.id)?.dispatched) return;
    if (workspaceNavigation && !hasWindowAppearance(group)) {
      if (confirmed) { makeStore(group).accept(group); updateCatalog(group); }
      selectStore(undefined); currentlyUnavailable.current = true; setUnavailable(true);
      if (confirmed && foreground.current) sectionRoute.current?.(window.id);
      return;
    }
    if (!foreground.current) return;
    if (created && !client) persistLocal(group);
    const next = makeStore(group);
    if (confirmed) { next.accept(group); confirmedStores.add(next); }
    if (client) cache(next.getCommittedGroup());
    if (confirmed) commitImportedWindowComposition(composition, window);
    if (workspaceNavigation && !confirmed) {
      selectStore(next); currentlyUnavailable.current = true; setUnavailable(true); setDeleted(false); return;
    }
    try { conversationSessionStorage.setItem(key, window.id); } catch { /* The URL still identifies the chosen Window. */ }
    try { conversationLocalStorage.setItem(`${key}:last-window`, window.id); } catch { /* The catalog can restore a Window without this preference. */ }
    const url = new URL(globalThis.location.href);
    if (url.searchParams.get('window') !== window.id) { url.searchParams.set('window', window.id); globalThis.history.replaceState(globalThis.history.state, '', url); }
    navigation.url = url.href;
    selectStore(next); currentlyUnavailable.current = false; setUnavailable(false); setDeleted(false);
  };
  const readCached = (id: string): WindowGroup | undefined => {
    const existing = stores.get(id); if (existing) return existing.getCommittedGroup();
    try {
      const journal = JSON.parse(conversationSessionStorage.getItem(`${key}:pending:${id}`) ?? 'null');
      const committed = decodeWindowGroup(journal?.committed);
      if (committed?.window.id === id) return committed;
    } catch { /* Fall back to the last confirmed layout. */ }
    try { const value = decodeWindowGroup(JSON.parse(conversationLocalStorage.getItem(`${key}:${id}`) ?? 'null')); return value?.window.id === id ? value : undefined; }
    catch { return undefined; }
  };
  const makeStore = (group: WindowGroup) => {
    const window = group.window;
    const existing = stores.get(window.id); if (existing) return existing;
    let recovery: unknown;
    try { recovery = JSON.parse(conversationSessionStorage.getItem(`${key}:pending:${window.id}`) ?? 'null'); } catch { /* Invalid journals do not replace a confirmed layout. */ }
    const next = new WindowWorkspaceStore(group, client, client ? () => cache(next.getCommittedGroup()) : undefined, client ? undefined : async (source, operation) => {
      const commit = async () => {
        const value = decodeWindowGroup(JSON.parse(conversationLocalStorage.getItem(`${key}:${source.window.id}`) ?? 'null'));
        if (!value) throw new Error('The local Window is unavailable.');
        const replacesLayout = operation.type === 'layout.apply' || operation.type === 'batch' && operation.operations.some(edit => edit.type === 'layout.apply');
        if (replacesLayout && value.window.revision !== source.window.revision) throw new Error('The Window changed before applying this layout. Refresh and retry.');
        const result = applyGroupOperation(value, operation); persistLocal(result); return result;
      };
      return globalThis.navigator.locks ? globalThis.navigator.locks.request(`${key}:${source.window.id}`, commit) : commit();
    }, {
      recovery, autoRetry: true, paused: !access.current,
      persist: value => {
        if (selection.deleted.has(window.id)) return;
        if (value.edits.length) conversationSessionStorage.setItem(`${key}:pending:${window.id}`, JSON.stringify(value));
        else conversationSessionStorage.removeItem(`${key}:pending:${window.id}`);
      },
    });
    stores.set(window.id, next);
    catalogSubscriptions.set(window.id, next.subscribe(() => updateCatalog(next.getGroup())));
    updateCatalog(next.getGroup());
    next.setEnabled(access.current);
    return next;
  };
  useEffect(() => {
    if (!participating) return;
    const prefix = `${key}:pending:`;
    try {
      for (const entry of conversationSessionStorage.keys().filter(entry => entry.startsWith(prefix))) {
        const id = entry.slice(prefix.length), cached = readCached(id);
        if (cached && !selection.deleted.has(id)) makeStore(cached);
      }
    } catch { /* Live layout and network saving do not require recovery storage. */ }
  }, [stores, participating]);
  const pendingCreation = (): PendingCreation | undefined => {
    if (creation.pending !== undefined) return creation.pending ?? undefined;
    const saved = conversationSessionStorage.getItem(`${key}:pending-create`);
    if (!saved) { creation.pending = null; return; }
    const value: unknown = JSON.parse(saved);
    const raw = value && typeof value === 'object' && 'request' in value ? value.request : undefined;
    const candidate = raw && typeof raw === 'object' && 'window' in raw ? decodeWorkspaceWindow(raw.window) : undefined;
    if (!candidate || !raw || typeof raw !== 'object' || !isWindowCreateRequest({ ...raw, window: candidate })) throw new Error('The pending Window creation cannot be recovered. Preserve its saved request before creating another Window.');
    // Keep the serialized payload unchanged for legacy receipt fingerprints.
    const pending: PendingCreation = { request: raw as WindowCreateRequest, candidate, bindings: value && typeof value === 'object' && 'bindings' in value && Array.isArray(value.bindings) ? value.bindings : [] };
    restoreImportedWindowComposition(composition, candidate, pending.bindings);
    creation.pending = pending; return pending;
  };
  const clearPendingCreation = () => {
    creation.pending = null;
    try { conversationSessionStorage.removeItem(`${key}:pending-create`); } catch { /* A retained settled request is safe to recover again after reload. */ }
  };
  const createHosted = (candidate: () => WorkspaceWindow, explicitRetry: boolean): Promise<CreatedWindow> => {
    if (creation.running) return creation.running;
    const previous = pendingCreation();
    const window = previous?.candidate ?? candidate();
    const pending = previous ?? { request: { operationId: crypto.randomUUID(), issuedAt: Date.now(), window }, candidate: window, bindings: captureImportedWindowComposition(window) };
    const submit = () => {
      conversationSessionStorage.setItem(`${key}:pending-create`, JSON.stringify({ request: pending.request, bindings: pending.bindings }));
      creation.pending = pending;
      return client!.create(pending.request.window, pending.request).catch(error => {
        // A refused replay does not establish what happened to the original request.
        if (previous && error instanceof WindowRequestError && !error.result) throw new WindowMutationUnknownError(window.id, pending.request, error);
        throw error;
      });
    };
    const run = async () => {
      if (!previous) return submit();
      try { return await client!.recoverCreate(pending.request.window, pending.request); }
      catch (error) {
        if (!explicitRetry || !(error instanceof WindowMutationUnknownError) || error.result?.status === 'committed') throw error;
        return submit();
      }
    };
    const result = run().then(snapshot => { clearPendingCreation(); return { candidate: window, snapshot }; }, error => { if (knownRejection(error)) clearPendingCreation(); throw error; });
    creation.running = result;
    void result.finally(() => { if (creation.running === result) creation.running = undefined; }).catch(() => {});
    return result;
  };
  const publishCatalog = (next: WindowGroup[]) => { catalog.groups = next; setGroups(next); };
  const updateCatalog = (group: WindowGroup) => {
    if (!inScope() || selection.deleted.has(group.window.id)) return;
    publishCatalog(catalog.groups.some(item => item.window.id === group.window.id)
      ? catalog.groups.map(item => item.window.id === group.window.id ? group : item) : [...catalog.groups, group]);
  };
  const forgetDeletedWindow = (id: string) => {
    selection.deleted.add(id);
    catalogSubscriptions.get(id)?.(); catalogSubscriptions.delete(id);
    const deletedStore = stores.get(id);
    if (deletedStore) { watches.get(deletedStore)?.abort.abort(); watches.delete(deletedStore); deletedStore.dispose(); }
    stores.delete(id);
    try { conversationSessionStorage.removeItem(`${key}:pending:${id}`); } catch { /* A deleted Window never replays its pending edits. */ }
    try { conversationLocalStorage.removeItem(`${key}:${id}`); } catch { /* A failed cache cleanup cannot undo a confirmed deletion. */ }
    if (!inScope()) return;
    publishCatalog(catalog.groups.filter(item => item.window.id !== id));
    if (currentStore.current?.getSnapshot().id !== id) return;
    selectStore(undefined); currentlyUnavailable.current = true; setUnavailable(true); setDeleted(true); setError(undefined);
  };
  const leaseStore = (target: WindowWorkspaceStore): (() => void) => {
    const token = Symbol('group-watch');
    let watch = watches.get(target);
    if (!watch) {
      watch = { leases: new Set(), abort: new AbortController() }; watches.set(target, watch);
      const signal = watch.abort.signal;
      if (client && access.current) void target.synchronize(signal).catch(error => {
        if (signal.aborted || !inScope()) return;
        if (error instanceof WindowRequestError && error.status === 404) forgetDeletedWindow(target.getSnapshot().id);
        else if (currentStore.current === target) setError(String(error.message ?? error));
      });
    }
    watch.leases.add(token);
    const retained = watch;
    return () => {
      if (!retained.leases.delete(token)) return;
      if (!retained.leases.size) { retained.abort.abort(); if (watches.get(target) === retained) watches.delete(target); }
    };
  };
  const acquireGroup = useCallback(async (id: string): Promise<GroupHandle> => {
    const ticket = admission;
    const live = () => inScope() && access.current && currentAdmission.current === ticket && !selection.deleted.has(id);
    if (!live()) throw new Error('The group scope or access changed.');
    if (deletions.has(id)) throw new Error('This group has an unsettled deletion.');
    let target = stores.get(id);
    if (!target || client && !confirmedStores.has(target)) {
      let loading = acquisitions.get(id);
      if (!loading) {
        loading = (async () => {
          let group: WindowGroup | undefined;
          try { group = client ? toWindowGroup(await client.inspect(id)) : readCached(id); }
          catch (error) { if (live() && error instanceof WindowRequestError && error.status === 404) forgetDeletedWindow(id); throw error; }
          if (!live()) throw new Error('The group scope or access changed.');
          if (!group || group.window.id !== id) throw new Error('This group is unavailable.');
          const next = makeStore(group); next.accept(group); confirmedStores.add(next); return next;
        })();
        acquisitions.set(id, loading);
        void loading.finally(() => { if (acquisitions.get(id) === loading) acquisitions.delete(id); }).catch(() => {});
      }
      target = await loading;
    }
    if (!live()) throw new Error('The group scope or access changed.');
    const releaseWatch = leaseStore(target); let released = false;
    const assertLive = () => { if (released || !live() || stores.get(id) !== target) throw new Error('The group scope or lease changed.'); };
    return {
      getGroup: target.getGroup, getSyncState: target.getSyncState, subscribe: target.subscribe,
      operate: operation => { assertLive(); return target!.operate(operation); },
      retry: () => { assertLive(); return target!.retry(); },
      release: () => { if (released) return; released = true; releaseWatch(); },
    };
  }, [stores, admission]);
  const operateGroup = useCallback(async (id: string, operation: WindowGroupOperation) => {
    const handle = await acquireGroup(id);
    try { await handle.operate(operation); } finally { handle.release(); }
  }, [acquireGroup]);
  const readGroup = useCallback((id: string) => selection.deleted.has(id) ? undefined : stores.get(id)?.getGroup() ?? catalog.groups.find(group => group.window.id === id), [stores, catalog, selection]);
  const refreshGroups = useCallback(async () => {
    const ticket = admission, generation = ++catalog.generation;
    const live = () => inScope() && access.current && currentAdmission.current === ticket && catalog.generation === generation;
    if (!live()) return;
    if (!client) {
      for (const entry of conversationLocalStorage.keys().filter(entry => entry.startsWith(`${key}:`))) {
        try { const group = decodeWindowGroup(JSON.parse(conversationLocalStorage.getItem(entry) ?? 'null')); if (group) { stores.get(group.window.id)?.accept(group); updateCatalog(stores.get(group.window.id)?.getGroup() ?? group); } } catch { /* Invalid local records are not groups. */ }
      }
      return;
    }
    const listed = await client.listGroups(); if (!live()) return;
    for (const group of listed) {
      if (selection.deleted.has(group.window.id)) continue;
      const retained = stores.get(group.window.id); retained?.accept(group);
      if (retained) confirmedStores.add(retained);
      updateCatalog(retained?.getGroup() ?? group);
    }
    const ids = new Set(listed.map(group => group.window.id));
    await Promise.all(catalog.groups.filter(group => !ids.has(group.window.id)).map(async group => {
      try {
        const next = await client.inspect(group.window.id); if (!live()) return;
        const retained = stores.get(group.window.id); retained?.accept(next); updateCatalog(retained?.getGroup() ?? toWindowGroup(next));
      } catch (error) { if (live() && error instanceof WindowRequestError && error.status === 404) forgetDeletedWindow(group.window.id); }
    }));
  }, [stores, admission]);
  const pendingSection = (): PendingSectionCreation | undefined => {
    if (sectionCreation.pending !== undefined) return sectionCreation.pending ?? undefined;
    const saved = conversationSessionStorage.getItem(`${key}:pending-section-create`);
    if (!saved) { sectionCreation.pending = null; return; }
    const value = JSON.parse(saved) as PendingSectionCreation;
    const group = decodeWindowGroup(value?.group);
    if (!group || !isWindowGroupCreateRequest({ ...group, operationId: value.operationId, issuedAt: value.issuedAt })) throw new Error('The pending section creation cannot be recovered. Preserve its saved request before creating another section.');
    sectionCreation.pending = { ...value, group }; return sectionCreation.pending;
  };
  const createSectionRequest = (title: string | undefined, explicitRetry: boolean): Promise<string> => {
    if (!inScope() || !access.current) return Promise.reject(new Error('The group scope or access changed.'));
    if (sectionCreation.running) return sectionCreation.running;
    const previous = pendingSection();
    if (!previous && title === undefined) return Promise.resolve('');
    const rank = catalog.groups.flatMap(group => group.bots ? [group.bots.rank] : []).sort().at(-1);
    const group: WindowGroup = previous?.group ?? { window: { ...emptyWindow(), title: title! }, bots: { rank: !rank ? 'm' : rank.length < 64 ? `${rank}m` : rank, members: {} }, presentation: { window: false } };
    const pending = previous ?? { group, operationId: crypto.randomUUID(), issuedAt: Date.now() };
    const ticket = admission;
    const clear = () => { sectionCreation.pending = null; try { conversationSessionStorage.removeItem(`${key}:pending-section-create`); } catch { /* A settled request can safely be inspected again. */ } };
    const submit = async () => {
      conversationSessionStorage.setItem(`${key}:pending-section-create`, JSON.stringify(pending)); sectionCreation.pending = pending;
      if (!client) { persistLocal(pending.group); return pending.group; }
      try { return toWindowGroup(await client.createGroup(pending.group, pending)); }
      catch (error) { if (previous && error instanceof WindowRequestError && !error.result) throw new WindowMutationUnknownError(group.window.id, { operationId: pending.operationId, issuedAt: pending.issuedAt, window: pending.group.window }, error); throw error; }
    };
    const run = async () => {
      sectionCreation.publish({ state: 'saving', title: pending.group.window.title });
      let confirmed: WindowGroup;
      if (!previous || !client) confirmed = await submit();
      else {
        try { confirmed = toWindowGroup(await client.recoverCreate(previous.group.window, previous)); }
        catch (error) {
          if (!explicitRetry || !(error instanceof WindowMutationUnknownError) || error.result?.status === 'committed') throw error;
          if (!inScope() || !access.current || currentAdmission.current !== ticket) throw new Error('The group scope or access changed.');
          confirmed = await submit();
        }
      }
      clear();
      sectionCreation.publish({ state: 'idle' });
      if (!inScope() || !access.current || currentAdmission.current !== ticket) throw new Error('The group scope or access changed.');
      const next = makeStore(confirmed); next.accept(confirmed); confirmedStores.add(next); updateCatalog(next.getGroup()); return confirmed.window.id;
    };
    const result = run().catch(error => {
      if (knownRejection(error)) clear();
      sectionCreation.publish({ state: sectionCreation.pending ? 'unknown' : 'error', title: pending.group.window.title, error: String(error.message ?? error) }); throw error;
    });
    sectionCreation.running = result; void result.finally(() => { if (sectionCreation.running === result) sectionCreation.running = undefined; }).catch(() => {}); return result;
  };
  useEffect(() => {
    if (!enabled || !participating) return;
    try { if (pendingSection()) void createSectionRequest(undefined, false).catch(() => {}); } catch (error) { sectionCreation.publish({ state: 'error', error: String(error instanceof Error ? error.message : error) }); }
  }, [sectionCreation, enabled, participating]);
  useEffect(() => {
    const generation = ++selection.generation;
    if (foreground.current || !currentStore.current || stores.get(currentStore.current.getSnapshot().id) !== currentStore.current) {
      selectStore(undefined); setUnavailable(false); setDeleted(false); setError(undefined);
    }
    if (!participating) return;
    const query = new URL(navigation.url).searchParams;
    const requested = foreground.current ? query.get('window') : null;
    const explicitSession = foreground.current && !requested && !!query.get('host') && !!query.get('provider') && !!query.get('session');
    const target: WindowSessionBinding | undefined = explicitSession ? {
        hostId: query.get('host')!, providerId: query.get('provider')!, nativeSessionId: query.get('session')!,
        title: composition.slots.find(slot => slot.intent.target.hostId === query.get('host')
          && slot.intent.target.native.providerId === query.get('provider')
          && slot.intent.target.native.nativeSessionId === query.get('session'))?.metadata?.title || query.get('session')!,
        ...(query.get('parent') ? { parentNativeSessionId: query.get('parent')! } : {}),
        ...(query.get('intent') === 'history' ? { sessionIntent: 'history' as const } : {}),
      } : undefined;
    const initialWindow = () => {
      const imported = importCompositionWindow(composition);
      if (!target) return imported;
      const existing = imported.views.find(view => view.binding?.hostId === target.hostId
        && view.binding.providerId === target.providerId && view.binding.nativeSessionId === target.nativeSessionId
        && view.binding.sessionIntent === target.sessionIntent);
      if (existing) { imported.selectedViewId = existing.id; imported.selectedPrimaryViewId = windowPrimaryViewId(imported, existing.id) ?? imported.selectedPrimaryViewId; return imported; }
      const operation = imported.selectedPrimaryViewId ? { type: 'view.bind' as const, viewId: imported.selectedPrimaryViewId, binding: target } : sessionLinkOperation(imported, target);
      const bound = operation ? applyWindowOperation(imported, operation) : imported;
      Object.assign(imported, bound, { revision: 0, title: target.title, selectedViewId: bound.selectedPrimaryViewId ?? bound.selectedViewId });
      return imported;
    };
    const preferredIds = () => {
      const ids: string[] = [];
      for (const [storage, name] of [[conversationSessionStorage, key], [conversationLocalStorage, `${key}:last-window`]] as const) {
        try { const id = storage.getItem(name); if (id && !ids.includes(id)) ids.push(id); } catch { /* The catalog does not depend on local storage. */ }
      }
      return ids;
    };
    let cached: WindowGroup | undefined;
    for (const id of requested ? [requested] : preferredIds()) {
      const value = readCached(id); if (value && (requested || hasWindowAppearance(value))) { cached = value; break; }
    }
    // A deep link is applied to the authoritative layout before it becomes the selected Window.
    if (client && cached && !target) choose(cached, false, false);
    let current = true;
    const live = () => current && inScope() && generation === selection.generation;
    const restore = async (group: WindowGroup) => {
      if (!live()) return;
      const operation = target && sessionLinkOperation(group.window, target);
      choose(group);
      if (operation) { const pending = makeStore(group).operate(operation); void pending.catch(error => { if (live()) setError(String(error.message ?? error)); }); }
    };
    if (!client) {
      const local: WindowGroup[] = [];
      for (const entry of conversationLocalStorage.keys().filter(entry => entry.startsWith(`${key}:`))) {
        try { const value = decodeWindowGroup(JSON.parse(conversationLocalStorage.getItem(entry) ?? 'null')); if (value) local.push(value); } catch { /* A corrupt cache is not a usable Window. */ }
      }
      publishCatalog(local);
      if (!foreground.current) return;
      if (requested && !cached) { setError('This Window is unavailable in the local workbench.'); setUnavailable(true); }
      else {
        const existing = cached ?? local.find(hasWindowAppearance);
        try {
          if (existing && !target) choose(existing);
          else if (existing) void Promise.resolve().then(() => restore(existing)).catch(error => { if (live()) setError(String(error.message ?? error)); });
          else { const imported = initialWindow(); choose({ window: imported }, true); }
        } catch (error) { setError(String(error instanceof Error ? error.message : error)); }
      }
    }
    if (!enabled || !client) return () => { current = false; };
    const restoreHosted = async () => {
      if (!live()) return;
      const all = (await client.listGroups()).filter(group => !selection.deleted.has(group.window.id)); if (!live()) return;
      for (const group of all) {
        const retained = stores.get(group.window.id);
        retained?.accept(group);
        updateCatalog(retained?.getGroup() ?? group);
      }
      const list = all.filter(hasWindowAppearance);
      // A background journal may outlive a Window deleted on another page.
      // Catalog omission alone is insufficient proof, and its inspection must not delay opening the selected Window.
      const listed = new Set(all.map(group => group.window.id));
      for (const [id, pending] of stores) {
        if (listed.has(id) || id === currentStore.current?.getSnapshot().id || !pending.getSyncState().pending) continue;
        void client.inspect(id).catch(error => {
          if (live() && stores.get(id) === pending && error instanceof WindowRequestError && error.status === 404) forgetDeletedWindow(id);
        });
      }
      if (!foreground.current) return;
      if (requested) { const next = await client.inspect(requested); if (live()) choose(toWindowGroup(next)); return; }
      if (!pendingCreation()) {
        const ids = [...new Set([...preferredIds(), ...list.map(group => group.window.id)])].filter(id => list.some(group => group.window.id === id));
        for (const id of ids) {
          let next: WindowSnapshot;
          try { next = await client.inspect(id); }
          catch (error) {
            if (!live()) return;
            if (!(error instanceof WindowRequestError) || error.status !== 404) throw error;
            forgetDeletedWindow(id);
            continue;
          }
          await restore(toWindowGroup(next)); return;
        }
      }
      if (!live()) return;
      const { candidate, snapshot: next } = await createHosted(initialWindow, false);
      if (live()) { commitImportedWindowComposition(composition, candidate, next.window); await restore(toWindowGroup(next)); }
    };
    const restored = !requested && globalThis.navigator.locks ? globalThis.navigator.locks.request(`${key}:restore`, restoreHosted) : restoreHosted();
    void restored.catch(error => {
      if (!live()) return;
      if (error?.status === 404) { if (requested) forgetDeletedWindow(requested); selectStore(undefined); setUnavailable(true); }
      setError(String(error.message ?? error));
    });
    return () => { current = false; };
  }, [scope, client, enabled, route, participating, workspaceNavigation?.mode]);
  const window = useSyncExternalStore(store?.subscribe ?? (() => () => {}), store?.getSnapshot ?? (() => undefined));
  const group = useSyncExternalStore(store?.subscribe ?? (() => () => {}), store?.getGroup ?? (() => undefined));
  const saveState = useSyncExternalStore(store?.subscribe ?? (() => () => {}), store?.getSyncState ?? (() => undefined));
  const confirmed = !!store && confirmedStores.has(store);
  useEffect(() => {
    if (!store || !enabled || !client || !participating || !confirmed) return;
    return leaseStore(store);
  }, [store, enabled, client, participating, confirmed]);
  useEffect(() => {
    if (client || !participating) return;
    const receive = (event: StorageEvent) => {
      if (!event.key?.startsWith(`${key}:`)) return;
      const id = event.key.slice(key.length + 1);
      if (event.newValue === null) { if (catalog.groups.some(group => group.window.id === id)) forgetDeletedWindow(id); return; }
      try { const value = decodeWindowGroup(JSON.parse(event.newValue)); if (value && value.window.id === id) { const retained = stores.get(id); retained?.accept(value); updateCatalog(retained?.getGroup() ?? value); } } catch { /* Invalid data never replaces a committed snapshot. */ }
    };
    globalThis.addEventListener('storage', receive); return () => globalThis.removeEventListener('storage', receive);
  }, [stores, client, key, participating]);
  const operate = (operation: WindowGroupOperation): Promise<void> => {
    const active = currentStore.current;
    if (!active || currentlyUnavailable.current || !inScope()) throw new Error('Open an available Window before editing its layout.');
    applyGroupOperation(active.getGroup(), operation);
    return active.operate(operation).catch(error => {
      if (inScope() && currentStore.current === active) setError(String(error instanceof Error ? error.message : error));
      throw error;
    });
  };
  const dispatch = (operation: Parameters<WindowWorkspaceStore['operate']>[0]) => {
    try { void operate(operation).catch(() => {}); } catch (error) { setError(String(error instanceof Error ? error.message : error)); }
  };
  const hasActiveWindow = confirmed && !unavailable;
  const deletedWindowIds = useMemo(() => [...selection.deleted] as readonly string[], [selection, selection.deleted.size]);
  return { window, group, windows, groups, error, client, deleted, deletedWindowIds, hasActiveWindow, saveState,
    retrySave: () => currentStore.current?.retry() ?? Promise.resolve(),
    sectionCreationState, retrySection: () => createSectionRequest(undefined, true),
    acquireGroup, readGroup, operateGroup, refreshGroups,
    async createSection(title: string): Promise<string> {
      const trimmed = title.trim(); if (!trimmed) throw new Error('A section title is required.'); if (trimmed.length > 256) throw new Error('A section title must be at most 256 characters.');
      return createSectionRequest(trimmed, false);
    },
    discardLocalChanges: () => currentStore.current?.discardPendingChanges() ?? Promise.resolve(), unavailable: participating && enabled && unavailable, operate, readWindow,
    authority: window && !unavailable ? {
      window, readWindow,
      operate: dispatch,
      resolveViewId: (id: string) => resolveCompositionWindowViewId(composition, window, id),
    } : undefined,
    sessionBridge: window && !unavailable ? createWindowSessionBridge(composition, window) : undefined,
    async open(id: string) {
      if (deletions.has(id)) throw new Error('This Window has an unsettled deletion. Retry deleting it before opening it.');
      const generation = ++selection.generation;
      const cached = readCached(id);
      if (cached && (!workspaceNavigation || hasWindowAppearance(cached))) { choose(cached, false, !client); setError(undefined); }
      let next: WindowGroup;
      try {
        if (client) next = toWindowGroup(await client.inspect(id));
        else { const cached = decodeWindowGroup(JSON.parse(conversationLocalStorage.getItem(`${key}:${id}`) ?? 'null')); if (!cached || cached.window.id !== id) throw new Error('This local Window is unavailable.'); next = cached; }
      } catch (error) {
        if (generation !== selection.generation) return;
        if (error instanceof WindowRequestError && error.status === 404) forgetDeletedWindow(id);
        throw error;
      }
      if (generation !== selection.generation) return;
      if (!inScope()) throw new Error('The Window scope changed before opening.');
      if (workspaceNavigation && !hasWindowAppearance(next)) {
        if (currentStore.current?.getSnapshot().id === id) selectStore(undefined);
        makeStore(next).accept(next); updateCatalog(next);
        throw new Error('This group is a section without a Window appearance.');
      }
      setError(undefined); choose(next);
    },
    async create() {
      const generation = ++selection.generation;
      let created: WindowGroup;
      const candidate = () => unavailable ? emptyWindow() : importCompositionWindow(composition);
      if (client) { const { candidate: original, snapshot } = await createHosted(candidate, true); if (generation !== selection.generation) return; created = toWindowGroup(snapshot); commitImportedWindowComposition(composition, original, created.window); }
      else created = { window: candidate() };
      choose(created, true); setError(undefined); setGroups(current => [...current.filter(group => group.window.id !== created.window.id), created]);
    },
    /**
     * Renames any Window in the catalog, resolving once the title is applied locally; `saved` settles with the
     * background save. Another Window saves through its own store, like edits made while it was open.
     */
    async rename(id: string, title: string): Promise<{ saved: Promise<void> }> {
      const operation: WindowOperation = { type: 'rename', title };
      if (currentStore.current?.getSnapshot().id === id) return { saved: operate(operation) };
      if (!inScope()) throw new Error('The Window scope changed before renaming.');
      if (selection.deleted.has(id) || deletions.has(id)) throw new Error('This Window is being deleted.');
      let target = stores.get(id);
      if (!target) {
        let group: WindowGroup | undefined;
        try { group = client ? toWindowGroup(await client.inspect(id)) : readCached(id); }
        catch (error) {
          if (error instanceof WindowRequestError && error.status === 404) forgetDeletedWindow(id);
          throw error;
        }
        if (!group || group.window.id !== id) throw new Error('This Window is unavailable.');
        if (!inScope() || selection.deleted.has(id)) throw new Error('The Window scope changed before renaming.');
        target = stores.get(id) ?? makeStore(group);
      }
      const store = target, saved = store.operate(operation);
      updateCatalog(store.getGroup());
      void saved.finally(() => updateCatalog(store.getGroup())).catch(() => {});
      return { saved };
    },
    async remove(id: string) {
      const assertInactive = () => {
        if (!id) throw new Error('Choose a Window to delete.');
        const active = currentStore.current;
        if (!inScope() || !active || !confirmedStores.has(active)) throw new Error('Open or create an available Window before deleting another Window.');
        if (active.getSnapshot().id === id) throw new Error('Switch to another Window before deleting the active Window.');
      };
      assertInactive();
      if (client) {
        const previous = deletions.get(id);
        const pending = previous ?? { window: undefined, identity: { operationId: crypto.randomUUID(), issuedAt: Date.now() }, dispatched: false };
        deletions.set(id, pending);
        pending.running ??= (async () => {
          const recovering = pending.dispatched;
          if (!pending.window) pending.window = (await client.inspect(id)).window;
          if (!inScope()) throw new Error('The Window scope changed before deletion.');
          assertInactive();
          if (recovering) {
            try { await client.recoverDelete(pending.window, pending.identity); return; }
            catch (error) { if (!(error instanceof WindowMutationUnknownError)) throw error; }
          }
          if (!inScope()) throw new Error('The Window scope changed before deletion.');
          assertInactive();
          pending.dispatched = true;
          try { await client.delete(pending.window, pending.identity); }
          catch (error) {
            if (recovering && error instanceof WindowRequestError && !error.result) throw new WindowMutationUnknownError(id,
              { ...pending.identity, baseRevision: pending.window.revision, operation: { type: 'delete' } }, error);
            throw error;
          }
        })();
        try { await pending.running; deletions.delete(id); }
        catch (error) { pending.running = undefined; if (!pending.dispatched || knownRejection(error)) deletions.delete(id); throw error; }
      } else conversationLocalStorage.removeItem(`${key}:${id}`);
      forgetDeletedWindow(id);
    },
  };
}
