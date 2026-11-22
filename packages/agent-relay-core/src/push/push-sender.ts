/**
 * The Relay's push sender: one push to one subscription through its browser's push service (RFC 8030), which is the sender's port.
 *
 * Contract. `deliver(target, message)` sends the encrypted payload with the VAPID authorization, `TTL`, `Urgency` and, when the message
 * has one, `Topic`, which lets the push service replace a push it still holds for the browser with a newer one of the same topic. It
 * resolves with what became of the push, and never rejects:
 * - `sent`: the service accepted it (2xx);
 * - `gone`: the subscription ended (404 or 410); the sender has told `forget`, so nothing is sent to it again;
 * - `refused`: the service refused this push for good (another 4xx, such as a token it does not accept);
 * - `too_large`: the payload does not fit one record, and nothing was sent;
 * - `failed`: the service was unreachable or busy (429 or 5xx) twice: the sender waited once, as long as `Retry-After` asked, at most
 *   `RETRY_LIMIT_MS`, and tried again;
 * - `blocked`: the endpoint is not one of the push services the Relay sends to (`endpoints`), and nothing was sent.
 * The token for one push service is signed once and reused until an hour before it expires. Web Crypto only: it runs on Workers.
 */
import { encryptPush, importVapidKeys, PUSH_PLAINTEXT_LIMIT, vapidAuthorization, type PushTarget, type VapidKeys } from './web-push.js';

export type PushUrgency = 'very-low' | 'low' | 'normal' | 'high';
export interface PushMessage {
  /** The plaintext the browser's service worker reads. */
  readonly payload: string;
  /** Up to 32 base64url characters; a newer push of the same topic replaces the one the service holds. */
  readonly topic?: string;
  /** How long the service holds the push for a browser that is offline, in seconds. */
  readonly ttlSeconds: number;
  readonly urgency: PushUrgency;
}
export type PushOutcome =
  | { readonly status: 'sent' }
  | { readonly status: 'gone'; readonly code: 404 | 410 }
  | { readonly status: 'refused'; readonly code: number }
  | { readonly status: 'too_large' }
  | { readonly status: 'failed'; readonly code?: number }
  | { readonly status: 'blocked' };

/** The longest the sender waits before its one retry; a push service that asks for longer is given up on. */
export const RETRY_LIMIT_MS = 5 * 60_000;
const DEFAULT_RETRY_MS = 30_000;

export interface PushSenderOptions {
  readonly vapid: VapidKeys & { readonly subject: string };
  /** The push service port: one HTTP request out, its response back (`fetch` in production). */
  post(request: Request): Promise<Response>;
  readonly now: () => number;
  /** Waits before the retry; real timers by default. */
  wait?(ms: number): Promise<void>;
  /** Told the endpoint of a subscription that ended (404 or 410). */
  forget?(endpoint: string): void | Promise<void>;
  /** The push services the Relay sends to; the browsers' own (`isBrowserPushService`) by default. */
  endpoints?(url: URL): boolean;
}

const PUSH_HOSTS = ['fcm.googleapis.com', 'android.googleapis.com', 'updates.push.services.mozilla.com', 'web.push.apple.com'];
const PUSH_HOST_SUFFIXES = ['.push.apple.com', '.push.services.mozilla.com', '.notify.windows.com'];
/** The push services of the browsers Orchard supports: Google's (Chrome, Edge on Android), Mozilla's, Apple's and Microsoft's, over HTTPS. */
export function isBrowserPushService(url: URL): boolean {
  return url.protocol === 'https:' && !url.port && (PUSH_HOSTS.includes(url.hostname) || PUSH_HOST_SUFFIXES.some(suffix => url.hostname.endsWith(suffix)));
}

/** How long a 429 or 503 asks to wait: `Retry-After` in seconds or as a date, otherwise a default. */
export function retryAfterMs(header: string | null, nowMs: number): number {
  if (header === null) return DEFAULT_RETRY_MS;
  if (/^\d+$/.test(header.trim())) return Number(header.trim()) * 1000;
  const at = Date.parse(header);
  return Number.isNaN(at) ? DEFAULT_RETRY_MS : Math.max(0, at - nowMs);
}

export type PushSender = ReturnType<typeof createPushSender>;

export function createPushSender(options: PushSenderOptions) {
  const signing = importVapidKeys(options.vapid);
  // A key pair that fails to import is a configuration error: every push is refused rather than the Relay failing.
  signing.catch(() => undefined);
  const tokens = new Map<string, { header: string; expiresAt: number }>();
  const allowed = options.endpoints ?? isBrowserPushService;
  const wait = options.wait ?? (ms => new Promise<void>(resolve => setTimeout(resolve, ms)));

  async function authorization(endpoint: string): Promise<string> {
    const audience = new URL(endpoint).origin, now = options.now();
    const cached = tokens.get(audience);
    if (cached && cached.expiresAt - now > 60 * 60_000) return cached.header;
    const token = await vapidAuthorization(await signing, { publicKey: options.vapid.publicKey, subject: options.vapid.subject }, endpoint, now);
    tokens.set(audience, token);
    return token.header;
  }

  async function attempt(target: PushTarget, message: PushMessage, body: Uint8Array): Promise<Response | undefined> {
    try {
      return await options.post(new Request(target.endpoint, { method: 'POST', body: body.slice().buffer, headers: {
        authorization: await authorization(target.endpoint), 'content-encoding': 'aes128gcm', 'content-type': 'application/octet-stream',
        ttl: String(Math.max(0, Math.floor(message.ttlSeconds))), urgency: message.urgency, ...(message.topic ? { topic: message.topic } : {}),
      } }));
    } catch { return undefined; }
  }

  return {
    /** The public key browsers subscribe with (`applicationServerKey`). */
    publicKey: options.vapid.publicKey,
    /** Whether the Relay may send to this endpoint at all; a subscription to anything else is refused when it is made. */
    accepts(endpoint: string): boolean {
      try { return allowed(new URL(endpoint)); } catch { return false; }
    },
    async deliver(target: PushTarget, message: PushMessage): Promise<PushOutcome> {
      if (!this.accepts(target.endpoint)) return { status: 'blocked' };
      const plaintext = new TextEncoder().encode(message.payload);
      if (plaintext.length > PUSH_PLAINTEXT_LIMIT) return { status: 'too_large' };
      let body: Uint8Array;
      try { body = await encryptPush(plaintext, target); await signing; }
      catch { return { status: 'refused', code: 0 }; }
      for (let tries = 1; ; tries += 1) {
        const response = await attempt(target, message, body);
        const code = response?.status;
        await response?.body?.cancel().catch(() => undefined);
        if (code !== undefined && code >= 200 && code < 300) return { status: 'sent' };
        if (code === 404 || code === 410) { await Promise.resolve(options.forget?.(target.endpoint)).catch(() => undefined); return { status: 'gone', code }; }
        if (code === 413) return { status: 'too_large' };
        if (code !== undefined && code < 500 && code !== 429) return { status: 'refused', code };
        const delay = retryAfterMs(response?.headers.get('retry-after') ?? null, options.now());
        if (tries >= 2 || delay > RETRY_LIMIT_MS) return code === undefined ? { status: 'failed' } : { status: 'failed', code };
        await wait(delay);
      }
    },
  };
}
