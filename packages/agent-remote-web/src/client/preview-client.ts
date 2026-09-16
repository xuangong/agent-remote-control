import type { PreviewRegistrationSnapshot } from '@agent-remote-controller/agent-remote-protocol';

type ProtocolPreviewRegistration = PreviewRegistrationSnapshot['registrations'][number];
export type PreviewPathMode = ProtocolPreviewRegistration['pathMode'];
export type PreviewLifecycle = ProtocolPreviewRegistration['status'];
export type PreviewSource = ProtocolPreviewRegistration['sources'][number];
export type PreviewAvailability = 'online' | 'controller_offline';

export type PreviewRegistration = Readonly<Omit<ProtocolPreviewRegistration, 'sources'>> & {
  readonly sources: readonly PreviewSource[];
  readonly availability: PreviewAvailability;
  readonly pendingUnregister?: boolean;
};
export type PreviewSnapshot = Readonly<Omit<PreviewRegistrationSnapshot, 'registrations'>> & {
  readonly registrations: readonly PreviewRegistration[];
};
export interface PreviewRegistrationRequest {
  readonly target: string;
  readonly itemId: string;
  readonly pathMode?: PreviewPathMode;
}

export class HttpPreviewClient {
  constructor(private readonly baseUrl: string, private readonly fetcher: typeof fetch = globalThis.fetch.bind(globalThis)) {}

  async register(agentId: string, request: PreviewRegistrationRequest): Promise<PreviewRegistration> {
    const value = await this.request<{ registration: PreviewRegistration }>(`v1/sessions/${encodeURIComponent(agentId)}/previews`, {
      method: 'POST', body: JSON.stringify(request), headers: { 'content-type': 'application/json' },
    });
    return value.registration;
  }

  snapshot(hostId: string, signal?: AbortSignal): Promise<PreviewSnapshot> {
    return this.request(`v1/remote/hosts/${encodeURIComponent(hostId)}/previews`, { signal });
  }

  async unregister(hostId: string, id: string): Promise<PreviewRegistration | undefined> {
    const value = await this.request<{ registration?: PreviewRegistration }>(`v1/remote/hosts/${encodeURIComponent(hostId)}/previews/${encodeURIComponent(id)}/unregister`, {
      method: 'POST', body: '{}', headers: { 'content-type': 'application/json' },
    });
    return value.registration;
  }

  async open(hostId: string, id: string, originalLoopbackUrl: string): Promise<string> {
    const value = await this.request<{ entryUrl: string }>(`v1/remote/hosts/${encodeURIComponent(hostId)}/previews/${encodeURIComponent(id)}/open`, {
      method: 'POST', body: JSON.stringify({ url: originalLoopbackUrl }), headers: { 'content-type': 'application/json' },
    });
    return value.entryUrl;
  }

  private async request<T>(path: string, init: RequestInit): Promise<T> {
    const base = this.baseUrl.endsWith('/') ? this.baseUrl : `${this.baseUrl}/`;
    const response = await this.fetcher(new URL(path, new URL(base, globalThis.location?.origin ?? 'http://localhost')).toString(), {
      credentials: 'same-origin', cache: 'no-store', ...init,
    });
    const value = await response.json().catch(() => undefined) as { error?: string } | undefined;
    if (!response.ok) throw new Error(value?.error || `Preview request failed (${response.status}). Check that preview tunneling is enabled for this Host.`);
    if (!value) throw new Error('The preview service returned an invalid response. Retry after checking the Controller connection.');
    return value as T;
  }
}
