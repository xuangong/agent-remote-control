import { describe, expect, it } from 'vitest';
import { base64url, createPushService, decryptPush, fromBase64url, importBrowserKey, PUSH_PAYLOAD_LIMIT, startPushService, type PushService } from './push-service.js';

// RFC 8291 Appendix A and section 5: a browser's keys, an auth secret and the body an application server sent for one plaintext.
const RFC_BROWSER = {
  privateKey: 'q1dXpw3UpT5VOmu_cf_v6ih07Aems3njxI-JWgLcM94',
  publicKey: 'BCVxsr7N_eNgVRqvHtD0zTZsEc6-VV-JvLexhqUzORcxaOzi6-AYWXvTBHm4bjyPjs7Vd8pZGH6SRpkNtoIAiw4',
  auth: 'BTBZMqHH6r4Tts7J_aSIgg',
};
const RFC_BODY = 'DGv6ra1nlYgDCS1FRnbzlwAAEABBBP4z9KsN6nGRTbVYI_c7VJSPQTBtkgcy27mlmlMoZIIgDll6e3vCYLocInmYWAmS6TlzAC8wEqKK6PBru3jl7A_yl95bQpu6cVPTpK4Mqgkf1CXztLVBSt2Ks3oZwbuwXPXLWyouBWLVWGNWQexSgSxsj_Qulcy4a-fN';
const RFC_PLAINTEXT = 'When I grow up, I want to be a watermelon';
const NOW = Date.parse('2026-11-22T12:00:00Z');

/** An application server's VAPID key and the authorization it signs for one audience. */
async function applicationServer() {
  const pair = await crypto.subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, true, ['sign', 'verify']) as CryptoKeyPair;
  const publicKey = base64url(new Uint8Array(await crypto.subtle.exportKey('raw', pair.publicKey)));
  const encode = (value: unknown) => base64url(new TextEncoder().encode(JSON.stringify(value)));
  return {
    publicKey,
    async authorization(claims: Record<string, unknown>, header: Record<string, unknown> = { typ: 'JWT', alg: 'ES256' }, key = publicKey) {
      const unsigned = `${encode(header)}.${encode(claims)}`;
      const signature = new Uint8Array(await crypto.subtle.sign({ name: 'ECDSA', hash: 'SHA-256' }, pair.privateKey, new TextEncoder().encode(unsigned)));
      return `vapid t=${unsigned}.${base64url(signature)}, k=${key}`;
    },
  };
}

async function setup(options: { now?: () => number } = {}) {
  const service = createPushService({ now: options.now ?? (() => NOW) });
  const server = await applicationServer();
  const subscription = await service.subscribe({ applicationServerKey: server.publicKey, browser: RFC_BROWSER });
  const claims = { aud: service.origin, exp: Math.floor(NOW / 1000) + 3600, sub: 'https://relay.example' };
  const push = async (overrides: { headers?: Record<string, string | undefined>; body?: Uint8Array; claims?: Record<string, unknown>; endpoint?: string } = {}) => {
    const headers: Record<string, string> = {};
    const all = { ttl: '60', urgency: 'high', 'content-encoding': 'aes128gcm', authorization: await server.authorization(overrides.claims ?? claims), ...overrides.headers };
    for (const [name, value] of Object.entries(all)) if (value !== undefined) headers[name] = value;
    return service.fetch(new Request(overrides.endpoint ?? subscription.endpoint, { method: 'POST', headers, body: overrides.body ?? fromBase64url(RFC_BODY) }));
  };
  return { service, server, subscription, claims, push };
}

describe('the browser side of RFC 8291', () => {
  it('decrypts the RFC\'s example push with the browser\'s keys', async () => {
    const browser = { privateKey: await importBrowserKey(RFC_BROWSER.privateKey, RFC_BROWSER.publicKey), publicKey: fromBase64url(RFC_BROWSER.publicKey), auth: fromBase64url(RFC_BROWSER.auth) };
    expect(await decryptPush(fromBase64url(RFC_BODY), browser)).toBe(RFC_PLAINTEXT);
    const tampered = fromBase64url(RFC_BODY); tampered[tampered.length - 1]! ^= 1;
    await expect(decryptPush(tampered, browser)).rejects.toThrow();
  });
});

