import { createDiagnosticJournal } from './diagnostic-journal.js';
import type { RelayDiagnosticStore, RelayDiagnosticContext } from './relay-diagnostics.js';
import { createFavorites } from './favorites.js';
import { createSessionMigrations } from './session-migrations.js';
import { PROTOCOL_VERSION, encodeSessionChannelServerMessage } from '@orchardworks/agent-remote-protocol';
import { acceptSessionChannel } from '@orchardworks/agent-remote-protocol';
import { createSessionStars, StarError } from './session-stars.js';
import { unavailableRoute } from './session-errors.js';
import { createSecurityPolicy } from './security.js';
import { authenticationCallback } from './auth-callback.js';
import { controllerPath, readControllerLocation } from './controller-location.js';
import { createHash, randomBytes } from 'node:crypto';
import { createHostBroker, type RemoteHostBrokerState } from './broker.js';
import { createGatewayControlVerifier } from './control.js';
import { SharingError } from './host-sharing.js';
import { createGatewaySessions } from './sessions.js';
import { queryGatewayAuthority, type AuthorityDiagnostic } from './authority.js';
import { provisionGatewayHostKey, revokeGatewayHostKey, validateBootstrapBody } from './host-bootstrap.js';
import { createRelayState, type RelayStateStore } from './state.js';
import { createTimerRelayScheduler, type RelayScheduler } from './scheduler.js';
import { readJson } from './request.js';
import { createSubdomainPreviewAccess } from './preview-subdomain-access.js';
import { previewDomainOrigin, isPreviewDomain } from './preview-domain.js';
import { PreviewNameError } from './preview-names.js';
import { previewFrameScript } from './preview-frame.js';
import { createPreviewAccess } from './preview-access.js';
import { previewRequest, previewResponseHeaders } from './preview-http.js';
import { previewTrafficBody, previewTrafficSocket } from './preview-traffic.js';
import { adaptPreviewContent, PreviewContentError } from './preview-content.js';
import type { TunnelSocket } from '@orchardworks/agent-remote-tunnel';
import type { BrokerRequestContext, RelaySocket } from './transport.js';
import { gatewayCookieName, readGatewayCookie, validateGatewayOrigin, verifyGatewayGrant, type GatewayAuthOptions, type GatewayGrant } from './auth.js';

export interface HostedRelayOptions extends GatewayAuthOptions {
  previewOrigin?: string;
  previewDomain?: string;
  storage?: RelayStateStore;
  diagnosticStorage?: RelayDiagnosticStore;
  diagnosticContext?: RelayDiagnosticContext;
  scheduler?: RelayScheduler;
  maxTenants?: number;
  clientAddress?(request: Request): string;
  keyLifetimeMs?: number;
}
type Tenant = { subject: string; namespace: string; authorityUntil: number; authorityRefreshAt: number; authorityDenied: boolean;
  checking?: Promise<'active' | 'denied' | 'unavailable'>; broker: ReturnType<typeof createHostBroker>; expiresAt: number };
