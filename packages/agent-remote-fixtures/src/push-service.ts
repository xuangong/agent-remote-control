/**
 * A push service simulator: a fake Web Push service (RFC 8030) for the Relay's push sender, at a port (`startPushService`) or in
 * memory (`createPushService`, whose `fetch` is the port). It stands for the browsers' push services (Apple's, Google's, Mozilla's),
 * the external dependency behind Web Push, and models what they do, as data (`PUSH_SERVICE_MODELLED`):
 * - **accept**: a valid push gets 201 with a `Location`, after the checks a real service makes: `TTL` present, `Urgency` and `Topic`
 *   well formed, the body `aes128gcm` (RFC 8188), and a VAPID authorization (RFC 8292) whose ES256 token is signed by the key it names,
 *   for this service's origin, not expired and not valid for more than 24 hours, with a `mailto:` or `https:` subject, and whose key is
 *   the one the subscription was made with (401 without one, 403 otherwise);
 * - **an expired subscription**: `expire(endpoint, 404 | 410)` answers every later push to it with that status, as a service does once a
 *   browser revoked the subscription; a path it never issued is 404;
 * - **rate limiting**: `rateLimit({ retryAfterSeconds, count })` answers the next pushes with 429 and `Retry-After`;
 * - **payload size**: a body over `maxPayloadBytes` (4096, the size every service accepts at least) is refused with 413;
 * - **delivery to the browser**: the service holds what it accepted for a browser that is offline (`setOnline`), a newer push with the
 *   same `Topic` replaces the one held (RFC 8030 section 5.4), and a push held longer than its `TTL` is dropped; `drop(count)` loses the
 *   next accepted pushes and `reorder()` delivers the held pushes in reverse order, as a service promises no order.
 * It also plays the browser: `subscribe()` makes the subscription's keys (an ECDH P-256 pair and an auth secret), so `delivered()` gives
 * each push the browser received, decrypted (RFC 8291). Web Crypto only; the clock is a port.
 */
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import type { webcrypto } from 'node:crypto';

type CryptoKey = webcrypto.CryptoKey;
type CryptoKeyPair = webcrypto.CryptoKeyPair;

export const PUSH_SERVICE_MODELLED = ['accept', 'vapid-check', 'expired-subscription', 'rate-limit', 'payload-limit', 'topic-replacement', 'ttl-expiry', 'drop', 'reorder', 'offline-browser'] as const;

/** The largest body every push service accepts (RFC 8030 section 7.2), and the default limit here. */
export const PUSH_PAYLOAD_LIMIT = 4096;
/** The longest a VAPID token may be valid (RFC 8292 section 2). */
const VAPID_LIFETIME_SECONDS = 24 * 60 * 60;
const URGENCIES = ['very-low', 'low', 'normal', 'high'] as const;

/** A subscription as a browser hands it to a page (`PushSubscription.toJSON()`), with the browser's private key for decryption. */
export interface SimulatedSubscription {
  readonly endpoint: string;
  readonly keys: { readonly p256dh: string; readonly auth: string };
}

/** What the service checked of one push it received, and what it answered. */
export interface ReceivedPush {
  readonly endpoint: string;
  readonly status: number;
  /** Why a push was refused, in the words a log would use. */
  readonly refusal?: string;
  readonly headers: { readonly ttl?: string; readonly urgency?: string; readonly topic?: string; readonly contentEncoding?: string; readonly authorization?: string };
  /** The VAPID token's claims and key, when the authorization could be read. */
  readonly vapid?: { readonly publicKey: string; readonly claims: { readonly aud?: unknown; readonly exp?: unknown; readonly sub?: unknown } };
  readonly bodyBytes: number;
}

/** A push the browser received: its plaintext, decrypted with the subscription's keys, or undefined when it could not be. */
export interface DeliveredPush {
  readonly endpoint: string;
  readonly topic?: string;
  readonly urgency: string;
  readonly payload?: string;
}

export interface PushServiceOptions {
  /** The service's origin, which a VAPID token's `aud` must name. The port mode sets it to the address it listens on. */
  readonly origin?: string;
  readonly maxPayloadBytes?: number;
  /** The service's clock, in milliseconds: token expiry and how long a push is held. */
  readonly now?: () => number;
}

