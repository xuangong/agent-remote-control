import { useEffect, useMemo, useRef, useSyncExternalStore } from 'react';
import type { WindowWorkspaceClient } from '@orchardworks/agent-remote-web';
import { isWindowSessionBinding, type WindowSessionBinding } from '@orchardworks/agent-remote-protocol';

interface ManagerState {
  manager?: WindowSessionBinding;
  status: 'loading' | 'ready' | 'error';
  error?: string;
  pending: boolean;
}
const empty: ManagerState = { status: 'ready', pending: false };
const emptySnapshot = () => empty;
const emptySubscription = () => () => {};
const message = (error: unknown) => error instanceof Error ? error.message : String(error);

function managerEntry(client: WindowWorkspaceClient, windowId: string) {
  let state: ManagerState = { status: 'loading', pending: false };
  let readGeneration = 0;
  let readAbort: AbortController | undefined;
  const listeners = new Set<() => void>();
  const update = (next: ManagerState) => { state = next; for (const listener of listeners) listener(); };
  const cancelRead = () => { readGeneration++; readAbort?.abort(); readAbort = undefined; };
  return {
    subscribe(listener: () => void) { listeners.add(listener); return () => { listeners.delete(listener); }; },
    getSnapshot: () => state,
    cancelRead,
    refresh() {
      if (state.pending) return;
      cancelRead(); const generation = readGeneration;
      const abort = readAbort = new AbortController();
      update({ ...state, status: 'loading', error: undefined });
      void client.inspect(windowId, abort.signal).then(snapshot => {
        if (abort.signal.aborted || generation !== readGeneration) return;
        update({ status: 'ready', pending: false, manager: snapshot.manager?.session });
      }).catch(error => {
        if (!abort.signal.aborted && generation === readGeneration) update({ ...state, status: 'error', error: message(error) });
      });
    },
    async assign(session: WindowSessionBinding | null): Promise<void> {
      if (state.pending) throw new Error('A manager change is already pending for this Window.');
      cancelRead();
      update({ ...state, pending: true, error: undefined });
      try {
        const value = await client.assign(windowId, session) as {
          generation?: number; manager?: { session?: WindowSessionBinding; generation?: number };
        } | null;
        if (!value || !Number.isSafeInteger(value.generation) || value.generation! < 0
          || (session ? !isWindowSessionBinding(value.manager?.session) || value.manager?.generation !== value.generation
            || value.manager.session.hostId !== session.hostId || value.manager.session.providerId !== session.providerId
            || value.manager.session.nativeSessionId !== session.nativeSessionId
            : value.manager !== undefined)) throw new Error('The service returned an invalid manager result. Refresh this Window before retrying.');
        update({ status: 'ready', pending: false, manager: value.manager?.session });
      } catch (error) {
        update({ ...state, pending: false, status: 'error', error: message(error) });
        throw error;
      }
    },
  };
}

/** The session named to arrange a Window, isolated by service client and Window identity. */
export function useWindowManager(client: WindowWorkspaceClient | undefined, windowId: string | undefined, active: boolean) {
  const entries = useRef(new WeakMap<WindowWorkspaceClient, Map<string, ReturnType<typeof managerEntry>>>());
  const entry = useMemo(() => {
    if (!client || !windowId) return;
    let windows = entries.current.get(client);
    if (!windows) { windows = new Map(); entries.current.set(client, windows); }
    let value = windows.get(windowId);
    if (!value) { value = managerEntry(client, windowId); windows.set(windowId, value); }
    return value;
  }, [client, windowId]);
  const state = useSyncExternalStore(entry?.subscribe ?? emptySubscription, entry?.getSnapshot ?? emptySnapshot);
  useEffect(() => {
    if (!active || !entry) return;
    entry.refresh(); return entry.cancelRead;
  }, [entry, active]);
  return { ...state,
    async assign(session: WindowSessionBinding | null): Promise<void> {
      if (!entry) throw new Error('Choose a hosted Window before managing its Agent.');
      await entry.assign(session);
    },
    refresh() { if (active) entry?.refresh(); },
  };
}