describe('accepting a push', () => {
  it('answers 201 with a location and hands the browser the decrypted payload', async () => {
    const { service, subscription, push, server } = await setup();
    const response = await push({ headers: { topic: 'needs-you-chief' } });
    expect(response.status).toBe(201);
    expect(response.headers.get('location')).toMatch(/\/message\/\d+$/);
    expect(service.received()).toEqual([expect.objectContaining({ endpoint: subscription.endpoint, status: 201,
      headers: expect.objectContaining({ ttl: '60', urgency: 'high', topic: 'needs-you-chief', contentEncoding: 'aes128gcm' }),
      vapid: { publicKey: server.publicKey, claims: { aud: service.origin, exp: Math.floor(NOW / 1000) + 3600, sub: 'https://relay.example' } } })]);
    expect(await service.delivered(subscription.endpoint)).toEqual([{ endpoint: subscription.endpoint, topic: 'needs-you-chief', urgency: 'high', payload: RFC_PLAINTEXT }]);
  });

  it.each([
    ['without TTL', { headers: { ttl: undefined } }, 400, 'TTL'],
    ['with an unknown urgency', { headers: { urgency: 'urgent' } }, 400, 'Urgency'],
    ['with a topic over 32 characters', { headers: { topic: 'x'.repeat(33) } }, 400, 'Topic'],
    ['with a topic outside base64url', { headers: { topic: 'needs you' } }, 400, 'Topic'],
    ['over the payload limit', { body: new Uint8Array(PUSH_PAYLOAD_LIMIT + 1) }, 413, 'too large'],
    ['in another content encoding', { headers: { 'content-encoding': 'aesgcm' } }, 415, 'aes128gcm'],
    ['without an authorization', { headers: { authorization: undefined } }, 401, 'no authorization'],
    ['with a bearer token', { headers: { authorization: 'Bearer abc' } }, 401, 'not a vapid'],
  ] as const)('refuses a push %s', async (_name, overrides, status, reason) => {
    const { service, push } = await setup();
    expect((await push(overrides)).status).toBe(status);
    expect(service.received()[0]!.refusal).toContain(reason);
    expect(await service.delivered()).toEqual([]);
  });

  it.each([
    ['for another audience', { aud: 'https://fcm.googleapis.com' }, 'audience'],
    ['expired', { exp: Math.floor(NOW / 1000) - 1 }, 'expired'],
    ['valid for more than 24 hours', { exp: Math.floor(NOW / 1000) + 24 * 3600 + 60 }, '24 hours'],
    ['without a mailto: or https: subject', { sub: 'relay' }, 'subject'],
  ])('refuses a VAPID token %s with 403', async (_name, change, reason) => {
    const { service, push, claims } = await setup();
    expect((await push({ claims: { ...claims, ...change } })).status).toBe(403);
    expect(service.received()[0]!.refusal).toContain(reason);
  });

  it('refuses a token another key signed, and a key the subscription was not made with', async () => {
    const { service, subscription, claims } = await setup();
    const other = await applicationServer();
    const forged = await other.authorization(claims, undefined, (await applicationServer()).publicKey);
    const signedByOther = await other.authorization(claims);
    for (const authorization of [forged, signedByOther]) {
      expect((await service.fetch(new Request(subscription.endpoint, { method: 'POST', headers: { ttl: '60', 'content-encoding': 'aes128gcm', authorization }, body: fromBase64url(RFC_BODY) }))).status).toBe(403);
    }
    expect(service.received().map(push => push.refusal)).toEqual(['the signature does not verify with k', 'k is not the key the subscription was made with']);
  });
});

describe('subscriptions that end, and rate limits', () => {
  it.each([404, 410] as const)('answers %i for an expired subscription, and 404 for a path it never issued', async status => {
    const { service, subscription, push } = await setup();
    service.expire(subscription.endpoint, status);
    expect((await push()).status).toBe(status);
    expect((await push({ endpoint: `${service.origin}/push/never` })).status).toBe(404);
  });

  it('answers 429 with Retry-After for as many pushes as it limits, then accepts again', async () => {
    const { service, push } = await setup();
    service.rateLimit({ retryAfterSeconds: 30, count: 2 });
    const first = await push(), second = await push(), third = await push();
    expect([first.status, second.status, third.status]).toEqual([429, 429, 201]);
    expect(first.headers.get('retry-after')).toBe('30');
    expect((await service.delivered()).length).toBe(1);
  });
});

describe('delivery to the browser', () => {
  it('holds pushes for a browser that is offline, and a newer push of the same topic replaces the one held', async () => {
    const { service, subscription, push } = await setup();
    service.setOnline(subscription.endpoint, false);
    await push({ headers: { topic: 'chief', urgency: 'high' } });
    await push({ headers: { topic: 'builder', urgency: 'normal' } });
    await push({ headers: { topic: 'chief', urgency: 'low' } });
    expect(await service.delivered()).toEqual([]);
    service.setOnline(subscription.endpoint, true);
    expect((await service.delivered()).map(push => [push.topic, push.urgency])).toEqual([['builder', 'normal'], ['chief', 'low']]);
  });

  it('drops a held push once its TTL passed, and a push with TTL 0 to a browser that is offline', async () => {
    let now = NOW;
    const { service, subscription, push } = await setup({ now: () => now });
    service.setOnline(subscription.endpoint, false);
    await push({ headers: { ttl: '60', topic: 'short' } });
    await push({ headers: { ttl: '3600', topic: 'long' } });
    await push({ headers: { ttl: '0', topic: 'now' } });
    now += 120_000;
    service.setOnline(subscription.endpoint, true);
    expect((await service.delivered()).map(push => push.topic)).toEqual(['long']);
  });

  it('loses the pushes it is told to drop and delivers held pushes in reverse order when it reorders', async () => {
    const { service, subscription, push } = await setup();
    service.drop(1);
    expect((await push({ headers: { topic: 'lost' } })).status).toBe(201);
    service.reorder();
    service.setOnline(subscription.endpoint, false);
    await push({ headers: { topic: 'first' } });
    await push({ headers: { topic: 'second' } });
    service.setOnline(subscription.endpoint, true);
    expect((await service.delivered()).map(push => push.topic)).toEqual(['second', 'first']);
  });
});

describe('at a port', () => {
  let service: PushService | undefined;
  it('serves the same service over HTTP, with endpoints at its own origin', async () => {
    service = await startPushService({ now: () => NOW });
    try {
      const server = await applicationServer();
      const subscription = await service.subscribe({ applicationServerKey: server.publicKey, browser: RFC_BROWSER });
      expect(subscription.endpoint.startsWith(`${service.origin}/push/`)).toBe(true);
      expect(service.origin).toMatch(/^http:\/\/127\.0\.0\.1:\d+$/);
      const response = await fetch(subscription.endpoint, { method: 'POST', body: fromBase64url(RFC_BODY),
        headers: { ttl: '60', 'content-encoding': 'aes128gcm', authorization: await server.authorization({ aud: service.origin, exp: Math.floor(NOW / 1000) + 60, sub: 'mailto:owner@example.com' }) } });
      expect(response.status).toBe(201);
      expect((await service.delivered()).map(push => push.payload)).toEqual([RFC_PLAINTEXT]);
    } finally { await service.close(); }
  });
});
