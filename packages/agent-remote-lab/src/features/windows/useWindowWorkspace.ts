import { createWindowSessionBridge, resolveCompositionWindowViewId } from '../../kernel/window-composition.js';
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react';
import { errorWords, keyedError, WindowMutationUnknownError, WindowRequestError, WindowWorkspaceClient, type WindowOperationIdentity, type WindowSnapshot } from '@orchardworks/agent-client';
import type { WindowCreateRequest, WindowOperation, WindowSessionBinding, WorkspaceWindow } from '@orchardworks/agent-remote-protocol';
import { conversationLocalStorage, conversationSessionStorage } from '../../kernel/conversation-storage.js';
import { captureImportedWindowComposition, restoreImportedWindowComposition, commitImportedWindowComposition, importCompositionWindow, WindowWorkspaceStore } from '../../kernel/window-workspace.js';
import type { CompositionDocument } from '../../kernel/session-composition.js';
import type { WorkbenchMode } from '../../kernel/workbench-mode.js';
import type { WindowSaveState } from '../../kernel/window-workspace-store.js';
import { appendedRank } from '../../kernel/bot-roster.js';
import { applyMoveSteps, type MoveStep } from '../../kernel/assistant-groups.js';
import { newAssistantPicture } from '../../kernel/assistant-picture.js';
import { applyGroupOperation, applyWindowOperation, createWindowView, decodeWindowGroup, decodeWorkspaceWindow, hasWindowAppearance, isWindowCreateRequest, isWindowGroupCreateRequest, rebindsBot, toWindowGroup, windowPrimaryViewId, type WindowGroup, type WindowGroupOperation } from '@orchardworks/agent-remote-protocol';
import { useTranslate } from '@orchardworks/agent-client-web/react';
import { advanceKnowledge, type Knowledge, type KnowledgeEvent } from '../../kernel/known-list.js';
import { readCatalogCache, writeCatalogCache } from '../../kernel/window-catalog-cache.js';

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

/**
 * Whether a deep link cannot open in this Window: the session is not in it and the selected view is a bot, which keeps its
 * conversation. Opening it beside the bots would add a bot to the account with every link, so another Window takes the link.
 */
function linkNeedsAnotherWindow(group: WindowGroup, binding: WindowSessionBinding): boolean {
  const { views, selectedViewId } = group.window;
  const matches = (view: WorkspaceWindow['views'][number]) => view.binding?.hostId === binding.hostId && view.binding.providerId === binding.providerId
    && view.binding.nativeSessionId === binding.nativeSessionId && view.binding.sessionIntent === binding.sessionIntent;
  return !views.some(matches) && rebindsBot(group, views.find(view => view.id === selectedViewId), binding);
}

/**
 * Product page catalog and URL selection; each chosen Window keeps its own store.
 * `canRead`: the device may show what it stored (the catalog its last load left) while `enabled`, which talks to the Relay, is still false.
 * The catalog's `groupsKnowledge` says whether an empty `groups` means nothing exists yet or only that nothing has loaded.
 */
