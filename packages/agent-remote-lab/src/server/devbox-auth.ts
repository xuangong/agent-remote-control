import { createHash, createHmac, randomUUID, timingSafeEqual } from 'node:crypto';
import type { GatewayAuthOptions } from '@orchardworks/agent-remote-hosted';
import { readRequestBytes } from '@orchardworks/agent-remote-hosted/request';
import type { GatewayRelayRequestInterceptor } from './gateway-relay.js';

const subject = 'devbox';
const sessionLifetimeMs = 12 * 60 * 60_000;
const json = (status: number, value: unknown) => new Response(JSON.stringify(value), {
  status, headers: { 'content-type': 'application/json', 'cache-control': 'no-store' },
});

/** Local identity is confined to the Devbox entrypoint; hosted sessions remain authoritative. */
export function createDevboxAuthentication(auth: GatewayAuthOptions): GatewayRelayRequestInterceptor {
  const continuation = createHmac('sha256', auth.secret).update('arc-devbox-continuation-v1').digest('base64url');
  const ticket = (nonce: string) => {
    const now = Date.now(); const iat = Math.floor(now / 1000);
    const content = [{ alg: 'HS256', typ: 'arc-relay+jwt' }, { iss: auth.issuer, aud: auth.origin, sub: subject,
      nonce, jti: randomUUID(), iat, exp: iat + 900, authenticatedAt: now, continuation, sessionExpiresAt: now + sessionLifetimeMs }]
      .map(value => Buffer.from(JSON.stringify(value)).toString('base64url')).join('.');
    return content + '.' + createHmac('sha256', auth.secret).update(content).digest('base64url');
  };
  const localBrowser = (request: Request) => !request.headers.has('authorization')
    && (!request.headers.has('origin') || request.headers.get('origin') === auth.origin)
    && request.headers.get('sec-fetch-site') !== 'cross-site';
  return async (request, dispatch) => {
    const url = new URL(request.url);
    if (url.origin !== auth.origin) return json(403, { error: 'Devbox origin is unavailable.' });
    const operation = /^\/api\/agent-remote\/(renew|user-status)$/.exec(url.pathname)?.[1];
    if (operation) {
      if (request.method !== 'POST' || request.headers.has('origin') || request.headers.has('cookie')) return json(401, { error: 'Local service authentication is required.' });
      try {
        const body = new TextDecoder().decode(await readRequestBytes(request, 8192));
        if (!serviceProof(request.headers.get('authorization'), auth, operation, body)) return json(401, { error: 'Local service authentication is required.' });
        const value = JSON.parse(body);
        if (operation === 'renew' ? value?.continuation !== continuation : value?.subject !== subject) return json(403, { active: false });
        const now = Date.now();
        return json(200, { active: true, subject, profile: { name: 'Devbox' }, authenticatedAt: now,
          expiresAt: now + sessionLifetimeMs, validUntil: now + 120_000 });
      } catch { return json(401, { error: 'Local service authentication is required.' }); }
    }
    if (url.pathname === '/agent-remote' && request.method === 'GET') {
      if (!localBrowser(request)) return json(403, { error: 'Devbox requires a local browser request.' });
      const nonce = url.searchParams.get('challenge');
      if (!nonce || !/^[A-Za-z0-9_-]{43}$/.test(nonce)) return new Response(null, { status: 303, headers: { location: '/auth/login', 'cache-control': 'no-store' } });
      return new Response(null, { status: 303, headers: { location: `/auth/callback#ticket=${ticket(nonce)}`, 'cache-control': 'no-store', 'referrer-policy': 'no-referrer' } });
    }
    const status = url.pathname === '/auth/status' && request.method === 'GET';
    const refresh = url.pathname === '/auth/refresh' && request.method === 'POST';
    if (!status && !refresh) return undefined;
    if (!localBrowser(request)) return json(403, { error: 'Devbox requires a local browser request.' });
    const existing = await dispatch(request);
    if (existing?.status !== 401) return localCapabilities(existing);
    const headers = new Headers(request.headers); headers.set('origin', auth.origin);
    headers.delete('content-type'); headers.delete('content-length');
    const login = await dispatch(new Request(auth.origin + '/auth/login', { headers }));
    if (login?.status !== 303) return login ?? json(503, { error: 'Devbox session could not be opened.' });
    const nonce = new URL(login.headers.get('location')!, auth.origin).searchParams.get('challenge');
    if (!nonce) return json(503, { error: 'Devbox session could not be opened.' });
    headers.set('cookie', mergeCookies(headers.get('cookie'), login.headers.getSetCookie()));
    headers.set('content-type', 'application/json');
    const exchanged = await dispatch(new Request(auth.origin + '/auth/session', { method: 'POST', headers, body: JSON.stringify({ ticket: ticket(nonce) }) }));
    return localCapabilities(exchanged);
  };
}

async function localCapabilities(response: Response | undefined): Promise<Response | undefined> {
  if (!response?.ok) return response;
  const value = await response.json();
  const headers = new Headers(response.headers); headers.delete('content-length');
  return new Response(JSON.stringify({ ...value, loginUrl: '/auth/login', auth: { ...value.auth,
    capabilities: { hostOnlyPairing: true, gatewaySetup: false, gatewayControl: false } } }), { status: response.status, headers });
}

function mergeCookies(previous: string | null, updates: string[]) {
  const values = new Map<string, string>();
  for (const part of [...(previous ?? '').split(';'), ...updates.map(value => value.split(';')[0]!)]) {
    const index = part.indexOf('='); if (index < 1) continue;
    values.set(part.slice(0, index).trim(), part.slice(index + 1));
  }
  return [...values].map(([key, value]) => `${key}=${value}`).join('; ');
}

function serviceProof(authorization: string | null, auth: GatewayAuthOptions, operation: string, body: string): boolean {
  const token = /^Bearer ([A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+)$/.exec(authorization ?? '')?.[1];
  if (!token || token.length > 8192) return false;
  const [head, payload, signature] = token.split('.') as [string, string, string];
  const expected = createHmac('sha256', auth.secret).update(head + '.' + payload).digest();
  const actual = Buffer.from(signature, 'base64url');
  if (actual.length !== expected.length || !timingSafeEqual(actual, expected)) return false;
  try {
    const header = JSON.parse(Buffer.from(head, 'base64url').toString());
    const value = JSON.parse(Buffer.from(payload, 'base64url').toString());
    const now = Math.floor(Date.now() / 1000);
    return header.alg === 'HS256' && header.typ === 'arc-relay-service+jwt' && value.iss === auth.origin && value.aud === auth.issuer
      && value.op === operation && value.bodyHash === createHash('sha256').update(body).digest('base64url')
      && Number.isSafeInteger(value.iat) && Number.isSafeInteger(value.exp) && value.iat <= now && value.exp > now && value.exp - value.iat <= 60;
  } catch { return false; }
}
