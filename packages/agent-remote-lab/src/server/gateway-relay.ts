import { createHash, randomBytes } from 'node:crypto';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import type { Duplex } from 'node:stream';
import { createGatewayControlVerifier } from './gateway-control.js';
import { SharingError } from './host-sharing.js';
import { openGatewayState } from './gateway-state.js';
import { createGatewaySessions, type SavedGatewaySession } from './gateway-sessions.js';
import { queryGatewayAuthority } from './gateway-authority.js';
import { createRemoteHostBroker, type RemoteHostBrokerState } from './remote-host-broker.js';
import { gatewayCookieName, readGatewayCookie, validateGatewayOrigin, verifyGatewayGrant, type GatewayAuthOptions, type GatewayGrant } from './gateway-auth.js';

export interface GatewayRelayOptions extends GatewayAuthOptions {
  maxTenants?: number;
  stateFile?: string;
  keyLifetimeMs?: number;
  servePage?(request: IncomingMessage, response: ServerResponse): Promise<boolean>;
}
type SavedState = { version: 1; sessions: SavedGatewaySession[]; tenants: Array<{ subject: string; namespace: string; broker: RemoteHostBrokerState }> };
type Tenant = { subject: string; namespace: string; authorityUntil: number; authorityDenied: boolean; checking?: Promise<'active' | 'denied' | 'unavailable'>; server: ReturnType<typeof createServer>; broker: ReturnType<typeof createRemoteHostBroker>; expiresAt: number };
export function createGatewayRelay(options: GatewayRelayOptions) {
  const auth = { origin: validateGatewayOrigin(options.origin), issuer: validateGatewayOrigin(options.issuer), secret: options.secret };
  if (Buffer.byteLength(auth.secret) < 32) throw new Error('Gateway signing secret must contain at least 32 bytes.');
  const tenants = new Map<string, Tenant>();
  const pairings = new Map<string, { namespace: string; expiresAt: number }>();
  const loginChallenges = new Map<string, { expiresAt: number; hostId?: string }>();
  const verifyControl = createGatewayControlVerifier(auth);
  const cookieFlags = `Path=/; HttpOnly; SameSite=Strict${auth.origin.startsWith('https:') ? '; Secure' : ''}`;
  const accepted = new WeakMap<IncomingMessage, GatewayGrant>();
  const hostRequests = new WeakSet<IncomingMessage>();
  const hash = (value: string) => createHash('sha256').update(value).digest('hex');
  let storage: ReturnType<typeof openGatewayState<SavedState>> | undefined;
  let restoring = false; let closing = false;
  let sessions = createGatewaySessions(auth, [], changed, !!options.stateFile);
  function changed() {
    if (restoring || closing) return;
    try { storage?.save({ version: 1, sessions: sessions.snapshot(), tenants: [...tenants.values()].map(value => ({ subject: value.subject, namespace: value.namespace, broker: value.broker.snapshot() })) }); }
    finally { for (const value of tenants.values()) value.broker.enforceExpiry(); }
  }
  async function activeOwner(owned: Tenant, force = false): Promise<'active' | 'denied' | 'unavailable'> {
    if (!options.stateFile) return 'active';
    if (!force && owned.authorityUntil > Date.now()) return 'active';
    if (owned.checking) return owned.checking;
    owned.checking = (async () => {
      const result = await queryGatewayAuthority(auth, 'user-status', { subject: owned.subject });
      if (closing) return 'unavailable' as const;
      if (result.status === 'active' && result.subject === owned.subject) { owned.authorityUntil = result.validUntil; owned.authorityDenied = false; }
      else if (result.status === 'denied' || result.status === 'active') { owned.authorityUntil = 0; owned.authorityDenied = true; }
      if (owned.authorityUntil <= Date.now()) owned.broker.disconnect(owned.authorityDenied ? 1008 : 1013);
      owned.broker.enforceExpiry();
      return owned.authorityUntil > Date.now() ? 'active' as const : owned.authorityDenied ? 'denied' as const : 'unavailable' as const;
    })();
    try { return await owned.checking; } finally { owned.checking = undefined; }
  }
  const server = createServer((request, response) => {
    void handle(request, response).catch(() => {
      if (response.headersSent) response.destroy(); else json(response, 503, { error: 'Relay request failed.' });
    });
  });
  server.requestTimeout = 15_000;
  server.headersTimeout = 10_000;
  server.on('upgrade', (request, socket, head) => {
    void upgrade(request, socket, head).catch(() => reject(socket, 503));
  });
  const sweep = setInterval(() => {
    const now = Date.now();
    for (const [challenge, value] of loginChallenges) if (value.expiresAt <= now) loginChallenges.delete(challenge);
    for (const [key, value] of pairings) if (value.expiresAt <= now) pairings.delete(key);
    for (const [namespace, value] of tenants) {
      if (!options.stateFile && value.expiresAt <= now) { tenants.delete(namespace); void value.broker.close(); }
    }
  }, 30_000);
  sweep.unref();
  const renewal = setInterval(() => { void sessions.refreshAll(); for (const owned of tenants.values()) void activeOwner(owned, true); }, 60_000);
  renewal.unref();
  function tenant(grant: GatewayGrant, initialState?: RemoteHostBrokerState): Tenant | undefined {
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
        ownerSubject: grant.subject, principalSubject: request => accepted.get(request)?.subject,
        durable: !!options.stateFile, initialState,
        onStateChange(value) {
          for (const [key, pairing] of pairings) if (pairing.namespace === grant.namespace) pairings.delete(key);
          for (const [key, credential] of value.keys) pairings.set(key, { namespace: grant.namespace, expiresAt: credential.expires });
          changed();
        },
        accessPolicy: { authorize: request => accepted.has(request) && (accepted.get(request)?.expiresAt ?? 0) > Date.now() },
        mutationPolicy: { validate: () => ({ status: 'allowed' }) },
        connectionExpiresAt: request => hostRequests.has(request) && options.stateFile
          ? (tenants.get(grant.namespace)?.authorityUntil ?? 0) : accepted.get(request)?.expiresAt,
        connectionExpiryCode: request => hostRequests.has(request) && !tenants.get(grant.namespace)?.authorityDenied ? 1013 : 1008,
        onPairing(key, expiresAt) {
          pairings.set(hash(key), { namespace: grant.namespace, expiresAt });
          const owned = tenants.get(grant.namespace);
          if (owned) owned.expiresAt = Math.max(owned.expiresAt, expiresAt);
        },
      });
      broker.install(dispatcher);
      entry = { subject: grant.subject, namespace: grant.namespace, authorityUntil: 0, authorityDenied: false, server: dispatcher, broker, expiresAt: grant.expiresAt };
      tenants.set(grant.namespace, entry);
      for (const [key, credential] of initialState?.keys ?? []) pairings.set(key, { namespace: grant.namespace, expiresAt: credential.expires });
    }
    entry.expiresAt = Math.max(entry.expiresAt, grant.expiresAt);
    return entry;
  }
  function state(grant: GatewayGrant) { return { basePath: `/u/${grant.namespace}/`, expiresAt: grant.expiresAt, ...(grant.continuation ? { refreshAfterMs: Math.max(250, Math.min(60_000, (grant.expiresAt - Date.now()) / 2)) } : {}), loginUrl: `${auth.issuer}/agent-remote` }; }
  async function authorize(request: IncomingMessage, response: ServerResponse, refresh = false): Promise<GatewayGrant | undefined> {
    const result = await sessions.authenticate(request, refresh);
    if (!result.grant) { json(response, result.unavailable ? 503 : 401, { error: 'Sign in through the gateway.', loginUrl: `${auth.issuer}/agent-remote` }); return; }
    return result.grant;
  }
  function originAllowed(request: IncomingMessage) { return request.headers.origin === auth.origin; }
  async function handle(request: IncomingMessage, response: ServerResponse) {
    const url = new URL(request.url ?? '/', auth.origin);
    response.setHeader('cache-control', 'no-store');
    response.setHeader('referrer-policy', 'no-referrer');
    response.setHeader('x-content-type-options', 'nosniff');
    if (url.pathname === '/health' && request.method === 'GET') return json(response, 200, { status: 'ok', service: 'agent-remote-gateway-relay' });
    if (url.pathname === '/gateway/control') {
      try {
        const control = await verifyControl(request);
        if (control.operation === 'hosts') return json(response, 200, { hosts: [...tenants.values()].flatMap(value => value.broker.visibleHosts(control.subject)) });
        const target = [...tenants.values()].find(value => value.broker.hasHost(control.hostId!));
        if (!target) return json(response, 404, { error: 'Host is unavailable.' });
        return json(response, 200, target.broker.manageShares(control.subject, control.hostId!, control.operation, control.targetSubject, control.targetLabel, control.sessionLimit));
      } catch (error) {
        if (error instanceof SharingError) return json(response, error.status, { code: error.code, error: error.message });
        throw error;
      }
    }
    if (url.pathname === '/auth/login' && request.method === 'GET') {
      if (loginChallenges.size >= 4096) return json(response, 429, { error: 'Too many pending sign-ins.' });
      const verifier = randomBytes(32).toString('base64url');
      const challenge = createHash('sha256').update(verifier).digest('base64url');
      const hostId = url.searchParams.get('host') ?? undefined;
      if (hostId !== undefined && !/^[A-Za-z0-9_-]{1,256}$/.test(hostId)) return json(response, 400, { error: 'Invalid Host.' });
      loginChallenges.set(challenge, { expiresAt: Date.now() + 300_000, ...(hostId ? { hostId } : {}) });
      response.setHeader('set-cookie', `${gatewayCookieName(auth.origin, 'login')}=${verifier}; ${cookieFlags}; Max-Age=300`);
      response.writeHead(303, { location: `${auth.issuer}/agent-remote?challenge=${challenge}${hostId ? '&host=' + encodeURIComponent(hostId) : ''}` }); response.end(); return;
    }
    if (url.pathname === '/auth/session' && request.method === 'POST') {
      if (!originAllowed(request)) return json(response, 403, { error: 'Origin is not allowed.' });
      if (request.headers['content-type']?.split(';')[0] !== 'application/json') return json(response, 415, { error: 'JSON is required.' });
      const body = await readJson(request);
      const grant = verifyGatewayGrant(body?.ticket, auth);
      if (!grant) return json(response, 401, { error: 'Gateway grant is invalid or expired.' });
      const verifier = readGatewayCookie(request, gatewayCookieName(auth.origin, 'login'));
      const challenge = verifier && /^[A-Za-z0-9_-]{43}$/.test(verifier) ? createHash('sha256').update(verifier).digest('base64url') : undefined;
      if (!challenge || challenge !== grant.nonce || (loginChallenges.get(challenge)?.expiresAt ?? 0) <= Date.now()) return json(response, 401, { error: 'Start sign-in from this browser before opening the gateway.' });
      const owned = tenant(grant);
      if (!owned) return json(response, 429, { error: 'Relay tenant capacity reached.' });
      const initialHost = loginChallenges.get(challenge)?.hostId;
      loginChallenges.delete(challenge);
      const exchange = await sessions.exchange(grant);
      if (exchange.status !== 'active') return json(response, exchange.status === 'unavailable' ? 503 : exchange.status === 'capacity' ? 429 : 401, { error: 'Gateway access could not be renewed.' });
      if (grant.continuation) { owned.authorityUntil = exchange.grant.expiresAt; owned.authorityDenied = false; }
      changed();
      response.setHeader('set-cookie', [
        `${gatewayCookieName(auth.origin, 'session')}=${exchange.token}; ${cookieFlags}; Max-Age=${Math.max(0, Math.floor((exchange.expiresAt - Date.now()) / 1000))}`,
        `${gatewayCookieName(auth.origin, 'login')}=; ${cookieFlags}; Max-Age=0`,
      ]);
      return json(response, 200, { ...state(exchange.grant), ...(initialHost ? { hostId: initialHost } : {}) });
    }
    if (url.pathname === '/auth/status' && request.method === 'GET') {
      const grant = await authorize(request, response); if (grant) json(response, 200, state(grant)); return;
    }
    if (url.pathname === '/auth/refresh' && request.method === 'POST') {
      if (!originAllowed(request)) return json(response, 403, { error: 'Origin is not allowed.' });
      const grant = await authorize(request, response, true); if (grant) json(response, 200, state(grant)); return;
    }
    if (url.pathname === '/auth/logout' && request.method === 'POST') {
      if (!originAllowed(request)) return json(response, 403, { error: 'Origin is not allowed.' });
      sessions.logout(request);
      response.setHeader('set-cookie', `${gatewayCookieName(auth.origin, 'session')}=; ${cookieFlags}; Max-Age=0`);
      return json(response, 200, { ok: true });
    }
    if (url.pathname === '/auth/callback' && request.method === 'GET') return callback(response);
    if (request.method === 'GET' && !url.pathname.startsWith('/v1/') && !url.pathname.startsWith('/u/') && await options.servePage?.(request, response)) return;
    const grant = await authorize(request, response); if (!grant) return;
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
    const relative = new URL(request.url, auth.origin).pathname;
    if (relative === '/v1/remote/hosts' && request.method === 'GET') return json(response, 200, { hosts: [...tenants.values()].flatMap(value => value.broker.visibleHosts(grant.subject)) });
    const destination = routeTenant(relative, grant.subject) ?? owned;
    destination.server.emit('request', request, response);
  }
  function routeTenant(path: string, subject: string): Tenant | undefined {
    const host = /^\/v1\/remote\/hosts\/([^/]+)/.exec(path);
    if (host) return [...tenants.values()].find(value => value.broker.canAccessHost(host[1]!, subject));
    const session = /^\/v1\/sessions\/([^/]+)/.exec(path);
    if (session) return [...tenants.values()].find(value => value.broker.canAccessSession(session[1]!, subject));
    return undefined;
  }
  async function upgrade(request: IncomingMessage, socket: Duplex, head: Buffer) {
    const url = new URL(request.url ?? '/', auth.origin);
    if (url.pathname === '/ws/remote-host') {
      const bearer = /^Bearer ([^\s]+)$/i.exec(request.headers.authorization ?? '')?.[1];
      const pairing = bearer && pairings.get(hash(bearer));
      const owned = pairing && pairing.expiresAt > Date.now() && tenants.get(pairing.namespace);
      if (!owned) return reject(socket, 401);
      const access = await activeOwner(owned);
      if (access !== 'active') return reject(socket, access === 'denied' ? 401 : 503);
      hostRequests.add(request);
      owned.server.emit('upgrade', request, socket, head); return;
    }
    const { grant } = await sessions.authenticate(request);
    if (!grant) return reject(socket, 401);
    if (!originAllowed(request)) return reject(socket, 403);
    const prefix = state(grant).basePath;
    if (!url.pathname.startsWith(prefix)) return reject(socket, 403);
    const owned = tenants.get(grant.namespace);
    if (!owned) return reject(socket, 404);
    accepted.set(request, grant);
    request.url = '/' + url.pathname.slice(prefix.length) + url.search;
    const destination = routeTenant(new URL(request.url, auth.origin).pathname, grant.subject) ?? owned;
    destination.server.emit('upgrade', request, socket, head);
  }
  return {
    server,
    async listen(port: number, host = '127.0.0.1') {
      await new Promise<void>((resolve, reject) => { server.once('error', reject); server.listen(port, host, () => { server.off('error', reject); resolve(); }); });
      const address = server.address() as AddressInfo;
      if (new URL(auth.origin).port === '0') auth.origin = `http://127.0.0.1:${address.port}`;
      if (options.stateFile) {
        try {
          storage = openGatewayState<SavedState>(options.stateFile, auth.secret, JSON.stringify([auth.origin, auth.issuer]));
          const saved = storage.initial;
          if (saved && (saved.version !== 1 || !Array.isArray(saved.sessions) || !Array.isArray(saved.tenants))) throw new Error('Unsupported Relay state format.');
          restoring = true;
          sessions.close(); sessions = createGatewaySessions(auth, saved?.sessions ?? [], changed, true);
          for (const item of saved?.tenants ?? []) {
            const owned = tenant({ subject: item.subject, namespace: item.namespace, expiresAt: Number.MAX_SAFE_INTEGER, ticket: '', nonce: '' }, item.broker);
            if (!owned) throw new Error('Stored Relay tenants exceed configured capacity.');
          }
          restoring = false;
        } catch (error) { storage?.close(); clearInterval(sweep); clearInterval(renewal); server.close(); throw error; }
      }
      return { port: address.port, url: auth.origin };
    },
    async close() {
      closing = true; sessions.close(); clearInterval(renewal); clearInterval(sweep);
      await Promise.all([...tenants.values()].map(value => value.broker.close()));
      tenants.clear(); pairings.clear(); loginChallenges.clear(); storage?.close();
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
  for await (const chunk of request) { const value = Buffer.from(chunk); size += value.length; if (size > 16384) return undefined; chunks.push(value); }
  try { const value = JSON.parse(Buffer.concat(chunks).toString()); return value && typeof value === 'object' && !Array.isArray(value) ? value : undefined; } catch { return undefined; }
}
function callback(response: ServerResponse) {
  const script = `const ticket=new URLSearchParams(location.hash.slice(1)).get('ticket');history.replaceState(null,'','/auth/callback');fetch('/auth/session',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({ticket})}).then(async r=>{if(!r.ok)throw Error();const state=await r.json();location.replace(state.hostId?'/?host='+encodeURIComponent(state.hostId):'/')}).catch(()=>{document.getElementById('status').textContent='Access expired or invalid. Return to the gateway to sign in.'});`;
  const digest = createHash('sha256').update(script).digest('base64');
  response.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'content-security-policy': `default-src 'none'; script-src 'sha256-${digest}'; connect-src 'self'; base-uri 'none'; frame-ancestors 'none'` });
  response.end(`<!doctype html><html lang="en"><meta charset="utf-8"><title>Agent Remote</title><p id="status">Opening your controller…</p><a href="/auth/login">Sign in through gateway</a><script>${script}</script></html>`);
}
