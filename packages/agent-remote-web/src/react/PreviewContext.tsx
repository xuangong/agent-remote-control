import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';

import type { HttpPreviewClient, PreviewRegistration, PreviewRegistrationRequest } from '../client/preview-client.js';
import type { PreviewController } from './PreviewActions.js';
import { PreviewBrowser } from './PreviewBrowser.js';

export interface PreviewContextValue extends PreviewController {
  readonly loading: boolean;
  readonly error?: string;
  refresh(): Promise<void>;
}

const Context = createContext<PreviewContextValue | undefined>(undefined);

export function PreviewProvider({ client, hostId, canManage, children }: {
  readonly client: HttpPreviewClient; readonly hostId: string; readonly canManage: boolean; readonly children: ReactNode;
}) {
  const scopeRef = useRef({ client, hostId, version: 0, request: 0 });
  if (scopeRef.current.client !== client || scopeRef.current.hostId !== hostId) {
    scopeRef.current = { client, hostId, version: scopeRef.current.version + 1, request: 0 };
  }
  const scope = scopeRef.current;
  const [state, setState] = useState<{ version: number; registrations: readonly PreviewRegistration[]; loading: boolean; error?: string }>(
    { version: scope.version, registrations: [], loading: true },
  );
  const currentState = state.version === scope.version ? state : { version: scope.version, registrations: [], loading: true };
  const [browser, setBrowser] = useState<{ version: number; id: string; target: string; url?: string; error?: string }>();
  const openRequest = useRef<AbortController>();
  const browserTrigger = useRef<HTMLElement>();
  const closeBrowser = useCallback(() => { openRequest.current?.abort(); setBrowser(undefined); }, []);
  useEffect(() => () => { openRequest.current?.abort(); }, [scope]);
  const shownBrowser = browser?.version === scope.version ? browser : undefined;
  const selected = currentState.registrations.find(item => item.id === shownBrowser?.id);
  const unavailable = selected && (selected.pendingUnregister ? 'This preview has been unregistered.'
    : selected.status !== 'active' ? `This preview is ${selected.status}. Open it again to register.`
    : selected.availability !== 'online' ? 'Controller offline. Close and reopen the preview after it reconnects.' : undefined);

  const refresh = useCallback(async () => {
    const request = ++scope.request;
    try {
      const snapshot = await client.snapshot(hostId);
      if (scopeRef.current === scope && scope.request === request) {
        setState({ version: scope.version, registrations: snapshot.registrations, loading: false });
      }
    } catch (cause) {
      if (scopeRef.current === scope && scope.request === request) {
        setState(current => ({
          version: scope.version,
          registrations: current.version === scope.version ? current.registrations : [],
          loading: false,
          error: message(cause, 'Preview state is unavailable. Retry after checking the Host connection.'),
        }));
      }
    }
  }, [client, hostId, scope]);

  useEffect(() => {
    setState({ version: scope.version, registrations: [], loading: true });
    void refresh();
    const timer = window.setInterval(() => void refresh(), 5_000);
    const visible = () => { if (document.visibilityState === 'visible') void refresh(); };
    document.addEventListener('visibilitychange', visible);
    return () => { window.clearInterval(timer); document.removeEventListener('visibilitychange', visible); };
  }, [refresh, scope.version]);

  const value = useMemo<PreviewContextValue>(() => ({
    registrations: currentState.registrations, canManage, loading: currentState.loading, error: currentState.error, refresh,
    register: async (agentId: string, request: PreviewRegistrationRequest) => {
      const registration = await client.register(agentId, request);
      await refresh();
      return registration;
    },
    unregister: async (id: string) => { await client.unregister(hostId, id); await refresh(); },
    open: async (id: string, target: string) => {
      openRequest.current?.abort();
      browserTrigger.current = document.activeElement instanceof HTMLElement ? document.activeElement : undefined;
      const request = new AbortController(); openRequest.current = request;
      setBrowser({ version: scope.version, id, target });
      const deadline = window.setTimeout(() => {
        if (!request.signal.aborted) {
          setBrowser({ version: scope.version, id, target, error: 'Preview access timed out. Close and open it again.' });
          request.abort();
        }
      }, 20_000);
      try {
        const entry = await client.open(hostId, id, target, request.signal);
        if (request.signal.aborted) return '';
        const url = await client.enter(entry, id, request.signal);
        if (!request.signal.aborted) setBrowser({ version: scope.version, id, target, url });
        return url;
      } catch (error) {
        if (!request.signal.aborted) setBrowser({ version: scope.version, id, target, error: message(error, 'Preview access is unavailable. Close and open it again.') });
        return '';
      } finally { window.clearTimeout(deadline); }
    },
  }), [canManage, client, currentState, hostId, refresh, scope]);

  return <Context.Provider value={value}>{children}{shownBrowser ? <PreviewBrowser key={`${scope.version}:${shownBrowser.id}`}
    url={shownBrowser.url} target={shownBrowser.target} error={unavailable ?? shownBrowser.error} returnFocus={browserTrigger.current} onClose={closeBrowser} /> : null}</Context.Provider>;
}

export function usePreviewController(): PreviewContextValue | undefined { return useContext(Context); }

function message(error: unknown, fallback: string): string { return error instanceof Error && error.message ? error.message : fallback; }
