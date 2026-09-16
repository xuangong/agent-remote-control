import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from 'react';

import type { HttpPreviewClient, PreviewRegistration, PreviewRegistrationRequest } from '../client/preview-client.js';
import type { PreviewController } from './PreviewActions.js';

export interface PreviewContextValue extends PreviewController {
  readonly loading: boolean;
  readonly error?: string;
  refresh(): Promise<void>;
}

const Context = createContext<PreviewContextValue | undefined>(undefined);

export function PreviewProvider({ client, hostId, canManage, children }: {
  readonly client: HttpPreviewClient; readonly hostId: string; readonly canManage: boolean; readonly children: ReactNode;
}) {
  const [registrations, setRegistrations] = useState<readonly PreviewRegistration[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string>();

  const refresh = useCallback(async () => {
    try {
      const snapshot = await client.snapshot(hostId);
      setRegistrations(snapshot.registrations);
      setError(undefined);
    } catch (cause) { setError(message(cause, 'Preview state is unavailable. Retry after checking the Host connection.')); }
    finally { setLoading(false); }
  }, [client, hostId]);

  useEffect(() => {
    setLoading(true); setRegistrations([]); setError(undefined);
    void refresh();
    const timer = window.setInterval(() => void refresh(), 5_000);
    const visible = () => { if (document.visibilityState === 'visible') void refresh(); };
    document.addEventListener('visibilitychange', visible);
    return () => { window.clearInterval(timer); document.removeEventListener('visibilitychange', visible); };
  }, [refresh]);

  const value = useMemo<PreviewContextValue>(() => ({
    registrations, canManage, loading, error, refresh,
    register: async (agentId: string, request: PreviewRegistrationRequest) => {
      const registration = await client.register(agentId, request);
      await refresh();
      return registration;
    },
    unregister: async (id: string) => { await client.unregister(hostId, id); await refresh(); },
    open: (id: string, target: string) => client.open(hostId, id, target),
  }), [canManage, client, error, hostId, loading, refresh, registrations]);

  return <Context.Provider value={value}>{children}</Context.Provider>;
}

export function usePreviewController(): PreviewContextValue | undefined { return useContext(Context); }

function message(error: unknown, fallback: string): string { return error instanceof Error && error.message ? error.message : fallback; }