export function useWindowWorkspace(scope: string, hosted: boolean, enabled: boolean, composition: CompositionDocument, participating = true, workspaceNavigation?: WorkspaceNavigation, canRead = enabled) {
  // A hosted workspace selects the Window this device last showed before the first paint, so its top bar and tile are in place in the first frame; what it
  // reads from the Relay comes later. A local one builds its Window from the composition, which the effects above it fill first, so it keeps the passive order.
  const useScopeEffect = hosted ? useLayoutEffect : useEffect;
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
  const catalog = useMemo(() => {
    const groups = hosted && canRead ? readCatalogCache(scope) : [];
    return { groups, generation: 0, knowledge: (groups.length ? 'stored' : 'unknown') as Knowledge, persistQueued: false };
  }, [stores]);
  const admission = useMemo(() => ({}), [stores, enabled, participating]);
  const currentAdmission = useRef(admission); currentAdmission.current = admission;
  const foreground = useRef(true); foreground.current = (workspaceNavigation?.mode ?? 'window') === 'window';
  const sectionRoute = useRef(workspaceNavigation?.onSectionRoute); sectionRoute.current = workspaceNavigation?.onSectionRoute;
  const access = useRef(enabled && participating); access.current = enabled && participating;
  const currentSelection = useRef(selection); currentSelection.current = selection;
  const inScope = () => selection.active && currentSelection.current === selection;
  const [store, setStore] = useState<WindowWorkspaceStore>();
  const currentStore = useRef<WindowWorkspaceStore>();
  useScopeEffect(() => {
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
  // A cached Window shown before the service confirms it is read-only: it may since have changed, been deleted or become a section.
  const [provisional, setProvisional] = useState(false);
  const currentlyProvisional = useRef(provisional); currentlyProvisional.current = provisional;
  const selectStore = (next: WindowWorkspaceStore | undefined, cachedOnly = false) => {
    currentStore.current = next; setStore(next); currentlyProvisional.current = cachedOnly; setProvisional(cachedOnly);
  };
  const [publishedCatalog, setPublishedCatalog] = useState(() => ({ catalog, groups: catalog.groups, knowledge: catalog.knowledge }));
  const groups = publishedCatalog.catalog === catalog ? publishedCatalog.groups : catalog.groups;
  const groupsKnowledge = publishedCatalog.catalog === catalog ? publishedCatalog.knowledge : catalog.knowledge;
  // Only a group shown as a Window can be opened in the workbench; a section alone belongs to Bot mode.
  const windows = useMemo(() => groups.filter(hasWindowAppearance).map(group => group.window), [groups]);
  const t = useTranslate();
  const shown = (failure: unknown) => errorWords(failure, t);
  const [error, setError] = useState<string>();
  const currentError = useRef(error); currentError.current = error;
  const [route, setRoute] = useState(0);
  const navigation = useMemo(() => ({ url: globalThis.location.href }), [route, key, workspaceNavigation?.mode]);
  useEffect(() => {
    const navigate = () => {
      // Moving between sessions of the selected Window (conversation history) keeps that Window. Reselecting it
      // showed its cached copy read-only while it was read again, so the session the history returned to could
      // not be bound to it, and history skipped back over it.
      const query = new URL(globalThis.location.href).searchParams, id = query.get('window');
      // A Window that failed (its read or its saving) is selected again, so the popstate retries it.
      const failed = !!currentError.current || currentStore.current?.getSyncState().state === 'error';
      if (id && query.get('mode') !== 'bot' && !currentlyUnavailable.current && !failed && currentStore.current?.getSnapshot().id === id) return;
      setRoute(value => value + 1);
    };
    globalThis.addEventListener('popstate', navigate); return () => globalThis.removeEventListener('popstate', navigate);
  }, []);
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
      // Until the service confirms the cached group (it may since have become a section), the page keeps showing
      // the Window it has; a page without one shows the cached group read-only, without writing anything from it.
      if (currentStore.current && confirmedStores.has(currentStore.current) && !currentlyUnavailable.current) return;
      selectStore(next, true); currentlyUnavailable.current = false; setUnavailable(false); setDeleted(false); return;
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
        if (!value) throw keyedError('windows.error.localUnavailable');
        const replacesLayout = operation.type === 'layout.apply' || operation.type === 'batch' && operation.operations.some(edit => edit.type === 'layout.apply');
        if (replacesLayout && value.window.revision !== source.window.revision) throw keyedError('windows.error.layoutChanged');
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
    if (!candidate || !raw || typeof raw !== 'object' || !isWindowCreateRequest({ ...raw, window: candidate })) throw keyedError('windows.error.pendingWindow');
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
  const publishCatalog = (next: WindowGroup[]) => {
    if (!inScope()) return;
    catalog.groups = next; setPublishedCatalog({ catalog, groups: next, knowledge: catalog.knowledge });
    // The device keeps the catalog a load confirmed, once per burst of updates.
    if (client && catalog.knowledge === 'confirmed' && !catalog.persistQueued) {
      catalog.persistQueued = true;
      queueMicrotask(() => { catalog.persistQueued = false; writeCatalogCache(scope, catalog.groups); });
    }
  };
  const learnCatalog = (event: KnowledgeEvent) => {
    if (!inScope()) return;
    catalog.knowledge = advanceKnowledge(catalog.knowledge, event);
    setPublishedCatalog({ catalog, groups: catalog.groups, knowledge: catalog.knowledge });
    if (client && event === 'confirmed') writeCatalogCache(scope, catalog.groups);
  };
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
        else if (currentStore.current === target) setError(shown(error));
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
    if (!live()) throw keyedError('windows.error.scopeChanged');
    if (deletions.has(id)) throw keyedError('windows.error.unsettledDeletion');
    let target = stores.get(id);
    if (!target || client && !confirmedStores.has(target)) {
      let loading = acquisitions.get(id);
      if (!loading) {
        loading = (async () => {
          let group: WindowGroup | undefined;
          try { group = client ? toWindowGroup(await client.inspect(id)) : readCached(id); }
          catch (error) { if (live() && error instanceof WindowRequestError && error.status === 404) forgetDeletedWindow(id); throw error; }
          if (!live()) throw keyedError('windows.error.scopeChanged');
          if (!group || group.window.id !== id) throw keyedError('windows.error.groupUnavailable');
          const next = makeStore(group); next.accept(group); confirmedStores.add(next); return next;
        })();
        acquisitions.set(id, loading);
        void loading.finally(() => { if (acquisitions.get(id) === loading) acquisitions.delete(id); }).catch(() => {});
      }
      target = await loading;
    }
    if (!live()) throw keyedError('windows.error.scopeChanged');
    const releaseWatch = leaseStore(target); let released = false;
    const assertLive = () => { if (released || !live() || stores.get(id) !== target) throw keyedError('windows.error.leaseChanged'); };
    return {
      getGroup: target.getGroup, getSyncState: target.getSyncState, subscribe: target.subscribe,
      operate: operation => { assertLive(); return target!.operate(operation); },
      retry: () => { assertLive(); return target!.retry(); },
      release: () => { if (released) return; released = true; releaseWatch(); },
    };
  }, [stores, admission]);
  const readGroup = useCallback((id: string) => selection.deleted.has(id) ? undefined : stores.get(id)?.getGroup() ?? catalog.groups.find(group => group.window.id === id), [stores, catalog, selection]);
  const operateGroup = useCallback(async (id: string, operation: WindowGroupOperation) => {
    const replacesLayout = operation.type === 'layout.apply' || operation.type === 'batch' && operation.operations.some(edit => edit.type === 'layout.apply');
    const expectedRevision = replacesLayout ? readGroup(id)?.window.revision : undefined;
    if (replacesLayout && expectedRevision === undefined) throw keyedError('windows.error.readGroupFirst');
    const handle = await acquireGroup(id);
    try {
      if (replacesLayout && handle.getGroup().window.revision !== expectedRevision) throw keyedError('windows.error.groupLayoutChanged');
      await handle.operate(operation);
    } finally { handle.release(); }
  }, [acquireGroup, readGroup]);
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
    learnCatalog('confirmed');
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
    if (!group || !isWindowGroupCreateRequest({ ...group, operationId: value.operationId, issuedAt: value.issuedAt })) throw keyedError('windows.error.pendingSection');
    sectionCreation.pending = { ...value, group }; return sectionCreation.pending;
  };
  /**
   * Creates a group in the background, never choosing it in Window mode: an empty group people name (`title`), or a group given
   * whole (`template`), such as one started from a new session. An uncertain request is kept and only Retry submits it again.
   */
  const createSectionRequest = (title: string | undefined, explicitRetry: boolean, template?: () => WindowGroup): Promise<string> => {
    if (!inScope() || !access.current) return Promise.reject(keyedError('windows.error.scopeChanged'));
    if (sectionCreation.running) return sectionCreation.running;
    const previous = pendingSection();
    if (!previous && title === undefined && !template) return Promise.resolve('');
    // A group people make starts empty, shown in Chats, the directory and Window mode alike, and is listed last.
    const group: WindowGroup = previous?.group ?? template?.() ?? { window: { schemaVersion: 3, id: crypto.randomUUID(), revision: 0, title: title!, selectedPrimaryViewId: null, selectedViewId: null, views: [] },
      bots: { rank: appendedRank(catalog.groups), members: {} } };
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
          if (!inScope() || !access.current || currentAdmission.current !== ticket) throw keyedError('windows.error.scopeChanged');
          confirmed = await submit();
        }
      }
      clear();
      sectionCreation.publish({ state: 'idle' });
      if (!inScope() || !access.current || currentAdmission.current !== ticket) throw keyedError('windows.error.scopeChanged');
      const next = makeStore(confirmed); next.accept(confirmed); confirmedStores.add(next); updateCatalog(next.getGroup()); return confirmed.window.id;
    };
    const result = run().catch(error => {
      if (knownRejection(error)) clear();
      sectionCreation.publish({ state: sectionCreation.pending ? 'unknown' : 'error', title: pending.group.window.title, error: shown(error) }); throw error;
    });
    sectionCreation.running = result; void result.finally(() => { if (sectionCreation.running === result) sectionCreation.running = undefined; }).catch(() => {}); return result;
  };
  useEffect(() => {
    if (!enabled || !participating) return;
    try { if (pendingSection()) void createSectionRequest(undefined, false).catch(() => {}); } catch (error) { sectionCreation.publish({ state: 'error', error: shown(error) }); }
  }, [sectionCreation, enabled, participating]);
  useScopeEffect(() => {
    const generation = ++selection.generation;
    if (foreground.current || !currentStore.current || stores.get(currentStore.current.getSnapshot().id) !== currentStore.current) {
      selectStore(undefined); setUnavailable(false); setDeleted(false); setError(undefined);
    }
    if (!participating) return;
    const query = new URL(navigation.url).searchParams;
    const windowRoute = foreground.current && query.get('mode') !== 'bot';
    const requested = windowRoute ? query.get('window') : null;
    const linkedSession = windowRoute && !!query.get('host') && !!query.get('provider') && !!query.get('session');
    const linked: WindowSessionBinding | undefined = linkedSession ? {
        hostId: query.get('host')!, providerId: query.get('provider')!, nativeSessionId: query.get('session')!,
        title: composition.slots.find(slot => slot.intent.target.hostId === query.get('host')
          && slot.intent.target.native.providerId === query.get('provider')
          && slot.intent.target.native.nativeSessionId === query.get('session'))?.metadata?.title || query.get('session')!,
        ...(query.get('parent') ? { parentNativeSessionId: query.get('parent')! } : {}),
        ...(query.get('intent') === 'history' ? { sessionIntent: 'history' as const } : {}),
      } : undefined;
    const target = requested ? undefined : linked;
    const initialWindow = () => {
      const imported = importCompositionWindow(composition);
      const session = target;
      if (!session) return imported;
      const existing = imported.views.find(view => view.binding?.hostId === session.hostId
        && view.binding.providerId === session.providerId && view.binding.nativeSessionId === session.nativeSessionId
        && view.binding.sessionIntent === session.sessionIntent);
      if (existing) { imported.selectedViewId = existing.id; imported.selectedPrimaryViewId = windowPrimaryViewId(imported, existing.id) ?? imported.selectedPrimaryViewId; return imported; }
      const operation = imported.selectedPrimaryViewId ? { type: 'view.bind' as const, viewId: imported.selectedPrimaryViewId, binding: session } : sessionLinkOperation(imported, session);
      const bound = operation ? applyWindowOperation(imported, operation) : imported;
      Object.assign(imported, bound, { revision: 0, title: session.title, selectedViewId: bound.selectedPrimaryViewId ?? bound.selectedViewId });
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
      if (operation) { const pending = makeStore(group).operate(operation); void pending.catch(error => { if (live()) setError(shown(error)); }); }
    };
    if (!client) {
      const local: WindowGroup[] = [];
      for (const entry of conversationLocalStorage.keys().filter(entry => entry.startsWith(`${key}:`))) {
        try { const value = decodeWindowGroup(JSON.parse(conversationLocalStorage.getItem(entry) ?? 'null')); if (value) local.push(value); } catch { /* A corrupt cache is not a usable Window. */ }
      }
      publishCatalog(local); learnCatalog('confirmed');
      if (!foreground.current) return;
      if (requested && !cached && linked) {
        // A local Window exists only in the browser that made it. Elsewhere, a link to it opens the session it carries
        // in a fresh Window, so no existing layout changes; choosing it replaces the foreign window= in the address,
        // so Back and Forward do not repeat this.
        try {
          const fresh = emptyWindow();
          choose({ window: { ...applyWindowOperation(fresh, { type: 'view.bind', viewId: 'main', binding: linked }), title: linked.title } }, true);
        } catch (error) { setError(shown(error)); }
      } else if (requested && !cached) { setError(t('windows.error.notInWorkbench')); setUnavailable(true); }
      else {
        const existing = cached ?? local.find(hasWindowAppearance);
        try {
          if (existing && !target) choose(existing);
          else if (existing) void Promise.resolve().then(() => restore(existing)).catch(error => { if (live()) setError(shown(error)); });
          else { const imported = initialWindow(); choose({ window: imported }, true); }
        } catch (error) { setError(shown(error)); }
      }
    }
    if (!enabled || !client) return () => { current = false; };
    const restoreHosted = async () => {
      if (!live()) return;
      // The requested Window is read beside the list rather than after it, so opening waits for one round trip.
      const requestedSnapshot = requested && foreground.current ? client.inspect(requested) : undefined;
      void requestedSnapshot?.catch(() => {});
      const all = (await client.listGroups()).filter(group => !selection.deleted.has(group.window.id)); if (!live()) return;
      for (const group of all) {
        const retained = stores.get(group.window.id);
        retained?.accept(group);
        updateCatalog(retained?.getGroup() ?? group);
      }
      learnCatalog('confirmed');
      // A group restored from this device's copy that the Relay no longer lists is checked: it is gone, or it only fell out of the list.
      const answered = new Set(all.map(group => group.window.id));
      for (const stale of catalog.groups.filter(group => !answered.has(group.window.id))) {
        void client.inspect(stale.window.id).then(next => {
          if (!live()) return;
          const retained = stores.get(stale.window.id); retained?.accept(next); updateCatalog(retained?.getGroup() ?? toWindowGroup(next));
        }, error => { if (live() && error instanceof WindowRequestError && error.status === 404) forgetDeletedWindow(stale.window.id); });
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
      if (requested) { const next = await (requestedSnapshot ?? client.inspect(requested)); if (live()) choose(toWindowGroup(next)); return; }
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
          const group = toWindowGroup(next);
          if (target && linkNeedsAnotherWindow(group, target)) continue;
          await restore(group); return;
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
      setError(shown(error));
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
    if (!active || currentlyUnavailable.current || !inScope()) throw keyedError('windows.error.openToEdit');
    if (currentlyProvisional.current) return Promise.reject(keyedError('windows.error.loadToEdit'));
    applyGroupOperation(active.getGroup(), operation);
    return active.operate(operation).catch(error => {
      if (inScope() && currentStore.current === active) setError(shown(error));
      throw error;
    });
  };
  const dispatch = (operation: Parameters<WindowWorkspaceStore['operate']>[0]) => {
    try { void operate(operation).catch(() => {}); } catch (error) { setError(shown(error)); }
  };
  /**
   * A move between two groups through the Relay's transfer or merge, sent with the revisions it reads first; the groups it
   * answers with replace the ones this page holds, and a merged group is forgotten. Without a Relay the same rules apply here.
   */
  const across = async (step: Extract<MoveStep, { kind: 'transfer' | 'merge' }>) => {
    let changed: Record<string, WindowGroup | null>;
    if (!client) {
      const result = applyMoveSteps([step.source, step.target].flatMap(id => { const group = readGroup(id); return group ? [group] : []; }), [step]);
      changed = Object.fromEntries([step.source, step.target].map(id => [id, result.find(group => group.window.id === id) ?? null]));
      for (const group of Object.values(changed)) if (group) persistLocal(group);
    } else {
      const [source, target] = await Promise.all([client.inspect(step.source), client.inspect(step.target)]);
      const identity = { operationId: crypto.randomUUID(), issuedAt: Date.now() };
      changed = (step.kind === 'transfer'
        ? await client.transfer(step.source, { ...identity, baseRevision: source.window.revision, viewId: step.viewId, target: step.target, targetRevision: target.window.revision })
        : await client.merge(step.target, { ...identity, baseRevision: target.window.revision, source: step.source, sourceRevision: source.window.revision })).groups;
    }
    if (!inScope()) throw keyedError('windows.error.scopeChanged');
    for (const [id, group] of Object.entries(changed)) {
      if (!group) { forgetDeletedWindow(id); continue; }
      const store = stores.get(id); store?.accept(group); updateCatalog(store?.getGroup() ?? group);
    }
  };
  const hasActiveWindow = confirmed && !unavailable;
  const deletedWindowIds = useMemo(() => [...selection.deleted] as readonly string[], [selection, selection.deleted.size]);
  return { window, group, windows, groups, groupsKnowledge, error, client, deleted, deletedWindowIds, hasActiveWindow, saveState, provisional: !!window && provisional,
    retrySave: () => currentStore.current?.retry() ?? Promise.resolve(),
    sectionCreationState, retrySection: () => createSectionRequest(undefined, true),
    acquireGroup, readGroup, operateGroup, refreshGroups,
    /** Starts a group from a session: its Window holds the session as the primary view, and it shows in both modes, named after the session; a `name` is the bot's own name, else it gets one. */
    async createBotGroup(binding: WindowSessionBinding, name?: string): Promise<{ groupId: string; viewId: string }> {
      if (pendingSection()) throw keyedError('windows.error.unconfirmedGroup');
      const viewId = 'main';
      const groupId = await createSectionRequest(undefined, false, () => ({
        window: { ...emptyWindow(), title: binding.title || 'New session', views: [createWindowView(viewId, binding, 'primary')], selectedPrimaryViewId: viewId, selectedViewId: viewId },
        bots: { rank: appendedRank(catalog.groups), members: { [viewId]: { picture: newAssistantPicture(viewId, catalog.groups), ...(name ? { name } : {}) } } } }));
      return { groupId, viewId };
    },
    /** Creates an empty group with this name, listed after the others. */
    async createGroup(title: string): Promise<string> {
      const trimmed = title.trim(); if (!trimmed) throw keyedError('windows.error.titleRequired'); if (trimmed.length > 256) throw keyedError('windows.error.titleTooLong');
      if (pendingSection()) throw keyedError('windows.error.unconfirmedGroup');
      return createSectionRequest(trimmed, false);
    },
    /** Runs the steps of a move (`planMove`) in order, each settled before the next. */
    async moveAssistant(steps: readonly MoveStep[]): Promise<void> {
      for (const step of steps) {
        if (!inScope() || !access.current) throw keyedError('windows.error.scopeChanged');
        if (step.kind === 'edit') await operateGroup(step.groupId, step.operation);
        else if (step.kind === 'create') {
          if (pendingSection()) throw keyedError('windows.error.unconfirmedGroup');
          await createSectionRequest(undefined, false, () => step.group);
        } else await across(step);
      }
    },
    /** Deletes a group that is not the open Window, such as an empty one; a group already gone counts as deleted. */
    async deleteGroup(id: string): Promise<void> {
      if (currentStore.current?.getSnapshot().id === id) throw keyedError('windows.error.switchBeforeDelete');
      if (client) {
        try { const snapshot = await client.inspect(id); await client.delete(snapshot.window, { operationId: crypto.randomUUID(), issuedAt: Date.now() }); }
        catch (error) { if (!(error instanceof WindowRequestError && error.status === 404)) throw error; }
      } else conversationLocalStorage.removeItem(`${key}:${id}`);
      forgetDeletedWindow(id);
    },
    discardLocalChanges: () => currentStore.current?.discardPendingChanges() ?? Promise.resolve(), unavailable: participating && enabled && unavailable, operate, readWindow,
    authority: window && !unavailable ? {
      window, readWindow,
      operate: dispatch,
      resolveViewId: (id: string) => resolveCompositionWindowViewId(composition, window, id),
    } : undefined,
    sessionBridge: window && !unavailable ? createWindowSessionBridge(composition, window) : undefined,
    async open(id: string) {
      if (deletions.has(id)) throw keyedError('windows.error.unsettledWindowDeletion');
      const generation = ++selection.generation;
      const cached = readCached(id);
      if (cached && (!workspaceNavigation || hasWindowAppearance(cached))) { choose(cached, false, !client); setError(undefined); }
      let next: WindowGroup;
      try {
        if (client) next = toWindowGroup(await client.inspect(id));
        else { const cached = decodeWindowGroup(JSON.parse(conversationLocalStorage.getItem(`${key}:${id}`) ?? 'null')); if (!cached || cached.window.id !== id) throw keyedError('windows.error.localWindowUnavailable'); next = cached; }
      } catch (error) {
        if (generation !== selection.generation) return;
        if (error instanceof WindowRequestError && error.status === 404) forgetDeletedWindow(id);
        throw error;
      }
      if (generation !== selection.generation) return;
      if (!inScope()) throw keyedError('windows.error.scopeBeforeOpening');
      if (workspaceNavigation && !hasWindowAppearance(next)) {
        if (currentStore.current?.getSnapshot().id === id) selectStore(undefined);
        makeStore(next).accept(next); updateCatalog(next);
        throw keyedError('windows.error.sectionWithoutAppearance');
      }
      setError(undefined); choose(next);
    },
    /** Creates a Window from this page's sessions, or an empty one on request; a pending creation is recovered first. */
    async create(options?: { empty?: boolean }) {
      const generation = ++selection.generation;
      let created: WindowGroup;
      const candidate = () => options?.empty === true || unavailable ? emptyWindow() : importCompositionWindow(composition);
      if (client) { const { candidate: original, snapshot } = await createHosted(candidate, true); if (generation !== selection.generation) return; created = toWindowGroup(snapshot); commitImportedWindowComposition(composition, original, created.window); }
      else created = { window: candidate() };
      choose(created, true); setError(undefined); updateCatalog(created);
    },
    /**
     * Renames any Window in the catalog, resolving once the title is applied locally; `saved` settles with the
     * background save. Another Window saves through its own store, like edits made while it was open.
     */
    async rename(id: string, title: string): Promise<{ saved: Promise<void> }> {
      const operation: WindowOperation = { type: 'rename', title };
      if (currentStore.current?.getSnapshot().id === id) return { saved: operate(operation) };
      if (!inScope()) throw keyedError('windows.error.scopeBeforeRenaming');
      if (selection.deleted.has(id) || deletions.has(id)) throw keyedError('windows.error.beingDeleted');
      let target = stores.get(id);
      if (!target) {
        let group: WindowGroup | undefined;
        try { group = client ? toWindowGroup(await client.inspect(id)) : readCached(id); }
        catch (error) {
          if (error instanceof WindowRequestError && error.status === 404) forgetDeletedWindow(id);
          throw error;
        }
        if (!group || group.window.id !== id) throw keyedError('windows.error.windowUnavailable');
        if (!inScope() || selection.deleted.has(id)) throw keyedError('windows.error.scopeBeforeRenaming');
        target = stores.get(id) ?? makeStore(group);
      }
      const store = target, saved = store.operate(operation);
      updateCatalog(store.getGroup());
      void saved.finally(() => updateCatalog(store.getGroup())).catch(() => {});
      return { saved };
    },
    async remove(id: string) {
      const assertInactive = () => {
        if (!id) throw keyedError('windows.error.chooseToDelete');
        const active = currentStore.current;
        if (!inScope() || !active || !confirmedStores.has(active)) throw keyedError('windows.error.openBeforeDelete');
        if (active.getSnapshot().id === id) throw keyedError('windows.error.switchBeforeDelete');
      };
      assertInactive();
      if (client) {
        const previous = deletions.get(id);
        const pending = previous ?? { window: undefined, identity: { operationId: crypto.randomUUID(), issuedAt: Date.now() }, dispatched: false };
        deletions.set(id, pending);
        pending.running ??= (async () => {
          const recovering = pending.dispatched;
          if (!pending.window) pending.window = (await client.inspect(id)).window;
          if (!inScope()) throw keyedError('windows.error.scopeBeforeDeletion');
          assertInactive();
          if (recovering) {
            try { await client.recoverDelete(pending.window, pending.identity); return; }
            catch (error) { if (!(error instanceof WindowMutationUnknownError)) throw error; }
          }
          if (!inScope()) throw keyedError('windows.error.scopeBeforeDeletion');
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
