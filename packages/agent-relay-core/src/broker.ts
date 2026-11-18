import { TeamBroker, teamMessageBudgetBytes } from './teams.js';
import { emptyCallForSupportState, validCallForSupportState, type CallForSupportState } from './call-for-support-profiles.js';
import { TEAM_RECORD_BYTES, teamBytes, teamStateBytes, trimTeamDeliveryReceipts, validSavedTeam, type SavedTeam } from './team-delivery.js';
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
import { committed, detached } from './drafts.js';
import { sessionIdentityMessage, withoutItemKeysFlag } from './session-identity.js';
import { JOURNAL_VERSION } from '@orchardworks/agent-remote-protocol';
import type { RelationChangeReset, BrokerRelationChange } from './relation-changes.js';
import { isDeepStrictEqual } from 'node:util';
import { resolveRoleSuccession, nativeSessionRefKey, type NativeSessionRef } from '@orchardworks/agent-remote-protocol';
import { isSuccessionAssociationAuthority } from '@orchardworks/agent-remote-protocol';
import { validSessionRelationUpdate, validSourceRelation, type SourceRelation, type SessionRelation } from '@orchardworks/agent-remote-protocol/model';
import type { NativeSessionOwner } from '@orchardworks/agent-remote-protocol';
import { controllerReleases } from './controller-releases.js';
import { decodeClientMessage, PROTOCOL_VERSION, type ControllerRelease } from '@orchardworks/agent-remote-protocol';
import { createHash } from 'node:crypto';
import { systemIds } from './relay-ids.js';
import { HostSharing, SharingError } from './host-sharing.js';
import { createHostPreviews } from './host-previews.js';
import type { TunnelSocket } from '@orchardworks/agent-remote-tunnel';
import { defaultBrokerScheduler, RELAY_SOCKET_OPEN, type BrokerRequestContext, type RelaySocket } from './transport.js';
import { createHostJournals, type JournalReadRequest } from './host-journals.js';
import { createHostStreamOpener } from './journal-host-stream.js';
import { createStreamControl } from './stream-control.js';
import { createJournalSessions, journalSessionKey } from './journal-sessions.js';
import { required, readOnlyProviders } from './request-input.js';
import { json, rejectUpgrade, HOST_STREAM_LIMIT, USER_STREAM_LIMIT, capacityRefusal } from './http-replies.js';
import { BrokerError, type Binding, type Host, type HostBrokerOptions, type RemoteHostBrokerState, type VisibleHostStates } from './broker-types.js';

export type { HostBrokerOptions, RemoteHostBrokerState, VisibleHostStates } from './broker-types.js';
export { USER_STREAM_LIMIT } from './http-replies.js';

/** The Relay's HTTP and socket handlers behind one object; a host adds its own listener around it. */
export type HostBroker = ReturnType<typeof createHostBroker>;

