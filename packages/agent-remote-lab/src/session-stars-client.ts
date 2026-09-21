import { validSessionStar, type SessionStar, type StarIdentity, type VisibleSessionStar } from '@orchardworks/agent-remote-hosted/session-stars';
export type { SessionStar, StarIdentity, VisibleSessionStar };
export type StarInput = Omit<SessionStar, 'starredAt'>;
export class SessionStarsClient {
  constructor(private readonly baseUrl: string, private readonly fetcher: typeof fetch = globalThis.fetch.bind(globalThis)) {}
  private async request(method: string, body?: StarInput | StarIdentity, signal?: AbortSignal): Promise<VisibleSessionStar[]> {
    const response = await this.fetcher(new URL('v1/stars', this.baseUrl), { method, credentials: 'same-origin', cache: 'no-store',
      signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(12000)]) : AbortSignal.timeout(12000),
      ...(body ? { headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) } : {}) });
    const value = await response.json();
    if (!response.ok) throw new Error(typeof value?.error === 'string' ? value.error : 'Favorites could not be updated. Try again.');
    if (!Array.isArray(value?.stars) || !value.stars.every((item: unknown) => validSessionStar(item) && 'available' in item && typeof item.available === 'boolean' && 'online' in item && typeof item.online === 'boolean')) throw new Error('The favorites response is invalid.');
    return value.stars;
  }
  list(signal?: AbortSignal) { return this.request('GET', undefined, signal); }
  save(item: StarInput, signal?: AbortSignal) { return this.request('POST', item, signal); }
  remove(item: StarIdentity, signal?: AbortSignal) { return this.request('DELETE', { hostId: item.hostId, providerId: item.providerId, nativeSessionId: item.nativeSessionId }, signal); }
}
