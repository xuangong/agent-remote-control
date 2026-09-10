import type { HostPairingService, PairingInvitation, RemoteHost } from './components/HostPairing.js';
export interface SessionSummary {
  nativeSessionId: string;
  providerId: string;
  title: string;
  workspace?: string;
  model?: string;
  createdAt: string;
  updatedAt: string;
  state: 'idle' | 'running' | 'waiting' | 'unavailable';
}
export interface SessionCatalogPage { items: SessionSummary[]; hasMore: boolean; nextCursor?: string; revision: string }
export interface SessionWorkspace { id: string; name: string; path: string }
export interface CreateSessionOptions { workspaceId?: string; cwd?: string; model?: string; reasoningEffort?: string; planning?: boolean }
export interface OpenedSession { hostId?: string; agentId: string; providerId: string; nativeSessionId: string; title: string; parentAgentId?: string; parentNativeSessionId?: string }
export class DirectoryError extends Error {
  constructor(message: string, readonly code?: string) { super(message); }
}
export class SessionDirectoryClient {
  readonly cachedPages = new Map<string, SessionCatalogPage>();
  constructor(private readonly baseUrl: string, private readonly fetcher: typeof fetch = globalThis.fetch.bind(globalThis), private readonly hostId = 'local') {}
  private async request<T>(path: string, body?: unknown): Promise<T> {
    const response = await this.fetcher(new URL(`v1/remote/${this.hostId === 'local' ? '' : `hosts/${encodeURIComponent(this.hostId)}/`}${path}`, this.baseUrl.endsWith('/') ? this.baseUrl : `${this.baseUrl}/`), body === undefined ? undefined : {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body),
    });
    const data = await response.json();
    if (!response.ok) throw new DirectoryError(data.error ?? data.message ?? 'Session service is unavailable.', data.code);
    return data as T;
  }
  list(providerId: string, cursor?: string): Promise<SessionCatalogPage> {
    const query = new URLSearchParams({ providerId, limit: '30' });
    if (cursor) query.set('cursor', cursor);
    return this.request(`catalog?${query}`);
  }
  revision(providerId: string): Promise<{ revision: string }> { return this.request(`catalog/revision?${new URLSearchParams({ providerId })}`); }
  workspaces(providerId: string): Promise<{ workspaces: SessionWorkspace[] }> { return this.request(`workspaces?${new URLSearchParams({ providerId })}`); }
  attach(providerId: string, nativeSessionId: string): Promise<{ agentId: string; nativeSessionId?: string }> { return this.request('attach', { providerId, nativeSessionId }); }
  attachChild(providerId: string, parentNativeSessionId: string, nativeSessionId: string): Promise<{ agentId: string; nativeSessionId: string }> { return this.request('child/attach', { providerId, parentNativeSessionId, nativeSessionId }); }
  create(providerId: string, requestId: string, options: CreateSessionOptions): Promise<{ agentId: string; nativeSessionId?: string }> { return this.request('create', { providerId, requestId, ...options }); }
}

export class RemoteHostClient implements HostPairingService {
  invitation?: PairingInvitation;
  constructor(private readonly baseUrl: string) {}
  private async request<T>(path: string, method = 'GET'): Promise<T> {
    const response = await fetch(new URL(`v1/remote/${path}`, this.baseUrl.endsWith('/') ? this.baseUrl : `${this.baseUrl}/`), { method, ...(method === 'POST' ? { headers: { 'content-type': 'application/json' }, body: '{}' } : {}) });
    const body = await response.json();
    if (!response.ok) throw new Error(body.error ?? 'Remote Host service is unavailable.');
    return body as T;
  }
  async hosts(): Promise<{ hosts: RemoteHost[] }> {
    const result = await this.request<{ hosts: RemoteHost[] }>('hosts');
    return { hosts: [{ id: 'local', name: 'Local runtime', online: true }, ...result.hosts] };
  }
  pair(): Promise<PairingInvitation> { return this.request('pairings', 'POST'); }
}
