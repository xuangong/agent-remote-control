import { createHash, createHmac, timingSafeEqual } from 'node:crypto';
import type { GatewayAuthOptions } from './auth.js';
import { SharingError } from './host-sharing.js';
import type { RelayState } from './state.js';
import { readRequestBytes } from './request.js';

export interface GatewayControlRequest {
  subject: string; operation: 'hosts' | 'shares' | 'share' | 'revoke-share';
  hostId?: string; targetSubject?: string; targetLabel?: string; sessionLimit?: number;
}
export function createGatewayControlVerifier(auth: GatewayAuthOptions, state: RelayState) {
  return async (request: Request): Promise<GatewayControlRequest> => {
    if (request.method !== 'POST' || request.headers.has('origin') || request.headers.has('cookie')) throw new SharingError(403, 'service_only', 'A Gateway service request is required.');
    if (request.headers.get('content-type')?.split(';')[0] !== 'application/json') throw new SharingError(415, 'json_required', 'JSON is required.');
    const body = Buffer.from(await readRequestBytes(request, 16384));
    const proof = /^Bearer ([A-Za-z0-9_.-]+)$/.exec(request.headers.get('authorization') ?? '')?.[1];
    const parts = proof?.split('.'); const now = Math.floor(Date.now() / 1000);
    let claims: Record<string, unknown>;
    try {
      if (!parts || parts.length !== 3) throw Error();
      const header = JSON.parse(Buffer.from(parts[0]!, 'base64url').toString());
      const expected = createHmac('sha256', auth.secret).update(parts[0] + '.' + parts[1]).digest();
      const actual = Buffer.from(parts[2]!, 'base64url');
      if (actual.length !== expected.length || !timingSafeEqual(expected, actual) || header.alg !== 'HS256' || header.typ !== 'arc-gateway-service+jwt' || Object.keys(header).length !== 2) throw Error();
      claims = JSON.parse(Buffer.from(parts[1]!, 'base64url').toString());
      if (claims.iss !== auth.issuer || claims.aud !== auth.origin || claims.op !== 'control' ||
        claims.bodyHash !== createHash('sha256').update(body).digest('base64url') ||
        typeof claims.iat !== 'number' || !Number.isSafeInteger(claims.iat) || claims.iat > now + 5 ||
        typeof claims.exp !== 'number' || !Number.isSafeInteger(claims.exp) || claims.exp <= now || claims.exp <= claims.iat || claims.exp > claims.iat + 60 ||
        typeof claims.jti !== 'string' || claims.jti.length < 16 || claims.jti.length > 128) throw Error();
    } catch { throw new SharingError(401, 'invalid_service_proof', 'Invalid or replayed Gateway service proof.'); }
    await state.mutate(draft => {
      draft.consumedProofs = draft.consumedProofs.filter(([, expires]) => expires > now);
      if (draft.consumedProofs.some(([id]) => id === claims.jti)) throw new SharingError(401, 'invalid_service_proof', 'Invalid or replayed Gateway service proof.');
      if (draft.consumedProofs.length >= 10000) throw new SharingError(429, 'service_capacity', 'Gateway service capacity reached.');
      draft.consumedProofs.push([claims.jti as string, claims.exp as number]);
    });
    let value: unknown;
    try { value = JSON.parse(body.toString()); } catch { throw new SharingError(400, 'invalid_request', 'Invalid JSON.'); }
    const record = value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {};
    const fields = ['subject', 'operation', 'hostId', 'targetSubject', 'targetLabel', 'sessionLimit'];
    if (Object.keys(record).some(key => !fields.includes(key)) || !validString(record.subject, 256) || !['hosts', 'shares', 'share', 'revoke-share'].includes(String(record.operation)) ||
      (record.operation !== 'hosts' && (typeof record.hostId !== 'string' || !/^[A-Za-z0-9_-]{1,256}$/.test(record.hostId))) ||
      (['share', 'revoke-share'].includes(String(record.operation)) && !validString(record.targetSubject, 256)) ||
      (record.operation === 'share' && (!validString(record.targetLabel, 320) || !Number.isSafeInteger(record.sessionLimit) || (record.sessionLimit as number) < 0 || (record.sessionLimit as number) > 10000))) {
      throw new SharingError(400, 'invalid_request', 'Invalid Host control request.');
    }
    return record as unknown as GatewayControlRequest;
  };
}
function validString(value: unknown, max: number): value is string { return typeof value === 'string' && value.trim().length > 0 && value.length <= max; }