export function createHostBroker(options: HostBrokerOptions) {
  const accountBacked = options.accountBacked ?? options.durable ?? false;
  const origin = new URL(options.origin).origin;
  if (options.successionEnrollment && (!accountBacked || !options.onStateChange || !isSuccessionAssociationAuthority(options.successionEnrollment) || options.successionEnrollment.origin !== origin || options.successionEnrollment.ownerSubject !== options.ownerSubject)) throw new Error('Succession enrollment requires a durable authenticated tenant authority.');
  const now = options.now ?? Date.now;
  const ids = options.ids ?? systemIds;
  const scheduler = options.scheduler ?? defaultBrokerScheduler;
  const setTimeout = scheduler.setTimeout.bind(scheduler);
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
  const previews = createHostPreviews({ initial: options.initialState?.previews,
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
  /** The session that holds the role of a session on a Host now, across handoffs. */
  function resolveRole(hostId: string, providerId: string, anchorNativeId: string): NativeSessionRef {
    const host = brokerState.hosts.get(hostId);
    if (!host) throw new Error('Team recipient Host is unavailable.');
    return resolveRoleSuccession(associationSource(host, providerId, anchorNativeId), prefixRecords(host)).target;
  }
  function callForSupportChange<T>(update: (state: CallForSupportState) => T): Promise<T> {
    return brokerState.commit(draft => {
      const next = structuredClone(brokerState.callForSupport ?? emptyCallForSupportState()), value = structuredClone(update(next));
      if (isDeepStrictEqual(next, brokerState.callForSupport ?? emptyCallForSupportState())) return { value, unchanged: true, publish() {} };
      if (!validCallForSupportState(next)) throw new Error('Invalid Call For Support state.');
      draft.callForSupport = next; return { value, publish() { brokerState.callForSupport = next; } };
    });
  }
  const teams = new TeamBroker({
    resolveSession: resolveRole,
    assertRecipient: target => assertAssociationOpen(target),
    assertRecipientSupport(hostId, generic) {
      const host = requireHost(hostId);
      if (host.teamRecipients !== 1) throw new BrokerError(409, 'team_recipients_upgrade_required', 'Update the Controller before replacing a Team recipient.');
      if (generic && host.teamSuccession !== 1) throw new BrokerError(409, 'team_succession_upgrade_required', 'Update the Controller to hand off Team members.');
    },
    resources: options.teamResources,
    now, read: () => brokerState.teams,
    ...(options.stateRoom ? { retention: () => options.stateRoom!().retention } : {}),
    change: update => brokerState.commit(draft => {
      // Only the Teams a change touches are copied, measured and validated; the others stay the committed objects.
      let value!: ReturnType<typeof update>;
      let next = committed.produce(brokerState.teams, teams => { value = structuredClone(detached(update(teams))); });
      const previous = new Map(brokerState.teams.map(team => [team.id, team]));
      const changed = (team: SavedTeam) => team !== previous.get(team.id);
      // A Team over its bound first loses its oldest settled receipts.
      if (next.some(team => changed(team) && teamBytes(team) > TEAM_RECORD_BYTES)) next = committed.produce(next, teams => {
        next.forEach((team, index) => { if (changed(team)) trimTeamDeliveryReceipts(teams[index]!, TEAM_RECORD_BYTES, teamBytes(team)); });
      });
      if (next === brokerState.teams || next.length === brokerState.teams.length && next.every((team, index) => team === brokerState.teams[index] || isDeepStrictEqual(team, brokerState.teams[index]))) return { value, unchanged: true, publish() {} };
      if (!next.every(team => brokerState.validTeams.has(team) || validSavedTeam(team) && teamMessageBudgetBytes(team) <= 128 * 1024 && brokerState.validTeams.add(team))) throw new Error('Team storage capacity reached.');
      // A change may not grow a Team beyond its bound, nor the Relay beyond its own; it may still shrink either.
      const grown = (team: SavedTeam) => teamBytes(team) > (previous.has(team.id) ? teamBytes(previous.get(team.id)!) : 0);
      if (next.some(team => changed(team) && teamBytes(team) > TEAM_RECORD_BYTES && grown(team))) throw new Error('Team storage capacity reached.');
      const growth = teamStateBytes(next) - teamStateBytes(brokerState.teams);
      if (growth > 0 && options.stateRoom && growth > options.stateRoom().growth) throw new Error('Team storage capacity reached.');
      draft.teams = next; return { value, publish() { brokerState.teams = next; } };
    }),
    assertHost(hostId, providerId) { const host = requireHost(hostId); if (!host.teamManagement) throw new Error('Update the Controller to use Teams.'); if (!host.providers.some(provider => provider.providerId === providerId)) throw new Error('Provider is unavailable on this Host.'); },
    async createSeat(hostId, seat) {
      const result = await rpc(requireHost(hostId), 'POST', '/remote/team/create-seat', undefined, JSON.stringify(seat));
      const value = JSON.parse(result.body); if (result.status !== 200) throw new Error(value.error ?? 'Team session creation failed.'); return value;
    },
    callForSupport: {
      state: () => brokerState.callForSupport,
      capable: hostId => brokerState.hosts.get(hostId)?.callForSupport === 1,
      assertHost(hostId) { if (requireHost(hostId).callForSupport !== 1) throw new BrokerError(409, 'call_for_support_upgrade_required', 'Update the Controller to use Call For Support.'); },
      readOnly: (hostId, providerId) => { const host = brokerState.hosts.get(hostId); return host?.callForSupport === 1 && !!host.readOnlyProviders?.includes(providerId) && host.providers.some(provider => provider.providerId === providerId); },
      async supportPatch(hostId, input) {
        const result = await rpc(requireHost(hostId), 'POST', '/remote/team/support-patch', undefined, JSON.stringify(input));
        const value = JSON.parse(result.body); if (result.status !== 200) throw new Error(value.error ?? 'The supporter patch failed.'); return value;
      },
      async supportBundle(hostId, input) {
        const result = await rpc(requireHost(hostId), 'POST', '/remote/team/support-bundle', undefined, JSON.stringify(input));
        const value = JSON.parse(result.body); if (result.status !== 200) throw new Error(value.error ?? 'The support bundle failed.'); return value;
      },
    },
  });
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
  });
  const deletion = createJournalDeletion({ state: brokerState, journals, scheduler, diagnostics: options.diagnostics, timeoutMs: options.journalDeletionTimeoutMs ?? 30_000 });
  const credentialExpiry = createExpiry({ scheduler, now });
  const hostViews = createHostViews({ brokerState, access, accountBacked, ownerSubject: options.ownerSubject, now });
  const { sessionStates, visibleHosts } = hostViews;
  const hostSession = createHostSession({ brokerState, options, accountBacked, heartbeat, now, scheduler, ids, journals, deletion, previews, teams, views: hostViews, expiry: credentialExpiry, keyHash,
    journalPublished: (hostId, sessionKey, result) => journalSessions?.published(hostId, sessionKey, result) });
  const { register, rpc, send, diagnostic, disconnected, notifySessionStates } = hostSession;
  const sessionBindings = createSessionBindings({ brokerState, access, succession, rpc, ids, now, scheduler, enrollmentEnabled: !!options.successionEnrollment, savedAssociations: options.initialState?.associations,
    ownerSubject: options.ownerSubject, rpcTimeoutMs: options.rpcTimeoutMs });
  const { runtimeAgentId, sessionRead, recoverBinding, waitForCreation, userMutation, sharedCatalog } = sessionBindings;
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
  /**
   * The limits and authorization every message of a browser session stream passes before anything else happens to it.
   * Returns a function that is true when the message may proceed; otherwise it already closed the stream or answered.
   */
  function admitClientMessages(client: RelaySocket, context: BrokerRequestContext, subject: string | undefined, expiry: () => number | undefined): (raw: string, binary: boolean) => boolean {
    let messageWindow = now(); let messageCount = 0; let timelineCount = 0; let imageChunkCount = 0; let imageChunkBytes = 0; let resourceCount = 0; let resourceBytes = 0;
    const refuse = (code: number, reason: string) => { client.close(code, reason); return false; };
    return (raw, binary) => {
      if (binary) return refuse(1003, 'Text protocol required');
      if (now()-messageWindow >= 60_000) { messageWindow=now(); messageCount=0; timelineCount=0; imageChunkCount=0; imageChunkBytes=0; resourceCount=0; resourceBytes=0; }
      let publicMessage: { type?: string; payload?: { locator?: unknown } };
      try { publicMessage = JSON.parse(raw.toString()); } catch { return refuse(1008, 'Invalid session message'); }
      if (publicMessage?.type === 'image_upload_chunk') {
        const bytes = Buffer.byteLength(raw.toString());
        imageChunkBytes += bytes;
        if (bytes > 48 * 1024 || ++imageChunkCount > 2048 || imageChunkBytes > 48 * 1024 * 1024) return refuse(1008, 'Image upload rate exceeded');
      } else if (publicMessage?.type === 'resource_upload_chunk' || publicMessage?.type === 'resource_download_request'
        // A conversation's images and a previewed file's local resources resolve and read one message each.
        || publicMessage?.type === 'resource_resolve_request' || publicMessage?.type === 'resource_request') {
        const bytes = Buffer.byteLength(raw.toString()); resourceBytes += bytes;
        if (bytes > 48 * 1024 || ++resourceCount > 8192 || resourceBytes > 192 * 1024 * 1024) return refuse(1008, 'Resource transfer rate exceeded');
      } else if (publicMessage?.type === 'timeline_request') {
        // Searching and reading older history take one page per request over the session wire; they are reads, not control messages.
        if (++timelineCount > 600) return refuse(1008, 'Timeline request rate exceeded');
      } else if (++messageCount > 120) return refuse(1008, 'Control message rate exceeded');
      if (context.authorizeMessage?.(raw.toString()) === false) {
        const decoded = decodeClientMessage(raw.toString());
        if (decoded.status !== 'ok' || !('payload' in decoded.value) || !('requestId' in decoded.value.payload)) return refuse(1008, 'Invalid session message');
        client.send(JSON.stringify({ protocolVersion: PROTOCOL_VERSION, type: 'protocol_error', payload: {
          requestId: decoded.value.payload.requestId, code: 'reauthentication_required',
          message: 'Sign in again before changing session permissions. Then retry the change.', recoverable: true,
        } }));
        return false;
      }
      if (!owner(subject)) {
        try { if (publicMessage.type === 'resource_resolve_request' && !(typeof publicMessage.payload?.locator === 'string' && /^input-image:[a-f0-9-]{36}$/.test(publicMessage.payload.locator))) return refuse(1008, 'Only the Host owner can resolve local files'); }
        catch { return refuse(1008, 'Invalid session message'); }
      }
      const expiresAt = expiry();
      if (expiresAt !== undefined && expiresAt <= now()) return refuse(1008, 'Credential expired');
      return true;
    };
  }
  /**
   * Makes the Controller know the session before a stream opens. A Host whose uplink was replaced while the attach was in
   * flight rejects the attach as offline although it is connected again; that is retryable, not a wait for the Host.
   */
  async function recoverForJournalStream(host: Host, binding: Binding): Promise<void> {
    requireHost(host.id);
    try { await recoverBinding(host, binding); }
    catch (error) {
      if (error instanceof BrokerError && error.code === 'host_offline' && host.ready && host.socket?.readyState === RELAY_SOCKET_OPEN) {
        throw new BrokerError(503, 'host_reconnected', 'The Host reconnected while the session was opening. Reconnect to continue.');
      }
      throw error;
    }
  }
  /** Asks the Controller to attach the session again, which refuses with the native owner when a terminal holds it; any other refusal is thrown. */
  async function readNativeOwner(host: Host, binding: Binding): Promise<NativeSessionOwner | undefined> {
    try { await recoverBinding(host, binding, true); return undefined; }
    catch (error) { if (error instanceof BrokerError && error.nativeOwner) return error.nativeOwner; throw error; }
  }
  /**
   * A browser stream whose session is read from its journal. Reads and control never touch the Controller; the Controller
   * stream for operations opens at the first message that needs it, through the Host's stream table, so limits, revocation
   * and Host disconnects apply to it like to any other stream.
   */
  function acceptJournalServed(host: Host, binding: Binding, context: BrokerRequestContext) {
    const subject = principal(context);
    return { accept(client: RelaySocket) {
      if (!sessionAllowed(binding, principal(context))) { client.close(1008, 'Session access is unavailable'); return; }
      // The switch may have been turned off after the upgrade was prepared.
      if (brokerState.hosts.get(host.id)?.smartReading?.includes(binding.providerId) !== true) { client.close(1012, 'Smart reading turned off'); return; }
      track(client);
      const expiry = () => sessionAllowed(binding, principal(context)) ? context.connectionExpiresAt?.() : 0;
      credentialExpiry.expire(client, expiry);
      if (client.readyState !== RELAY_SOCKET_OPEN) return;
      client.onError(() => undefined);
      const admit = admitClientMessages(client, context, subject, expiry);
      const userStreams = () => subject === undefined ? 0 : options.userStreamCount?.(subject) ?? activeStreamCount(subject);
      const stream = journalSessions!.attach({
        hostId: host.id, providerId: binding.providerId, sessionKey: journalSessionKey(binding.providerId, binding.nativeSessionId), publicAgentId: binding.agentId, client,
        readNativeOwner: () => readNativeOwner(host, binding),
        hostStreams: createHostStreamOpener({
          streams: host.streams, publicAgentId: binding.agentId, runtimeAgentId: () => runtimeAgentId(host, binding), subject,
          authorized: () => { const end = expiry(); return end === undefined || end > now(); },
          recover: () => recoverForJournalStream(host, binding),
          capacity: () => host.streams.size >= HOST_STREAM_LIMIT ? 'host' : userStreams() >= USER_STREAM_LIMIT ? 'account' : undefined,
          write: message => send(host, message), scheduler, openTimeoutMs: options.rpcTimeoutMs ?? 30_000,
          diagnostic: details => diagnostic(host, details),
        }),
      });
      client.onMessage((raw, binary) => { if (admit(raw, binary)) stream.receive(raw); });
      client.onClose(() => stream.close());
    } };
  }
  async function upgrade(request: Request, context: BrokerRequestContext, url: URL) {
    brokerState.assertAvailable();
    if (url.pathname === '/ws/remote-host') {
      const header = request.headers.get('authorization');
      const hash = header?.startsWith('Bearer ') ? keyHash(header.slice(7)) : undefined;
      const key = hash ? brokerState.keys.get(hash) : undefined;
      if (!key || key.claimedAt !== undefined || key.expires <= now()) return rejectUpgrade(401);
      return { accept(client: RelaySocket) {
        if (brokerState.unavailable || brokerState.keys.get(hash!) !== key || key.claimedAt !== undefined || key.expires <= now()) { client.close(1008, 'Device credential revoked'); return; }
        track(client);
        const asked = (name: string) => url.searchParams.get(name) === '1';
        const enrollment = url.searchParams.get('successionEnrollment');
        register(client, key, context, hash!, { enrollmentRequested: enrollment === '3' ? 3 : enrollment === '2' ? 2 : enrollment === '1' ? 1 : undefined,
          teamRequested: asked('team'), resourcesRequested: asked('teamResources'), recipientsRequested: asked('teamRecipients'), inboxRequested: asked('teamInbox'),
          statesRequested: !asked('sessionStates') ? false : asked('sessionReplyFacts') ? 2 : 1, successionRequested: asked('teamSuccession'),
          callForSupportRequested: asked('callForSupport') && readOnlyProviders(url.searchParams.getAll('readOnlyProvider')), statusRequested: asked('hostStatus'), outboxRequested: asked('outbox'),
          journalRequested: url.searchParams.get('journal') === String(JOURNAL_VERSION) ? JOURNAL_VERSION : 0, controlRequested: asked('control') });
      } };
    }
    const match = /^\/v1\/sessions\/([^/]+)\/events$/.exec(url.pathname);
    const binding = match && brokerState.bindings.get(match[1]!);
    if (!binding || !sessionAllowed(binding, principal(context)) || !await permitted(context) || request.headers.get('origin') !== origin) return rejectUpgrade(403);
    // Authorization above is the same for both modes. A session with a journal head is read from it, whether or not its Host is online.
    const journalHost = journalSessions && brokerState.hosts.get(binding.hostId);
    // A store that cannot be read must not stop the session from opening: the Controller path still works.
    const journaled = journalHost && await journalSessions!.serves(journalHost.id, binding.providerId, journalSessionKey(binding.providerId, binding.nativeSessionId)).catch(() => {
      diagnostic(journalHost, { event: 'journal_store_failed' });
      return false;
    });
    if (journalHost && journaled) return acceptJournalServed(journalHost, binding, context);
    let host: Host;
    try { host = requireHost(binding.hostId); await recoverBinding(host, binding); }
    catch (error) {
      // A Host refusal such as native ownership is permanent until the user acts; only unknown failures stay retryable.
      return error instanceof BrokerError ? new Response(JSON.stringify({ code: error.code, error: error.message }), { status: error.status, headers: { 'content-type': 'application/json' } }) : rejectUpgrade(503);
    }
    const subject = principal(context);
    const userStreams = () => subject === undefined ? 0 : options.userStreamCount?.(subject) ?? activeStreamCount(subject);
    if (host.streams.size >= HOST_STREAM_LIMIT || userStreams() >= USER_STREAM_LIMIT) return capacityRefusal(host.streams.size >= HOST_STREAM_LIMIT);
    return { accept(client: RelaySocket) {
      if (!sessionAllowed(binding, principal(context))) { client.close(1008, 'Session access is unavailable'); return; }
      if (host.streams.size >= HOST_STREAM_LIMIT || userStreams() >= USER_STREAM_LIMIT) { client.close(1013, 'Remote stream capacity reached'); return; }
      track(client);
      const expiry = () => sessionAllowed(binding, principal(context)) ? context.connectionExpiresAt?.() : 0;
      credentialExpiry.expire(client, expiry);
      if (client.readyState !== RELAY_SOCKET_OPEN) return;
      const streamId = ids.uuid(); const stream: Host['streams'] extends Map<string, infer Value> ? Value : never = { publicAgentId: binding.agentId, runtimeAgentId: runtimeAgentId(host, binding), socket: client, subject: principal(context), authorized: () => { const end = expiry(); return end === undefined || end > now(); }, ready: false, buffered: [],
        control: createStreamControl({ agentId: binding.agentId, readNativeOwner: () => readNativeOwner(host, binding), send: frame => { if (client.readyState === RELAY_SOCKET_OPEN) client.send(JSON.stringify(frame)); } }) };
      host.streams.set(streamId, stream);
      diagnostic(host,{event:'stream_opening',streamId,agentId:binding.agentId});
      const opening = setTimeout(() => { diagnostic(host,{event:'stream_open_timeout',streamId}); client.close(1013, 'Remote stream opening timed out'); }, options.rpcTimeoutMs ?? 30_000);
      stream.timer = opening;
      client.onError(() => undefined);
      const admit = admitClientMessages(client, context, subject, expiry);
      client.onMessage((raw, binary) => {
        if (!admit(raw, binary)) return;
        if (stream.control!.admitRaw(raw.toString())) return;
        let outgoing: string;
        try { outgoing = withoutItemKeysFlag(sessionIdentityMessage(raw.toString(), stream.publicAgentId, stream.runtimeAgentId, 'client')); }
        catch { return client.close(1008, 'Invalid session target'); }
        if (!stream.ready) {
          if (stream.buffered.length >= 32 || stream.buffered.reduce((sum, value) => sum + Buffer.byteLength(value), 0) + Buffer.byteLength(raw.toString()) > 1024 * 1024) return client.close(1013, 'Remote stream is not ready');
          stream.buffered.push(outgoing); return;
        }
        clearTimeout(opening);
        try { send(host, { uplinkVersion: 2, type: 'stream_message', streamId, message: outgoing }); } catch { client.close(1012, 'Remote Host disconnected'); }
      });
      client.onClose(() => {
        clearTimeout(opening);
        if (!host.streams.delete(streamId)) return;
        diagnostic(host,{event:'stream_closed',streamId});
        try { send(host, { uplinkVersion: 2, type: 'stream_close', streamId, code: 1000, reason: 'Browser disconnected' }); } catch { /* The host may already be offline. */ }
      });
      try { send(host, { uplinkVersion: 2, type: 'stream_open', streamId, sessionId: stream.runtimeAgentId }); }
      catch { client.close(1012, 'Remote Host disconnected'); }
    } };
  }
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
        if (error instanceof BrokerError || error instanceof SharingError) return json(error.status, { code: error.code, error: error.message, ...(error instanceof BrokerError && error.requestId ? { requestId: error.requestId } : {}), ...(error instanceof BrokerError && error.nativeOwner ? {nativeOwner: error.nativeOwner} : {}) });
        return json(503, { code: 'host_operation_failed', error: error instanceof Error ? error.message : 'Remote Host operation failed.' });
      }
    },
    async prepareUpgrade(request: Request, context: BrokerRequestContext = {}): Promise<{ accept(socket: RelaySocket): void } | Response | undefined> {
      const url = new URL(request.url);
      if (!handlesUpgrade(url)) return undefined;
      try { return await upgrade(request, context, url); }
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
