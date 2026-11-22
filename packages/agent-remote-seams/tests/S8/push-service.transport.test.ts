// S8, the Relay's push sender to a browser's push service: the real sender against the push service simulator at a loopback port. The
// service checks the signed request as a real one does, and the test's browser keys decrypt what it delivers (docs/current/agent-remote/seams.md).
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createPushSender, generateVapidKeys, PUSH_PLAINTEXT_LIMIT, toBase64url, type PushMessage, type VapidKeys } from '@orchardworks/agent-relay-core';
import { decryptPush, fromBase64url, importBrowserKey, startPushService, type PushService } from '@orchardworks/agent-remote-fixtures/push-service';

const SUBJECT = 'https://agents.example';
let service: PushService;
let vapid: VapidKeys;
beforeEach(async () => { service = await startPushService(); vapid = await generateVapidKeys(); });
afterEach(async () => { await service.close(); });

/** A browser with keys the test holds, subscribed with the Relay's public key. */
async function browser() {
  const pair = await crypto.subtle.generateKey({ name: 'ECDH', namedCurve: 'P-256' }, true, ['deriveBits']) as CryptoKeyPair;
  const keys = { privateKey: (await crypto.subtle.exportKey('jwk', pair.privateKey)).d!, publicKey: toBase64url(new Uint8Array(await crypto.subtle.exportKey('raw', pair.publicKey))),
    auth: toBase64url(crypto.getRandomValues(new Uint8Array(16))) };
  const subscription = await service.subscribe({ applicationServerKey: vapid.publicKey, browser: keys });
  return { subscription, keys };
}

function sender(forgotten: string[] = [], waits: number[] = []) {
  return createPushSender({ vapid: { ...vapid, subject: SUBJECT }, post: request => fetch(request), now: Date.now,
    endpoints: url => url.origin === service.origin, forget: endpoint => { forgotten.push(endpoint); }, wait: async ms => { waits.push(ms); } });
}
const reminder = (kind: string, tag: string): PushMessage => ({ payload: JSON.stringify({ v: 1, kind, name: 'Chief', tag }), topic: tag, ttlSeconds: 86_400, urgency: kind === 'needs_you' ? 'high' : 'normal' });

describe('S8: the Relay\'s push sender to a push service', () => {
  it('sends a request the service accepts: signed for its origin by the Relay\'s key, with the push\'s headers', async () => {
    const { subscription } = await browser();
    const started = Math.floor(Date.now() / 1000);
    expect(await sender().deliver(subscription, reminder('needs_you', 'chief'))).toEqual({ status: 'sent' });
    const [received] = service.received();
    expect(received).toMatchObject({ status: 201, headers: { ttl: '86400', urgency: 'high', topic: 'chief', contentEncoding: 'aes128gcm' },
      vapid: { publicKey: vapid.publicKey, claims: { aud: service.origin, sub: SUBJECT } } });
    const exp = received!.vapid!.claims.exp as number;
    expect(exp).toBeGreaterThan(started);
    expect(exp).toBeLessThanOrEqual(started + 24 * 3600);
  });

  it('delivers a payload only the browser\'s keys decrypt, to exactly what the Relay sent', async () => {
    const { subscription, keys } = await browser();
    const message = reminder('needs_you', 'chief');
    await sender().deliver(subscription, message);
    expect((await service.delivered(subscription.endpoint)).map(push => push.payload)).toEqual([message.payload]);
    // The test decrypts with its own key, as the browser does; any other key fails.
    const [body] = service.bodies(subscription.endpoint);
    const own = { privateKey: await importBrowserKey(keys.privateKey, keys.publicKey), publicKey: fromBase64url(keys.publicKey), auth: fromBase64url(keys.auth) };
    expect(await decryptPush(body!, own)).toBe(message.payload);
    await expect(decryptPush(body!, { ...own, auth: crypto.getRandomValues(new Uint8Array(16)) })).rejects.toThrow();
  });

  it('collapses by its tag: a newer reminder of one session replaces the one the service holds, another session\'s stays', async () => {
    const { subscription } = await browser();
    service.setOnline(subscription.endpoint, false);
    const push = sender();
    await push.deliver(subscription, reminder('needs_you', 'chief'));
    await push.deliver(subscription, reminder('needs_you', 'builder'));
    await push.deliver(subscription, reminder('finished', 'chief'));
    service.setOnline(subscription.endpoint, true);
    const delivered = (await service.delivered(subscription.endpoint)).map(push => JSON.parse(push.payload!) as { kind: string; tag: string });
    expect(delivered).toEqual([{ v: 1, kind: 'needs_you', name: 'Chief', tag: 'builder' }, { v: 1, kind: 'finished', name: 'Chief', tag: 'chief' }]);
  });

  it.each([404, 410] as const)('forgets a subscription the service answers %i for, and sends it nothing more', async status => {
    const { subscription } = await browser();
    service.expire(subscription.endpoint, status);
    const forgotten: string[] = [];
    expect(await sender(forgotten).deliver(subscription, reminder('needs_you', 'chief'))).toEqual({ status: 'gone', code: status });
    expect(forgotten).toEqual([subscription.endpoint]);
  });

  it('waits as long as a 429 asks and sends once more, and fits the largest payload in the service\'s limit', async () => {
    const { subscription } = await browser();
    service.rateLimit({ retryAfterSeconds: 7 });
    const waits: number[] = [];
    expect(await sender([], waits).deliver(subscription, reminder('finished', 'chief'))).toEqual({ status: 'sent' });
    expect(waits).toEqual([7_000]);
    expect(service.received().map(push => push.status)).toEqual([429, 201]);
    expect(await sender().deliver(subscription, { ...reminder('finished', 'chief'), payload: 'x'.repeat(PUSH_PLAINTEXT_LIMIT) })).toEqual({ status: 'sent' });
    expect(service.received().at(-1)).toMatchObject({ status: 201, bodyBytes: 4096 });
  });
});
