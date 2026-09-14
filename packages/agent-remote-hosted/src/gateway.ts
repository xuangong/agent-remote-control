import { createSecurityPolicy } from './security.js';
import { authenticationCallback } from './auth-callback.js';
import { controllerPath, readControllerLocation } from './controller-location.js';
import { createHash, randomBytes } from 'node:crypto';
import { createHostBroker, type RemoteHostBrokerState } from './broker.js';
import { createGatewayControlVerifier } from './control.js';
import { SharingError } from './host-sharing.js';
import { createGatewaySessions } from './sessions.js';
import { queryGatewayAuthority } from './authority.js';
import { createRelayState, type RelayStateStore } from './state.js';
import { createTimerRelayScheduler, type RelayScheduler } from './scheduler.js';
import { readJson } from './request.js';
import type { BrokerRequestContext, RelaySocket } from './transport.js';
import { gatewayCookieName, readGatewayCookie, validateGatewayOrigin, verifyGatewayGrant, type GatewayAuthOptions, type GatewayGrant } from './auth.js';

export interface HostedRelayOptions extends GatewayAuthOptions {
  storage?: RelayStateStore;
  scheduler?: RelayScheduler;
  maxTenants?: number;
  clientAddress?(request: Request): string;
  keyLifetimeMs?: number;
}
type Tenant = { subject: string; namespace: string; authorityUntil: number; authorityDenied: boolean;
  checking?: Promise<'active' | 'denied' | 'unavailable'>; broker: ReturnType<typeof createHostBroker>; expiresAt: number };
