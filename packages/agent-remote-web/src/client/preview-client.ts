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

export class PreviewRequestError extends Error {
  constructor(readonly status: number, message: string) { super(message); this.name = 'PreviewRequestError'; }
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

  async renew(hostId: string, id: string, target: string, signal?: AbortSignal): Promise<PreviewRegistration> {
    const { registration } = await this.request<{ registration: PreviewRegistration }>(`v1/remote/hosts/${encodeURIComponent(hostId)}/previews/${encodeURIComponent(id)}/renew`, {
      method: 'POST', body: '{}', headers: { 'content-type': 'application/json' }, signal,
    });
    const origin = new URL(this.baseUrl, globalThis.location?.origin ?? 'http://localhost').origin;
    const response = await this.fetcher(`${origin}/p/${encodeURIComponent(id)}/_arc/renew`, {
      method: 'POST', credentials: 'same-origin', cache: 'no-store', headers: { 'content-type': 'application/json' }, body: '{}', signal,
    });
    if (response.status === 401) {
      // A suspended browser can lose its cookie; redeem fresh access without navigating the retained iframe.
      await this.enter(await this.open(hostId, id, target, signal), id, signal);
    } else if (!response.ok) throw new Error('Preview access could not be renewed. Retrying when the connection is available.');
    return registration;
  }

  async open(hostId: string, id: string, originalLoopbackUrl: string, signal?: AbortSignal): Promise<string> {
    const value = await this.request<{ entryUrl: string }>(`v1/remote/hosts/${encodeURIComponent(hostId)}/previews/${encodeURIComponent(id)}/open`, {
      method: 'POST', body: JSON.stringify({ url: originalLoopbackUrl }), headers: { 'content-type': 'application/json' }, signal,
    });
    return value.entryUrl;
  }

  async enter(entryUrl: string, id: string, signal?: AbortSignal): Promise<string> {
    const entry = new URL(entryUrl);
    const origin = new URL(this.baseUrl, globalThis.location?.origin ?? 'http://localhost').origin;
    if (entry.origin !== origin) throw new Error('Embedded previews require the same Relay origin.');
    if (entry.pathname !== '/_arc/enter' || !entry.hash) throw new Error('The preview entry is invalid. Open it again.');
    const response = await this.fetcher(origin + '/_arc/enter', {
      method: 'POST', credentials: 'same-origin', cache: 'no-store', signal,
      headers: { 'content-type': 'application/json' }, body: JSON.stringify({ code: entry.hash.slice(1) }),
    });
    const value = await response.json().catch(() => undefined) as { url?: string } | undefined;
    if (!response.ok || !value?.url) throw new Error('Preview access expired or is unavailable. Open it again from the Controller.');
    const destination = new URL(value.url, origin);
    if (destination.origin !== origin || !destination.pathname.startsWith(`/p/${id}/`)) throw new Error('The preview destination is invalid.');
    return destination.href;
  }

  private async request<T>(path: string, init: RequestInit): Promise<T> {
    const base = this.baseUrl.endsWith('/') ? this.baseUrl : `${this.baseUrl}/`;
    const response = await this.fetcher(new URL(path, new URL(base, globalThis.location?.origin ?? 'http://localhost')).toString(), {
      credentials: 'same-origin', cache: 'no-store', ...init,
    });
    const value = await response.json().catch(() => undefined) as { error?: string } | undefined;
    if (!response.ok) throw new PreviewRequestError(response.status, value?.error || `Preview request failed (${response.status}). Check that preview tunneling is enabled for this Host.`);
    if (!value) throw new Error('The preview service returned an invalid response. Retry after checking the Controller connection.');
    return value as T;
  }
}
