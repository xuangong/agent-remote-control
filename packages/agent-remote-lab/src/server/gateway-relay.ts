import { createHash, randomBytes } from 'node:crypto';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import type { Duplex } from 'node:stream';
import { createRemoteHostBroker } from './remote-host-broker.js';
import { authenticateGatewayRequest, gatewayCookieName, readGatewayCookie, validateGatewayOrigin, verifyGatewayGrant, type GatewayAuthOptions, type GatewayGrant } from './gateway-auth.js';

export interface GatewayRelayOptions extends GatewayAuthOptions {
  maxTenants?: number;
  keyLifetimeMs?: number;
  servePage?(request: IncomingMessage, response: ServerResponse): Promise<boolean>;
}
type Tenant = { server: ReturnType<typeof createServer>; broker: ReturnType<typeof createRemoteHostBroker>; expiresAt: number };
export function createGatewayRelay(options: GatewayRelayOptions) {
  const auth = { origin: validateGatewayOrigin(options.origin), issuer: validateGatewayOrigin(options.issuer), secret: options.secret };
  if (Buffer.byteLength(auth.secret) < 32) throw new Error('Gateway signing secret must contain at least 32 bytes.');
  const tenants = new Map<string, Tenant>();
  const pairings = new Map<string, { namespace: string; expiresAt: number }>();
  const loginChallenges = new Map<string, number>();
  const cookieFlags = `Path=/; HttpOnly; SameSite=Strict${auth.origin.startsWith('https:') ? '; Secure' : ''}`;
  const accepted = new WeakMap<IncomingMessage, GatewayGrant>();
  const hash = (value: string) => createHash('sha256').update(value).digest('hex');
  const server = createServer((request, response) => {
    void handle(request, response).catch(() => {
      if (response.headersSent) response.destroy(); else json(response, 503, { error: 'Relay request failed.' });
    });
  });
  server.requestTimeout = 15_000;
  server.headersTimeout = 10_000;
  server.on('upgrade', (request, socket, head) => {
    try { upgrade(request, socket, head); } catch { reject(socket, 503); }
  });
  const sweep = setInterval(() => {
    const now = Date.now();
    for (const [challenge, expiresAt] of loginChallenges) if (expiresAt <= now) loginChallenges.delete(challenge);
    for (const [key, value] of pairings) if (value.expiresAt <= now) pairings.delete(key);
    for (const [namespace, value] of tenants) {
      if (value.expiresAt <= now) { tenants.delete(namespace); void value.broker.close(); }
    }
  }, 30_000);
  sweep.unref();
  function tenant(grant: GatewayGrant): Tenant | undefined {
    let entry = tenants.get(grant.namespace);
    if (!entry) {
      if (tenants.size >= (options.maxTenants ?? 64)) return undefined;
      const dispatcher = createServer((request, response) => {
        const path = new URL(request.url ?? '/', auth.origin).pathname;
        if (path === '/v1/providers' && request.method === 'GET') return json(response, 200, {
          protocolVersion: '1.4.0', type: 'provider_list', payload: { providers: [] },
        });
        json(response, 404, { error: 'Route or session is unavailable.' });
      });
      dispatcher.on('upgrade', (_, socket) => reject(socket, 404));
      const broker = createRemoteHostBroker({
        origin: auth.origin, publicUrl: auth.origin, keyLifetimeMs: options.keyLifetimeMs,
        accessPolicy: { authorize: request => accepted.get(request)?.namespace === grant.namespace },
        mutationPolicy: { validate: () => ({ status: 'allowed' }) },
        connectionExpiresAt: request => accepted.get(request)?.expiresAt,
        onPairing(key, expiresAt) {
          pairings.set(hash(key), { namespace: grant.namespace, expiresAt });
          const owned = tenants.get(grant.namespace);
          if (owned) owned.expiresAt = Math.max(owned.expiresAt, expiresAt);
        },
      });
      broker.install(dispatcher);
      entry = { server: dispatcher, broker, expiresAt: grant.expiresAt };
      tenants.set(grant.namespace, entry);
    }
    entry.expiresAt = Math.max(entry.expiresAt, grant.expiresAt);
    return entry;
  }
  function state(grant: GatewayGrant) { return { basePath: `/u/${grant.namespace}/`, expiresAt: grant.expiresAt, loginUrl: `${auth.issuer}/agent-remote` }; }
  function authorize(request: IncomingMessage, response: ServerResponse): GatewayGrant | undefined {
    const grant = authenticateGatewayRequest(request, auth);
    if (!grant) { json(response, 401, { error: 'Sign in through the gateway.', loginUrl: `${auth.issuer}/agent-remote` }); return; }
    return grant;
  }
  function originAllowed(request: IncomingMessage) { return request.headers.origin === auth.origin; }
  async function handle(request: IncomingMessage, response: ServerResponse) {
    const url = new URL(request.url ?? '/', auth.origin);
    response.setHeader('cache-control', 'no-store');
    response.setHeader('referrer-policy', 'no-referrer');
    response.setHeader('x-content-type-options', 'nosniff');
    if (url.pathname === '/health' && request.method === 'GET') return json(response, 200, { status: 'ok', service: 'agent-remote-gateway-relay' });
    if (url.pathname === '/auth/login' && request.method === 'GET') {
      if (loginChallenges.size >= 4096) return json(response, 429, { error: 'Too many pending sign-ins.' });
      const verifier = randomBytes(32).toString('base64url');
      const challenge = createHash('sha256').update(verifier).digest('base64url');
      loginChallenges.set(challenge, Date.now() + 300_000);
      response.setHeader('set-cookie', `${gatewayCookieName(auth.origin, 'login')}=${verifier}; ${cookieFlags}; Max-Age=300`);
      response.writeHead(303, { location: `${auth.issuer}/agent-remote?challenge=${challenge}` }); response.end(); return;
    }
    if (url.pathname === '/auth/session' && request.method === 'POST') {
      if (!originAllowed(request)) return json(response, 403, { error: 'Origin is not allowed.' });
      if (request.headers['content-type']?.split(';')[0] !== 'application/json') return json(response, 415, { error: 'JSON is required.' });
      const body = await readJson(request);
      const grant = verifyGatewayGrant(body?.ticket, auth);
      if (!grant) return json(response, 401, { error: 'Gateway grant is invalid or expired.' });
      const verifier = readGatewayCookie(request, gatewayCookieName(auth.origin, 'login'));
      const challenge = verifier && /^[A-Za-z0-9_-]{43}$/.test(verifier) ? createHash('sha256').update(verifier).digest('base64url') : undefined;
      if (!challenge || challenge !== grant.nonce || (loginChallenges.get(challenge) ?? 0) <= Date.now()) return json(response, 401, { error: 'Start sign-in from this browser before opening the gateway.' });
      if (!tenant(grant)) return json(response, 429, { error: 'Relay tenant capacity reached.' });
      loginChallenges.delete(challenge);
      response.setHeader('set-cookie', [
        `${gatewayCookieName(auth.origin, 'session')}=${grant.ticket}; ${cookieFlags}; Max-Age=${Math.max(0, Math.floor((grant.expiresAt - Date.now()) / 1000))}`,
        `${gatewayCookieName(auth.origin, 'login')}=; ${cookieFlags}; Max-Age=0`,
      ]);
      return json(response, 200, state(grant));
    }
    if (url.pathname === '/auth/status' && request.method === 'GET') {
      const grant = authorize(request, response); if (grant) json(response, 200, state(grant)); return;
    }
    if (url.pathname === '/auth/logout' && request.method === 'POST') {
      if (!originAllowed(request)) return json(response, 403, { error: 'Origin is not allowed.' });
      response.setHeader('set-cookie', `${gatewayCookieName(auth.origin, 'session')}=; ${cookieFlags}; Max-Age=0`);
      return json(response, 200, { ok: true });
    }
    if (url.pathname === '/auth/callback' && request.method === 'GET') return callback(response);
    if (request.method === 'GET' && !url.pathname.startsWith('/v1/') && !url.pathname.startsWith('/u/') && await options.servePage?.(request, response)) return;
    const grant = authorize(request, response); if (!grant) return;
    if (request.headers.origin && !originAllowed(request)) return json(response, 403, { error: 'Origin is not allowed.' });
    if (request.method !== 'GET') {
      if (!originAllowed(request)) return json(response, 403, { error: 'Origin is required.' });
      if (request.headers['content-type']?.split(';')[0] !== 'application/json') return json(response, 415, { error: 'JSON is required.' });
    }
    const prefix = state(grant).basePath;
    if (!url.pathname.startsWith(prefix)) return json(response, 403, { error: 'User namespace is not accessible.' });
    const owned = tenant(grant); if (!owned) return json(response, 429, { error: 'Relay tenant capacity reached.' });
    accepted.set(request, grant);
    request.url = '/' + url.pathname.slice(prefix.length) + url.search;
    owned.server.emit('request', request, response);
  }
  function upgrade(request: IncomingMessage, socket: Duplex, head: Buffer) {
    const url = new URL(request.url ?? '/', auth.origin);
    if (url.pathname === '/ws/remote-host') {
      const bearer = /^Bearer ([^\s]+)$/i.exec(request.headers.authorization ?? '')?.[1];
      const pairing = bearer && pairings.get(hash(bearer));
      const owned = pairing && pairing.expiresAt > Date.now() && tenants.get(pairing.namespace);
      if (!owned) return reject(socket, 401);
      owned.server.emit('upgrade', request, socket, head); return;
    }
    const grant = authenticateGatewayRequest(request, auth);
    if (!grant) return reject(socket, 401);
    if (!originAllowed(request)) return reject(socket, 403);
    const prefix = state(grant).basePath;
    if (!url.pathname.startsWith(prefix)) return reject(socket, 403);
    const owned = tenants.get(grant.namespace);
    if (!owned) return reject(socket, 404);
    accepted.set(request, grant);
    request.url = '/' + url.pathname.slice(prefix.length) + url.search;
    owned.server.emit('upgrade', request, socket, head);
  }
  return {
    server,
    async listen(port: number, host = '127.0.0.1') {
      await new Promise<void>((resolve, reject) => { server.once('error', reject); server.listen(port, host, () => { server.off('error', reject); resolve(); }); });
      const address = server.address() as AddressInfo;
      if (new URL(auth.origin).port === '0') auth.origin = `http://127.0.0.1:${address.port}`;
      return { port: address.port, url: auth.origin };
    },
    async close() {
      clearInterval(sweep);
      await Promise.all([...tenants.values()].map(value => value.broker.close()));
      tenants.clear(); pairings.clear(); loginChallenges.clear();
      server.closeAllConnections();
      if (server.listening) await new Promise<void>(resolve => server.close(() => resolve()));
    },
  };
}
function json(response: ServerResponse, status: number, value: unknown) {
  response.writeHead(status, { 'content-type': 'application/json' }); response.end(JSON.stringify(value));
}
function reject(socket: Duplex, status: number) { socket.end(`HTTP/1.1 ${status} Rejected\r\nConnection: close\r\nContent-Length: 0\r\n\r\n`); }
async function readJson(request: IncomingMessage): Promise<Record<string, unknown> | undefined> {
  const chunks: Buffer[] = []; let size = 0;
  for await (const chunk of request) { const value = Buffer.from(chunk); size += value.length; if (size > 8192) return undefined; chunks.push(value); }
  try { const value = JSON.parse(Buffer.concat(chunks).toString()); return value && typeof value === 'object' && !Array.isArray(value) ? value : undefined; } catch { return undefined; }
}
function callback(response: ServerResponse) {
  const script = `const ticket=new URLSearchParams(location.hash.slice(1)).get('ticket');history.replaceState(null,'','/auth/callback');fetch('/auth/session',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({ticket})}).then(r=>{if(!r.ok)throw Error();location.replace('/')}).catch(()=>{document.getElementById('status').textContent='Access expired or invalid. Return to the gateway to sign in.'});`;
  const digest = createHash('sha256').update(script).digest('base64');
  response.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'content-security-policy': `default-src 'none'; script-src 'sha256-${digest}'; connect-src 'self'; base-uri 'none'; frame-ancestors 'none'` });
  response.end(`<!doctype html><html lang="en"><meta charset="utf-8"><title>Agent Remote</title><p id="status">Opening your controller…</p><a href="/auth/login">Sign in through gateway</a><script>${script}</script></html>`);
}
