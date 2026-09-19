import type { HostPairingService, PairingInvitation, RemoteHost, HostStopResult } from './components/HostPairing.js';
export interface SessionSummary {
  nativeSessionId: string;
  providerId: string;
  title: string;
  workspace?: string;
  model?: string;
  createdAt: string;
  updatedAt: string;
  state: 'idle' | 'running' | 'waiting' | 'unknown' | 'unavailable';
}
export interface SessionCatalogPage { items: SessionSummary[]; hasMore: boolean; nextCursor?: string; revision: string }
export interface SessionWorkspace { id: string; name: string; path: string }
export interface WorkspaceFolderPage { path: string; parentPath: string | null; roots: string[]; folders: Array<{ name: string; path: string }>; nextOffset: number | null }
export interface CreateSessionOptions { workspaceId?: string; cwd?: string; model?: string; reasoningEffort?: string; planning?: boolean }
export interface OpenedSession { hostId?: string; agentId: string; providerId: string; nativeSessionId: string; title: string; parentAgentId?: string; parentNativeSessionId?: string; createdAt?: string }
export class DirectoryError extends Error {
  constructor(message: string, readonly code?: string, readonly status?: number, readonly requestId?: string) { super(message); }
}
export class SessionDirectoryClient {
  readonly cachedPages = new Map<string, SessionCatalogPage>();
  constructor(private readonly baseUrl: string, private readonly fetcher: typeof fetch = globalThis.fetch.bind(globalThis), private readonly hostId = 'local') {}
  private async request<T>(path: string, body?: unknown, signal?: AbortSignal): Promise<T> {
    const response = await this.fetcher(new URL(`v1/remote/${this.hostId === 'local' ? '' : `hosts/${encodeURIComponent(this.hostId)}/`}${path}`, this.baseUrl.endsWith('/') ? this.baseUrl : `${this.baseUrl}/`), body === undefined ? { signal } : {
      signal,
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body),
    });
    const data = await response.json();
    if (!response.ok) throw new DirectoryError(data.error ?? data.message ?? 'Session service is unavailable.', data.code, response.status, typeof data.requestId === 'string' ? data.requestId : undefined);
    return data as T;
  }
  list(providerId: string, cursor?: string): Promise<SessionCatalogPage> {
    const query = new URLSearchParams({ providerId, limit: '30' });
    if (cursor) query.set('cursor', cursor);
    return this.request(`catalog?${query}`);
  }
  revision(providerId: string): Promise<{ revision: string }> { return this.request(`catalog/revision?${new URLSearchParams({ providerId })}`); }
  workspaces(providerId: string): Promise<{ workspaces: SessionWorkspace[] }> { return this.request(`workspaces?${new URLSearchParams({ providerId })}`); }
  folders(providerId: string, options: { path?: string; offset?: number; search?: string; hidden?: boolean } = {}, signal?: AbortSignal): Promise<WorkspaceFolderPage> {
    const query = new URLSearchParams({ providerId });
    if (options.path) query.set('path', options.path);
    if (options.offset) query.set('offset', String(options.offset));
    if (options.search) query.set('search', options.search);
    if (options.hidden) query.set('hidden', '1');
    return this.request(`workspace-folders?${query}`, undefined, signal);
  }
  attach(providerId: string, nativeSessionId: string, signal?: AbortSignal): Promise<{ agentId: string; nativeSessionId?: string }> { return this.request('attach', { providerId, nativeSessionId }, signal); }
  createFolder(providerId: string, parentPath: string, name: string, signal?: AbortSignal): Promise<{ path: string }> {
    return this.request('workspace-folders/create', { providerId, parentPath, name }, signal);
  }
  attachChild(providerId: string, parentNativeSessionId: string, nativeSessionId: string, signal?: AbortSignal): Promise<{ agentId: string; nativeSessionId: string }> { return this.request('child/attach', { providerId, parentNativeSessionId, nativeSessionId }, signal); }
  create(providerId: string, operationId: string, options: CreateSessionOptions): Promise<{ agentId: string; nativeSessionId?: string }> { return this.request('create', { providerId, operationId, ...options }); }
}

export class RemoteHostClient implements HostPairingService {
  invitation?: PairingInvitation;
  constructor(private readonly baseUrl: string) {}
  private async request<T>(path: string, method = 'GET', requestBody?: unknown): Promise<T> {
    const response = await fetch(new URL(`v1/remote/${path}`, this.baseUrl.endsWith('/') ? this.baseUrl : `${this.baseUrl}/`), { method,
      ...(method === 'POST' ? { headers: { 'content-type': 'application/json' }, body: JSON.stringify(requestBody ?? {}) } : {}) });
    const body = await response.json();
    if (!response.ok) throw new DirectoryError(body.code === 'reauthentication_required' ? 'A recent gateway sign-in is required.' : body.error ?? 'Remote Host service is unavailable.', body.code, response.status, typeof body.requestId === 'string' ? body.requestId : undefined);
    return body as T;
  }
  async hosts(): Promise<{ hosts: RemoteHost[] }> {
    return this.request<{ hosts: RemoteHost[] }>('hosts');
  }
  pair(): Promise<PairingInvitation> { return this.request('pairings', 'POST'); }
  async rotate(hostId: string): Promise<{ ok: true; status: 'pending' | 'rotated' }> {
    const value = await this.request<{ ok?: boolean; status?: string }>(`hosts/${encodeURIComponent(hostId)}/rotate`, 'POST');
    if (value.ok !== true || !['pending', 'rotated'].includes(value.status ?? '')) throw new Error('The rotation result could not be confirmed. Refresh before trying again.');
    return value as { ok: true; status: 'pending' | 'rotated' };
  }
  async stop(hostId: string, operationId = crypto.randomUUID()): Promise<{ results: HostStopResult[] }> {
    const value = await this.request<{ results?: HostStopResult[] }>(`hosts/${encodeURIComponent(hostId)}/stop`, 'POST', { operationId });
    if (!Array.isArray(value.results) || !value.results.every(result => result && typeof result.agentId === 'string' && ['cancelled', 'unsupported', 'failed'].includes(result.status) && (result.message === undefined || typeof result.message === 'string'))) throw new Error('The stop results could not be confirmed. Work may still be running.');
    return { results: value.results };
  }
  async revoke(hostId: string): Promise<void> { await this.request(`hosts/${encodeURIComponent(hostId)}/revoke`, 'POST'); }
}
