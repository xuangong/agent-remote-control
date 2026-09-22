import { createHash, createHmac } from 'node:crypto';
import { gatewayProfile, type GatewayProfile, type GatewayAuthOptions } from './auth.js';
import { readRequestBytes } from './request.js';

export type AuthorityResult = { status: 'active'; profile?: GatewayProfile; subject: string; expiresAt?: number; authenticatedAt?: number; validUntil: number } | { status: 'denied' | 'unavailable' };
export interface AuthorityDiagnostic {
  reason: 'authority_active' | 'access_revoked' | 'authority_timeout' | 'authority_http_error' | 'authority_transport_error' | 'authority_invalid_response';
  status?: number;
  durationMs: number;
}
export function gatewayServiceProof(auth: GatewayAuthOptions, operation: string, body: string): string {
  const iat = Math.floor(Date.now() / 1000);
  const input = [{ alg: 'HS256', typ: 'arc-relay-service+jwt' }, { iss: auth.origin, aud: auth.issuer, op: operation,
    bodyHash: createHash('sha256').update(body).digest('base64url'), iat, exp: iat + 60 }]
    .map(part => Buffer.from(JSON.stringify(part)).toString('base64url')).join('.');
  return input + '.' + createHmac('sha256', auth.secret).update(input).digest('base64url');
}
export async function queryGatewayAuthority(auth: GatewayAuthOptions, operation: 'renew' | 'user-status', value: { continuation: string } | { subject: string }, observe?: (diagnostic: AuthorityDiagnostic) => void): Promise<AuthorityResult> {
  const body = JSON.stringify(value); const proof = gatewayServiceProof(auth, operation, body);
  const started = Date.now(), signal = AbortSignal.timeout(5000);
  let status: number | undefined;
  const done = (result: AuthorityResult, reason: AuthorityDiagnostic['reason']): AuthorityResult => {
    try { observe?.({ reason, ...(status === undefined ? {} : { status }), durationMs: Math.max(0, Date.now() - started) }); }
    catch { /* Diagnostics cannot alter authorization. */ }
    return result;
  };
  try {
    // Workers supports manual redirects; every non-success response fails closed below.
    const response = await fetch(`${auth.issuer}/api/agent-remote/${operation}`, { method: 'POST', redirect: 'manual', signal,
      headers: { authorization: `Bearer ${proof}`, 'content-type': 'application/json' }, body });
    status = response.status;
    if (!response.ok) {
      await response.body?.cancel().catch(() => undefined);
      return response.status === 401 || response.status === 403
        ? done({ status: 'denied' }, 'access_revoked') : done({ status: 'unavailable' }, 'authority_http_error');
    }
    const data: unknown = JSON.parse(new TextDecoder().decode(await readRequestBytes(response, 16384)));
    if (!data || typeof data !== 'object' || !('active' in data) || data.active !== true || !('subject' in data) || typeof data.subject !== 'string' ||
      !('validUntil' in data) || typeof data.validUntil !== 'number' || !Number.isFinite(data.validUntil) || data.validUntil <= Date.now()) return done({ status: 'unavailable' }, 'authority_invalid_response');
    const expiresAt = 'expiresAt' in data && typeof data.expiresAt === 'number' && Number.isFinite(data.expiresAt) ? data.expiresAt : undefined;
    if (operation === 'renew' && (expiresAt === undefined || expiresAt <= Date.now())) return done({ status: 'denied' }, 'access_revoked');
    const authenticatedAt = 'authenticatedAt' in data && typeof data.authenticatedAt === 'number' && Number.isSafeInteger(data.authenticatedAt) && data.authenticatedAt >= 0 && data.authenticatedAt <= Date.now() ? data.authenticatedAt : undefined;
    return done({ status: 'active', profile: gatewayProfile('profile' in data ? data.profile : undefined), subject: data.subject, expiresAt, authenticatedAt, validUntil: Math.min(data.validUntil, Date.now() + 120_000, expiresAt ?? Infinity) }, 'authority_active');
  } catch { return done({ status: 'unavailable' }, signal.aborted ? 'authority_timeout' : status === undefined ? 'authority_transport_error' : 'authority_invalid_response'); }
}
