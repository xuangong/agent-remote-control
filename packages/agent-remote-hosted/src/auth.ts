import { createHash, createHmac, timingSafeEqual } from 'node:crypto';

export interface GatewayGrant { subject: string; namespace: string; expiresAt: number; ticket: string; nonce: string; continuation?: string; sessionExpiresAt?: number; authenticatedAt?: number }
export interface GatewayAuthOptions { origin: string; issuer: string; secret: string }
export function validateGatewayOrigin(value: string): string {
  const url = new URL(value);
  if (url.username || url.password || url.search || url.hash || url.pathname !== '/' ||
    (url.protocol !== 'https:' && !(url.protocol === 'http:' && ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname)))) {
    throw new Error('Gateway and Relay URLs must be HTTPS origins or loopback HTTP origins.');
  }
  return url.origin;
}
export function verifyGatewayGrant(ticket: unknown, options: GatewayAuthOptions): GatewayGrant | undefined {
  if (typeof ticket !== 'string' || ticket.length > 8192) return undefined;
  const parts = ticket.split('.');
  if (parts.length !== 3 || parts.some(part => !/^[A-Za-z0-9_-]+$/.test(part))) return undefined;
  const [header, payload, signature] = parts as [string, string, string];
  const expected = createHmac('sha256', options.secret).update(`${header}.${payload}`).digest();
  const actual = Buffer.from(signature, 'base64url');
  if (actual.toString('base64url') !== signature || actual.length !== expected.length || !timingSafeEqual(actual, expected)) return undefined;
  try {
    const head = JSON.parse(Buffer.from(header, 'base64url').toString());
    const value = JSON.parse(Buffer.from(payload, 'base64url').toString());
    const now = Math.floor(Date.now() / 1000);
    if (head?.alg !== 'HS256' || head.typ !== 'arc-relay+jwt' || Object.keys(head).length !== 2 ||
      value?.iss !== options.issuer || value.aud !== options.origin ||
      typeof value.sub !== 'string' || !value.sub || value.sub.length > 512 ||
      typeof value.nonce !== 'string' || !/^[A-Za-z0-9_-]{43}$/.test(value.nonce) ||
      typeof value.jti !== 'string' || !value.jti || value.jti.length > 128 ||
      !Number.isSafeInteger(value.iat) || !Number.isSafeInteger(value.exp) ||
      value.iat > now || value.exp <= now || value.exp <= value.iat || value.exp - value.iat > 900) return undefined;
    if ((value.continuation !== undefined || value.sessionExpiresAt !== undefined) &&
      (typeof value.continuation !== 'string' || !value.continuation || value.continuation.length > 6000 ||
        !Number.isSafeInteger(value.sessionExpiresAt) || value.sessionExpiresAt <= Date.now())) return undefined;
    if (value.authenticatedAt !== undefined && (!Number.isSafeInteger(value.authenticatedAt) || value.authenticatedAt < 0 || value.authenticatedAt > Date.now())) return undefined;
    return { authenticatedAt: value.authenticatedAt, continuation: value.continuation, sessionExpiresAt: value.sessionExpiresAt, subject: value.sub, namespace: createHash('sha256').update(JSON.stringify([value.iss, value.sub])).digest('hex'), expiresAt: value.exp * 1000, ticket, nonce: value.nonce };
  } catch { return undefined; }
}
export function authenticateGatewayRequest(request: Request, options: GatewayAuthOptions): GatewayGrant | undefined {
  const authorization = request.headers.get('authorization');
  const token = authorization ? /^Bearer ([^\s]+)$/i.exec(authorization)?.[1]
    : readGatewayCookie(request, gatewayCookieName(options.origin, 'session'));
  return verifyGatewayGrant(token, options);
}

export function gatewayCookieName(origin: string, kind: 'session' | 'login'): string {
  return `${origin.startsWith('https:') ? '__Host-' : ''}arc_${kind}`;
}
export function readGatewayCookie(request: Request, name: string): string | undefined {
  const matches = (request.headers.get('cookie') ?? '').split(';').map(value => value.trim()).filter(value => value.startsWith(name + '='));
  return matches.length === 1 ? matches[0]?.slice(name.length + 1) : undefined;
}
