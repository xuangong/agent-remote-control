import { createTeamService } from './team-service.js';
import { createSocketEdge } from './socket-edge.js';
import { createClientAdmission } from './client-admission.js';
import { createBrokerState } from './broker-state.js';
import { createControllerRoutes } from './controller-routes.js';
import { createTeamRoutes } from './team-routes.js';
import { createHostServiceRoutes } from './host-service-routes.js';
import { createPreviewRoutes } from './preview-routes.js';
import { createPairingRoutes } from './pairing-routes.js';
import { createSessionDirectoryRoutes } from './session-directory-routes.js';
import { createSessionReadRoutes } from './session-read-routes.js';
import { principal, type RouteGroup } from './request-input.js';
import { createAccess } from './access.js';
import { createExpiry } from './credential-expiry.js';
import { createHostViews } from './host-views.js';
import { createHostSession } from './host-session.js';
import { createSessionBindings } from './session-bindings.js';
import { createSuccession } from './succession-service.js';
import { createRelations } from './relation-service.js';
import { createJournalDeletion } from './journal-deletion.js';
import type { RelationChangeReset, BrokerRelationChange } from './relation-changes.js';
import { nativeSessionRefKey, type NativeSessionRef } from '@orchardworks/agent-remote-protocol';
import { isSuccessionAssociationAuthority } from '@orchardworks/agent-remote-protocol';
import { validSessionRelationUpdate, validSourceRelation, type SourceRelation, type SessionRelation } from '@orchardworks/agent-remote-protocol/model';
import { controllerReleases } from './controller-releases.js';
import { type ControllerRelease } from '@orchardworks/agent-remote-protocol';
import { createHash } from 'node:crypto';
import { systemIds } from './relay-ids.js';
import { HostSharing, SharingError } from './host-sharing.js';
import { createHostPreviews } from './host-previews.js';
import type { TunnelSocket } from '@orchardworks/agent-remote-tunnel';
import { defaultBrokerScheduler, RELAY_SOCKET_OPEN, type BrokerRequestContext, type RelaySocket } from './transport.js';
import { createHostJournals, type JournalReadRequest } from './host-journals.js';
import { createJournalSessions, journalSessionKey } from './journal-sessions.js';
import { json, rejectUpgrade, HOST_STREAM_LIMIT } from './http-replies.js';
import { BrokerError, type Binding, type Host, type HostBrokerOptions } from './broker-types.js';

export type { HostBrokerOptions, RemoteHostBrokerState, VisibleHostStates } from './broker-types.js';
export { USER_STREAM_LIMIT } from './http-replies.js';

/** The Relay's HTTP and socket handlers behind one object; a host adds its own listener around it. */
export type HostBroker = ReturnType<typeof createHostBroker>;