export function createHostedRelay(options: HostedRelayOptions) {
  const auth = { origin: validateGatewayOrigin(options.origin), issuer: validateGatewayOrigin(options.issuer), secret: options.secret };
  if (Buffer.byteLength(auth.secret) < 32) throw new Error('Gateway signing secret must contain at least 32 bytes.');
  const tenants = new Map<string, Tenant>();
  const scheduler = options.scheduler ?? createTimerRelayScheduler();
  const durable = options.storage !== undefined;
  const cookieFlags = `Path=/; HttpOnly; SameSite=Strict${auth.origin.startsWith('https:') ? '; Secure' : ''}`;
  const hash = (value: string) => createHash('sha256').update(value).digest('hex');
  let closing = false; let failed = false; let initialized = false; let refreshing: Promise<void> | undefined;
  let scheduling: Promise<unknown> = Promise.resolve();
  let renewalAt = Date.now() + 60_000;
  const state = createRelayState(auth, options.storage, failClosed, published);
  const sessions = createGatewaySessions(auth, state, durable);
  const security = createSecurityPolicy(state);
  const verifyControl = createGatewayControlVerifier(auth, state);
  function failClosed() {
    failed = true;
    for (const owned of tenants.values()) owned.broker.close();
    void Promise.resolve(scheduler.cancel()).catch(() => undefined);
  }
  function available() { if (closing || failed) throw new Error('Relay state is unavailable.'); state.assertAvailable(); }
  function published() {
    for (const owned of tenants.values()) owned.broker.enforceExpiry();
    if (initialized && !refreshing) queueSchedule();
  }
  function queueSchedule() {
    if (closing || failed) return;
    const due = [renewalAt, ...state.read().loginChallenges.map(([, value]) => value.expiresAt), ...state.read().consumedProofs.map(([, expires]) => expires * 1000)];
    for (const owned of tenants.values()) {
      if (!durable) due.push(owned.expiresAt);
      if (owned.authorityUntil > Date.now()) due.push(owned.authorityUntil);
    }
    for (const session of state.read().sessions) {
      due.push(session.sessionExpiresAt);
      if (session.grant.expiresAt > Date.now()) due.push(session.grant.expiresAt);
    }
    const deadline = Math.max(Date.now() + 1, Math.min(...due));
    scheduling = scheduling.then(() => closing || failed ? undefined : scheduler.schedule(deadline, refresh)).catch(error => { failClosed(); throw error; });
    void scheduling.catch(() => undefined);
  }
  async function activeOwner(owned: Tenant, force = false): Promise<'active' | 'denied' | 'unavailable'> {
    if (!durable) return 'active';
    if (!force && owned.authorityUntil > Date.now()) return 'active';
    if (owned.checking) return owned.checking;
    owned.checking = (async () => {
      const result = await queryGatewayAuthority(auth, 'user-status', { subject: owned.subject });
      if (closing || failed) return 'unavailable' as const;
      if (result.status === 'active' && result.subject === owned.subject) { owned.authorityUntil = result.validUntil; owned.authorityDenied = false; }
      else if (result.status === 'denied' || result.status === 'active') { owned.authorityUntil = 0; owned.authorityDenied = true; }
      if (owned.authorityUntil <= Date.now()) {
        owned.authorityUntil = 0;
        owned.broker.disconnect(owned.authorityDenied ? 1008 : 1013);
      }
      owned.broker.enforceExpiry();
      if (!refreshing) queueSchedule();
      return owned.authorityUntil > Date.now() ? 'active' as const : owned.authorityDenied ? 'denied' as const : 'unavailable' as const;
    })();
    try { return await owned.checking; } finally { owned.checking = undefined; }
  }
  function tenant(grant: GatewayGrant, initialState?: RemoteHostBrokerState): Tenant | undefined {
    let entry = tenants.get(grant.namespace);
    if (!entry) {
      if (tenants.size >= (options.maxTenants ?? 64)) return undefined;
      const broker = createHostBroker({ origin: auth.origin, publicUrl: auth.origin, keyLifetimeMs: options.keyLifetimeMs,
        ownerSubject: grant.subject, durable, initialState,
        userStreamCount: subject => [...tenants.values()].reduce((sum, owned) => sum + owned.broker.activeStreamCount(subject), 0),
        onStateChange: async broker => { await state.mutate(draft => {
          const previous = draft.tenants.find(value => value.namespace === grant.namespace);
          if (previous) previous.broker = broker;
          else draft.tenants.push({ subject: grant.subject, namespace: grant.namespace, broker });
        }); await scheduling; },
        onPairing(_key, expiresAt) { const owned = tenants.get(grant.namespace); if (owned) owned.expiresAt = Math.max(owned.expiresAt, expiresAt); },
      });
      entry = { subject: grant.subject, namespace: grant.namespace, authorityUntil: 0, authorityDenied: false, broker, expiresAt: grant.expiresAt };
      tenants.set(grant.namespace, entry);
    }
    entry.expiresAt = Math.max(entry.expiresAt, grant.expiresAt);
    return entry;
  }
  for (const item of state.read().tenants) {
    if (!tenant({ subject: item.subject, namespace: item.namespace, expiresAt: Number.MAX_SAFE_INTEGER, ticket: '', nonce: '' }, item.broker)) throw new Error('Stored Relay tenants exceed configured capacity.');
  }
  initialized = true; queueSchedule();
  function browserState(grant: GatewayGrant) { return { basePath: `/u/${grant.namespace}/`, expiresAt: grant.expiresAt,
    ...(grant.continuation ? { refreshAfterMs: Math.max(250, Math.min(60_000, (grant.expiresAt - Date.now()) / 2)) } : {}), loginUrl: `${auth.issuer}/agent-remote` }; }
  async function authorize(request: Request, refresh = false): Promise<GatewayGrant | Response> {
    const result = await sessions.authenticate(request, refresh);
    if (!result.grant) return json(result.unavailable ? 503 : 401, { error: 'Sign in through the gateway.', loginUrl: `${auth.issuer}/agent-remote` });
    return result.grant;
  }
  const originAllowed = (request: Request) => request.headers.get('origin') === auth.origin;
  function context(request: Request, grant: GatewayGrant): BrokerRequestContext {
    return { principalSubject: () => grant.subject, authorizeMessage: raw => {
      try { const message = JSON.parse(raw); return message.type !== 'set_session_setting' || !['approval', 'sandbox', 'permissions'].includes(message.payload?.settingId) || security.recent(grant.authenticatedAt); } catch { return true; }
    }, authorize: () => !closing && !failed && sessions.expiresAt(request, grant) > Date.now(),
      validateMutation: () => ({ status: 'allowed' }), connectionExpiresAt: () => failed || closing ? 0 : sessions.expiresAt(request, grant) };
  }
  function relativeRequest(request: Request, prefix: string): Request {
    const url = new URL(request.url); url.pathname = '/' + url.pathname.slice(prefix.length);
    return new Request(url, request);
  }
  function routeTenant(path: string, subject: string): Tenant | undefined {
    const host = /^\/v1\/remote\/hosts\/([^/]+)/.exec(path);
    if (host) return [...tenants.values()].find(value => value.broker.canAccessHost(host[1]!, subject));
    const session = /^\/v1\/sessions\/([^/]+)/.exec(path);
    if (session) return [...tenants.values()].find(value => value.broker.canAccessSession(session[1]!, subject));
    return undefined;
  }
  async function handle(request: Request): Promise<Response | undefined> {
    const url = new URL(request.url);
    if (url.pathname === '/health' && request.method === 'GET') return json(200, { status: 'ok', service: 'agent-remote-gateway-relay' });
    if (url.pathname === '/gateway/control') {
      const control = await verifyControl(request);
      if (control.operation === 'hosts') return json(200, { hosts: [...tenants.values()].flatMap(value => value.broker.visibleHosts(control.subject)) });
      const target = [...tenants.values()].find(value => value.broker.hasHost(control.hostId!));
      if (!target) return json(404, { error: 'Host is unavailable.' });
      const result = await target.broker.manageShares(control.subject, control.hostId!, control.operation, control.targetSubject, control.targetLabel, control.sessionLimit);
      if (control.operation !== 'shares') await security.record(control.subject, control.operation === 'share' ? 'host_shared' : 'share_revoked', 'allowed', control.hostId);
      return json(200, result);
    }
    if (url.pathname === '/auth/login' && request.method === 'GET') {
      if (!security.allow('login:' + (options.clientAddress?.(request) ?? 'unknown'), 30, 60_000) || !security.allow('login:global', 300, 60_000)) return json(429, {error:'Too many sign-in attempts. Try again shortly.'});
      const reauthenticate = url.searchParams.get('reauthenticate');
      if (reauthenticate !== null && reauthenticate !== '1') return json(400, {error:'Invalid authentication request.'});
      let returnPath: string;
      try { returnPath = controllerPath(readControllerLocation(url.searchParams)); }
      catch { return json(400, { error: 'Invalid session link.' }); }
      const hostId = url.searchParams.get('host') ?? undefined;
      const verifier = randomBytes(32).toString('base64url');
      const challenge = createHash('sha256').update(verifier).digest('base64url');
      const added = await state.mutate(draft => {
        draft.loginChallenges = draft.loginChallenges.filter(([, value]) => value.expiresAt > Date.now());
        if (draft.loginChallenges.length >= 4096) return false;
        draft.loginChallenges.push([challenge, { expiresAt: Date.now() + 300_000, returnPath, ...(hostId ? { hostId } : {}) }]); return true;
      });
      if (!added) return json(429, { error: 'Too many pending sign-ins.' });
      return new Response(null, { status: 303, headers: {
        'set-cookie': `${gatewayCookieName(auth.origin, 'login')}=${verifier}; ${cookieFlags}; Max-Age=300`,
        location: `${auth.issuer}/agent-remote?challenge=${challenge}${hostId ? '&host=' + encodeURIComponent(hostId) : ''}${reauthenticate ? '&reauthenticate=1' : ''}`,
      } });
    }
    if (url.pathname === '/auth/session' && request.method === 'POST') {
      if (!originAllowed(request)) return json(403, { error: 'Origin is not allowed.' });
      if (request.headers.get('content-type')?.split(';')[0] !== 'application/json') return json(415, { error: 'JSON is required.' });
      const body = await readJson(request); const grant = verifyGatewayGrant(body?.ticket, auth);
      if (!grant) return json(401, { error: 'Gateway grant is invalid or expired.' });
      const verifier = readGatewayCookie(request, gatewayCookieName(auth.origin, 'login'));
      const challenge = verifier && /^[A-Za-z0-9_-]{43}$/.test(verifier) ? createHash('sha256').update(verifier).digest('base64url') : undefined;
      if (!challenge || challenge !== grant.nonce) return json(401, { error: 'Start sign-in from this browser before opening the gateway.' });
      const owned = tenant(grant); if (!owned) return json(429, { error: 'Relay tenant capacity reached.' });
      const pending = await state.mutate(draft => {
        const entry = draft.loginChallenges.find(([key, value]) => key === challenge && value.expiresAt > Date.now());
        if (!entry) return undefined;
        draft.loginChallenges = draft.loginChallenges.filter(([key]) => key !== challenge); return entry[1];
      });
      if (!pending) return json(401, { error: 'Start sign-in from this browser before opening the gateway.' });
      const exchange = await sessions.exchange(grant, request);
      if (exchange.status !== 'active') return json(exchange.status === 'unavailable' ? 503 : exchange.status === 'capacity' ? 429 : 401, { error: 'Gateway access could not be renewed.' });
      if (grant.continuation) { owned.authorityUntil = exchange.grant.expiresAt; owned.authorityDenied = false; }
      await security.record(grant.subject, 'signed_in', 'allowed');
      const response = json(200, { ...browserState(exchange.grant), ...(pending.returnPath ? { returnPath: pending.returnPath } : {}), ...(pending.hostId ? { hostId: pending.hostId } : {}) });
      response.headers.append('set-cookie', `${gatewayCookieName(auth.origin, 'session')}=${exchange.token}; ${cookieFlags}; Max-Age=${Math.max(0, Math.floor((exchange.expiresAt - Date.now()) / 1000))}`);
      response.headers.append('set-cookie', `${gatewayCookieName(auth.origin, 'login')}=; ${cookieFlags}; Max-Age=0`);
      return response;
    }
    if (url.pathname === '/auth/status' && request.method === 'GET') {
      const grant = await authorize(request); return grant instanceof Response ? grant : json(200, browserState(grant));
    }
    if (['/auth/refresh', '/auth/logout'].includes(url.pathname) && request.method === 'POST') {
      if (!originAllowed(request)) return json(403, {error:'Origin is not allowed.'});
      if (request.headers.get('content-type')?.split(';')[0] !== 'application/json') return json(415, {error:'JSON is required.'});
      const body = await readJson(request);
      if (!body || Object.keys(body).length) return json(400, {error:'No parameters are accepted.'});
      const credential = readGatewayCookie(request, gatewayCookieName(auth.origin, 'session')) ?? '';
      if (!security.allow(url.pathname + ':' + hash(credential), 30, 60_000) || !security.allow(url.pathname + ':global', 600, 60_000)) return json(429, {error:'Too many authentication requests.'});
    }
    if (url.pathname === '/auth/refresh' && request.method === 'POST') {
      if (!originAllowed(request)) return json(403, { error: 'Origin is not allowed.' });
      const grant = await authorize(request, true); return grant instanceof Response ? grant : json(200, browserState(grant));
    }
    if (url.pathname === '/auth/logout' && request.method === 'POST') {
      if (!originAllowed(request)) return json(403, { error: 'Origin is not allowed.' });
      const current = await sessions.authenticate(request);
      await sessions.logout(request);
      if (current.grant) await security.record(current.grant.subject, 'signed_out', 'allowed');
      const response = json(200, { ok: true });
      response.headers.set('set-cookie', `${gatewayCookieName(auth.origin, 'session')}=; ${cookieFlags}; Max-Age=0`); return response;
    }
    if (['/auth/sessions', '/auth/sessions/revoke', '/auth/sessions/revoke-all', '/auth/audit'].includes(url.pathname)) {
      const grant = await authorize(request); if (grant instanceof Response) return grant;
      if (request.headers.has('origin') && !originAllowed(request)) return json(403, {error:'Origin is not allowed.'});
      if (request.method === 'GET' && url.pathname === '/auth/sessions') return json(200, {sessions:sessions.list(grant.subject, request), authenticatedAt:grant.authenticatedAt ?? null, recentAuthentication:security.recent(grant.authenticatedAt)});
      if (request.method === 'GET' && url.pathname === '/auth/audit') return json(200, {events:security.events(grant.subject)});
      if (request.method !== 'POST' || !originAllowed(request)) return json(403, {error:'Same-origin POST is required.'});
      if (request.headers.get('content-type')?.split(';')[0] !== 'application/json') return json(415, {error:'JSON is required.'});
      if (!security.allow('security:' + grant.subject, 30, 60_000)) return json(429, {error:'Too many security requests.'});
      const body = await readJson(request);
      let current = false;
      if (url.pathname === '/auth/sessions/revoke') {
        if (!body || Object.keys(body).length !== 1 || typeof body.id !== 'string' || body.id.length > 128) return json(400, {error:'A browser session ID is required.'});
        const result = await sessions.revoke(grant.subject, body.id, request);
        if (!result.found) return json(404, {error:'Browser session is unavailable.'});
        current = result.current;
        await security.record(grant.subject, 'session_revoked', 'allowed');
      } else if (url.pathname === '/auth/sessions/revoke-all') {
        if (!body || Object.keys(body).length) return json(400, {error:'No parameters are accepted.'});
        await sessions.revokeAll(grant.subject); current = true;
        await security.record(grant.subject, 'all_sessions_revoked', 'allowed');
      } else return json(405, {error:'Method is not allowed.'});
      const response = json(200, {ok:true,current});
      if (current) response.headers.set('set-cookie', `${gatewayCookieName(auth.origin, 'session')}=; ${cookieFlags}; Max-Age=0`);
      return response;
    }
    if (url.pathname === '/auth/callback' && request.method === 'GET') return authenticationCallback(auth.origin);
    if (request.method === 'GET' && !url.pathname.startsWith('/v1/') && !url.pathname.startsWith('/u/') && !url.pathname.startsWith('/auth/')) return undefined;
    const grant = await authorize(request); if (grant instanceof Response) return grant;
    if (request.headers.has('origin') && !originAllowed(request)) return json(403, { error: 'Origin is not allowed.' });
    if (request.method !== 'GET') {
      if (!originAllowed(request)) return json(403, { error: 'Origin is required.' });
      if (request.headers.get('content-type')?.split(';')[0] !== 'application/json') return json(415, { error: 'JSON is required.' });
    }
    const prefix = browserState(grant).basePath;
    if (!url.pathname.startsWith(prefix)) return json(403, { error: 'User namespace is not accessible.' });
    const owned = tenant(grant); if (!owned) return json(429, { error: 'Relay tenant capacity reached.' });
    const relative = relativeRequest(request, prefix); const path = new URL(relative.url).pathname;
    if (path === '/v1/remote/hosts' && request.method === 'GET') return json(200, { hosts: [...tenants.values()].flatMap(value => value.broker.visibleHosts(grant.subject)) });
    if (request.method !== 'GET') {
      if (!security.allow('mutation:' + grant.subject, 60, 60_000)) return json(429, {error:'Too many control requests.'});
      const sensitive = path === '/v1/remote/pairings' || /\/rotate$/.test(path);
      if (sensitive && durable && !security.recent(grant.authenticatedAt)) {
        await security.record(grant.subject, 'recent_authentication_required', 'denied');
        return json(403, {code:'reauthentication_required',error:'Sign in again before managing device credentials.',loginUrl:'/auth/login?reauthenticate=1'});
      }
      if (path === '/v1/remote/pairings' && !security.allow('pair:' + grant.subject, 5, 60_000)) return json(429, {error:'Too many pairing invitations.'});
    }
    const destination = routeTenant(path, grant.subject) ?? owned;
    const result = await destination.broker.handleRequest(relative, context(request, grant));
    if (request.method !== 'GET' && result) {
      const action = path === '/v1/remote/pairings' ? 'pairing_created' : /\/revoke$/.test(path) ? 'host_revoked' : /\/rotate$/.test(path) ? 'credential_rotation_requested' : /\/stop$/.test(path) ? 'host_stop_requested' : undefined;
      if (action) await security.record(grant.subject, action, result.ok ? 'allowed' : 'denied', /^\/v1\/remote\/hosts\/([^/]+)/.exec(path)?.[1]);
    }
    return result ?? (path === '/v1/providers' && request.method === 'GET'
      ? json(200, { protocolVersion: '1.4.0', type: 'provider_list', payload: { providers: [] } })
      : json(404, { error: 'Route or session is unavailable.' }));
  }
  async function prepare(request: Request) {
    const url = new URL(request.url);
    if (url.pathname === '/ws/remote-host') {
      const bearer = /^Bearer ([^\s]+)$/i.exec(request.headers.get('authorization') ?? '')?.[1];
      const credential = bearer && hash(bearer);
      const owned = credential && [...tenants.values()].find(value => value.broker.snapshot().keys.some(([key, value]) => key === credential && value.expires > Date.now()));
      if (!owned) return json(401, {});
      const access = await activeOwner(owned);
      if (access !== 'active') return json(access === 'denied' ? 401 : 503, {});
      return owned.broker.prepareUpgrade(request, { connectionExpiresAt: () => failed || closing ? 0 : durable ? owned.authorityUntil : undefined,
        connectionExpiryCode: () => owned.authorityDenied ? 1008 : 1013 });
    }
    const { grant } = await sessions.authenticate(request); if (!grant) return json(401, {});
    if (!originAllowed(request)) return json(403, {});
    const prefix = browserState(grant).basePath;
    if (!url.pathname.startsWith(prefix)) return json(403, {});
    const owned = tenants.get(grant.namespace); if (!owned) return json(404, {});
    const relative = relativeRequest(request, prefix);
    const destination = routeTenant(new URL(relative.url).pathname, grant.subject) ?? owned;
    return await destination.broker.prepareUpgrade(relative, context(request, grant)) ?? json(404, {});
  }
  async function refresh(): Promise<void> {
    if (refreshing) return refreshing;
    available();
    const operation = (async () => {
      const now = Date.now(); renewalAt = now + 60_000;
      for (const [namespace, owned] of tenants) {
        owned.broker.enforceExpiry();
        if (!durable && owned.expiresAt <= now) { tenants.delete(namespace); owned.broker.close(); }
      }
      await state.mutate(draft => {
        draft.loginChallenges = draft.loginChallenges.filter(([, value]) => value.expiresAt > now);
        draft.consumedProofs = draft.consumedProofs.filter(([, expires]) => expires * 1000 > now);
        if (!durable) draft.tenants = draft.tenants.filter(value => tenants.has(value.namespace));
      });
      await Promise.all([sessions.refreshAll(), ...[...tenants.values()].map(owned => activeOwner(owned, true))]);
    })();
    refreshing = operation;
    try { await operation; } finally { refreshing = undefined; queueSchedule(); await scheduling; }
  }
  return {
    async fetch(request: Request): Promise<Response | undefined> {
      try {
        await scheduling; available(); const response = await handle(request); await scheduling; available();
        if (response) { response.headers.set('cache-control', 'no-store'); response.headers.set('referrer-policy', 'no-referrer'); response.headers.set('x-content-type-options', 'nosniff'); }
        return response;
      } catch (error) {
        return error instanceof SharingError ? json(error.status, { code: error.code, error: error.message }) : json(503, { error: 'Relay request failed.' });
      }
    },
    async prepareUpgrade(request: Request): Promise<{ accept(socket: RelaySocket): void } | Response | undefined> {
      try { await scheduling; available(); const prepared = await prepare(request); await scheduling; available(); return prepared; } catch { return json(503, {}); }
    },
    refresh,
    async close() {
      if (closing) return;
      closing = true; sessions.close(); await scheduling.catch(() => undefined); await scheduler.cancel();
      for (const owned of tenants.values()) owned.broker.close();
      await Promise.all([...tenants.values()].map(owned => owned.broker.settled()));
      await state.close(); tenants.clear();
    },
  };
}
function json(status: number, value: unknown) { return new Response(JSON.stringify(value), { status, headers: { 'content-type': 'application/json', 'cache-control': 'no-store' } }); }