export interface PushService {
  readonly origin: string;
  /**
   * A new subscription of one browser; `applicationServerKey` (base64url) is the key every push to it must be signed with. `browser`
   * gives the browser known keys (base64url), for a vector such as RFC 8291's; otherwise it makes its own.
   */
  subscribe(options?: { applicationServerKey?: string; browser?: { privateKey: string; publicKey: string; auth: string } }): Promise<SimulatedSubscription>;
  /** The service as a fetch port: what a sender's `fetch` reaches. */
  fetch(request: Request): Promise<Response>;
  /** Every push the service received, in arrival order. */
  received(endpoint?: string): ReceivedPush[];
  /** Every push the browser of `endpoint` (or of any subscription) received, decrypted, in delivery order. */
  delivered(endpoint?: string): Promise<DeliveredPush[]>;
  /** The encrypted bodies the browser of `endpoint` received, in delivery order, for a test that decrypts with its own key. */
  bodies(endpoint: string): Uint8Array[];
  /** The subscription ended: every later push to it is answered `status`. */
  expire(endpoint: string, status: 404 | 410): void;
  /** The next `count` pushes (1 by default) are answered 429 with `Retry-After: retryAfterSeconds`. */
  rateLimit(options: { retryAfterSeconds: number; count?: number }): void;
  /** The browser of `endpoint` goes offline (pushes are held) or online again (what is held is delivered). */
  setOnline(endpoint: string, online: boolean): void;
  /** The next `count` pushes the service accepts never reach the browser. */
  drop(count?: number): void;
  /** Held pushes reach the browser in reverse order when it comes online. */
  reorder(on?: boolean): void;
  /** Forgets what was received and delivered; subscriptions and faults stay. */
  clear(): void;
  close(): Promise<void>;
}

interface Held { readonly id: number; readonly topic?: string; readonly urgency: string; readonly body: Uint8Array; readonly expiresAt: number }
interface Browser {
  readonly endpoint: string;
  readonly privateKey: CryptoKey;
  readonly publicKey: Uint8Array;
  readonly auth: Uint8Array;
  readonly applicationServerKey?: string;
  expired?: 404 | 410;
  online: boolean;
  held: Held[];
  delivered: Held[];
}

const subtle = globalThis.crypto.subtle;
const encoder = new TextEncoder();

export function base64url(bytes: Uint8Array): string {
  return Buffer.from(bytes).toString('base64url');
}
export function fromBase64url(value: string): Uint8Array {
  if (!/^[A-Za-z0-9_-]*$/.test(value)) throw new Error('Not base64url.');
  return new Uint8Array(Buffer.from(value, 'base64url'));
}
const concat = (...parts: Uint8Array[]) => {
  const out = new Uint8Array(parts.reduce((sum, part) => sum + part.length, 0));
  let offset = 0;
  for (const part of parts) { out.set(part, offset); offset += part.length; }
  return out;
};
const buffer = (bytes: Uint8Array): ArrayBuffer => bytes.slice().buffer;

async function hkdf(salt: Uint8Array, ikm: Uint8Array, info: Uint8Array, length: number): Promise<Uint8Array> {
  const key = await subtle.importKey('raw', buffer(ikm), 'HKDF', false, ['deriveBits']);
  return new Uint8Array(await subtle.deriveBits({ name: 'HKDF', hash: 'SHA-256', salt: buffer(salt), info: buffer(info) }, key, length * 8));
}

/** The browser's side of RFC 8291: the plaintext of an `aes128gcm` body, given the subscription's private key and auth secret. */
export async function decryptPush(body: Uint8Array, browser: { privateKey: CryptoKey; publicKey: Uint8Array; auth: Uint8Array }): Promise<string> {
  if (body.length < 21) throw new Error('The body has no aes128gcm header.');
  const salt = body.subarray(0, 16);
  const recordSize = new DataView(body.buffer, body.byteOffset + 16, 4).getUint32(0);
  const keyLength = body[20]!;
  const senderKey = body.subarray(21, 21 + keyLength);
  const ciphertext = body.subarray(21 + keyLength);
  if (keyLength !== 65 || senderKey[0] !== 4) throw new Error('The key id is no P-256 public key.');
  if (ciphertext.length > recordSize) throw new Error('A push holds one record.');
  const sender = await subtle.importKey('raw', buffer(senderKey), { name: 'ECDH', namedCurve: 'P-256' }, false, []);
  const shared = new Uint8Array(await subtle.deriveBits({ name: 'ECDH', public: sender }, browser.privateKey, 256));
  const ikm = await hkdf(browser.auth, shared, concat(encoder.encode('WebPush: info\0'), browser.publicKey, senderKey), 32);
  const cek = await hkdf(salt, ikm, encoder.encode('Content-Encoding: aes128gcm\0'), 16);
  const nonce = await hkdf(salt, ikm, encoder.encode('Content-Encoding: nonce\0'), 12);
  const key = await subtle.importKey('raw', buffer(cek), 'AES-GCM', false, ['decrypt']);
  const padded = new Uint8Array(await subtle.decrypt({ name: 'AES-GCM', iv: buffer(nonce) }, key, buffer(ciphertext)));
  // The last record ends with the delimiter 2, then zero or more bytes of padding.
  let end = padded.length - 1;
  while (end >= 0 && padded[end] === 0) end -= 1;
  if (end < 0 || padded[end] !== 2) throw new Error('The record has no last-record delimiter.');
  return new TextDecoder().decode(padded.subarray(0, end));
}