export function createHostBroker(options: HostBrokerOptions) {
  const accountBacked = options.accountBacked ?? options.durable ?? false;
  const origin = new URL(options.origin).origin;
  if (options.successionEnrollment && (!accountBacked || !options.onStateChange || !isSuccessionAssociationAuthority(options.successionEnrollment) || options.successionEnrollment.origin !== origin || options.successionEnrollment.ownerSubject !== options.ownerSubject)) throw new Error('Succession enrollment requires a durable authenticated tenant authority.');
  const now = options.now ?? Date.now;
  const hostStreamLimit = options.hostStreamLimit ?? HOST_STREAM_LIMIT;
  const ids = options.ids ?? systemIds;
  const scheduler = options.scheduler ?? defaultBrokerScheduler;
  const clearTimeout = scheduler.clearTimeout.bind(scheduler);
  const journals = options.journalService ?? (options.journals && createHostJournals({ store: options.journals, ids }));
  const heartbeat = { intervalMs: options.heartbeatIntervalMs ?? 30_000, timeoutMs: options.heartbeatTimeoutMs ?? 10_000 };
  if (!Number.isSafeInteger(heartbeat.intervalMs) || !Number.isSafeInteger(heartbeat.timeoutMs) || heartbeat.timeoutMs < 1 || heartbeat.timeoutMs >= heartbeat.intervalMs || heartbeat.intervalMs > 600_000) {
    throw new RangeError('Host heartbeat deadlines require 0 < timeout < interval <= 600000 milliseconds.');
  }
  const clients = new Set<RelaySocket>();
  function track(client: RelaySocket) { clients.add(client); client.onClose(() => clients.delete(client)); }
  const brokerState = createBrokerState({ initialState: options.initialState, now, ...(options.onStateChange ? { onStateChange: options.onStateChange } : {}),
    keepsAssociations: !!options.successionEnrollment || !!options.initialState?.associations, keepsSharing: !!options.ownerSubject });
  for (const host of brokerState.hosts.values()) options.diagnostics?.record(host.id, { event: 'relay_started' });
  const activeStreamCount = (subject: string) => [...brokerState.hosts.values()].reduce((sum, host) => sum + [...host.streams.values()].filter(stream => stream.subject === subject).length, 0);
  const previews = createHostPreviews({ initial: options.initialState?.previews, scheduler, now,
    save: (value, publish) => {
      const owners = value.map(item => brokerState.hosts.get(item.hostId));
      return brokerState.commit(draft => {
        for (const host of owners) { if (!host) throw new BrokerError(404, 'host_revoked', 'Preview Host access was revoked.'); brokerState.assertHostCurrent(host); }
        draft.previews = value; return { value: undefined, publish };
      });
    },
    renew: async (hostId, id) => {
      const result = await rpc(requireHost(hostId), 'POST', '/remote/previews/renew', undefined, JSON.stringify({ id }));
      if (result.status !== 200) throw new Error('Preview renewal unavailable.');
      return (JSON.parse(result.body) as { registration: { expiresAt: number } }).registration;
    },
    remove: async (hostId, id) => { const result = await rpc(requireHost(hostId), 'POST', '/remote/previews/unregister', undefined, JSON.stringify({ id }));
      if (result.status !== 200) throw new Error('Preview removal is pending.'); },
  });
  brokerState.previews = previews;
  brokerState.onUnavailable(() => {
    hostSession.closeAll('relay_state_unavailable', 1011);
    for (const client of clients) client.close(1011, 'Relay state is unavailable');
  });
  const access = createAccess({ state: brokerState, ownerSubject: options.ownerSubject });
  const { owner, hostAllowed, sessionAllowed, requireOwner, requireAccess, requireHost } = access;
  const { teams, callForSupportChange, resolveRole } = createTeamService({ brokerState, options, now, requireHost,
    rpc: (...args) => rpc(...args), assertAssociationOpen: target => assertAssociationOpen(target),
    associationSource: (...args) => associationSource(...args), prefixRecords: host => prefixRecords(host) });
  const succession = createSuccession({ brokerState, enrollment: options.successionEnrollment, projectionAllowance: options.successionProjectionAllowance, ids, rpc: (...args: Parameters<typeof rpc>) => rpc(...args),
    teams: { assertReplacementSupported: (...args) => teams.assertReplacementSupported(...args), hasUnsettledRecipient: (...args) => teams.hasUnsettledRecipient(...args) },
    creations: { has: key => sessionBindings.hasCreation(key) } });
  const { assertCapacity: assertAssociationCapacity, change: associationChange, assertOpen: assertAssociationOpen, assertMutable: assertAssociationMutable, assertCreationOpen: assertAssociationCreationOpen, source: associationSource, rpc: associationRpc, action: successionAction, prefixRecords } = succession;
  const relations = createRelations({ brokerState, access, succession, enrollment: options.successionEnrollment, ids });
  const { currentRelationTarget, canonicalRelationInput, relationAccess, savedRelationOperation, continueRelationChange, relationIntent, assertExactRelationIntent, assertRelationNotReset, reserveRelationUpdate } = relations;
  function changeSharing<T>(change: (draft: HostSharing) => T): Promise<T> {
    return brokerState.commit(state => {
      const draft = new HostSharing(state.sharing, () => {});
      const value = change(draft); state.sharing = draft.snapshot();
      return { value, publish() { brokerState.sharing = draft; } };
    });
  }
  const permitted = async (context: BrokerRequestContext) => !context.authorize || await context.authorize() === true;
  const keyHash = (key: string) => createHash('sha256').update(key).digest('hex');
  const requireJournal = (hostId: string) => {
    const connection = requireHost(hostId).journal;
    if (!connection) throw new BrokerError(501, 'journal_unavailable', 'The Controller on this Host does not publish journals.');
    return connection;
  };
  /** Serves the reads of sessions that have a journal head from their journals; see journal-sessions.ts. */
  const journalSessions = journals && createJournalSessions({
    journals, scheduler,
    gate: {
      readingEnabled: (hostId, providerId) => brokerState.hosts.get(hostId)?.smartReading?.includes(providerId) === true,
      served: (hostId, sessionKey) => journals.served(hostId, sessionKey),
      loadServed: async hostId => { await journals.servedSessions(hostId); },
    },
    requestFill: async (hostId, sessionKey, itemKeys, read) => requireJournal(hostId).requestFill(sessionKey, itemKeys, read),
    requestOlder: async (hostId, sessionKey, limit, beforeItemKey) => requireJournal(hostId).requestOlder(sessionKey, limit, beforeItemKey),
    shownChanged: hostId => { const host = brokerState.hosts.get(hostId); if (host) showSessions(host); },
  });
  const deletion = createJournalDeletion({ state: brokerState, journals, scheduler, diagnostics: options.diagnostics, timeoutMs: options.journalDeletionTimeoutMs ?? 30_000 });
  const credentialExpiry = createExpiry({ scheduler, now });
  const hostViews = createHostViews({ brokerState, access, accountBacked, ownerSubject: options.ownerSubject, now });
  const { sessionStates, visibleHosts } = hostViews;
  const hostSession = createHostSession({ brokerState, options, accountBacked, heartbeat, now, scheduler, ids, journals, deletion, previews, teams, views: hostViews, expiry: credentialExpiry, keyHash,
    journalPublished: (hostId, sessionKey, result) => journalSessions?.published(hostId, sessionKey, result), hostReady: host => showSessions(host) });
  const { register, rpc, send, diagnostic, disconnected, notifySessionStates } = hostSession;
  const sessionBindings = createSessionBindings({ brokerState, access, succession, rpc, ids, now, scheduler, enrollmentEnabled: !!options.successionEnrollment, savedAssociations: options.initialState?.associations,
    ownerSubject: options.ownerSubject, rpcTimeoutMs: options.rpcTimeoutMs,
    readableWithoutController: async binding => !!journalSessions && await journalSessions.serves(binding.hostId, binding.providerId, journalSessionKey(binding.providerId, binding.nativeSessionId)).catch(() => false),
    nativeRefusalChanged: (binding, refusal) => journalSessions?.refused(binding.hostId, journalSessionKey(binding.providerId, binding.nativeSessionId), refusal) });
  const { runtimeAgentId, sessionRead, recoverBinding, waitForCreation, userMutation, sharedCatalog, nativeRefusal } = sessionBindings;
  /**
   * Visibility: tells a Host's Controller the complete set of its sessions that pages show (`journal_shown`), when it registers and
   * whenever the set changes, and attaches each shown session the Controller does not hold on this connection, so that every session a
   * page shows is resident and live. Only a Controller that asked for the set is told.
   */
  function showSessions(host: Host): void {
    if (!host.ready || !host.journalShown || !journalSessions) return;
    const sessionKeys = journalSessions.shown(host.id);
    try { send(host, { uplinkVersion: 2, type: 'journal_shown', sessionKeys }); }
    catch { return; }
    const shown = new Set(sessionKeys);
    for (const binding of brokerState.bindings.values()) {
      if (binding.hostId !== host.id || binding.generation === host.generation || !shown.has(journalSessionKey(binding.providerId, binding.nativeSessionId))) continue;
      // A session the Controller refuses stays read from its journal; the page's own open says why.
      void recoverBinding(host, binding).catch(() => undefined);
    }
  }
  const bridgeLookups = new Map<string, Promise<ControllerRelease>>();
  function readUpgradeBridge(version: string, refresh = false): Promise<ControllerRelease> {
    if (refresh) bridgeLookups.delete(version);
    let lookup = bridgeLookups.get(version);
    if (!lookup) {
      const releases = options.controllerReleases ?? controllerReleases;
      if (!releases.version) return Promise.reject(new Error('Upgrade component release discovery is unavailable.'));
      lookup = releases.version(version).catch(error => {
        if (bridgeLookups.get(version) === lookup) bridgeLookups.delete(version);
        throw error;
      });
      bridgeLookups.set(version, lookup);
    }
    return lookup;
  }

  async function handle(request: Request, context: BrokerRequestContext, url: URL) {
    brokerState.assertAvailable();
    if (!await permitted(context)) throw new BrokerError(403, 'forbidden', 'This endpoint is available only to the local application.');
    if (request.method === 'POST' || (request.method === 'PUT' && /^\/v1\/remote\/hosts\/[^/]+\/smart-reading$/.test(url.pathname))) {
      const access = context.validateMutation?.();
      if (access?.status === 'rejected') throw new BrokerError(access.httpStatus, access.code, access.message);
    }
    const subject = principal(context);
    for (const route of routes) {
      const response = await route(request, context, url, subject);
      if (response) return response;
    }
    throw new BrokerError(404, 'route_not_found', 'Unknown Remote Host route.');
  }
  const socketEdge = createSocketEdge({ brokerState, options, now, ids, scheduler, origin, hostStreamLimit, sessionAllowed, requireHost, permitted, keyHash, track, credentialExpiry,
    register, send, diagnostic, journalSessions, runtimeAgentId, recoverBinding, nativeRefusal, activeStreamCount,
    admitClientMessages: createClientAdmission({ now, owner }) });
  const routes: RouteGroup[] = [
    createControllerRoutes({ access, brokerState, rpc, successionAction: succession.action, options }),
    createTeamRoutes({ access, brokerState, now, teams, callForSupportChange, resolveRole }),
    createHostServiceRoutes({ access, brokerState, rpc }),
    createPreviewRoutes({ access, brokerState, now, rpc, previews }),
    createPairingRoutes({ access, brokerState, now, ids, rpc, disconnected, previews, deletion, journals, journalSessions, visibleHosts, credentialExpiry, accountBacked, keyHash, sessionBindings, options }),
    createSessionDirectoryRoutes({ access, brokerState, rpc, waitForCreation, userMutation, sharedCatalog }),
    createSessionReadRoutes({ access, brokerState, sessionBindings }),
  ];
  const handlesRequest = (url: URL) => {
    const session = /^\/v1\/sessions\/([^/]+)\//.exec(url.pathname);
    return url.pathname === '/v1/remote/controller-release' || /^\/v1\/remote\/(hosts|pairings|teams|call-for-support)(\/|$)/.test(url.pathname) || !!(session && brokerState.bindings.has(session[1]!));
  };
  const handlesUpgrade = (url: URL) => {
    const session = /^\/v1\/sessions\/([^/]+)\//.exec(url.pathname);
    return url.pathname === '/ws/remote-host' || !!(session && brokerState.bindings.has(session[1]!));
  };
  function authenticateDevice(value: string) {
    if (brokerState.unavailable || !accountBacked) return undefined;
    const hash = keyHash(value); const credential = brokerState.keys.get(hash);
    if (!credential || credential.kind !== 'device' || credential.requiresRotation || !credential.installationId || credential.expires <= now()) return undefined;
    const host = [...brokerState.hosts.values()].find(host => host.installationId === credential.installationId);
    if (!host) return undefined;
    return { hostId: host.id, hostName: host.name, pairingPurpose: host.pairingPurpose ?? (host.gatewayKeyRequested ? 'gateway-setup' : 'host-only'),
      current: () => !brokerState.unavailable && brokerState.keys.get(hash) === credential && credential.expires > now() && brokerState.hosts.get(host.id) === host };
  }
  if (brokerState.journalDeletions.length > 0) deletion.drain();
  return {
    previews,
    authenticateDevice,
    async markGatewayKeyRequested(value: string): Promise<boolean> {
      return brokerState.commit(draft => {
        const device = authenticateDevice(value);
        if (!device || device.pairingPurpose !== 'gateway-setup') return { value: false, publish() {} };
        draft.hosts.find(host => host.id === device.hostId)!.gatewayKeyRequested = true;
        return { value: true, publish() { brokerState.hosts.get(device.hostId)!.gatewayKeyRequested = true; } };
      });
    },
    gatewayKeyHost(hostId: string, subject: string) {
      const host = brokerState.hosts.get(hostId);
      return !brokerState.unavailable && owner(subject) && host?.gatewayKeyRequested ? { hostId: host.id, hostName: host.name } : undefined;
    },
    ownsHost: (hostId: string, subject: string) => brokerState.hosts.has(hostId) && owner(subject),
    /** Whether an account may leave messages for this Host: its own Host, whose Controller delivers from the outbox. */
    outboxHost: (hostId: string, subject: string) => !brokerState.unavailable && owner(subject) && brokerState.hosts.get(hostId)?.outbox === 1,
    /** Tells a connected Host's Controller that a message waits for it. */
    outboxReady(hostId: string) {
      const host = brokerState.hosts.get(hostId);
      if (!host?.ready || host.outbox !== 1 || host.socket?.readyState !== RELAY_SOCKET_OPEN) return;
      try { send(host, { uplinkVersion: 2, type: 'outbox_ready' }); } catch { /* The Controller polls again on its own. */ }
    },
    /**
     * Asks a connected Host's Controller to read item bodies again from native history. Resolves with what the journal
     * accepted; rejects with a JournalRequestError (timeout, in_flight, busy, closed) or a BrokerError for an offline Host.
     * The caller authorizes the read this serves.
     */
    async requestFill(hostId: string, sessionKey: string, itemKeys: string[], read?: JournalReadRequest) { return requireJournal(hostId).requestFill(sessionKey, itemKeys, read); },
    /** Asks a connected Host's Controller to read older history and publish it as prepended items. */
    async requestOlder(hostId: string, sessionKey: string, limit: number, beforeItemKey: string) { return requireJournal(hostId).requestOlder(sessionKey, limit, beforeItemKey); },
    tunnelHost: (token: string) => [...brokerState.hosts.values()].find(host => host.ready && host.socket?.readyState === RELAY_SOCKET_OPEN && host.tunnelToken === token)?.id,
    acceptTunnel(token: string, socket: TunnelSocket) {
      const host = [...brokerState.hosts.values()].find(host => host.ready && host.socket?.readyState === RELAY_SOCKET_OPEN && host.tunnelToken === token);
      if (!host || brokerState.unavailable) { socket.close(1008, 'Tunnel authorization expired'); return; }
      previews.attach(host.id, socket);
    },
    snapshot: brokerState.snapshot,
    activeStreamCount,
    settled: brokerState.settled,
    visibleHosts,
    hasHost: (hostId: string) => brokerState.hosts.has(hostId),
    canAccessHost: hostAllowed,
    sessionStates,
    canStarSession: (item: { hostId: string; providerId: string; nativeSessionId: string }, subject: string) => {
      const host = brokerState.hosts.get(item.hostId);
      if (!hostAllowed(item.hostId, subject) || !host?.providers.some(provider => provider.providerId === item.providerId)) return false;
      const binding = brokerState.nativeBindings.get(JSON.stringify([item.hostId, item.providerId, item.nativeSessionId]));
      return owner(subject) || !!binding && sessionAllowed(binding, subject);
    },
    sessionRelations(subject: string): SessionRelation[] {
      const result: SessionRelation[] = [];
      for (const binding of brokerState.bindings.values()) {
        const relation = binding.sourceRelation, host = brokerState.hosts.get(binding.hostId);
        if (!relation || !host || !sessionAllowed(binding, subject)) continue;
        const nativeSourceRef = relation.nativeSourceRef ?? associationSource(host, binding.providerId, relation.sourceNativeSessionId);
        const fixed = brokerState.nativeBindings.get(JSON.stringify([binding.hostId,nativeSourceRef.providerId,nativeSourceRef.nativeSessionId]));
        if (!fixed || !sessionAllowed(fixed,subject)) continue;
        const operation = brokerState.associations.relationChanges.filter(row => row.reservation.hostId === host.id && row.reservation.relationId === relation.id && nativeSessionRefKey(row.reservation.readerRef) === nativeSessionRefKey(associationSource(host,binding.providerId,binding.nativeSessionId))).at(-1);
        const latest = brokerState.associations.freezes.filter(row => row.hostId === host.id && row.projection
          && [...row.receipt.lineage, row.projection.role.current].some(ref => nativeSessionRefKey(ref) === nativeSessionRefKey(nativeSourceRef))).at(-1);
        const projection = latest?.projection;
        const enrolled = latest?.receipt.relations.some(value => value.relationId === relation.id && value.linked
          && nativeSessionRefKey(value.readerRef) === nativeSessionRefKey(associationSource(host,binding.providerId,binding.nativeSessionId)));
        const pending = operation && operation.phase !== 'committed';
        const role = projection?.role ?? (operation ? { id:operation.reservation.roleId,origin:operation.reservation.origin,current:operation.reservation.current,revision:operation.reservation.expectedRoleRevision } : undefined);
        const follows = (relation.linked ?? true) && !pending && !!role && (enrolled || operation?.phase === 'committed' && operation.reservation.linked);
        const selected = follows ? role!.current : nativeSourceRef;
        if (!host.providers.some(row => row.providerId === selected.providerId)) continue;
        const resolved = brokerState.nativeBindings.get(JSON.stringify([binding.hostId,selected.providerId,selected.nativeSessionId]));
        if (resolved && !sessionAllowed(resolved,subject)) continue;
        const navigationRef = operation?.reservation.current;
        const navigationBinding = navigationRef ? brokerState.nativeBindings.get(JSON.stringify([host.id,navigationRef.providerId,navigationRef.nativeSessionId])) : undefined;
        const identity = (value: Binding, title: string) => ({ hostId:value.hostId,providerId:value.providerId,nativeSessionId:value.nativeSessionId,agentId:value.agentId,title });
        if (!resolved && !owner(subject)) continue;
        let target: NativeSessionRef;
        try {
          target = currentRelationTarget(host, binding, subject);
          if (!host.providers.some(row => row.providerId === target.providerId)) continue;
        } catch { continue; }
        const targetBinding = brokerState.nativeBindings.get(JSON.stringify([host.id, target.providerId, target.nativeSessionId]));
        result.push({id:relation.id,kind:relation.kind,createdAt:relation.createdAt,linked:relation.linked??true,revision:relation.revision??0,nativeSourceRef,
          hostLocator:{hostId:host.id,controllerId:host.installationId}, sourceBinding:follows?{kind:'primary_role',roleId:role!.id,origin:role!.origin}:{kind:'fixed',source:nativeSourceRef},
          ...(pending && navigationRef && host.providers.some(row=>row.providerId===navigationRef.providerId)
            && (navigationBinding ? sessionAllowed(navigationBinding,subject) : owner(subject))
            ? {navigationSource:navigationBinding?identity(navigationBinding,'Source session'):{hostId:host.id,providerId:navigationRef.providerId,nativeSessionId:navigationRef.nativeSessionId,agentId:'',title:'Source session'}} : {}),
          ...(role?{roleRevision:role.revision}:{}), ...(operation?{operation:{operationId:operation.reservation.operationId,phase:operation.phase}}:{}),
          source:resolved?identity(resolved,'Source session'):{hostId:host.id,providerId:selected.providerId,nativeSessionId:selected.nativeSessionId,agentId:'',title:'Source session'},target:targetBinding ? identity(targetBinding,relation.kind==='ask'?'Ask':'Side') : {hostId:host.id,providerId:target.providerId,nativeSessionId:target.nativeSessionId,agentId:'',title:relation.kind==='ask'?'Ask':'Side'}});
      }
      return result.sort((a,b)=>a.createdAt.localeCompare(b.createdAt)||a.id.localeCompare(b.id));
    },
    async importSessionRelation(subject: string, rawInput: Record<string, unknown>): Promise<void> {
      if (!validSourceRelation(rawInput) || typeof rawInput.hostId !== 'string' || typeof rawInput.providerId !== 'string' || typeof rawInput.nativeSessionId !== 'string') {
        throw new SharingError(400, 'invalid_relation', 'A complete session relation is required.');
      }
      const requested = { ...rawInput } as typeof rawInput & { hostId: string; providerId: string; nativeSessionId: string };
      const input = canonicalRelationInput(subject, requested, true);
      const binding = brokerState.nativeBindings.get(JSON.stringify([input.hostId, input.providerId, input.nativeSessionId]));
      const source = brokerState.nativeBindings.get(JSON.stringify([input.hostId, input.providerId, input.sourceNativeSessionId]));
      const allowed = () => binding && source && binding !== source && sessionAllowed(binding, subject) && sessionAllowed(source, subject);
      if (!allowed()) throw new SharingError(403, 'session_forbidden', 'Session access is unavailable.');
      assertAssociationMutable(associationSource(brokerState.hosts.get(input.hostId)!, input.providerId, input.sourceNativeSessionId));
      const proven = [...brokerState.completedCreations.values()].some(value => {
        if (value.agentId !== binding!.agentId) return false;
        try { return JSON.parse(value.fingerprint).sourceNativeSessionId === input.sourceNativeSessionId; } catch { return false; }
      });
      if (!proven) throw new SharingError(403, 'unverified_relation', 'The source relationship could not be verified.');
      const relation: SourceRelation = { id: input.id, kind: input.kind, sourceNativeSessionId: input.sourceNativeSessionId, createdAt: input.createdAt };
      await brokerState.commit(draft => {
        const current = canonicalRelationInput(subject, requested, true);
        if (brokerState.nativeBindings.get(JSON.stringify([current.hostId, current.providerId, current.nativeSessionId])) !== binding) throw new SharingError(409, 'relation_conflict', 'The source reader binding changed.');
        if (!allowed() || brokerState.bindings.get(binding!.agentId) !== binding) throw new SharingError(403, 'session_forbidden', 'Session access is unavailable.');
        assertAssociationMutable(associationSource(brokerState.hosts.get(input.hostId as string)!, input.providerId as string, input.sourceNativeSessionId as string));
        if (options.successionEnrollment || draft.associations) { draft.associations = structuredClone(brokerState.associations); draft.associations.revision++; }
        const prior = binding!.sourceRelation;
        if (prior && (prior.kind !== relation.kind || prior.id !== relation.id || prior.sourceNativeSessionId !== relation.sourceNativeSessionId)) {
          throw new SharingError(409, 'relation_conflict', 'This session already has a different relationship.');
        }
        const saved = draft.bindings.find(item => item.agentId === binding!.agentId)!;
        saved.sourceRelation = prior ?? relation;
        return { value: undefined, publish() { if (draft.associations) brokerState.associations = draft.associations; binding!.sourceRelation = saved.sourceRelation; } };
      });
    },
    async updateSessionRelation(subject: string, rawInput: unknown): Promise<void | { operation: BrokerRelationChange }> {
      if (!validSessionRelationUpdate(rawInput)) throw new SharingError(400, 'invalid_relation', 'A complete session relation and current revision are required.');
      const requested = { ...rawInput };
      const input = canonicalRelationInput(subject, requested);
      const expectedBinding = brokerState.nativeBindings.get(JSON.stringify([input.hostId, input.providerId, input.nativeSessionId]));
      const host = brokerState.hosts.get(input.hostId);
      if (host) {
        const nativeRelation = brokerState.nativeBindings.get(JSON.stringify([host.id,input.providerId,input.nativeSessionId]))?.sourceRelation;
        const source = nativeRelation?.nativeSourceRef ?? associationSource(host,input.providerId,input.sourceNativeSessionId);
        if (input.operationId && brokerState.associations.relationResets.some(row=>row.intent.operationId===input.operationId)) assertRelationNotReset(brokerState.associations,relationIntent(subject,input));
        const projection = brokerState.associations.freezes.filter(row => row.hostId === host.id && row.projection && [...row.receipt.lineage, row.projection.role.current].some(ref => nativeSessionRefKey(ref) === nativeSessionRefKey(source))).at(-1)?.projection;
        if (projection) return reserveRelationUpdate(subject, input, host, projection.role);
        assertAssociationMutable(source);
      }
      await brokerState.commit(draft => {
        if (!host) throw new SharingError(404, 'host_not_found', 'Host is unavailable.');
        brokerState.assertHostCurrent(host);
        const current = canonicalRelationInput(subject, requested);
        if (brokerState.nativeBindings.get(JSON.stringify([current.hostId, current.providerId, current.nativeSessionId])) !== expectedBinding) throw new SharingError(409, 'relation_conflict', 'The source reader binding changed.');
        assertAssociationMutable(associationSource(host, input.providerId, input.sourceNativeSessionId));
        const binding = brokerState.nativeBindings.get(JSON.stringify([input.hostId, input.providerId, input.nativeSessionId]));
        const source = brokerState.nativeBindings.get(JSON.stringify([input.hostId, input.providerId, input.sourceNativeSessionId]));
        if (!binding || !source || !sessionAllowed(binding, subject) || !sessionAllowed(source, subject)) {
          throw new SharingError(403, 'session_forbidden', 'Session access is unavailable.');
        }
        const relation = binding.sourceRelation;
        if (!relation || relation.kind !== 'side' || relation.id !== input.id || relation.sourceNativeSessionId !== input.sourceNativeSessionId) {
          throw new SharingError(409, 'relation_conflict', 'This side relationship changed. Refresh before trying again.');
        }
        const revision = relation.revision ?? 0;
        if (revision === input.expectedRevision + 1 && (relation.linked ?? true) === input.linked) return { value: undefined, publish() {} };
        if (revision !== input.expectedRevision) throw new SharingError(409, 'relation_conflict', 'This side relationship changed. Refresh before trying again.');
        const next = { ...relation, linked: input.linked, revision: revision + 1 };
        if (options.successionEnrollment || draft.associations) { draft.associations = structuredClone(brokerState.associations); draft.associations.revision++; }
        draft.bindings.find(item => item.agentId === binding.agentId)!.sourceRelation = next;
        return { value: undefined, publish() { if (draft.associations) brokerState.associations = draft.associations; binding.sourceRelation = next; } };
      });
    },
    async resetSessionRelationChange(subject: string, rawInput: unknown): Promise<{ reset: RelationChangeReset } | { operation: BrokerRelationChange }> {
      if (!validSessionRelationUpdate(rawInput)) throw new SharingError(400,'invalid_relation','An exact retained relationship intent is required.');
      const input = canonicalRelationInput(subject, rawInput);
      const host = requireHost(input.hostId);
      const selected = await associationChange(state => {
        brokerState.assertHostCurrent(host);
        const intent = relationIntent(subject,input);
        const existing = state.relationChanges.find(row => row.reservation.operationId === intent.operationId);
        if (existing) { assertExactRelationIntent(intent,existing.reservation); relationAccess(subject,existing.reservation); return { operation: existing }; }
        const previous = state.relationResets.find(row => row.intent.operationId === intent.operationId);
        if (previous) { assertExactRelationIntent(intent,previous.intent); return { reset: previous }; }
        if (state.relationResets.length >= 1024) throw new SharingError(409,'association_capacity','Relationship reset capacity is exhausted.');
        const reset: RelationChangeReset = { version: 1, phase: 'pre_effect', intent };
        state.relationResets.push(reset); return { reset };
      });
      return selected.operation ? continueRelationChange(subject,selected.operation) : { reset: structuredClone(selected.reset!) };
    },
    sessionRelationChangeStatus(subject: string, selection: { hostId: string; operationId: string }) { return { operation: structuredClone(savedRelationOperation(subject, selection)) }; },
    reconcileSessionRelationChange(subject: string, selection: { hostId: string; operationId: string }) { return continueRelationChange(subject, savedRelationOperation(subject, selection)); },
    canAccessSession: (agentId: string, subject: string) => { const binding = brokerState.bindings.get(agentId); return !!binding && sessionAllowed(binding, subject); },
    /** The session a public agent id is bound to, as a subject that may access it sees it. */
    sessionOf(agentId: string, subject: string): { hostId: string; providerId: string; nativeSessionId: string } | undefined {
      const binding = brokerState.bindings.get(agentId);
      return binding && sessionAllowed(binding, subject) ? { hostId: binding.hostId, providerId: binding.providerId, nativeSessionId: binding.nativeSessionId } : undefined;
    },
    async manageShares(subject: string, hostId: string, action: 'shares' | 'share' | 'revoke-share', targetSubject?: string, targetLabel?: string, sessionLimit?: number) {
      brokerState.assertAvailable();
      requireOwner(subject);
      const host = brokerState.hosts.get(hostId);
      if (!host) throw new SharingError(404, 'host_not_found', 'Host is unavailable.');
      if (action === 'shares') return { shares: brokerState.sharing.list(hostId) };
      if (!targetSubject || targetSubject === options.ownerSubject) throw new SharingError(400, 'invalid_recipient', 'Choose another user.');
      if (action === 'share') await changeSharing(draft => { brokerState.assertHostCurrent(host); draft.set(hostId, targetSubject, targetLabel ?? targetSubject, sessionLimit!); });
      else {
        await changeSharing(draft => { brokerState.assertHostCurrent(host); draft.revoke(hostId, targetSubject); });
        for (const [streamId, stream] of host.streams) if (stream.subject === targetSubject) {
          host.streams.delete(streamId); stream.buffered = []; clearTimeout(stream.timer);
          stream.socket.close(1008, 'Host share revoked');
          try { send(host, { uplinkVersion: 2, type: 'stream_close', streamId, code: 1008, reason: 'Host share revoked' }); } catch { /* The Host may be offline. */ }
        }
      }
      credentialExpiry.enforce();
      return { ok: true };
    },
    enforceExpiry() { credentialExpiry.enforce(); },
    disconnect(code = 1008) {
      for (const host of brokerState.hosts.values()) if (host.socket) { const socket = host.socket; disconnected(host, socket, code===1008?'access_revoked':'authority_unavailable', code); socket.close(code, code === 1008 ? 'Access revoked' : 'Authority temporarily unavailable'); }
    },
    handlesRequest,
    handlesUpgrade,
    async handleRequest(request: Request, context: BrokerRequestContext = {}): Promise<Response | undefined> {
      const url = new URL(request.url);
      if (!handlesRequest(url)) return undefined;
      try { return await handle(request, context, url); }
      catch (error) {
        if (error instanceof BrokerError || error instanceof SharingError) return json(error.status, { code: error.code, error: error.message, ...(error instanceof BrokerError && error.requestId ? { requestId: error.requestId } : {}), ...(error instanceof BrokerError && error.nativeOwner ? {nativeOwner: error.nativeOwner} : {}), ...(error instanceof BrokerError && error.resetsAt !== undefined ? { resetsAt: error.resetsAt } : {}) });
        return json(503, { code: 'host_operation_failed', error: error instanceof Error ? error.message : 'Remote Host operation failed.' });
      }
    },
    async prepareUpgrade(request: Request, context: BrokerRequestContext = {}): Promise<{ accept(socket: RelaySocket): void } | Response | undefined> {
      const url = new URL(request.url);
      if (!handlesUpgrade(url)) return undefined;
      try { return await socketEdge.upgrade(request, context, url); }
      catch { return rejectUpgrade(503); }
    },
    close() {
      brokerState.close();
      previews.close();
      hostSession.stopTimers();
      for (const host of brokerState.hosts.values()) if (host.socket) disconnected(host, host.socket, 'relay_closed', 1001);
      for (const client of clients) client.close(1001, 'Broker closed');
      clients.clear();
      brokerState.keys.clear(); brokerState.hosts.clear(); brokerState.bindings.clear(); brokerState.nativeBindings.clear(); sessionBindings.clear();
    },
  };
}
