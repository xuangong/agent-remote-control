import { createHash, createHmac } from 'node:crypto';
import type { GatewayAuthOptions } from './auth.js';

export type AuthorityResult = { status: 'active'; subject: string; expiresAt?: number; authenticatedAt?: number; validUntil: number } | { status: 'denied' | 'unavailable' };
export async function queryGatewayAuthority(auth: GatewayAuthOptions, operation: 'renew' | 'user-status', value: { continuation: string } | { subject: string }): Promise<AuthorityResult> {
  const body = JSON.stringify(value); const iat = Math.floor(Date.now() / 1000);
  const input = [{ alg: 'HS256', typ: 'arc-relay-service+jwt' }, { iss: auth.origin, aud: auth.issuer, op: operation,
    bodyHash: createHash('sha256').update(body).digest('base64url'), iat, exp: iat + 60 }]
    .map(part => Buffer.from(JSON.stringify(part)).toString('base64url')).join('.');
  const proof = input + '.' + createHmac('sha256', auth.secret).update(input).digest('base64url');
  try {
    // Workers supports manual redirects; every non-success response fails closed below.
    const response = await fetch(`${auth.issuer}/api/agent-remote/${operation}`, { method: 'POST', redirect: 'manual', signal: AbortSignal.timeout(5000),
      headers: { authorization: `Bearer ${proof}`, 'content-type': 'application/json' }, body });
    if (response.status === 401 || response.status === 403) return { status: 'denied' };
    if (!response.ok) return { status: 'unavailable' };
    const data: unknown = await response.json();
    if (!data || typeof data !== 'object' || !('active' in data) || data.active !== true || !('subject' in data) || typeof data.subject !== 'string' ||
      !('validUntil' in data) || typeof data.validUntil !== 'number' || !Number.isFinite(data.validUntil) || data.validUntil <= Date.now()) return { status: 'unavailable' };
    const expiresAt = 'expiresAt' in data && typeof data.expiresAt === 'number' && Number.isFinite(data.expiresAt) ? data.expiresAt : undefined;
    if (operation === 'renew' && (expiresAt === undefined || expiresAt <= Date.now())) return { status: 'denied' };
    const authenticatedAt = 'authenticatedAt' in data && typeof data.authenticatedAt === 'number' && Number.isSafeInteger(data.authenticatedAt) && data.authenticatedAt >= 0 && data.authenticatedAt <= Date.now() ? data.authenticatedAt : undefined;
    return { status: 'active', subject: data.subject, expiresAt, authenticatedAt, validUntil: Math.min(data.validUntil, Date.now() + 120_000, expiresAt ?? Infinity) };
  } catch { return { status: 'unavailable' }; }
}
