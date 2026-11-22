/**
 * This device's push subscription at the Relay (`/v1/push-subscriptions`, I5c): whether the Relay sends pushes (its VAPID public key),
 * what it keeps of this device, and keeping or forgetting this device's subscription. The fetch is a port, as for every Relay client.
 */
import { isPushDevice, type PushDevice, type PushSubscriptionRequest } from '@orchardworks/agent-remote-protocol';

export class PushRequestError extends Error {
  constructor(readonly status: number, readonly code: string | undefined, message: string) { super(message); this.name = 'PushRequestError'; }
}

export class HttpPushClient {
  constructor(private readonly baseUrl: string, private readonly fetcher: typeof fetch = globalThis.fetch.bind(globalThis)) {}

  /** What the Relay says of push and of this device. */
  device(signal?: AbortSignal): Promise<PushDevice> { return this.request('GET', undefined, signal); }
  /** Keeps this device's subscription, its language and its switch. */
  subscribe(request: PushSubscriptionRequest): Promise<PushDevice> { return this.request('POST', request); }
  /** Forgets this device's subscription. */
  unsubscribe(): Promise<PushDevice> { return this.request('DELETE', {}); }

  private async request(method: string, body?: unknown, signal?: AbortSignal): Promise<PushDevice> {
    const response = await this.fetcher(new URL('v1/push-subscriptions', this.baseUrl).href, { method, credentials: 'same-origin', ...(signal ? { signal } : {}),
      ...(body === undefined ? {} : { headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }) });
    const value: unknown = await response.json().catch(() => undefined);
    if (!response.ok) {
      const error = value as { code?: unknown; error?: unknown } | undefined;
      throw new PushRequestError(response.status, typeof error?.code === 'string' ? error.code : undefined, typeof error?.error === 'string' ? error.error : `Push subscriptions answered ${response.status}.`);
    }
    if (!isPushDevice(value)) throw new PushRequestError(response.status, 'invalid_response', 'Push subscriptions answered something unexpected.');
    return value;
  }
}