export function createHostedRelay(options: HostedRelayOptions) {
  const auth = { origin: validateGatewayOrigin(options.origin), issuer: validateGatewayOrigin(options.issuer), secret: options.secret };
  if (Buffer.byteLength(auth.secret) < 32) throw new Error('Gateway signing secret must contain at least 32 bytes.');
  const tenants = new Map<string, Tenant>();
  const diagnostics = createDiagnosticJournal({storage:options.diagnosticStorage,context:options.diagnosticContext});
  const hostKeyOperations = new Map<string, Promise<unknown>>();
  const browserChannels = new Map<RelaySocket, { subject: string; expiresAt(): number; migrations?: Set<string>; titles?: Map<string, string> }>();
  const scheduler = options.scheduler ?? createTimerRelayScheduler();
  const durable = options.storage !== undefined;
  const cookieFlags = `Path=/; HttpOnly; SameSite=Strict${auth.origin.startsWith('https:') ? '; Secure' : ''}`;
  const hash = (value: string) => createHash('sha256').update(value).digest('hex');
  let closing = false; let failed = false; let initialized = false; let refreshing: Promise<void> | undefined;
  let scheduling: Promise<unknown> = Promise.resolve();
  let renewalAt = Date.now() + 60_000;
  const state = createRelayState(auth, options.storage, failClosed, published);
  const sessions = createGatewaySessions(auth, state, durable);
  const starAccess = (subject: string, item: import('./session-stars.js').StarIdentity) => {
    const broker = [...tenants.values()].find(value => value.broker.canStarSession(item, subject))?.broker;
    const host = broker?.visibleHosts(subject).find(host => host.id === item.hostId);
    return host ? { online: host.online, hostName: host.name, canRename: host.providers.some(provider => provider.providerId === item.providerId && provider.sessionRename === true) } : undefined;
  };
  const stars = createSessionStars(state, starAccess);
  const favorites = createFavorites(state, starAccess);
  const migrations = createSessionMigrations(state, (subject, item) => [...tenants.values()].some(value => value.broker.canStarSession(item, subject)));
  function publishMigrations(socket: RelaySocket, channel: { subject: string; migrations?: Set<string> }) {
    if (!channel.migrations || socket.readyState !== 1) return;
    for (const migration of migrations.list(channel.subject)) {
      if (channel.migrations.has(migration.id)) continue;
      const encoded = encodeSessionChannelServerMessage({ protocolVersion: PROTOCOL_VERSION, type: 'session_migrated', migration });
      if (encoded.status !== 'ok') continue;
      if ((socket.bufferedAmount ?? 0) + encoded.json.length * 3 > 16 * 1024 * 1024) { socket.close(1013, 'Migration backlog'); return; }
      try { socket.send(encoded.json); channel.migrations.add(migration.id); } catch { socket.close(1011, 'Migration delivery failed'); return; }
    }
  }
  function publishTitles(socket: RelaySocket, channel: { subject: string; titles?: Map<string, string> }) {
    if (!channel.titles || socket.readyState !== 1) return;
    const snapshot = favorites.list(channel.subject);
    const keys = new Set<string>();
    for (const star of snapshot.stars) {
      if (!star.available) continue;
      const { hostId, providerId, nativeSessionId, title } = star;
      const key = JSON.stringify([hostId, providerId, nativeSessionId]); keys.add(key);
      if (channel.titles.get(key) === title) continue;
      const encoded = encodeSessionChannelServerMessage({ protocolVersion: PROTOCOL_VERSION, type: 'session_title_updated', session: { hostId, providerId, nativeSessionId, title, revision: snapshot.revision } });
      if (encoded.status !== 'ok') continue;
      if ((socket.bufferedAmount ?? 0) + encoded.json.length * 3 > 16 * 1024 * 1024) { socket.close(1013, 'Title update backlog'); return; }
      try { socket.send(encoded.json); channel.titles.set(key, title); } catch { socket.close(1011, 'Title update delivery failed'); return; }
    }
    for (const key of channel.titles.keys()) if (!keys.has(key)) channel.titles.delete(key);
  }
  const previewOrigin = validateGatewayOrigin(options.previewOrigin || auth.origin);
  const previewAccess = createPreviewAccess({ origin: auth.origin, previewOrigin,
    authorizeBrowser: async (request, entry) => {
      const { grant } = await sessions.authenticate(request);
      return !!grant && grant.subject === entry.subject;
    },
    authorize: authorizePreview,
  });
  async function authorizePreview(entry: import('./preview-access.js').PreviewSession): Promise<boolean> {
      const { grant } = await sessions.authenticate(entry.source);
      if (!grant || grant.subject !== entry.subject) return false;
      const owned = [...tenants.values()].find(value => value.broker.ownsHost(entry.hostId, grant.subject));
      return !!owned && await activeOwner(owned) === 'active' && !!owned.broker.previews.lookup(entry.hostId, entry.previewId) && !!owned.broker.previews.bridge(entry.hostId);
    }
  const subdomainAccess = options.previewDomain ? createSubdomainPreviewAccess({ origin: auth.origin, authorize: authorizePreview, lookup: url => {
    if (!isPreviewDomain(url.origin, options.previewDomain, auth.origin)) return undefined;
    for (const tenant of tenants.values()) for (const host of tenant.broker.previews.snapshot()) {
      const matching = host.snapshot.registrations.filter(item => previewDomainOrigin(tenant.broker.previews.nameId(host.hostId, item.id), options.previewDomain!, auth.origin) === url.origin);
      const active = matching.filter(item => tenant.broker.previews.lookup(host.hostId, item.id));
      if (active.length > 1) return undefined;
      const registration = active[0] ?? matching.at(-1);
      if (registration) return { hostId: host.hostId, previewId: registration.id };
    }
    return undefined;
  } }) : undefined;
  const domainOrigin = (broker: ReturnType<typeof createHostBroker>, hostId: string, id: string) => previewDomainOrigin(broker.previews.nameId(hostId, id), options.previewDomain!, auth.origin);

  const security = createSecurityPolicy(state);
  const verifyControl = createGatewayControlVerifier(auth, state);
  function failClosed() {
    failed = true;
    for (const socket of browserChannels.keys()) socket.close(1013, 'Relay unavailable');
    for (const owned of tenants.values()) owned.broker.close();
    void Promise.resolve(scheduler.cancel()).catch(() => undefined);
  }
  function available() { if (closing || failed) throw new Error('Relay state is unavailable.'); state.assertAvailable(); }
  function enforceChannels() {
    for (const [socket, channel] of browserChannels) if (closing || failed || channel.expiresAt() <= Date.now()) socket.close(1008, 'Session expired');
  }
  function published() {
    enforceChannels();
    for (const [socket, channel] of browserChannels) { publishMigrations(socket, channel); publishTitles(socket, channel); }
    for (const owned of tenants.values()) owned.broker.enforceExpiry();
    void previewAccess.enforce(); void subdomainAccess?.enforce();
    if (initialized && !refreshing) queueSchedule();
  }
  function queueSchedule() {
    if (closing || failed) return;
    const due = [...browserChannels.values()].map(channel => channel.expiresAt());
    due.push(renewalAt, ...state.read().loginChallenges.map(([, value]) => value.expiresAt), ...state.read().consumedProofs.map(([, expires]) => expires * 1000));
    for (const owned of tenants.values()) {
      if (!durable) due.push(owned.expiresAt);
      if (owned.authorityRefreshAt > 0) due.push(owned.authorityRefreshAt);
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
      const hostIds = owned.broker.visibleHosts(owned.subject).map(host => host.id);
      for (const id of hostIds) diagnostics.record(id, { event: 'authority_refresh_started', leaseRemainingMs: Math.max(0, owned.authorityUntil - Date.now()) });
      let detail: AuthorityDiagnostic | undefined;
      const result = await queryGatewayAuthority(auth, 'user-status', { subject: owned.subject }, value => { detail = value; });
      if (closing || failed) return 'unavailable' as const;
      if (result.status === 'active' && result.subject === owned.subject) { owned.authorityUntil = result.validUntil; owned.authorityDenied = false; }
      else if (result.status === 'denied' || result.status === 'active') { owned.authorityUntil = 0; owned.authorityDenied = true; }
      // Renewal must finish before expiry. A transient outage retries within the
      // existing lease; it never grants additional time without authority approval.
      const remaining = owned.authorityUntil - Date.now();
      owned.authorityRefreshAt = Date.now() + (remaining > 0
        ? Math.max(result.status === 'active' ? 1 : 250, Math.floor(Math.min(result.status === 'active' ? 60_000 : 10_000, remaining / 2)))
        : 10_000);
      for (const id of hostIds) diagnostics.record(id, { event: 'authority_refresh_completed', ...detail,
        ...(owned.authorityDenied ? { reason: 'access_revoked' as const } : {}),
        leaseRemainingMs: Math.max(0, remaining), retryDelayMs: Math.max(0, owned.authorityRefreshAt - Date.now()) });
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
        ownerSubject: grant.subject, durable, initialState, diagnostics,
        userStreamCount: subject => [...tenants.values()].reduce((sum, owned) => sum + owned.broker.activeStreamCount(subject), 0),
        onStateChange: async broker => { await state.mutate(draft => {
          const previous = draft.tenants.find(value => value.namespace === grant.namespace);
          if (previous) previous.broker = broker;
          else draft.tenants.push({ subject: grant.subject, namespace: grant.namespace, broker });
        }); await scheduling; },
        onPairing(_key, expiresAt) { const owned = tenants.get(grant.namespace); if (owned) owned.expiresAt = Math.max(owned.expiresAt, expiresAt); },
      });
      entry = { subject: grant.subject, namespace: grant.namespace, authorityUntil: 0, authorityRefreshAt: 0, authorityDenied: false, broker, expiresAt: grant.expiresAt };
      tenants.set(grant.namespace, entry);
    }
    entry.expiresAt = Math.max(entry.expiresAt, grant.expiresAt);
    return entry;
  }
  for (const item of state.read().tenants) {
    if (!tenant({ subject: item.subject, namespace: item.namespace, expiresAt: Number.MAX_SAFE_INTEGER, ticket: '', nonce: '' }, item.broker)) throw new Error('Stored Relay tenants exceed configured capacity.');
  }
  initialized = true; queueSchedule();
  function browserState(grant: GatewayGrant) { return { user: { id: grant.subject, ...(grant.profile ?? {}) }, basePath: `/u/${grant.namespace}/`, expiresAt: grant.expiresAt,
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
  async function withHostKey<T>(hostId: string, operation: () => Promise<T>): Promise<T> {
    const previous = hostKeyOperations.get(hostId) ?? Promise.resolve();
    const pending = previous.catch(() => undefined).then(operation);
    hostKeyOperations.set(hostId, pending);
    try { return await pending; }
    finally { if (hostKeyOperations.get(hostId) === pending) hostKeyOperations.delete(hostId); }
  }
  async function bootstrapHost(request: Request, url: URL): Promise<Response> {
    if (request.method !== 'POST') return json(405, { error: 'Method is not allowed.' });
    if (request.headers.has('origin') || request.headers.has('cookie')) return json(403, { error: 'Device authentication is required.' });
    if (url.search) return json(400, { error: 'No bootstrap parameters are accepted.' });
    if (request.headers.get('content-type')?.split(';')[0] !== 'application/json') return json(415, { error: 'JSON is required.' });
    const bearer = /^Bearer ([^\s]{1,256})$/i.exec(request.headers.get('authorization') ?? '')?.[1];
    const owned = bearer && [...tenants.values()].find(value => value.broker.authenticateDevice(bearer));
    const device = owned && owned.broker.authenticateDevice(bearer!);
    if (!owned || !device) return json(401, { error: 'Device credential is unavailable.' });
    if (device.pairingPurpose !== 'gateway-setup') return json(403, { code: 'gateway_setup_not_authorized', error: 'This Host was paired to join only. Gateway setup was not authorized.' });
    if (!security.allow('bootstrap:' + device.hostId, 30, 60_000)) return json(429, { error: 'Too many bootstrap requests.' });
    await validateBootstrapBody(request);
    return withHostKey(device.hostId, async () => {
      if (request.signal.aborted || !device.current()) return json(401, { error: 'Device credential is unavailable.' });
      const authority = await queryGatewayAuthority(auth, 'user-status', { subject: owned.subject });
      if (authority.status !== 'active' || authority.subject !== owned.subject) {
        return json(authority.status === 'unavailable' ? 503 : 403, { error: 'Host owner access could not be verified.' });
      }
      if (!device.current() || !await owned.broker.markGatewayKeyRequested(bearer!)) return json(401, { error: 'Device credential is unavailable.' });
      const result = await provisionGatewayHostKey(auth, { subject: owned.subject, hostId: device.hostId, hostName: device.hostName });
      if (!device.current()) return json(401, { error: 'Device credential is unavailable.' });
      return result.status === 'active' ? json(200, result.credentials)
        : json(result.status === 'denied' ? 403 : 503, { error: 'Host bootstrap could not be completed.' });
    });
  }
  async function handle(request: Request): Promise<Response | undefined> {
    const url = new URL(request.url);
    if (isPreviewRequest(url)) return handlePreview(request);
    if (url.origin !== auth.origin) return json(403, { error: 'Origin is not allowed.' });
    if (url.pathname === '/v1/remote/host/bootstrap') return bootstrapHost(request, url);
    if (url.pathname === '/_arc/preview-authorize' && subdomainAccess) {
      if (request.method !== 'POST' || !originAllowed(request)) return json(403, {});
      if (request.headers.get('content-type')?.split(';')[0] !== 'application/json') return json(415, { error: 'JSON is required.' });
      const granted = await authorize(request); if (granted instanceof Response) return granted;
      if (!security.allow('preview-entry:' + granted.subject, 60, 60_000)) return json(429, { error: 'Too many preview entry requests.' });
      const body = await readJson(request);
      const id = typeof body?.challenge === 'string' ? body.challenge : '';
      const code = await subdomainAccess.approve(id, request, granted.subject);
      return code ? json(200, { code }) : json(403, { error: 'Tunnel login challenge expired or access was denied.' });
    }
    if (url.pathname === '/' && url.searchParams.has('preview')) {
      if (request.method !== 'GET') return new Response(null, { status: 405, headers: { allow: 'GET', 'cache-control': 'no-store' } });
      let location: ReturnType<typeof readControllerLocation>;
      try { location = readControllerLocation(url.searchParams); } catch { return json(400, { error: 'Invalid tunnel link.' }); }
      const { grant, unavailable } = await sessions.authenticate(request);
      if (!grant) return unavailable ? json(503, { error: 'Sign-in verification is temporarily unavailable.' })
        : new Response(null, { status: 303, headers: { location: '/auth/login' + controllerPath(location).slice(1), 'cache-control': 'no-store' } });
      const owned = [...tenants.values()].find(value => value.broker.ownsHost(location.hostId!, grant.subject));
      if (!owned) return json(403, { error: 'This account does not own the requested tunnel.' });
      const authority = await activeOwner(owned);
      if (authority !== 'active') return json(authority === 'denied' ? 403 : 503, { error: 'Tunnel access could not be verified.' });
      if (!owned.broker.previews.lookup(location.hostId!, location.previewId!) || !owned.broker.previews.bridge(location.hostId!)) return json(410, { error: 'This tunnel is offline, expired, or unregistered. Open it again from Agent Remote.' });
      let entryUrl: string;
      if (subdomainAccess) {
        if (!location.previewChallenge) return new Response(null, { status: 303, headers: { 'cache-control': 'no-store', location: domainOrigin(owned.broker, location.hostId!, location.previewId!) + '/_arc/start?path=' + encodeURIComponent(location.previewPath!) } });
        const code = await subdomainAccess.approve(location.previewChallenge, request, grant.subject);
        const destination = code && subdomainAccess.entryUrl(location.previewChallenge, code);
        if (!destination) return json(403, { error: 'Tunnel login challenge expired or access was denied. Open the tunnel again.' });
        entryUrl = destination;
      } else entryUrl = previewAccess.issue({ source: request, subject: grant.subject, hostId: location.hostId!, previewId: location.previewId!, path: location.previewPath! });
      return new Response(null, { status: 303, headers: { location: entryUrl, 'cache-control': 'no-store', 'referrer-policy': 'no-referrer' } });
    }
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
      if (grant.continuation) {
        owned.authorityUntil = exchange.grant.expiresAt; owned.authorityDenied = false;
        owned.authorityRefreshAt = Date.now() + Math.max(1, Math.floor(Math.min(60_000, (owned.authorityUntil - Date.now()) / 2)));
      }
      await security.record(grant.subject, 'signed_in', 'allowed');
      const response = json(200, { ...browserState(exchange.grant), ...(pending.returnPath ? { returnPath: pending.returnPath } : {}), ...(pending.hostId ? { hostId: pending.hostId } : {}) });
      response.headers.append('set-cookie', `${gatewayCookieName(auth.origin, 'session')}=${exchange.token}; ${cookieFlags}; Max-Age=${Math.max(0, Math.floor((exchange.expiresAt - Date.now()) / 1000))}`);
      if (exchange.browserCookie) response.headers.append('set-cookie', `${gatewayCookieName(auth.origin, 'browser')}=${exchange.browserCookie}; ${cookieFlags}; Max-Age=31536000`);
      response.headers.append('set-cookie', `${gatewayCookieName(auth.origin, 'login')}=; ${cookieFlags}; Max-Age=0`);
      return response;
    }
    if (url.pathname === '/auth/status' && request.method === 'GET') {
      const grant = await authorize(request); if (grant instanceof Response) return grant;
      const response = json(200, browserState(grant));
      const browser = await sessions.browserCookie(request);
      if (browser) response.headers.append('set-cookie', `${gatewayCookieName(auth.origin, 'browser')}=${browser}; ${cookieFlags}; Max-Age=31536000`);
      return response;
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
      const grant = await authorize(request, true); if (grant instanceof Response) return grant;
      const response = json(200, browserState(grant));
      const browser = await sessions.browserCookie(request);
      if (browser) response.headers.append('set-cookie', `${gatewayCookieName(auth.origin, 'browser')}=${browser}; ${cookieFlags}; Max-Age=31536000`);
      return response;
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
      const sensitive = path.startsWith('/v1/remote/pairings') || /\/rotate$/.test(path);
      if (sensitive && durable && !security.recent(grant.authenticatedAt)) {
        await security.record(grant.subject, 'recent_authentication_required', 'denied');
        return json(403, {code:'reauthentication_required',error:'Sign in again before managing device credentials.',loginUrl:'/auth/login?reauthenticate=1'});
      }
      if (path === '/v1/remote/pairings' && request.method === 'POST' && !security.allow('pair:' + grant.subject, 5, 60_000)) return json(429, {error:'Too many pairing invitations.'});
    }
    if (path === '/v1/session-migrations' && request.method === 'GET') return json(200, { migrations: migrations.list(grant.subject) });
    if (path === '/v1/favorites') {
      try {
        if (request.method === 'GET') return json(200, favorites.list(grant.subject));
        if (request.method === 'POST') return json(200, await favorites.execute(grant.subject, await readJson(request)));
        return json(405, { error: 'Method is not allowed.' });
      } catch (error) {
        if (error instanceof StarError) return json(error.status, { code: error.code, error: error.message });
        throw error;
      }
    }
    if (path === '/v1/stars') {
      try {
        if (request.method === 'GET') return json(200, { stars: stars.list(grant.subject) });
        if (request.method === 'POST') await stars.save(grant.subject, await readJson(request));
        else if (request.method === 'DELETE') await stars.remove(grant.subject, await readJson(request));
        else return json(405, { error: 'Method is not allowed.' });
        return json(200, { stars: stars.list(grant.subject) });
      } catch (error) {
        if (error instanceof StarError) return json(error.status, { code: error.code, error: error.message });
        throw error;
      }
    }
    const destination = routeTenant(path, grant.subject) ?? owned;
    const unpinPreview = /^\/v1\/remote\/hosts\/([^/]+)\/previews\/pins\/([A-Za-z0-9_-]+)\/unpin$/.exec(path);
    if (unpinPreview && request.method === 'POST') {
      const [, hostId, nameId] = unpinPreview;
      if (!destination.broker.ownsHost(hostId!, grant.subject)) return json(403, { error: 'Only the Host owner can unpin tunnel names.' });
      await readJson(request);
      await destination.broker.previews.unpinName(hostId!, nameId!);
      return json(200, { pinned: false });
    }
    const pinPreview = /^\/v1\/remote\/hosts\/([^/]+)\/previews\/([A-Za-z0-9_-]+)\/pin$/.exec(path);
    if (pinPreview && request.method === 'POST') {
      const [, hostId, previewId] = pinPreview;
      if (!destination.broker.ownsHost(hostId!, grant.subject)) return json(403, { error: 'Only the Host owner can pin tunnel names.' });
      if (!subdomainAccess) return json(409, { error: 'Pinned tunnel names require dedicated tunnel domains.' });
      const body = await readJson(request);
      if (typeof body?.pinned !== 'boolean') return json(400, { error: 'Choose whether to pin the tunnel name.' });
      try {
        await destination.broker.previews.pinName(hostId!, previewId!, body.pinned);
        return json(200, { pinned: body.pinned });
      } catch (error) {
        if (error instanceof PreviewNameError) return json(error.status, { error: error.message });
        throw error;
      }
    }
    const openPreview = /^\/v1\/remote\/hosts\/([^/]+)\/previews\/([A-Za-z0-9_-]+)\/open$/.exec(path);
    if (openPreview && request.method === 'POST') {
      const hostId = openPreview[1]!; const previewId = openPreview[2]!;
      if (!destination.broker.ownsHost(hostId, grant.subject)) return json(403, { error: 'Only the Host owner can open previews.' });
      const registration = destination.broker.previews.lookup(hostId, previewId);
      if (!registration || !destination.broker.previews.bridge(hostId)) return json(503, { error: 'Preview is unavailable. Reconnect the Controller or register again.' });
      const body = await readJson(request);
      let original: URL;
      try { original = new URL(typeof body?.url === 'string' ? body.url : ''); } catch { return json(400, { error: 'Invalid preview URL.' }); }
      if (original.hostname === 'localhost') original.hostname = '127.0.0.1';
      if (original.origin !== registration.target || original.username || original.password) return json(400, { error: 'URL must match the registered local service.' });
      const prefix = `/p/${previewId}`;
      const path = !subdomainAccess && registration.pathMode === 'preserve' && original.pathname.startsWith(prefix + '/') ? original.pathname.slice(prefix.length) : original.pathname;
      if (subdomainAccess) {
        const tunnelOrigin = domainOrigin(destination.broker, hostId, previewId);
        const tunnelUrl = tunnelOrigin + path + original.search + original.hash;
        return body?.mode === 'link' ? json(200, { tunnelUrl }) : json(200, { entryUrl: tunnelOrigin + '/_arc/start?path=' + encodeURIComponent(path + original.search + original.hash) });
      }
      if (body?.mode === 'link') return json(200, { tunnelUrl: auth.origin + controllerPath({ hostId, previewId, previewPath: path + original.search + original.hash }) });
      return json(200, { entryUrl: previewAccess.issue({ source: request, subject: grant.subject, hostId, previewId, path: path + original.search + original.hash }) });
    }
    const revokeHost = /^\/v1\/remote\/hosts\/([^/]+)\/revoke$/.exec(path);
    const execute = async () => {
      const renameRoute = /^\/v1\/remote\/hosts\/([^/]+)\/session\/rename$/.exec(path);
      if (renameRoute && request.method === 'POST') {
        const input = await readJson(relative.clone());
        if (typeof input?.providerId !== 'string' || typeof input.nativeSessionId !== 'string') return json(400, { error: 'A native session identity is required.' });
        const identity = { hostId: decodeURIComponent(renameRoute[1]!), providerId: input.providerId, nativeSessionId: input.nativeSessionId };
        if (!favorites.list(grant.subject).stars.some(star => star.hostId === identity.hostId && star.providerId === identity.providerId && star.nativeSessionId === identity.nativeSessionId && star.available)) return json(403, { error: 'Choose an accessible favorite session to rename.' });
        return withHostKey('session-name:' + JSON.stringify(identity), async () => {
          const response = await destination.broker.handleRequest(relative, context(request, grant));
          if (response?.ok) {
            const result = await response.clone().json() as { title: string };
            await favorites.renameSession(identity, result.title);
          }
          return response;
        });
      }
      const editRoute = /^\/v1\/remote\/hosts\/([^/]+)\/create$/.exec(path);
      const input = editRoute && request.method === 'POST' ? await readJson(relative.clone()) : undefined;
      if (!input?.editNativeSessionId) return destination.broker.handleRequest(relative, context(request, grant));
      if (typeof input.editNativeSessionId !== 'string' || typeof input.providerId !== 'string' || typeof input.operationId !== 'string') return json(400, { error: 'A complete prompt-edit identity is required.' });
      const operationId = input.operationId;
      const fromIdentity = { hostId: decodeURIComponent(editRoute![1]!), providerId: input.providerId, nativeSessionId: input.editNativeSessionId };
      return withHostKey('prompt-edit:' + JSON.stringify([grant.subject, fromIdentity]), async () => {
        try {
          const from = state.read().tenants.flatMap(value => value.broker.bindings).find(binding => binding.hostId === fromIdentity.hostId && binding.providerId === fromIdentity.providerId && binding.nativeSessionId === fromIdentity.nativeSessionId);
          if (!from || !destination.broker.canStarSession(fromIdentity, grant.subject)) return json(403, { error: 'Source session access is unavailable.' });
          migrations.check(grant.subject, fromIdentity, operationId);
          const response = await destination.broker.handleRequest(relative, context(request, grant));
          if (!response?.ok) return response;
          const result = await response.clone().json() as { agentId: string; nativeSessionId: string };
          await migrations.save(grant.subject, { id: operationId, from: { ...fromIdentity, agentId: from.agentId },
            to: { hostId: from.hostId, providerId: from.providerId, nativeSessionId: result.nativeSessionId, agentId: result.agentId }, createdAt: Date.now() });
          return response;
        } catch (error) { if (error instanceof StarError) return json(error.status, { code: error.code, error: error.message }); throw error; }
      });
    };
    const result = durable && revokeHost && request.method === 'POST' ? await withHostKey(revokeHost[1]!, async () => {
      const identity = destination.broker.gatewayKeyHost(revokeHost[1]!, grant.subject);
      if (identity) {
        await validateBootstrapBody(relative.clone());
        if (!context(request, grant).authorize!()) return json(401, { error: 'Session is unavailable.' });
        if (!await revokeGatewayHostKey(auth, { subject: grant.subject, ...identity })) {
          return json(503, { error: 'Host key revocation could not be completed. Retry revoking the Host.' });
        }
      }
      return execute();
    }) : await execute();
    if (result?.ok && request.method === 'GET' && /^\/v1\/remote\/hosts\/[^/]+\/previews$/.test(path)) {
      const snapshot = await result.json() as { registrations: Array<{ id: string }>; pinnedNames?: Array<{ nameId: string; target: string }> };
      const hostId = /^\/v1\/remote\/hosts\/([^/]+)/.exec(path)![1]!;
      return json(200, { ...snapshot, routing: subdomainAccess ? 'subdomain' : 'path',
        pinnedNames: (snapshot.pinnedNames ?? []).map(value => ({ ...value,
          ...(subdomainAccess ? { tunnelOrigin: previewDomainOrigin(value.nameId, options.previewDomain!, auth.origin) } : {}),
        })),
        registrations: snapshot.registrations.map(value => ({ ...value,
          ...(subdomainAccess ? { tunnelOrigin: domainOrigin(destination.broker, hostId, value.id) } : {}),
        })),
      });
    }
    if (request.method !== 'GET' && result) {
      const action = path === '/v1/remote/pairings' ? 'pairing_created' : path.startsWith('/v1/remote/pairings/') ? (request.method === 'DELETE' ? 'pairing_deleted' : 'pairing_revoked') : /\/revoke$/.test(path) ? 'host_revoked' : /\/rotate$/.test(path) ? 'credential_rotation_requested' : /\/stop$/.test(path) ? 'host_stop_requested' : /\/codex-daemon$/.test(path) ? 'codex_daemon_restart_requested' : undefined;
      if (action) await security.record(grant.subject, action, result.ok ? 'allowed' : 'denied', /^\/v1\/remote\/hosts\/([^/]+)/.exec(path)?.[1]);
    }
    return result ?? (path === '/v1/providers' && request.method === 'GET'
      ? json(200, { protocolVersion: '1.5.0', type: 'provider_list', payload: { providers: [] } })
      : json(404, unavailableRoute(path)));
  }
  async function prepare(request: Request): Promise<{ accept(socket: RelaySocket): void } | Response | undefined> {
    const url = new URL(request.url);
    if (url.origin !== auth.origin) return json(403, {});
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
    const route = new URL(relative.url);
    if (route.pathname === '/v1/session-channel') {
      const mode = route.searchParams.get('observation');
      if (mode !== 'session' && mode !== 'activity') return json(400, {});
      const count = () => [...browserChannels.values()].filter(channel => channel.subject === grant.subject).length;
      if (count() >= 16) return json(429, {});
      return { accept(socket: RelaySocket) {
        if (closing || failed || sessions.expiresAt(request, grant) <= Date.now()) { socket.close(1008, 'Session expired'); return; }
        if (count() >= 16) { socket.close(1013, 'Channel capacity reached'); return; }
        browserChannels.set(socket, { subject: grant.subject, expiresAt: () => sessions.expiresAt(request, grant), ...(route.searchParams.get('migrations') === '1' ? { migrations: new Set<string>() } : {}), ...(route.searchParams.get('titles') === '1' ? { titles: new Map<string, string>() } : {}) });
        socket.onClose(() => { browserChannels.delete(socket); queueSchedule(); });
        queueSchedule();
        acceptSessionChannel(socket, mode, async agentId => {
          // Reuse the authenticated per-session route, including cross-Host sharing,
          // native binding recovery, expiry, and resource/command authorization.
          const target = new URL(request.url);
          target.pathname = `${prefix}v1/sessions/${encodeURIComponent(agentId)}/events`;
          target.search = '';
          const prepared = await prepare(new Request(target, request));
          if (!prepared || prepared instanceof Response) {
            const status = prepared?.status ?? 404;
            return { code: status >= 500 || status === 429 ? 1013 : 1008, reason: 'Session subscription is unavailable.' };
          }
          return prepared;
        });
        publishMigrations(socket, browserChannels.get(socket)!);
        publishTitles(socket, browserChannels.get(socket)!);
      } };
    }
    const destination = routeTenant(route.pathname, grant.subject) ?? owned;
    return await destination.broker.prepareUpgrade(relative, context(request, grant)) ?? json(404, {});
  }
  function isPreviewRequest(url: URL): boolean {
    return isPreviewDomain(url.origin, options.previewDomain, auth.origin) || url.origin === previewOrigin && (previewOrigin !== auth.origin || url.pathname === '/_arc/enter' || url.pathname === '/p' || url.pathname.startsWith('/p/'));
  }
  async function handlePreview(request: Request): Promise<Response> {
    const isolated = isPreviewDomain(request.url, options.previewDomain, auth.origin);
    const accessManager = isolated ? subdomainAccess! : previewAccess;
    const entry = await accessManager.handle(request); if (entry) return entry;
    const access = await accessManager.authenticate(request);
    if (access instanceof Response) {
      const url = new URL(request.url);
      if (isolated && access.status === 401 && request.method === 'GET' && ['document', 'iframe'].includes(request.headers.get('sec-fetch-dest') ?? '')) return subdomainAccess!.challenge(request);
      const match = /^\/p\/([A-Za-z0-9_-]{1,128})(\/.*)?$/.exec(url.pathname);
      if (access.status === 401 && request.method === 'GET' && request.headers.get('sec-fetch-dest') === 'document' && match) {
        const host = [...tenants.values()].flatMap(value => value.broker.previews.snapshot()).find(value => value.snapshot.registrations.some(item => item.id === match[1]));
        if (host) return new Response(null, { status: 303, headers: { 'cache-control': 'no-store', location: auth.origin + controllerPath({ hostId: host.hostId, previewId: match[1], previewPath: (match[2] ?? '/') + url.search }) } });
      }
      return access;
    }
    if (request.headers.get('service-worker') === 'script' || request.headers.get('sec-fetch-dest') === 'serviceworker') return json(403, { error: 'Service workers are not supported in local previews.' });
    if (isolated && new URL(request.url).pathname === '/_arc/frame.js' && request.method === 'GET') return new Response(previewFrameScript(auth.origin),
      { headers: { 'content-type': 'text/javascript; charset=utf-8', 'cache-control': 'no-store', 'x-content-type-options': 'nosniff' } });
    const owned = [...tenants.values()].find(value => value.broker.ownsHost(access.hostId, access.subject));
    const registration = owned?.broker.previews.lookup(access.hostId, access.previewId);
    const bridge = owned?.broker.previews.bridge(access.hostId);
    if (!bridge || !registration) return json(503, { error: 'Controller preview is unavailable.' });
    const abort = new AbortController();
    const cancel = () => abort.abort(); request.signal.addEventListener('abort', cancel, { once: true });
    if (request.signal.aborted) cancel();
    const unwatch = accessManager.watch(access, cancel);
    const cleanup = () => { unwatch(); request.signal.removeEventListener('abort', cancel); };
    try {
      const route = isolated ? { ...registration, root: true } : registration;
      const outgoing = previewRequest(request, route);
      const activity = () => { if (!abort.signal.aborted && accessManager.activity(access)) owned!.broker.previews.activity(access.hostId, access.previewId); };
      activity();
      const result = await bridge.fetch(access.previewId, { ...outgoing, body: previewTrafficBody(outgoing.body, activity), signal: abort.signal });
      activity();
      const responseHeaders = previewResponseHeaders(result.headers, route, outgoing.path);
      if (!result.body || request.method === 'HEAD' || [204, 304].includes(result.status)) { cleanup(); return new Response(null, { status: result.status, headers: responseHeaders }); }
      const adapted = await adaptPreviewContent({ body: previewTrafficBody(result.body, activity)!, headers: responseHeaders, route, requestPath: outgoing.path, status: result.status });
      const headers = adapted.headers;
      const reader = adapted.body!.getReader();
      const body = new ReadableStream<Uint8Array>({
        async pull(controller) {
          try { const part = await reader.read(); if (part.done) { cleanup(); controller.close(); } else controller.enqueue(part.value); }
          catch (error) { cleanup(); controller.error(error); }
        },
        async cancel() { cancel(); cleanup(); await reader.cancel().catch(() => undefined); },
      }, { highWaterMark: 0 });
      return new Response(body, { status: result.status, headers });
    } catch (error) { cancel(); cleanup(); return json(502, { error: error instanceof PreviewContentError ? error.message : 'Local preview request failed. Check the local service and its preview base path.' }); }
  }
  async function preparePreviewUpgrade(request: Request): Promise<{ protocol?: string; accept(socket: TunnelSocket): void } | Response | undefined> {
    const url = new URL(request.url);
    if (!isPreviewRequest(url) && url.pathname !== '/ws/preview-tunnel') return undefined;
    try {
      await scheduling; available();
      if (url.origin === auth.origin && url.pathname === '/ws/preview-tunnel') {
        const token = /^Bearer ([A-Za-z0-9_-]{43})$/.exec(request.headers.get('authorization') ?? '')?.[1];
        const owned = token && [...tenants.values()].find(value => value.broker.tunnelHost(token));
        if (!owned || !token) return json(401, {});
        const status = await activeOwner(owned);
        if (status !== 'active') return json(status === 'denied' ? 401 : 503, {});
        return { accept(socket) { owned.broker.acceptTunnel(token, socket); } };
      }
      const isolated = isPreviewDomain(url.origin, options.previewDomain, auth.origin);
      const accessManager = isolated ? subdomainAccess! : previewAccess;
      if (!isolated && url.origin !== previewOrigin) return json(403, {});
      const access = await accessManager.authenticate(request); if (access instanceof Response) return access;
      const owned = [...tenants.values()].find(value => value.broker.ownsHost(access.hostId, access.subject));
      const registration = owned?.broker.previews.lookup(access.hostId, access.previewId);
      const bridge = owned?.broker.previews.bridge(access.hostId);
      if (!bridge || !registration) return json(503, {});
      const route = isolated ? { ...registration, root: true } : registration;
      const outgoing = previewRequest(request, route);
      const abort = new AbortController();
      let applicationSocket: TunnelSocket | undefined;
      let revoked = false;
      const revoke = () => { revoked = true; abort.abort(); applicationSocket?.close(1008, 'Preview access revoked'); };
      const unwatch = accessManager.watch(access, revoke);
      request.signal.addEventListener('abort', revoke, { once: true });
      if (request.signal.aborted) revoke();
      let prepared: Awaited<ReturnType<typeof bridge.prepareWebSocket>>;
      try {
        prepared = await bridge.prepareWebSocket(access.previewId, { path: outgoing.path, headers: outgoing.headers,
          protocols: (request.headers.get('sec-websocket-protocol') ?? '').split(',').map(value => value.trim()).filter(Boolean), signal: abort.signal });
      } catch (error) {
        unwatch(); request.signal.removeEventListener('abort', revoke); throw error;
      }
      if ('status' in prepared) { unwatch(); request.signal.removeEventListener('abort', revoke); return json(prepared.status, { error: prepared.message }); }
      if (revoked || await accessManager.authenticate(request) instanceof Response) {
        revoke(); unwatch(); request.signal.removeEventListener('abort', revoke); return json(401, {});
      }
      return { protocol: prepared.protocol, accept(socket) {
        applicationSocket = socket;
        socket.onClose(() => { unwatch(); request.signal.removeEventListener('abort', revoke); });
        if (revoked) socket.close(1008, 'Preview access revoked'); else {
          const activity = () => { if (!revoked && accessManager.activity(access)) owned!.broker.previews.activity(access.hostId, access.previewId); };
          activity(); prepared.accept(previewTrafficSocket(socket, activity));
        }
      } };
    } catch { return json(503, { error: 'Preview WebSocket is unavailable.' }); }
  }
  async function refresh(): Promise<void> {
    if (refreshing) return refreshing;
    available();
    const operation = (async () => {
      const now = Date.now(); renewalAt = now + 60_000;
      enforceChannels();
      for (const [namespace, owned] of tenants) {
        owned.broker.enforceExpiry();
        if (!durable && owned.expiresAt <= now) { tenants.delete(namespace); owned.broker.close(); }
      }
      await state.mutate(draft => {
        draft.loginChallenges = draft.loginChallenges.filter(([, value]) => value.expiresAt > now);
        draft.consumedProofs = draft.consumedProofs.filter(([, expires]) => expires * 1000 > now);
        if (!durable) draft.tenants = draft.tenants.filter(value => tenants.has(value.namespace));
      });
      const renewOwners = async (force = false) => {
        const due = [...tenants.values()].filter(owned => force || owned.authorityRefreshAt <= Date.now());
        for (let index = 0; index < due.length; index += 4) {
          await Promise.all(due.slice(index, index + 4).map(owned => activeOwner(owned, true)));
        }
      };
      // Host authorization must not queue behind every saved browser login.
      // Recheck due owners between browser batches even during a long refresh.
      await renewOwners(true);
      await sessions.refreshAll(renewOwners);
      await previewAccess.enforce();
    })();
    refreshing = operation;
    try { await operation; } finally { refreshing = undefined; queueSchedule(); await scheduling; }
  }
  return {
    preparePreviewUpgrade,
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
      closing = true;
      for (const socket of browserChannels.keys()) socket.close(1001, 'Relay stopped');
      browserChannels.clear();
      previewAccess.close(); subdomainAccess?.close(); sessions.close(); await scheduling.catch(() => undefined); await scheduler.cancel();
      for (const owned of tenants.values()) owned.broker.close();
      await Promise.all([...tenants.values()].map(owned => owned.broker.settled()));
      await diagnostics.close(); await state.close(); tenants.clear();
    },
  };
}
function json(status: number, value: unknown) { return new Response(JSON.stringify(value), { status, headers: { 'content-type': 'application/json', 'cache-control': 'no-store' } }); }
