// @vitest-environment node
import { createHash, createHmac } from 'node:crypto';
import { afterEach, expect, it } from 'vitest';
import { createGatewayRelay } from './gateway-relay.js';
const secret = 'control-test-012345678901234567890123456789';
const issuer = 'https://gateway.example';
let relay: ReturnType<typeof createGatewayRelay> | undefined;
afterEach(async () => { await relay?.close(); });
function proof(url: string, body: string, changes = {}, header = {}) {
  const iat = Math.floor(Date.now() / 1000);
  const input = [{ alg: 'HS256', typ: 'arc-gateway-service+jwt', ...header }, { iss: issuer, aud: url, op: 'control',
    bodyHash: createHash('sha256').update(body).digest('base64url'), iat, exp: iat + 60, jti: crypto.randomUUID(), ...changes }]
    .map(value => Buffer.from(JSON.stringify(value)).toString('base64url')).join('.');
  return `Bearer ${input}.${createHmac('sha256', secret).update(input).digest('base64url')}`;
}
it('accepts purpose-bound service proofs once and rejects tampering, browser credentials and other proof purposes', async () => {
  relay = createGatewayRelay({ origin: 'http://127.0.0.1:0', issuer, secret }); const { url } = await relay.listen(0);
  const body = JSON.stringify({ subject: 'alice', operation: 'hosts' });
  const request = (authorization: string, payload = body, extra = {}) => fetch(url + '/gateway/control', { method: 'POST', headers: { 'content-type': 'application/json', authorization, ...extra }, body: payload });
  const valid = proof(url, body);
  expect((await request(valid)).status).toBe(200);
  expect((await request(valid)).status).toBe(401);
  expect((await request(proof(url, body), body.replace('alice', 'bob'))).status).toBe(401);
  expect((await request(proof(url, body), body, { origin: url })).status).toBe(403);
  expect((await request(proof(url, body), body, { cookie: 'arc_session=x' })).status).toBe(403);
  for (const changes of [{ aud: issuer }, { iss: url }, { op: 'renew' }, { exp: 1 }, { exp: Math.floor(Date.now() / 1000) + 120 }]) {
    expect((await request(proof(url, body, changes))).status).toBe(401);
  }
  expect((await request(proof(url, body, {}, { typ: 'arc-relay-service+jwt' }))).status).toBe(401);
  expect((await request('Bearer invalid')).status).toBe(401);
  const invalid = JSON.stringify({ subject: 'alice', operation: 'share', hostId: 'h', targetSubject: 'bob', targetLabel: 'Bob', sessionLimit: -1 });
  expect((await request(proof(url, invalid), invalid)).status).toBe(400);
}, 10000);
