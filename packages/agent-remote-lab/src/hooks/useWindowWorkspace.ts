import { createWindowSessionBridge, resolveCompositionWindowViewId } from '../window-composition.js';
import { useEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react';
import { WindowWorkspaceClient, WindowMutationUnknownError, WindowRequestError, type WindowOperationIdentity, type WindowSnapshot } from '@orchardworks/agent-remote-web';
import type { WindowCreateRequest, WorkspaceWindow } from '@orchardworks/agent-remote-protocol';
import { conversationLocalStorage, conversationSessionStorage } from '../conversation-storage.js';
import { captureImportedWindowComposition, restoreImportedWindowComposition, commitImportedWindowComposition, importCompositionWindow, WindowWorkspaceStore } from '../window-workspace.js';
import type { CompositionDocument } from '../session-composition.js';
import { applyWindowOperation, createWindowView, isWindowCreateRequest, isWorkspaceWindow } from '@orchardworks/agent-remote-protocol';

interface PendingCreation { request: WindowCreateRequest; bindings: Array<[string, string]> }
interface CreatedWindow { candidate: WorkspaceWindow; snapshot: WindowSnapshot }
const knownRejection = (error: unknown) => error instanceof WindowRequestError && (error.result?.status === 'rejected' || error.status >= 400 && error.status < 500);
const emptyWindow = (): WorkspaceWindow => ({ schemaVersion: 1, id: crypto.randomUUID(), revision: 0, title: 'Window', primaryViewId: 'main', selectedViewId: 'main', mainMinimized: false, views: [createWindowView('main', undefined, 'primary')] });

/** Product page catalog and URL selection; each chosen Window keeps its own store. */
export function useWindowWorkspace(scope: string, hosted: boolean, enabled: boolean, composition: CompositionDocument, participating = true) {
  const client = useMemo(() => hosted ? new WindowWorkspaceClient(scope) : undefined, [scope, hosted]);
  const key = `agent-remote:recovery:${scope}:shared-window`;
  const creation = useMemo(() => ({ pending: undefined as PendingCreation | null | undefined, running: undefined as Promise<CreatedWindow> | undefined }), [key, client]);
  const deletions = useMemo(() => new Map<string, { window: WorkspaceWindow; identity: WindowOperationIdentity; running?: Promise<void> }>(), [key, client]);
  const selection = useMemo(() => ({ generation: 0 }), [key, client]);
  const [store, setStore] = useState<WindowWorkspaceStore>();
  const currentStore = useRef<WindowWorkspaceStore>();
  useEffect(() => () => { selection.generation++; currentStore.current = undefined; }, [selection]);
  const confirmedStores = useMemo(() => new WeakSet<WindowWorkspaceStore>(), [key, client]);
  const [unavailable, setUnavailable] = useState(false);
  const replacements = useMemo(() => new WeakMap<WindowWorkspaceStore, Promise<void>>(), [key, client]);
  const selectStore = (next: WindowWorkspaceStore | undefined) => { currentStore.current = next; setStore(next); };
  const [windows, setWindows] = useState<WorkspaceWindow[]>([]);
  const [error, setError] = useState<string>();
  const [route, setRoute] = useState(() => globalThis.location.href);
  useEffect(() => { const navigate = () => setRoute(globalThis.location.href); globalThis.addEventListener('popstate', navigate); return () => globalThis.removeEventListener('popstate', navigate); }, []);
  const cache = (window: WorkspaceWindow) => { try { conversationLocalStorage.setItem(`${key}:${window.id}`, JSON.stringify(window)); } catch { /* The service remains authoritative when cache storage is unavailable. */ } };
  const persistLocal = (window: WorkspaceWindow) => conversationLocalStorage.setItem(`${key}:${window.id}`, JSON.stringify(window));
  const choose = (window: WorkspaceWindow, created = false, confirmed = true) => {
    if (created && !client) persistLocal(window);
    commitImportedWindowComposition(composition, window);
    cache(window);
    try { conversationSessionStorage.setItem(key, window.id); } catch { /* The URL still identifies the chosen Window. */ }
    const url = new URL(globalThis.location.href);
    if (url.searchParams.get('window') !== window.id) { url.searchParams.set('window', window.id); globalThis.history.replaceState(globalThis.history.state, '', url); }
    const next = makeStore(window); if (confirmed) confirmedStores.add(next);
    selectStore(next); setUnavailable(false);
  };
  const makeStore = (window: WorkspaceWindow) => new WindowWorkspaceStore(window, client, client ? cache : undefined, client ? undefined : async (source, operation) => {
    const commit = async () => {
      const value: unknown = JSON.parse(conversationLocalStorage.getItem(`${key}:${source.id}`) ?? 'null');
      if (!isWorkspaceWindow(value)) throw new Error('The local Window is unavailable.');
      const replacesLayout = operation.type === 'layout.apply' || operation.type === 'batch' && operation.operations.some(edit => edit.type === 'layout.apply');
      if (replacesLayout && value.revision !== source.revision) throw new Error('The Window changed before applying this layout. Refresh and retry.');
      const next = applyWindowOperation(value, operation); persistLocal(next); return next;
    };
    return globalThis.navigator.locks ? globalThis.navigator.locks.request(`${key}:${source.id}`, commit) : commit();
  });
  const pendingCreation = (): PendingCreation | undefined => {
    if (creation.pending !== undefined) return creation.pending ?? undefined;
    const saved = conversationSessionStorage.getItem(`${key}:pending-create`);
    if (!saved) { creation.pending = null; return; }
    const value: unknown = JSON.parse(saved);
    if (!value || typeof value !== 'object' || !('request' in value) || !isWindowCreateRequest(value.request)) throw new Error('The pending Window creation cannot be recovered. Preserve its saved request before creating another Window.');
    const pending: PendingCreation = { request: value.request, bindings: 'bindings' in value && Array.isArray(value.bindings) ? value.bindings : [] };
    restoreImportedWindowComposition(composition, pending.request.window, pending.bindings);
    creation.pending = pending; return pending;
  };
  const clearPendingCreation = () => {
    creation.pending = null;
    try { conversationSessionStorage.removeItem(`${key}:pending-create`); } catch { /* A retained settled request is safe to recover again after reload. */ }
  };
  const createHosted = (candidate: () => WorkspaceWindow, explicitRetry: boolean): Promise<CreatedWindow> => {
    if (creation.running) return creation.running;
    const previous = pendingCreation();
    const window = previous?.request.window ?? candidate();
    const pending = previous ?? { request: { operationId: crypto.randomUUID(), issuedAt: Date.now(), window }, bindings: captureImportedWindowComposition(window) };
    const submit = () => {
      conversationSessionStorage.setItem(`${key}:pending-create`, JSON.stringify(pending));
      creation.pending = pending;
      return client!.create(window, pending.request).catch(error => {
        // A refused replay does not establish what happened to the original request.
        if (previous && error instanceof WindowRequestError && !error.result) throw new WindowMutationUnknownError(window.id, pending.request, error);
        throw error;
      });
    };
    const run = async () => {
      if (!previous) return submit();
      try { return await client!.recoverCreate(window, pending.request); }
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
  const updateCatalog = (window: WorkspaceWindow) => setWindows(current => current.some(item => item.id === window.id)
    ? current.map(item => item.id === window.id ? window : item) : [...current, window]);
  const replaceDeletedWindow = (deletedStore: WindowWorkspaceStore): Promise<void> => {
    const id = deletedStore.getSnapshot().id;
    setWindows(current => current.filter(item => item.id !== id));
    try { conversationLocalStorage.removeItem(`${key}:${id}`); } catch { /* A failed cache cleanup cannot undo a confirmed deletion. */ }
    if (currentStore.current !== deletedStore) return Promise.resolve();
    const existing = replacements.get(deletedStore); if (existing) return existing;
    setUnavailable(true);
    const replace = async () => {
      let replacement: WorkspaceWindow;
      if (client) {
        // Another creation must settle without replay before allocating an empty replacement.
        if (creation.running || pendingCreation()) {
          const settled = await (creation.running ?? createHosted(emptyWindow, false));
          cache(settled.snapshot.window); updateCatalog(settled.snapshot.window);
          if (currentStore.current !== deletedStore) return;
        }
        const { snapshot } = await createHosted(emptyWindow, false);
        if (currentStore.current !== deletedStore) return;
        replacement = snapshot.window;
      } else replacement = emptyWindow();
      choose(replacement, true); setError(undefined); updateCatalog(replacement);
    };
    const pending = replace().catch(error => {
      if (currentStore.current === deletedStore) setError(String(error instanceof Error ? error.message : error));
      throw error;
    });
    replacements.set(deletedStore, pending);
    return pending;
  };
  useEffect(() => {
    const generation = ++selection.generation;
    selectStore(undefined); setUnavailable(false); setError(undefined);
    if (!participating) return;
    const query = new URL(globalThis.location.href).searchParams;
    const requested = query.get('window');
    const explicitSession = !requested && !!query.get('host') && !!query.get('provider') && !!query.get('session');
    const initialWindow = () => {
      const imported = importCompositionWindow(composition);
      if (!explicitSession) return imported;
      const target = {
        hostId: query.get('host')!, providerId: query.get('provider')!, nativeSessionId: query.get('session')!,
        title: composition.slots.find(slot => slot.intent.target.hostId === query.get('host')
          && slot.intent.target.native.providerId === query.get('provider')
          && slot.intent.target.native.nativeSessionId === query.get('session'))?.metadata?.title || query.get('session')!,
        ...(query.get('parent') ? { parentNativeSessionId: query.get('parent')! } : {}),
      };
      const existing = imported.views.find(view => view.binding?.hostId === target.hostId
        && view.binding.providerId === target.providerId && view.binding.nativeSessionId === target.nativeSessionId);
      if (existing) { imported.selectedViewId = existing.id; return imported; }
      const bound = applyWindowOperation(imported, { type: 'view.bind', viewId: imported.primaryViewId, binding: target });
      Object.assign(imported, bound, { revision: 0, title: target.title, selectedViewId: bound.primaryViewId });
      return imported;
    };
    let cached: unknown; try { const selected = requested ?? (explicitSession ? undefined : conversationSessionStorage.getItem(key)); cached = selected ? JSON.parse(conversationLocalStorage.getItem(`${key}:${selected}`) ?? 'null') : undefined; } catch { /* Ignore an invalid cache. */ }
    if (isWorkspaceWindow(cached) && (!requested || cached.id === requested)) choose(cached, false, !client);
    else if (!client && requested) setError('This Window is unavailable in the local workbench.');
    else if (!client) { try { const imported = initialWindow(); choose(imported, true); } catch (error) { setError(String(error instanceof Error ? error.message : error)); } }
    if (!client) { const local: WorkspaceWindow[] = []; for (const entry of conversationLocalStorage.keys().filter(entry => entry.startsWith(`${key}:`))) { try { const value: unknown = JSON.parse(conversationLocalStorage.getItem(entry) ?? 'null'); if (isWorkspaceWindow(value)) local.push(value); } catch { /* A corrupt cache is not a usable Window. */ } } setWindows(local); }
    if (!enabled || !client) return;
    let current = true;
    void (async () => {
      const list = await client.list(); if (!current || generation !== selection.generation) return; setWindows(list);
      if (requested) { const next = await client.inspect(requested); if (current && generation === selection.generation) choose(next.window); }
      else if (isWorkspaceWindow(cached)) { const next = await client.inspect(cached.id); if (current && generation === selection.generation) choose(next.window); }
      else { const { candidate, snapshot: next } = await createHosted(initialWindow, false); if (current && generation === selection.generation) { commitImportedWindowComposition(composition, candidate, next.window); choose(next.window); setWindows([...list.filter(window => window.id !== next.window.id), next.window]); } }
    })().catch(error => { if (current && generation === selection.generation) { setError(String(error.message ?? error)); if (error?.status === 404) selectStore(undefined); } });
    return () => { current = false; };
  }, [scope, client, enabled, route, participating]);
  const window = useSyncExternalStore(store?.subscribe ?? (() => () => {}), store?.getSnapshot ?? (() => undefined));
  useEffect(() => {
    if (!window) return;
    updateCatalog(window);
  }, [window]);
  useEffect(() => {
    if (!store || !enabled || !client || !confirmedStores.has(store)) return;
    const abort = new AbortController();
    void store.synchronize(abort.signal).catch(async error => {
      if (abort.signal.aborted) return;
      if (error?.status === 404) {
        try { await replaceDeletedWindow(store); } catch { /* The recovery surface keeps the original failure visible. */ }
      } else setError(String(error.message ?? error));
    });
    return () => abort.abort();
  }, [store, enabled, client]);
  useEffect(() => {
    if (client || !store) return;
    const receive = (event: StorageEvent) => {
      if (event.key !== `${key}:${store.getSnapshot().id}`) return;
      if (event.newValue === null) { void replaceDeletedWindow(store).catch(() => {}); return; }
      try { const value: unknown = JSON.parse(event.newValue); if (isWorkspaceWindow(value)) store.accept(value); } catch { /* Invalid data never replaces a committed snapshot. */ }
    };
    globalThis.addEventListener('storage', receive); return () => globalThis.removeEventListener('storage', receive);
  }, [store, client, key]);
  const operate = async (operation: Parameters<WindowWorkspaceStore['operate']>[0]): Promise<void> => { if (!store || unavailable) throw new Error('Choose an available Window before editing its layout.'); try { await store.operate(operation); } catch (error) { setError(String(error instanceof Error ? error.message : error)); throw error; } };
  const dispatch = (operation: Parameters<WindowWorkspaceStore['operate']>[0]) => { void operate(operation).catch(() => {}); };
  return { window, windows, error, client, unavailable: participating && enabled && unavailable, operate, readWindow: () => unavailable ? undefined : store?.getSnapshot(),
    authority: window && !unavailable ? {
      window,
      operate: dispatch,
      resolveViewId: (id: string) => resolveCompositionWindowViewId(composition, window, id),
    } : undefined,
    sessionBridge: window && !unavailable ? createWindowSessionBridge(composition, window) : undefined,
    async open(id: string) {
      const generation = ++selection.generation;
      let next: WorkspaceWindow;
      try {
        if (client) next = (await client.inspect(id)).window;
        else { const cached: unknown = JSON.parse(conversationLocalStorage.getItem(`${key}:${id}`) ?? 'null'); if (!isWorkspaceWindow(cached) || cached.id !== id) throw new Error('This local Window is unavailable.'); next = cached; }
      } catch (error) { if (generation === selection.generation) throw error; return; }
      if (generation !== selection.generation) return;
      setError(undefined); choose(next);
    },
    async create() {
      const generation = ++selection.generation;
      let created: WorkspaceWindow;
      if (client) { const { candidate, snapshot } = await createHosted(() => importCompositionWindow(composition), true); if (generation !== selection.generation) return; created = snapshot.window; commitImportedWindowComposition(composition, candidate, created); }
      else created = importCompositionWindow(composition);
      choose(created, true); setError(undefined); setWindows(current => [...current.filter(window => window.id !== created.id), created]);
    },
    async remove() {
      if (!window) return;
      const deletedStore = store!;
      if (client) {
        const previous = deletions.get(window.id);
        const pending = previous ?? { window: structuredClone(window), identity: { operationId: crypto.randomUUID(), issuedAt: Date.now() } };
        deletions.set(window.id, pending);
        pending.running ??= (async () => {
          if (previous) {
            try { await client.recoverDelete(pending.window, pending.identity); return; }
            catch (error) { if (!(error instanceof WindowMutationUnknownError)) throw error; }
          }
          try { await client.delete(pending.window, pending.identity); }
          catch (error) {
            if (previous && error instanceof WindowRequestError && !error.result) throw new WindowMutationUnknownError(window.id,
              { ...pending.identity, baseRevision: pending.window.revision, operation: { type: 'delete' } }, error);
            throw error;
          }
        })();
        try { await pending.running; deletions.delete(window.id); }
        catch (error) { pending.running = undefined; if (knownRejection(error)) deletions.delete(window.id); throw error; }
        try { conversationLocalStorage.removeItem(`${key}:${window.id}`); } catch { /* A failed cache cleanup cannot undo a committed deletion. */ }
      } else conversationLocalStorage.removeItem(`${key}:${window.id}`);
      await replaceDeletedWindow(deletedStore);
    },
  };
}
