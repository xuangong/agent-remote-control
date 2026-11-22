// @vitest-environment node
import { describe, expect, it } from 'vitest';
import { encryptPush, fromBase64url, generateVapidKeys, importVapidKeys, isUncompressedKey, PUSH_PLAINTEXT_LIMIT, toBase64url, vapidAuthorization } from './web-push.js';

// RFC 8291 Appendix A: the application server's and the browser's keys, the auth secret and salt, and the body they give (section 5).
const RFC = {
  plaintext: 'When I grow up, I want to be a watermelon',
  senderPrivate: 'yfWPiYE-n46HLnH0KqZOF1fJJU3MYrct3AELtAQ-oRw',
  senderPublic: 'BP4z9KsN6nGRTbVYI_c7VJSPQTBtkgcy27mlmlMoZIIgDll6e3vCYLocInmYWAmS6TlzAC8wEqKK6PBru3jl7A8',
  browserPublic: 'BCVxsr7N_eNgVRqvHtD0zTZsEc6-VV-JvLexhqUzORcxaOzi6-AYWXvTBHm4bjyPjs7Vd8pZGH6SRpkNtoIAiw4',
  auth: 'BTBZMqHH6r4Tts7J_aSIgg',
  salt: 'DGv6ra1nlYgDCS1FRnbzlw',
  body: 'DGv6ra1nlYgDCS1FRnbzlwAAEABBBP4z9KsN6nGRTbVYI_c7VJSPQTBtkgcy27mlmlMoZIIgDll6e3vCYLocInmYWAmS6TlzAC8wEqKK6PBru3jl7A_yl95bQpu6cVPTpK4Mqgkf1CXztLVBSt2Ks3oZwbuwXPXLWyouBWLVWGNWQexSgSxsj_Qulcy4a-fN',
};
const point = (value: string) => { const bytes = fromBase64url(value); return { x: toBase64url(bytes.subarray(1, 33)), y: toBase64url(bytes.subarray(33)) }; };

describe('payload encryption (RFC 8291)', () => {
  it('gives the RFC\'s body for its keys, salt and plaintext', async () => {
    const ecdh = { name: 'ECDH', namedCurve: 'P-256' } as const;
    const senderKeys = {
      privateKey: await crypto.subtle.importKey('jwk', { kty: 'EC', crv: 'P-256', d: RFC.senderPrivate, ...point(RFC.senderPublic) }, ecdh, true, ['deriveBits']),
      publicKey: await crypto.subtle.importKey('raw', fromBase64url(RFC.senderPublic), ecdh, true, []),
    };
    const body = await encryptPush(new TextEncoder().encode(RFC.plaintext), { endpoint: 'https://push.example/x', keys: { p256dh: RFC.browserPublic, auth: RFC.auth } },
      { salt: fromBase64url(RFC.salt), senderKeys });
    expect(toBase64url(body)).toBe(RFC.body);
  });

  it('uses a new sender key and salt for every push, and refuses a payload over one record or a key that is no P-256 point', async () => {
    const target = { endpoint: 'https://push.example/x', keys: { p256dh: RFC.browserPublic, auth: RFC.auth } };
    const [first, second] = [await encryptPush(new Uint8Array(3), target), await encryptPush(new Uint8Array(3), target)];
    expect(toBase64url(first.subarray(0, 86))).not.toBe(toBase64url(second.subarray(0, 86)));
    expect(first.length).toBe(86 + 3 + 1 + 16);
    expect((await encryptPush(new Uint8Array(PUSH_PLAINTEXT_LIMIT), target)).length).toBe(4096);
    await expect(encryptPush(new Uint8Array(PUSH_PLAINTEXT_LIMIT + 1), target)).rejects.toThrow(RangeError);
    await expect(encryptPush(new Uint8Array(3), { ...target, keys: { ...target.keys, p256dh: RFC.auth } })).rejects.toThrow('uncompressed');
  });
});

describe('VAPID (RFC 8292)', () => {
  it('signs a token for the push service\'s origin, valid for 12 hours, that verifies with the public key it names', async () => {
    const keys = await generateVapidKeys();
    expect(isUncompressedKey(keys.publicKey)).toBe(true);
    expect(fromBase64url(keys.privateKey)).toHaveLength(32);
    const now = Date.parse('2026-11-22T12:00:00Z');
    const { header, expiresAt } = await vapidAuthorization(await importVapidKeys(keys), { publicKey: keys.publicKey, subject: 'https://agents.example' }, 'https://fcm.googleapis.com/fcm/send/abc', now);
    const [, token, key] = /^vapid t=([^,]+), k=(.+)$/.exec(header)!;
    expect(key).toBe(keys.publicKey);
    const [head, claims, signature] = token!.split('.');
    const read = (part: string) => JSON.parse(new TextDecoder().decode(fromBase64url(part)));
    expect(read(head!)).toEqual({ typ: 'JWT', alg: 'ES256' });
    expect(read(claims!)).toEqual({ aud: 'https://fcm.googleapis.com', exp: now / 1000 + 12 * 3600, sub: 'https://agents.example' });
    expect(expiresAt).toBe(now + 12 * 3600_000);
    const verifying = await crypto.subtle.importKey('raw', fromBase64url(keys.publicKey), { name: 'ECDSA', namedCurve: 'P-256' }, false, ['verify']);
    expect(await crypto.subtle.verify({ name: 'ECDSA', hash: 'SHA-256' }, verifying, fromBase64url(signature!), new TextEncoder().encode(`${head}.${claims}`))).toBe(true);
  });

  it('refuses a pair whose halves belong to different keys, and keys of the wrong shape', async () => {
    const [one, two] = [await generateVapidKeys(), await generateVapidKeys()];
    await expect(importVapidKeys({ publicKey: one.publicKey, privateKey: two.privateKey })).rejects.toThrow('does not belong');
    await expect(importVapidKeys({ publicKey: one.publicKey.slice(0, 40), privateKey: one.privateKey })).rejects.toThrow('public key');
    await expect(importVapidKeys({ publicKey: one.publicKey, privateKey: 'abc' })).rejects.toThrow('private key');
  });
});
