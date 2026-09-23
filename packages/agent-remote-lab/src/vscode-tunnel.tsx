import { workspaceFetch } from './workspace-access.js';
import { watchPagePolling } from '@orchardworks/agent-remote-web';
import { createContext, useCallback, useContext, useEffect, useRef, useState, type ReactNode } from 'react';
import { parseVscodeTunnelSnapshot, type VscodeTunnelSnapshot } from '@orchardworks/agent-remote-protocol';
import type { RemoteHost } from './components/HostPairing.js';
import { DirectoryError } from './directory-client.js';

export interface VscodeTunnelService {
  status(hostId: string): Promise<VscodeTunnelSnapshot>;
  start(hostId: string): Promise<VscodeTunnelSnapshot>;
  stop(hostId: string): Promise<VscodeTunnelSnapshot>;
}
export class HttpVscodeTunnelClient implements VscodeTunnelService {
  constructor(private readonly baseUrl: string, private readonly fetcher: typeof fetch = workspaceFetch) {}
  private async request(hostId: string, action?: 'start' | 'stop') {
    const url = new URL(`v1/remote/hosts/${encodeURIComponent(hostId)}/vscode-tunnel${action ? `/${action}` : ''}`, this.baseUrl.endsWith('/') ? this.baseUrl : `${this.baseUrl}/`);
    const response = await this.fetcher(url, { cache: 'no-store', signal: AbortSignal.timeout(12_000), ...(action ? {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(action === 'start' ? { acceptLicense: true } : {}),
    } : {}) });
    const body = await response.json();
    if (!response.ok) throw new DirectoryError(response.status === 404 ? 'This Host does not support VS Code tunnels. Update its Controller.' : body.error ?? 'VS Code tunnel is unavailable.', body.code);
    return parseVscodeTunnelSnapshot(body);
  }
  status(hostId: string) { return this.request(hostId); }
  start(hostId: string) { return this.request(hostId, 'start'); }
  stop(hostId: string) { return this.request(hostId, 'stop'); }
}

interface TunnelContext {
  host: RemoteHost;
  state?: VscodeTunnelSnapshot;
  error?: string;
  errorCode?: string;
  busy: boolean;
  refresh(): Promise<void>;
  start(): Promise<void>;
  stop(): Promise<void>;
}
const Context = createContext<TunnelContext | undefined>(undefined);
export const useVscodeTunnel = () => useContext(Context);

const unavailableHost: RemoteHost = { id: 'local', name: '', online: false };
export function VscodeTunnelScope({ host, service, polling = true, children }: { host?: RemoteHost; service: VscodeTunnelService; polling?: boolean; children: ReactNode }) {
  const available = host && host.id !== 'local' && host.access !== 'shared';
  return <HostTunnelState host={available ? host : unavailableHost} service={service} polling={polling}>{children}</HostTunnelState>;
}

function HostTunnelState({ host, service, polling, children }: { host: RemoteHost; service: VscodeTunnelService; polling: boolean; children: ReactNode }) {
  const [state, setState] = useState<VscodeTunnelSnapshot>();
  const [error, setError] = useState<string>();
  const [errorCode, setErrorCode] = useState<string>();
  const [busy, setBusy] = useState(false);
  const pending = useRef<'status' | 'mutation'>();
  const sequence = useRef(0);
  const mounted = useRef(true);
  useEffect(() => {
    mounted.current = true; pending.current = undefined; setBusy(false);
    setState(undefined); setError(undefined); setErrorCode(undefined);
    return () => { mounted.current = false; sequence.current += 1; };
  }, [host.id, host.online, service]);
  const request = useCallback(async (action: 'status' | 'start' | 'stop') => {
    if (!host.online || pending.current === 'mutation' || (action === 'status' && pending.current)) return;
    pending.current = action === 'status' ? 'status' : 'mutation';
    const current = ++sequence.current;
    if (action !== 'status') setBusy(true);
    try {
      const result = await service[action](host.id);
      if (mounted.current && sequence.current === current) { setState(previous => JSON.stringify(previous) === JSON.stringify(result) ? previous : result); setError(undefined); setErrorCode(undefined); }
    } catch (failure) {
      if (mounted.current && sequence.current === current) {
        setError(failure instanceof Error ? failure.message : 'Could not read VS Code tunnel status.');
        setErrorCode(failure instanceof DirectoryError ? failure.code : undefined);
      }
    } finally {
      if (mounted.current && sequence.current === current) { pending.current = undefined; setBusy(false); }
    }
  }, [host.id, host.online, service]);
  const refresh = useCallback(() => request('status'), [request]);
  useEffect(() => host.online ? watchPagePolling(refresh, polling ? 2_000 : 30_000) : undefined, [refresh, polling, host.online]);

  return <Context.Provider value={host.id === 'local' ? undefined : { host, state, error, errorCode, busy, refresh,
    start: () => request('start'), stop: () => request('stop') }}>{children}</Context.Provider>;
}