/** A browser's private key from its raw parts, for a test that holds a known one (RFC 8291's example). */
export async function importBrowserKey(privateKey: string, publicKey: string): Promise<CryptoKey> {
  const point = fromBase64url(publicKey);
  return subtle.importKey('jwk', { kty: 'EC', crv: 'P-256', d: privateKey, x: base64url(point.subarray(1, 33)), y: base64url(point.subarray(33, 65)), ext: true },
    { name: 'ECDH', namedCurve: 'P-256' }, false, ['deriveBits']);
}

/** The VAPID authorization of one push (`vapid t=<jwt>, k=<key>`), checked as a push service checks it; a refusal says why. */
async function checkVapid(header: string | undefined, origin: string, nowSeconds: number, expectedKey: string | undefined):
  Promise<{ status: 201 | 401 | 403; refusal?: string; vapid?: ReceivedPush['vapid'] }> {
  if (!header) return { status: 401, refusal: 'no authorization' };
  const match = /^vapid\s+(.+)$/i.exec(header.trim());
  if (!match) return { status: 401, refusal: 'not a vapid authorization' };
  const fields = new Map(match[1]!.split(',').map(part => { const [name, ...value] = part.trim().split('='); return [name!.trim(), value.join('=').trim()] as const; }));
  const token = fields.get('t'), key = fields.get('k');
  if (!token || !key) return { status: 401, refusal: 'the authorization lacks t or k' };
  const parts = token.split('.');
  if (parts.length !== 3) return { status: 403, refusal: 'the token is no JWT' };
  let header0: { typ?: unknown; alg?: unknown }, claims: { aud?: unknown; exp?: unknown; sub?: unknown };
  try {
    header0 = JSON.parse(new TextDecoder().decode(fromBase64url(parts[0]!)));
    claims = JSON.parse(new TextDecoder().decode(fromBase64url(parts[1]!)));
  } catch { return { status: 403, refusal: 'the token cannot be read' }; }
  const vapid = { publicKey: key, claims: { aud: claims.aud, exp: claims.exp, sub: claims.sub } };
  if (header0.alg !== 'ES256') return { status: 403, refusal: 'the token is not ES256', vapid };
  let verified = false;
  try {
    const publicKey = await subtle.importKey('raw', buffer(fromBase64url(key)), { name: 'ECDSA', namedCurve: 'P-256' }, false, ['verify']);
    verified = await subtle.verify({ name: 'ECDSA', hash: 'SHA-256' }, publicKey, buffer(fromBase64url(parts[2]!)), buffer(encoder.encode(`${parts[0]}.${parts[1]}`)));
  } catch { verified = false; }
  if (!verified) return { status: 403, refusal: 'the signature does not verify with k', vapid };
  if (claims.aud !== origin) return { status: 403, refusal: `the audience is not ${origin}`, vapid };
  if (typeof claims.exp !== 'number' || claims.exp <= nowSeconds) return { status: 403, refusal: 'the token expired', vapid };
  if (claims.exp > nowSeconds + VAPID_LIFETIME_SECONDS) return { status: 403, refusal: 'the token is valid for more than 24 hours', vapid };
  if (typeof claims.sub !== 'string' || !/^(mailto:|https:)/.test(claims.sub)) return { status: 403, refusal: 'the subject is no mailto: or https: URL', vapid };
  if (expectedKey && key !== expectedKey) return { status: 403, refusal: 'k is not the key the subscription was made with', vapid };
  return { status: 201, vapid };
}

