import { createHmac } from 'node:crypto';
import { expect, it, vi } from 'vitest';
import { authenticateGatewayRequest, readGatewayCookie, verifyGatewayGrant } from './auth.js';

const auth = { origin: 'https://agents.example', issuer: 'https://gateway.example', secret: 'portable-auth-secret-01234567890123456789' };
function ticket() {
  const iat = Math.floor(Date.now() / 1000);
  const input = [{ alg: 'HS256', typ: 'arc-relay+jwt' }, {
    iss: auth.issuer, aud: auth.origin, sub: 'alice', iat, exp: iat + 900, jti: 'portable-grant', nonce: 'n'.repeat(43),
  }].map(value => Buffer.from(JSON.stringify(value)).toString('base64url')).join('.');
  return input + '.' + createHmac('sha256', auth.secret).update(input).digest('base64url');
}
it('authenticates a Web Request without accepting a cookie for another origin or duplicate cookies', () => {
  const token = ticket();
  const request = new Request(auth.origin, { headers: { cookie: `__Host-arc_session=${token}` } });
  expect(authenticateGatewayRequest(request, auth)?.subject).toBe('alice');
  expect(verifyGatewayGrant(token, { ...auth, origin: 'https://other.example' })).toBeUndefined();
  const duplicated = new Request(auth.origin, { headers: { cookie: `__Host-arc_session=${token}; __Host-arc_session=other` } });
  expect(readGatewayCookie(duplicated, '__Host-arc_session')).toBeUndefined();
  expect(authenticateGatewayRequest(duplicated, auth)).toBeUndefined();
});

it('verifies independent HS256 bytes and the stable issuer-subject namespace', () => {
  const now = vi.spyOn(Date, 'now').mockReturnValue(1_700_000_000_000);
  try {
    const token = 'eyJhbGciOiJIUzI1NiIsInR5cCI6ImFyYy1yZWxheStqd3QifQ.eyJpc3MiOiJodHRwczovL2dhdGV3YXkuZXhhbXBsZSIsImF1ZCI6Imh0dHBzOi8vYWdlbnRzLmV4YW1wbGUiLCJzdWIiOiJhbGljZSIsImlhdCI6MTcwMDAwMDAwMCwiZXhwIjoxNzAwMDAwOTAwLCJqdGkiOiJmaXhlZC1pbmRlcGVuZGVudC12ZWN0b3IiLCJub25jZSI6Im5ubm5ubm5ubm5ubm5ubm5ubm5ubm5ubm5ubm5ubm5ubm5ubm5ubm5ubm4ifQ.KLLgimyGOKOvOyOKj50S-Ec87lMBbx1UBhiShjBGqTA';
    expect(verifyGatewayGrant(token, auth)).toMatchObject({ subject: 'alice', expiresAt: 1_700_000_900_000,
      namespace: '7c1c385902e0ae7f484f5274fbad49131a97fc0771fac9b71f56d093232f49cd' });
    expect(verifyGatewayGrant(token.slice(0, -1) + 'B', auth)).toBeUndefined();
  } finally { now.mockRestore(); }
}, 10000);
