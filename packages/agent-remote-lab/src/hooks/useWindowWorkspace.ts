import { createWindowSessionBridge, resolveCompositionWindowViewId } from '../window-composition.js';
import { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react';
import { WindowWorkspaceClient, WindowMutationUnknownError, WindowRequestError, type WindowOperationIdentity, type WindowSnapshot } from '@orchardworks/agent-remote-web';
import type { WindowCreateRequest, WindowOperation, WindowSessionBinding, WorkspaceWindow } from '@orchardworks/agent-remote-protocol';
import { conversationLocalStorage, conversationSessionStorage } from '../conversation-storage.js';
import { captureImportedWindowComposition, restoreImportedWindowComposition, commitImportedWindowComposition, importCompositionWindow, WindowWorkspaceStore } from '../window-workspace.js';
import type { CompositionDocument } from '../session-composition.js';
import { applyWindowOperation, createWindowView, decodeWorkspaceWindow, isWindowCreateRequest, windowPrimaryViewId } from '@orchardworks/agent-remote-protocol';

interface PendingCreation { request: WindowCreateRequest; candidate: WorkspaceWindow; bindings: Array<[string, string]> }
interface CreatedWindow { candidate: WorkspaceWindow; snapshot: WindowSnapshot }
const knownRejection = (error: unknown) => error instanceof WindowRequestError && (error.result?.status === 'rejected' || error.status >= 400 && error.status < 500);
const emptyWindow = (): WorkspaceWindow => ({ schemaVersion: 2, id: crypto.randomUUID(), revision: 0, title: 'Window', selectedPrimaryViewId: 'main', selectedViewId: 'main', views: [createWindowView('main', undefined, 'primary')] });

function sessionLinkOperation(window: WorkspaceWindow, binding: WindowSessionBinding): WindowOperation | undefined {
  const selected = window.views.find(view => view.id === window.selectedViewId)!;
  const matches = (view: typeof selected) => view.binding?.hostId === binding.hostId && view.binding.providerId === binding.providerId
    && view.binding.nativeSessionId === binding.nativeSessionId && view.binding.sessionIntent === binding.sessionIntent;
  const matching = matches(selected) ? selected : window.views.find(matches);
  if (matching) return matching.id === selected.id && !matching.collapsed ? undefined : { type: 'view.select', viewId: matching.id };
  if (selected.bindingPolicy === 'managed') {
    const view = createWindowView(crypto.randomUUID(), binding);
    return { type: 'batch', operations: [{ type: 'view.create', view }, { type: 'view.select', viewId: view.id }] };
  }
  return { type: 'batch', operations: [
    { type: 'view.bind', viewId: selected.id, binding, expectedBinding: selected.binding ?? null },
    { type: 'view.select', viewId: selected.id },
  ] };
}

/** Product page catalog and URL selection; each chosen Window keeps its own store. */
export function useWindowWorkspace(scope: string, hosted: boolean, enabled: boolean, composition: CompositionDocument, participating = true) {
  const client = useMemo(() => hosted ? new WindowWorkspaceClient(scope) : undefined, [scope, hosted]);
  const key = `agent-remote:recovery:${scope}:shared-window`;
  const creation = useMemo(() => ({ pending: undefined as PendingCreation | null | undefined, running: undefined as Promise<CreatedWindow> | undefined }), [key, client]);
  const deletions = useMemo(() => new Map<string, { window?: WorkspaceWindow; identity: WindowOperationIdentity; dispatched: boolean; running?: Promise<void> }>(), [key, client]);
  const selection = useMemo(() => ({ generation: 0, active: true, deleted: new Set<string>() }), [key, client]);
  const stores = useMemo(() => new Map<string, WindowWorkspaceStore>(), [key, client]);
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
      for (const saved of stores.values()) saved.setEnabled(false);
      // React may immediately replay effects; only a departed scope owns disposal.
      queueMicrotask(() => { if (!selection.active) { for (const saved of stores.values()) saved.dispose(); stores.clear(); } });
    };
  }, [selection, stores]);
  useEffect(() => { for (const saved of stores.values()) saved.setEnabled(enabled && participating); }, [stores, enabled, participating]);
  const confirmedStores = useMemo(() => new WeakSet<WindowWorkspaceStore>(), [key, client]);
  const [unavailable, setUnavailable] = useState(false);
  const currentlyUnavailable = useRef(unavailable); currentlyUnavailable.current = unavailable;
  const readWindow = useCallback(() => currentlyUnavailable.current ? undefined : currentStore.current?.getSnapshot(), []);
  const [deleted, setDeleted] = useState(false);
  const selectStore = (next: WindowWorkspaceStore | undefined) => { currentStore.current = next; setStore(next); };
  const [windows, setWindows] = useState<WorkspaceWindow[]>([]);
  const [error, setError] = useState<string>();
  const [route, setRoute] = useState(() => globalThis.location.href);
  const navigation = useMemo(() => ({ url: globalThis.location.href }), [route, key]);
  useEffect(() => { const navigate = () => setRoute(globalThis.location.href); globalThis.addEventListener('popstate', navigate); return () => globalThis.removeEventListener('popstate', navigate); }, []);
  const cache = (window: WorkspaceWindow) => {
    if (selection.deleted.has(window.id)) return;
    try {
      const previous = decodeWorkspaceWindow(JSON.parse(conversationLocalStorage.getItem(`${key}:${window.id}`) ?? 'null'));
      if (!previous || previous.revision <= window.revision) conversationLocalStorage.setItem(`${key}:${window.id}`, JSON.stringify(window));
    } catch { /* The service remains authoritative when cache storage is unavailable. */ }
  };
  const persistLocal = (window: WorkspaceWindow) => conversationLocalStorage.setItem(`${key}:${window.id}`, JSON.stringify(window));
  const choose = (window: WorkspaceWindow, created = false, confirmed = true) => {
    if (!inScope() || selection.deleted.has(window.id) || deletions.get(window.id)?.dispatched) return;
    if (created && !client) persistLocal(window);
    const next = makeStore(window);
    if (confirmed) { next.accept(window); confirmedStores.add(next); }
    if (client) cache(next.getCommittedSnapshot());
    if (confirmed) commitImportedWindowComposition(composition, window);
    try { conversationSessionStorage.setItem(key, window.id); } catch { /* The URL still identifies the chosen Window. */ }
    try { conversationLocalStorage.setItem(`${key}:last-window`, window.id); } catch { /* The catalog can restore a Window without this preference. */ }
    const url = new URL(globalThis.location.href);
    if (url.searchParams.get('window') !== window.id) { url.searchParams.set('window', window.id); globalThis.history.replaceState(globalThis.history.state, '', url); }
    navigation.url = url.href;
    selectStore(next); currentlyUnavailable.current = false; setUnavailable(false); setDeleted(false);
  };
  const readCached = (id: string): WorkspaceWindow | undefined => {
    const existing = stores.get(id); if (existing) return existing.getCommittedSnapshot();
    try {
      const journal = JSON.parse(conversationSessionStorage.getItem(`${key}:pending:${id}`) ?? 'null');
      const committed = decodeWorkspaceWindow(journal?.committed);
      if (committed?.id === id) return committed;
    } catch { /* Fall back to the last confirmed layout. */ }
    try { const value = decodeWorkspaceWindow(JSON.parse(conversationLocalStorage.getItem(`${key}:${id}`) ?? 'null')); return value?.id === id ? value : undefined; }
    catch { return undefined; }
  };
  const makeStore = (window: WorkspaceWindow) => {
    const existing = stores.get(window.id); if (existing) return existing;
    let recovery: unknown;
    try { recovery = JSON.parse(conversationSessionStorage.getItem(`${key}:pending:${window.id}`) ?? 'null'); } catch { /* Invalid journals do not replace a confirmed layout. */ }
    const next = new WindowWorkspaceStore(window, client, client ? () => cache(next.getCommittedSnapshot()) : undefined, client ? undefined : async (source, operation) => {
      const commit = async () => {
        const value = decodeWorkspaceWindow(JSON.parse(conversationLocalStorage.getItem(`${key}:${source.id}`) ?? 'null'));
        if (!value) throw new Error('The local Window is unavailable.');
        const replacesLayout = operation.type === 'layout.apply' || operation.type === 'batch' && operation.operations.some(edit => edit.type === 'layout.apply');
        if (replacesLayout && value.revision !== source.revision) throw new Error('The Window changed before applying this layout. Refresh and retry.');
        const result = applyWindowOperation(value, operation); persistLocal(result); return result;
      };
      return globalThis.navigator.locks ? globalThis.navigator.locks.request(`${key}:${source.id}`, commit) : commit();
    }, {
      recovery, autoRetry: true, paused: !access.current,
      persist: value => {
        if (selection.deleted.has(window.id)) return;
        if (value.edits.length) conversationSessionStorage.setItem(`${key}:pending:${window.id}`, JSON.stringify(value));
        else conversationSessionStorage.removeItem(`${key}:pending:${window.id}`);
      },
    });
    stores.set(window.id, next);
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
  const updateCatalog = (window: WorkspaceWindow) => { if (inScope() && !selection.deleted.has(window.id)) setWindows(current => current.some(item => item.id === window.id)
    ? current.map(item => item.id === window.id ? window : item) : [...current, window]); };
  const forgetDeletedWindow = (id: string) => {
    selection.deleted.add(id);
    stores.get(id)?.dispose(); stores.delete(id);
    try { conversationSessionStorage.removeItem(`${key}:pending:${id}`); } catch { /* A deleted Window never replays its pending edits. */ }
    try { conversationLocalStorage.removeItem(`${key}:${id}`); } catch { /* A failed cache cleanup cannot undo a confirmed deletion. */ }
    if (!inScope()) return;
    setWindows(current => current.filter(item => item.id !== id));
    if (currentStore.current?.getSnapshot().id !== id) return;
    selectStore(undefined); currentlyUnavailable.current = true; setUnavailable(true); setDeleted(true); setError(undefined);
  };
  useEffect(() => {
    const generation = ++selection.generation;
    selectStore(undefined); setUnavailable(false); setDeleted(false); setError(undefined);
    if (!participating) return;
    const query = new URL(navigation.url).searchParams;
    const requested = query.get('window');
    const explicitSession = !requested && !!query.get('host') && !!query.get('provider') && !!query.get('session');
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
      const bound = applyWindowOperation(imported, { type: 'view.bind', viewId: imported.selectedPrimaryViewId, binding: target });
      Object.assign(imported, bound, { revision: 0, title: target.title, selectedViewId: bound.selectedPrimaryViewId });
      return imported;
    };
    const preferredIds = () => {
      const ids: string[] = [];
      for (const [storage, name] of [[conversationSessionStorage, key], [conversationLocalStorage, `${key}:last-window`]] as const) {
        try { const id = storage.getItem(name); if (id && !ids.includes(id)) ids.push(id); } catch { /* The catalog does not depend on local storage. */ }
      }
      return ids;
    };
    let cached: WorkspaceWindow | undefined;
    for (const id of requested ? [requested] : preferredIds()) {
      const value = readCached(id); if (value) { cached = value; break; }
    }
    // A deep link is applied to the authoritative layout before it becomes the selected Window.
    if (client && cached && !target) choose(cached, false, false);
    let current = true;
    const live = () => current && inScope() && generation === selection.generation;
    const restore = async (window: WorkspaceWindow) => {
      if (!live()) return;
      const operation = target && sessionLinkOperation(window, target);
      choose(window);
      if (operation) { const pending = makeStore(window).operate(operation); void pending.catch(error => { if (live()) setError(String(error.message ?? error)); }); }
    };
    if (!client) {
      const local: WorkspaceWindow[] = [];
      for (const entry of conversationLocalStorage.keys().filter(entry => entry.startsWith(`${key}:`))) {
        try { const value = decodeWorkspaceWindow(JSON.parse(conversationLocalStorage.getItem(entry) ?? 'null')); if (value) local.push(value); } catch { /* A corrupt cache is not a usable Window. */ }
      }
      setWindows(local);
      if (requested && !cached) { setError('This Window is unavailable in the local workbench.'); setUnavailable(true); }
      else {
        const existing = cached ?? local[0];
        try {
          if (existing && !target) choose(existing);
          else if (existing) void Promise.resolve().then(() => restore(existing)).catch(error => { if (live()) setError(String(error.message ?? error)); });
          else { const imported = initialWindow(); choose(imported, true); }
        } catch (error) { setError(String(error instanceof Error ? error.message : error)); }
      }
    }
    if (!enabled || !client) return () => { current = false; };
    const restoreHosted = async () => {
      if (!live()) return;
      const list = (await client.list()).filter(window => !selection.deleted.has(window.id)); if (!current || generation !== selection.generation) return; setWindows(list.map(window => stores.get(window.id)?.getSnapshot() ?? window));
      // A background journal may outlive a Window deleted on another page.
      // Catalog omission alone is insufficient proof, and its inspection must not delay opening the selected Window.
      const listed = new Set(list.map(window => window.id));
      for (const [id, pending] of stores) {
        if (listed.has(id) || id === currentStore.current?.getSnapshot().id || !pending.getSyncState().pending) continue;
        void client.inspect(id).catch(error => {
          if (live() && stores.get(id) === pending && error instanceof WindowRequestError && error.status === 404) forgetDeletedWindow(id);
        });
      }
      if (requested) { const next = await client.inspect(requested); if (live()) choose(next.window); return; }
      if (!pendingCreation()) {
        const ids = [...new Set([...preferredIds(), ...list.map(window => window.id)])].filter(id => list.some(window => window.id === id));
        for (const id of ids) {
          let next: WindowSnapshot;
          try { next = await client.inspect(id); }
          catch (error) {
            if (!live()) return;
            if (!(error instanceof WindowRequestError) || error.status !== 404) throw error;
            forgetDeletedWindow(id);
            continue;
          }
          await restore(next.window); return;
        }
      }
      if (!live()) return;
      const { candidate, snapshot: next } = await createHosted(initialWindow, false);
      if (live()) { commitImportedWindowComposition(composition, candidate, next.window); await restore(next.window); }
    };
    const restored = !requested && globalThis.navigator.locks ? globalThis.navigator.locks.request(`${key}:restore`, restoreHosted) : restoreHosted();
    void restored.catch(error => {
      if (!live()) return;
      if (error?.status === 404) { if (requested) forgetDeletedWindow(requested); selectStore(undefined); setUnavailable(true); }
      setError(String(error.message ?? error));
    });
    return () => { current = false; };
  }, [scope, client, enabled, route, participating]);
  const window = useSyncExternalStore(store?.subscribe ?? (() => () => {}), store?.getSnapshot ?? (() => undefined));
  const saveState = useSyncExternalStore(store?.subscribe ?? (() => () => {}), store?.getSyncState ?? (() => undefined));
  useEffect(() => {
    if (!window) return;
    updateCatalog(window);
  }, [window]);
  const confirmed = !!store && confirmedStores.has(store);
  useEffect(() => {
    if (!store || !enabled || !client || !participating || !confirmed) return;
    const abort = new AbortController();
    void store.synchronize(abort.signal).catch(error => {
      if (abort.signal.aborted) return;
      if (error?.status === 404) {
        forgetDeletedWindow(store.getSnapshot().id);
      } else setError(String(error.message ?? error));
    });
    return () => abort.abort();
  }, [store, enabled, client, participating, confirmed]);
  useEffect(() => {
    if (client || !store) return;
    const receive = (event: StorageEvent) => {
      if (!event.key?.startsWith(`${key}:`)) return;
      if (event.newValue === null) { forgetDeletedWindow(event.key.slice(key.length + 1)); return; }
      if (event.key !== `${key}:${store.getSnapshot().id}`) return;
      try { const value = decodeWorkspaceWindow(JSON.parse(event.newValue)); if (value) store.accept(value); } catch { /* Invalid data never replaces a committed snapshot. */ }
    };
    globalThis.addEventListener('storage', receive); return () => globalThis.removeEventListener('storage', receive);
  }, [store, client, key]);
  const operate = (operation: Parameters<WindowWorkspaceStore['operate']>[0]): Promise<void> => {
    const active = currentStore.current;
    if (!active || currentlyUnavailable.current || !inScope()) throw new Error('Open an available Window before editing its layout.');
    applyWindowOperation(active.getSnapshot(), operation);
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
  return { window, windows, error, client, deleted, deletedWindowIds, hasActiveWindow, saveState, retrySave: () => currentStore.current?.retry() ?? Promise.resolve(),
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
      if (cached) { choose(cached, false, !client); setError(undefined); }
      let next: WorkspaceWindow;
      try {
        if (client) next = (await client.inspect(id)).window;
        else { const cached = decodeWorkspaceWindow(JSON.parse(conversationLocalStorage.getItem(`${key}:${id}`) ?? 'null')); if (!cached || cached.id !== id) throw new Error('This local Window is unavailable.'); next = cached; }
      } catch (error) {
        if (generation !== selection.generation) return;
        if (error instanceof WindowRequestError && error.status === 404) forgetDeletedWindow(id);
        throw error;
      }
      if (generation !== selection.generation) return;
      setError(undefined); choose(next);
    },
    async create() {
      const generation = ++selection.generation;
      let created: WorkspaceWindow;
      const candidate = () => unavailable ? emptyWindow() : importCompositionWindow(composition);
      if (client) { const { candidate: original, snapshot } = await createHosted(candidate, true); if (generation !== selection.generation) return; created = snapshot.window; commitImportedWindowComposition(composition, original, created); }
      else created = candidate();
      choose(created, true); setError(undefined); setWindows(current => [...current.filter(window => window.id !== created.id), created]);
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