/** A push service in memory; `fetch` is the port a sender uses. */
export function createPushService(options: PushServiceOptions = {}): PushService {
  let origin = options.origin ?? 'https://push.simulator.test';
  const now = options.now ?? Date.now;
  const limit = options.maxPayloadBytes ?? PUSH_PAYLOAD_LIMIT;
  const browsers = new Map<string, Browser>();
  let received: ReceivedPush[] = [];
  let next = 0, subscriptions = 0, dropping = 0, reversed = false;
  let limited: { retryAfterSeconds: number; count: number } | undefined;

  const endpointOf = (path: string) => `${origin}${path}`;
  /** Drops what outlived its TTL; a browser that is online gets what is held. */
  function settle(browser: Browser) {
    browser.held = browser.held.filter(push => push.expiresAt > now());
    if (!browser.online || !browser.held.length) return;
    const batch = reversed ? [...browser.held].reverse() : browser.held;
    browser.delivered.push(...batch);
    browser.held = [];
  }

  async function handle(request: Request): Promise<Response> {
    const url = new URL(request.url);
    const browser = browsers.get(url.pathname);
    const headers = {
      ...(request.headers.get('ttl') !== null ? { ttl: request.headers.get('ttl')! } : {}),
      ...(request.headers.get('urgency') !== null ? { urgency: request.headers.get('urgency')! } : {}),
      ...(request.headers.get('topic') !== null ? { topic: request.headers.get('topic')! } : {}),
      ...(request.headers.get('content-encoding') !== null ? { contentEncoding: request.headers.get('content-encoding')! } : {}),
      ...(request.headers.get('authorization') !== null ? { authorization: request.headers.get('authorization')! } : {}),
    };
    const body = new Uint8Array(await request.arrayBuffer());
    const answer = (status: number, refusal?: string, vapid?: ReceivedPush['vapid'], extra: Record<string, string> = {}) => {
      received.push({ endpoint: endpointOf(url.pathname), status, ...(refusal ? { refusal } : {}), headers, ...(vapid ? { vapid } : {}), bodyBytes: body.length });
      return new Response(status >= 400 ? JSON.stringify({ reason: refusal }) : null, { status, headers: extra });
    };
    if (request.method !== 'POST') return answer(405, 'only POST delivers a push');
    if (!browser) return answer(404, 'no such subscription');
    if (browser.expired) return answer(browser.expired, 'the subscription expired');
    if (limited && limited.count > 0) {
      limited.count -= 1;
      return answer(429, 'too many pushes', undefined, { 'retry-after': String(limited.retryAfterSeconds) });
    }
    const vapid = await checkVapid(headers.authorization, origin, Math.floor(now() / 1000), browser.applicationServerKey);
    if (vapid.status !== 201) return answer(vapid.status, vapid.refusal, vapid.vapid);
    const known = vapid.vapid;
    const ttl = headers.ttl === undefined ? NaN : Number(headers.ttl);
    if (!Number.isSafeInteger(ttl) || ttl < 0) return answer(400, 'TTL is missing or not a whole number of seconds', known);
    if (headers.urgency !== undefined && !URGENCIES.includes(headers.urgency as typeof URGENCIES[number])) return answer(400, 'Urgency is not a known level', known);
    if (headers.topic !== undefined && !/^[A-Za-z0-9_-]{1,32}$/.test(headers.topic)) return answer(400, 'Topic is not up to 32 base64url characters', known);
    if (body.length > limit) return answer(413, 'the payload is too large', known);
    if (body.length > 0 && headers.contentEncoding !== 'aes128gcm') return answer(415, 'the body is not aes128gcm', known);
    const push: Held = { id: ++next, ...(headers.topic ? { topic: headers.topic } : {}), urgency: headers.urgency ?? 'normal', body, expiresAt: now() + ttl * 1000 };
    const response = answer(201, undefined, known, { location: `${origin}/message/${push.id}` });
    if (dropping > 0) { dropping -= 1; return response; }
    settle(browser);
    // A push to a browser that is offline is held; a newer one with the same topic replaces it.
    if (push.topic) browser.held = browser.held.filter(held => held.topic !== push.topic);
    if (browser.online && ttl === 0) browser.delivered.push(push);
    else if (ttl > 0) { browser.held.push(push); settle(browser); }
    return response;
  }

  const service: PushService = {
    get origin() { return origin; },
    async subscribe(subscribeOptions = {}) {
      const known = subscribeOptions.browser;
      const pair = known ? undefined : await subtle.generateKey({ name: 'ECDH', namedCurve: 'P-256' }, true, ['deriveBits']) as CryptoKeyPair;
      const privateKey = known ? await importBrowserKey(known.privateKey, known.publicKey) : pair!.privateKey;
      const publicKey = known ? fromBase64url(known.publicKey) : new Uint8Array(await subtle.exportKey('raw', pair!.publicKey));
      const auth = known ? fromBase64url(known.auth) : globalThis.crypto.getRandomValues(new Uint8Array(16));
      const path = `/push/${++subscriptions}-${base64url(globalThis.crypto.getRandomValues(new Uint8Array(9)))}`;
      browsers.set(path, { endpoint: endpointOf(path), privateKey, publicKey, auth, ...(subscribeOptions.applicationServerKey ? { applicationServerKey: subscribeOptions.applicationServerKey } : {}),
        online: true, held: [], delivered: [] });
      return { endpoint: endpointOf(path), keys: { p256dh: base64url(publicKey), auth: base64url(auth) } };
    },
    fetch: handle,
    received: endpoint => received.filter(push => !endpoint || push.endpoint === endpoint),
    async delivered(endpoint) {
      const out: DeliveredPush[] = [];
      for (const browser of browsers.values()) {
        if (endpoint && browser.endpoint !== endpoint) continue;
        settle(browser);
        for (const push of browser.delivered) {
          let payload: string | undefined;
          try { payload = await decryptPush(push.body, browser); } catch { payload = undefined; }
          out.push({ endpoint: browser.endpoint, ...(push.topic ? { topic: push.topic } : {}), urgency: push.urgency, ...(payload === undefined ? {} : { payload }) });
        }
      }
      return out;
    },
    bodies(endpoint) {
      const browser = [...browsers.values()].find(each => each.endpoint === endpoint);
      if (!browser) return [];
      settle(browser);
      return browser.delivered.map(push => push.body.slice());
    },
    expire(endpoint, status) { const browser = [...browsers.values()].find(each => each.endpoint === endpoint); if (browser) browser.expired = status; },
    rateLimit({ retryAfterSeconds, count = 1 }) { limited = { retryAfterSeconds, count }; },
    setOnline(endpoint, online) {
      const browser = [...browsers.values()].find(each => each.endpoint === endpoint);
      if (!browser) return;
      browser.online = online;
      settle(browser);
    },
    drop(count = 1) { dropping += count; },
    reorder(on = true) { reversed = on; },
    clear() { received = []; for (const browser of browsers.values()) { browser.held = []; browser.delivered = []; } },
    async close() {},
  };
  return Object.assign(service, { setOrigin(value: string) { origin = value; } });
}

