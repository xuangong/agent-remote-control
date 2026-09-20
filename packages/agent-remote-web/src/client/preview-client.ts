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
  readonly tunnelOrigin?: string;
  readonly tunnelNamePinned?: boolean;
};
export type PreviewSnapshot = Readonly<Omit<PreviewRegistrationSnapshot, 'registrations'>> & {
  readonly registrations: readonly PreviewRegistration[];
  readonly routing?: 'subdomain' | 'path';
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
  private readonly entryOrigins = new Map<string, string>();
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

  async pinName(hostId: string, id: string, pinned: boolean): Promise<void> {
    await this.request(`v1/remote/hosts/${encodeURIComponent(hostId)}/previews/${encodeURIComponent(id)}/pin`, {
      method: 'POST', body: JSON.stringify({ pinned }), headers: { 'content-type': 'application/json' }, signal: AbortSignal.timeout(20_000),
    });
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
    const destination = this.entryOrigins.get(id);
    const isolated = destination && destination !== origin;
    const response = await this.fetcher(isolated ? `${destination}/_arc/renew` : `${origin}/p/${encodeURIComponent(id)}/_arc/renew`, {
      method: 'POST', credentials: isolated ? 'include' : 'same-origin', cache: 'no-store', headers: { 'content-type': 'application/json' }, body: '{}', signal,
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
    this.entryOrigins.set(id, new URL(value.entryUrl).origin);
    return value.entryUrl;
  }

  async tunnelUrl(hostId: string, id: string, originalLoopbackUrl: string, signal?: AbortSignal): Promise<string> {
    const value = await this.request<{ tunnelUrl: string }>(`v1/remote/hosts/${encodeURIComponent(hostId)}/previews/${encodeURIComponent(id)}/open`, {
      method: 'POST', body: JSON.stringify({ url: originalLoopbackUrl, mode: 'link' }), headers: { 'content-type': 'application/json' }, signal,
    });
    return value.tunnelUrl;
  }

  async enter(entryUrl: string, id: string, signal?: AbortSignal): Promise<string> {
    const entry = new URL(entryUrl);
    const origin = new URL(this.baseUrl, globalThis.location?.origin ?? 'http://localhost').origin;
    if (entry.origin !== origin) {
      if (this.entryOrigins.get(id) !== entry.origin || entry.pathname !== '/_arc/start') throw new Error('Embedded previews require the same Relay origin or an authorized tunnel origin.');
      const post = async (url: string, body: unknown, credentials: RequestCredentials) => {
        const response = await this.fetcher(url, { method: 'POST', credentials, cache: 'no-store', signal,
          headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
        if (!response.ok) throw new Error('Preview access expired or is unavailable. Open it again from the Controller.');
        return await response.json() as { challenge?: string; code?: string; url?: string };
      };
      const challenge = await post(entry.origin + '/_arc/challenge', { path: entry.searchParams.get('path') ?? '/' }, 'include');
      if (!challenge.challenge) throw new Error('The preview challenge is invalid.');
      const proof = await post(origin + '/_arc/preview-authorize', { challenge: challenge.challenge }, 'same-origin');
      if (!proof.code) throw new Error('The preview authorization is invalid.');
      const redeemed = await post(entry.origin + '/_arc/enter', { code: proof.code }, 'include');
      const destination = redeemed.url && new URL(redeemed.url, entry.origin);
      if (!destination || destination.origin !== entry.origin || destination.pathname.startsWith('/_arc/')) throw new Error('The preview destination is invalid.');
      return destination.href;
    }
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
