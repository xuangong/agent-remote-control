// @vitest-environment node
import { createHmac } from 'node:crypto';
import { expect, it } from 'vitest';
import { verifyGatewayGrant } from './gateway-auth.js';
const auth = { origin: 'https://relay.example', issuer: 'https://gateway.example', secret: 'test-only-32-byte-secret-value-0123456789' };
function sign(head: unknown, body: unknown) {
  const value = [head, body].map(value => Buffer.from(JSON.stringify(value)).toString('base64url')).join('.');
  return value + '.' + createHmac('sha256', auth.secret).update(value).digest('base64url');
}
it('rejects other JWT purposes, algorithms, issuers, lifetimes and malformed claims', () => {
  const iat = Math.floor(Date.now() / 1000);
  const head = { alg: 'HS256', typ: 'arc-relay+jwt' };
  const body = { iat, exp: iat + 900, iss: auth.issuer, aud: auth.origin, sub: 'alice', nonce: 'n'.repeat(43), jti: 'unique' };
  expect(verifyGatewayGrant(sign(head, body), auth)?.subject).toBe('alice');
  for (const mutation of [{ typ: 'JWT' }, { alg: 'none' }, { alg: 'HS384' }, { jku: 'https://evil.example' }]) expect(verifyGatewayGrant(sign({ ...head, ...mutation }, body), auth)).toBeUndefined();
  for (const mutation of [{ iss: 'https://evil.example' }, { aud: ['https://relay.example'] }, { sub: '' }, { sub: ['alice'] }, { exp: iat + 901 }, { iat: iat + 10 }, { exp: iat }, { jti: null }, { exp: String(iat + 900) }]) expect(verifyGatewayGrant(sign(head, { ...body, ...mutation }), auth)).toBeUndefined();
  for (const value of [null, 'a.b.c', 'x'.repeat(4097), sign(head, body) + '=']) expect(verifyGatewayGrant(value, auth)).toBeUndefined();
});