/** The push service at a loopback port: its origin is `http://127.0.0.1:<port>`, which every endpoint it issues starts with. */
export async function startPushService(options: Omit<PushServiceOptions, 'origin'> = {}): Promise<PushService> {
  const service = createPushService(options) as PushService & { setOrigin(value: string): void };
  const server: Server = createServer((incoming: IncomingMessage, outgoing: ServerResponse) => {
    const chunks: Buffer[] = [];
    incoming.on('data', chunk => chunks.push(chunk as Buffer));
    incoming.on('end', () => {
      const headers = new Headers();
      for (const [name, value] of Object.entries(incoming.headers)) if (typeof value === 'string') headers.set(name, value);
      const body = Buffer.concat(chunks);
      void service.fetch(new Request(service.origin + (incoming.url ?? '/'), { method: incoming.method ?? 'GET', headers, ...(body.length && incoming.method !== 'GET' ? { body } : {}) }))
        .then(async response => {
          outgoing.writeHead(response.status, Object.fromEntries(response.headers));
          outgoing.end(Buffer.from(await response.arrayBuffer()));
        }, () => { outgoing.writeHead(500); outgoing.end(); });
    });
  });
  await new Promise<void>((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', () => resolve()); });
  service.setOrigin(`http://127.0.0.1:${(server.address() as AddressInfo).port}`);
  return Object.assign(service, {
    async close() { await new Promise<void>(resolve => { server.closeAllConnections(); server.close(() => resolve()); }); },
  });
}
