import { TeamBroker, teamMessageBudgetBytes } from './teams.js';
import { CallForSupportProfileError, emptyCallForSupportState, executeProfileCommand, isCallForSupportProfileCommand, projectEnablement, setEnablement, validCallForSupportState, type CallForSupportState } from './call-for-support-profiles.js';
import { TEAM_RECORD_BYTES, teamBytes, teamStateBytes, trimTeamDeliveryReceipts, validSavedTeam, type SavedTeam } from './team-delivery.js';
import { createBrokerState } from './broker-state.js';
import { createAccess } from './access.js';
import { createExpiry } from './credential-expiry.js';
import { createHostViews } from './host-views.js';
import { createHostSession } from './host-session.js';
import { createSuccession } from './succession-service.js';
import { createRelations } from './relation-service.js';
import { createJournalDeletion } from './journal-deletion.js';
import { JOURNAL_DELETION_LIMIT } from './state.js';
import { committed, detached } from './drafts.js';
import { isTeamCreate, isTeamAction, isTeamDelete } from '@orchardworks/agent-remote-protocol';
import { sessionIdentityMessage, withoutItemKeysFlag } from './session-identity.js';
import { isCreationSource, type CreationSource } from '@orchardworks/agent-remote-protocol';
import { isHostStatus, ownerOnlyHostStatus } from '@orchardworks/agent-remote-protocol';
import { JOURNAL_VERSION } from '@orchardworks/agent-remote-protocol';
import type { RelationChangeReset, BrokerRelationChange } from './relation-changes.js';
import { isDeepStrictEqual } from 'node:util';
import { type HostRecoverySelection, type RevokedHost } from './host-recovery.js';
import { type BrokerAssociationState } from './succession-associations.js';
import { isNativeSessionRef, resolveRoleSuccession, nativeSessionRefKey, type NativeSessionRef } from '@orchardworks/agent-remote-protocol';
import { isSuccessionAssociationAuthority } from '@orchardworks/agent-remote-protocol';
import { isTpmAction, isTpmCreate, isTpmList, isTpmWork } from '@orchardworks/agent-remote-protocol';
import { validSessionRelationUpdate, validSourceRelation, type SourceRelation, type SessionRelation } from '@orchardworks/agent-remote-protocol/model';
import { isHostProviderChange } from '@orchardworks/agent-remote-protocol';
import type { NativeSessionOwner } from '@orchardworks/agent-remote-protocol';
import { isCodexDaemonRestart } from '@orchardworks/agent-remote-protocol';
import { controllerReleases } from './controller-releases.js';
import { decodeClientMessage, PROTOCOL_VERSION, controllerUpdateTarget, controllerUpgradeBridgeVersion, type ControllerRelease } from '@orchardworks/agent-remote-protocol';
import { MAX_PAIRING_HISTORY, pairingStatus, visiblePairing, type SavedPairingKey } from './pairing-keys.js';
import { createHash } from 'node:crypto';
import { systemIds } from './relay-ids.js';
import { isPairingPurpose } from '@orchardworks/agent-remote-protocol';
import { sessionAttachFailure } from '@orchardworks/agent-remote-protocol/model';
import { HostSharing, SharingError } from './host-sharing.js';
import { createHostPreviews } from './host-previews.js';
import type { TunnelSocket } from '@orchardworks/agent-remote-tunnel';
import { defaultBrokerScheduler, RELAY_SOCKET_OPEN, type BrokerRequestContext, type RelaySocket } from './transport.js';
import { createHostJournals, type JournalReadRequest } from './host-journals.js';
import { createHostStreamOpener } from './journal-host-stream.js';
import { createStreamControl } from './stream-control.js';
import { createJournalSessions, journalSessionKey } from './journal-sessions.js';
import { required, requiredHostIdentity, creationFingerprintSettings, optionalSettings, sameBinding, readBody, readOnlyProviders } from './request-input.js';
import { json, rawJson, rejectUpgrade, HOST_STREAM_LIMIT, USER_STREAM_LIMIT, capacityRefusal } from './http-replies.js';
import { BrokerError, type Binding, type DeviceCredential, type Host, type HostBrokerOptions, type RemoteHostBrokerState, type RpcResponse, type SharedCreation, type VisibleHostStates } from './broker-types.js';

export type { HostBrokerOptions, RemoteHostBrokerState, VisibleHostStates } from './broker-types.js';
export { USER_STREAM_LIMIT } from './http-replies.js';

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
  const runtimeBindings = new Map<string, { generation: number; agentId: string }>();
  const activeStreamCount = (subject: string) => [...brokerState.hosts.values()].reduce((sum, host) => sum + [...host.streams.values()].filter(stream => stream.subject === subject).length, 0);
  const pendingBindingSlots = new Map<string, { admissionId?: string; nativeKey?: string; creationKey?: string }>();
  const attached = new Map<string, Promise<Binding>>();
  const attachmentRequests = new Map<string, Promise<Binding>>();
  const creations = new Map<string, { fingerprint: string; result: Promise<Binding> }>();
  for (const binding of brokerState.bindings.values()) attached.set(JSON.stringify([binding.hostId, binding.providerId, binding.nativeSessionId]), Promise.resolve(binding));
  for (const [key, value] of brokerState.completedCreations) creations.set(key, { fingerprint: value.fingerprint, result: Promise.resolve(brokerState.bindings.get(value.agentId)!) });
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
    creations: { has: key => creations.has(key) } });
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
  const sharedCreates = new Map<string, { fingerprint: string; result: Promise<Binding> }>();
  const principal = (context: BrokerRequestContext) => context.principalSubject?.();
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
  function runtimeAgentId(host: Host, binding: Binding): string {
    const runtime = runtimeBindings.get(binding.agentId);
    return runtime?.generation === host.generation ? runtime.agentId : binding.agentId;
  }
  function assertRuntimeIdentity(host: Host, binding: Pick<Binding, 'agentId' | 'providerId' | 'nativeSessionId'>, agentId: string): void {
    const occupied = brokerState.bindings.get(agentId);
    if (occupied && !sameBinding(occupied, host.id, binding.providerId, binding.nativeSessionId)) {
      throw new BrokerError(409, 'session_binding_conflict', 'The Remote Host session identity belongs to another binding.');
    }
    for (const [publicId, runtime] of runtimeBindings) {
      const other = brokerState.bindings.get(publicId);
      if (other?.hostId === host.id && runtime.generation === host.generation && runtime.agentId === agentId
        && !sameBinding(other, host.id, binding.providerId, binding.nativeSessionId)) {
        throw new BrokerError(409, 'session_binding_conflict', 'The Remote Host runtime identity belongs to another session.');
      }
    }
    const previous = runtimeBindings.get(binding.agentId);
    if (previous?.generation === host.generation && previous.agentId !== agentId) {
      throw new BrokerError(409, 'session_binding_conflict', 'The Remote Host changed session identity within one connection.');
    }
  }
  async function sessionRead(host: Host, binding: Binding, path: string): Promise<RpcResponse> {
    const agentId = runtimeAgentId(host, binding);
    const result = await rpc(host, 'GET', path.replace(/^\/v1\/sessions\/[^/]+\//, `/v1/sessions/${encodeURIComponent(agentId)}/`), agentId);
    if (result.status >= 300) return result;
    try { return { ...result, body: sessionIdentityMessage(result.body, agentId, binding.agentId, 'server') }; }
    catch { throw new BrokerError(502, 'invalid_host_response', 'The Remote Host returned an invalid session response.'); }
  }
  async function recoverBinding(host: Host, binding: Binding, again = false): Promise<void> {
    brokerState.assertHostCurrent(host);
    if (brokerState.bindings.get(binding.agentId) !== binding) throw new BrokerError(404, 'session_unavailable', 'The session binding was revoked.');
    if (host.ready && !host.control) throw new BrokerError(409, 'controller_upgrade_required', 'Update required: this Host\'s Controller must be updated before it can send or open sessions.');
    if (binding.generation === host.generation && !again) return;
    if (!binding.recovery) {
      const generation = host.generation;
      binding.recovery = (async () => {
        if (binding.parentNativeSessionId) {
          const parent = brokerState.nativeBindings.get(JSON.stringify([host.id, binding.providerId, binding.parentNativeSessionId]));
          if (!parent) throw new BrokerError(409, 'parent_binding_missing', 'The native parent session must be attached before its child.');
          await recoverBinding(host, parent);
        }
        const path = binding.parentNativeSessionId ? '/remote/child/attach' : '/remote/attach';
        const body = host.legacyDsh ? { nativeSessionId: binding.nativeSessionId } : {
          providerId: binding.providerId, nativeSessionId: binding.nativeSessionId,
          ...(binding.parentNativeSessionId ? { parentNativeSessionId: binding.parentNativeSessionId } : {}),
          ...(binding.creatorSubject !== undefined && !owner(binding.creatorSubject) ? { shared: true } : {}),
        };
        const result = await rpc(host, 'POST', path, binding.agentId, JSON.stringify(body));
        brokerState.assertHostCurrent(host, generation);
        if (brokerState.bindings.get(binding.agentId) !== binding) throw new BrokerError(404, 'session_unavailable', 'The session binding was revoked.');
        if (result.status >= 300) {
          const failure = sessionAttachFailure(result.body);
          throw new BrokerError(result.status, failure.code, failure.error, false, result.requestId, failure.nativeOwner);
        }
        if (host.generation !== generation) throw new BrokerError(503, 'host_reconnected', 'The Remote Host changed while the session was reattaching.');
        let agentId = binding.agentId;
        if (!host.legacyDsh) {
          let returned: Record<string, unknown>;
          try { returned = JSON.parse(result.body); } catch { throw new BrokerError(502, 'invalid_host_response', 'The Remote Host returned invalid session identity.'); }
          if (returned.nativeSessionId !== binding.nativeSessionId) {
            throw new BrokerError(409, 'session_binding_conflict', 'The Remote Host returned a different binding during recovery.');
          }
          agentId = requiredHostIdentity(returned.agentId, 'agentId');
        }
        await brokerState.commit(() => {
          brokerState.assertHostCurrent(host, generation);
          if (brokerState.bindings.get(binding.agentId) !== binding) throw new BrokerError(404, 'session_unavailable', 'The session binding was revoked.');
          assertRuntimeIdentity(host, binding, agentId);
          runtimeBindings.set(binding.agentId, { generation, agentId });
          binding.generation = generation;
          return { value: undefined, unchanged: true, publish() {} };
        });
      })();
      void binding.recovery.finally(() => { binding.recovery = undefined; }).catch(() => undefined);
    }
    await binding.recovery;
  }
  function assertSessionSlots() {
    const durable = new Set(brokerState.associations.admissions.map(row => row.id));
    let bindingClaims = durable.size, creationClaims = durable.size;
    for (const claim of pendingBindingSlots.values()) {
      if (claim.admissionId && durable.has(claim.admissionId)) continue;
      if (!claim.nativeKey || !brokerState.nativeBindings.has(claim.nativeKey)) bindingClaims++;
      if (claim.creationKey && !brokerState.completedCreations.has(claim.creationKey)) creationClaims++;
    }
    if (brokerState.bindings.size + bindingClaims > 4096 || brokerState.completedCreations.size + creationClaims > 4096) throw new BrokerError(429, 'capacity_exceeded', 'Session completion capacity is reserved by pending operations.', true);
    assertAssociationCapacity(brokerState.associations);
  }
  async function mutate(host: Host, action: string, body: Record<string, unknown>, creatorSubject?: string, shared?: SharedCreation): Promise<Binding> {
    brokerState.assertHostCurrent(host); const admittedGeneration = host.generation;
    const callerSubject = creatorSubject ?? options.ownerSubject;
    const providerId = host.legacyDsh ? 'dsh' : required(body.providerId, 'providerId');
    if (!host.providers.some((provider) => provider.providerId === providerId)) throw new BrokerError(400, 'invalid_provider', 'The selected provider is unavailable on this Host.');
    if (host.legacyDsh && action === 'create' && ['cwd', 'model', 'reasoningEffort', 'planning', 'creationSource', 'sourceNativeSessionId', 'editNativeSessionId', 'editTurnId', 'editMessageId'].some((key) => body[key] !== undefined)) {
      throw new BrokerError(400, 'unsupported_configuration', 'This Host uses native model settings and a registered workspace.');
    }
    if (host.legacyDsh && action === 'child/attach') throw new BrokerError(400, 'unsupported_operation', 'This Host does not support native child attachment.');
    const attaching = action !== 'create';
    const nativeSessionId = attaching ? required(body.nativeSessionId, 'nativeSessionId') : ids.uuid();
    const parentNativeSessionId = action === 'child/attach' ? required(body.parentNativeSessionId, 'parentNativeSessionId') : undefined;
    if (parentNativeSessionId) creatorSubject ??= brokerState.nativeBindings.get(JSON.stringify([host.id, providerId, parentNativeSessionId]))?.creatorSubject;
    const key = JSON.stringify([host.id, providerId, action === 'create' ? required(body.operationId, 'operationId') : nativeSessionId]);
    const source = action === 'create' && typeof body.sourceNativeSessionId === 'string' ? associationSource(host, providerId, body.sourceNativeSessionId) : undefined;
    const sourceBindingKey = action === 'create' && isCreationSource(body.creationSource) ? JSON.stringify([host.id, body.creationSource.providerId, body.creationSource.nativeSessionId]) : undefined;
    const sourceBinding = sourceBindingKey ? brokerState.nativeBindings.get(sourceBindingKey) : undefined;
    const assertMutationAccess = () => {
      brokerState.assertHostCurrent(host, admittedGeneration); requireAccess(host.id, callerSubject);
      if (action === 'create' && brokerState.associations.freezes.some(row => row.hostId === host.id && row.receipt.request.operationId === body.operationId && row.receipt.request.preparation)) throw new BrokerError(409, 'succession_identity_conflict', 'Operation identity belongs to native prefix succession.');
      if (sourceBindingKey && (!sourceBinding || brokerState.nativeBindings.get(sourceBindingKey) !== sourceBinding || !sessionAllowed(sourceBinding, callerSubject))) throw new SharingError(403, 'session_forbidden', 'Source session access changed.');
    };
    const admissionId = createHash('sha256').update(key).digest('hex');
    const admissionFingerprint = createHash('sha256').update(JSON.stringify([providerId, Object.entries(body).filter(([name]) => name !== 'creationSource').sort(([a],[b])=>a.localeCompare(b))])).digest('hex');
    const trackAssociation = !!source && (!!options.successionEnrollment || !!options.initialState?.associations);
    const fingerprint = JSON.stringify({ providerId, cwd: body.cwd ?? null, workspaceId: body.workspaceId ?? null,
      model: body.model ?? null, reasoningEffort: body.reasoningEffort ?? null, planning: body.planning ?? null, ...creationFingerprintSettings(body, ['conversationKind', 'creationSource', 'sourceNativeSessionId', 'editNativeSessionId', 'editTurnId', 'editMessageId']) });
    const exactAdmission = (state: BrokerAssociationState) => {
      const admission = state.admissions.find(row => row.id === admissionId);
      if (admission && (admission.fingerprint !== admissionFingerprint || !isDeepStrictEqual(admission.source, source))) throw new BrokerError(409, 'association_outcome_unknown', 'Source creation identity changed.');
      return admission;
    };
    const exactSharedReceipt = (state: RemoteHostBrokerState) => {
      const receipt = state.sharing?.reservations.find(row => row.key === shared!.reservation.key);
      const { fresh: _fresh, agentId: _agent, ...expected } = shared!.reservation;
      const { agentId: _actual, ...actual } = receipt ?? {};
      if (!receipt || !isDeepStrictEqual(actual, expected)) throw new BrokerError(409, 'creation_outcome_unknown', 'The complete shared creation reservation requires reconciliation.');
      return receipt;
    };
    let safeHostRejection = false;
    const operation = () => {
      const existingBinding = attaching ? brokerState.nativeBindings.get(key) : undefined;
      if (existingBinding && existingBinding.parentNativeSessionId !== parentNativeSessionId) {
        throw new BrokerError(409, 'session_binding_conflict', 'The native session parent conflicts with its existing binding.');
      }
      const slot = JSON.stringify([attaching ? 'attach' : 'create', key]);
      const claim = { ...(trackAssociation ? { admissionId } : {}), ...(attaching ? { nativeKey: key } : { creationKey: key }) };
      return (async () => {
        await brokerState.commit(() => {
          assertMutationAccess();
          if (pendingBindingSlots.has(slot)) throw new BrokerError(409, 'request_conflict', 'This session has a different in-flight request.');
          pendingBindingSlots.set(slot, claim);
          try { assertSessionSlots(); } catch (error) { pendingBindingSlots.delete(slot); throw error; }
          return { value: undefined, unchanged: true, publish() {} };
        });
        const proposedAgentId = existingBinding?.agentId ?? ids.uuid();
        const generation = host.generation;
        // A share recipient's session is marked, so the Controller hides it from the owner's session commands.
        const recipient = creatorSubject !== undefined && !owner(creatorSubject) ? { shared: true } : {};
        const request = host.legacyDsh
          ? { nativeSessionId, ...(body.workspaceId === undefined ? {} : { workspaceId: required(body.workspaceId, 'workspaceId') }) }
          : action === 'create'
            ? { providerId, operationId: required(body.operationId, 'operationId'),
                ...optionalSettings(body, ['cwd', 'workspaceId', 'model', 'reasoningEffort', 'planning', 'creationSource', 'sourceNativeSessionId', 'editNativeSessionId', 'editTurnId', 'editMessageId']), ...recipient }
            : { providerId, nativeSessionId, ...(parentNativeSessionId ? { parentNativeSessionId } : {}), ...(body.takeOver === undefined ? {} : {takeOver: required(body.takeOver, 'takeOver')}), ...recipient };
        if (source) assertAssociationCreationOpen(source);
        let recoverSource = false;
        if (trackAssociation || shared) await brokerState.commit(draft => {
          assertMutationAccess();
          let nextSharing: HostSharing | undefined;
          if (shared) {
            if (trackAssociation && exactAdmission(brokerState.associations) && shared.reservation.fresh) throw new BrokerError(409, 'creation_outcome_unknown', 'The saved source admission is missing its shared quota receipt.');
            nextSharing = new HostSharing(draft.sharing, () => {});
            const reservation = nextSharing.reserve(host.id, shared.subject, providerId, shared.operationId, shared.fingerprint);
            draft.sharing = nextSharing.snapshot(); exactSharedReceipt(draft);
            if (reservation.agentId !== undefined) throw new BrokerError(409, 'creation_outcome_unknown', 'A completed shared reservation requires its exact creation result.');
          }
          let next = brokerState.associations;
          if (trackAssociation) {
            assertAssociationCreationOpen(source!);
            const previous = exactAdmission(brokerState.associations);
            if (previous) recoverSource = true;
            else {
              if (shared && !shared.reservation.fresh) throw new BrokerError(409, 'creation_outcome_unknown', 'A previous shared creation has no source admission; reconcile its exact outcome.');
              next = structuredClone(brokerState.associations);
              next.admissions.push({ id: admissionId, fingerprint: admissionFingerprint, source: source! });
              if (next.revision >= Number.MAX_SAFE_INTEGER) throw new BrokerError(409, 'association_capacity', 'Association revision is exhausted.');
              next.revision++;
              assertAssociationCapacity(next);
              draft.associations = next;
            }
          }
          const unchanged = isDeepStrictEqual(draft, brokerState.snapshot());
          return { value: undefined, ...(unchanged ? { unchanged: true as const } : {}), publish() { brokerState.associations = next; if (nextSharing) brokerState.sharing = nextSharing; } };
        }, !brokerState.associations.admissions.some(row => row.id === admissionId) && (!shared || shared.reservation.fresh));
        await brokerState.commit(() => {
          assertMutationAccess(); assertSessionSlots();
          if (trackAssociation && !exactAdmission(brokerState.associations)) throw new BrokerError(409, 'association_outcome_unknown', 'Source dispatch requires its durable admission.');
          return { value: undefined, unchanged: true, publish() {} };
        });
        let result: RpcResponse;
        let recoveredReaderId: string | undefined;
        assertMutationAccess();
        if (recoverSource) {
          const recovered = await associationRpc(host, {action:'source-result',providerId,operationId:body.operationId,sourceNativeSessionId:body.sourceNativeSessionId,parameters:optionalSettings(body,['sourceNativeSessionId','cwd','workspaceId','model','reasoningEffort','planning'])});
          if (!isNativeSessionRef(recovered.source) || !isNativeSessionRef(recovered.reader) || nativeSessionRefKey(recovered.source) !== nativeSessionRefKey(source!) || recovered.reader.controllerId !== host.installationId || recovered.reader.providerId !== providerId || recovered.operationId !== body.operationId) throw new BrokerError(409,'association_outcome_unknown','Source creation result evidence does not match.');
          recoveredReaderId = recovered.reader.nativeSessionId;
          assertMutationAccess();
          result = await rpc(host,'POST','/remote/attach',proposedAgentId,JSON.stringify({providerId,nativeSessionId:recoveredReaderId}));
        } else result = await rpc(host, 'POST', `/remote/${action}`, proposedAgentId, JSON.stringify(request));
        brokerState.assertHostCurrent(host, generation);
        if (result.status >= 300) {
          if (attaching) {
            const failure = sessionAttachFailure(result.body);
            throw new BrokerError(result.status, failure.code, failure.error, false, result.requestId, failure.nativeOwner);
          }
          let detail: Record<string, unknown> = {};
          try { detail = JSON.parse(result.body); } catch { /* Preserve the status if the host did not return JSON. */ }
          safeHostRejection = !recoverSource && result.status < 500 && [
            'invalid_request', 'invalid_provider', 'unsupported_configuration', 'invalid_operation_id',
            'operation_capacity_exceeded', 'operation_result_too_large', 'operation_rejected', 'succession_admission_closed',
          ].includes(String(detail.code));
          throw new BrokerError(result.status, typeof detail.code === 'string' ? detail.code : 'host_rejected', typeof detail.error === 'string' ? detail.error : 'The Remote Host rejected the operation.', safeHostRejection, result.requestId);
        }
        let returned: Record<string, unknown> = {};
        try { returned = JSON.parse(result.body); } catch {
          if (!host.legacyDsh) throw new BrokerError(502, 'invalid_host_response', 'The Remote Host returned invalid session identity.');
        }
        if (host.legacyDsh && returned.nativeSessionId !== undefined && returned.nativeSessionId !== nativeSessionId) {
          throw new BrokerError(409, 'native_identity_conflict', 'The Remote Host returned a different native session identity.');
        }
        const actualNativeSessionId = host.legacyDsh ? nativeSessionId : requiredHostIdentity(returned.nativeSessionId, 'nativeSessionId');
        const returnedAgentId = host.legacyDsh ? proposedAgentId : requiredHostIdentity(returned.agentId, 'agentId');
        if (recoveredReaderId && actualNativeSessionId !== recoveredReaderId) throw new BrokerError(409, 'native_identity_conflict', 'The recovered session attachment returned a different native identity.');
        if (attaching && actualNativeSessionId !== nativeSessionId) throw new BrokerError(409, 'native_identity_conflict', 'The Remote Host returned a different native session identity.');
        if (body.conversationKind && actualNativeSessionId === body.sourceNativeSessionId) throw new BrokerError(409, 'native_identity_conflict', 'The new conversation cannot be its own source.');
        const nativeKey = JSON.stringify([host.id, providerId, actualNativeSessionId]);
        return brokerState.commit(draft => {
          if (source) assertAssociationCreationOpen(source);
          if (brokerState.hosts.get(host.id) !== host || host.generation !== generation) throw new BrokerError(503, 'host_reconnected', 'The Remote Host changed while the session operation was completing.');
          const byNative = brokerState.nativeBindings.get(nativeKey);
          const agentId = byNative?.agentId ?? returnedAgentId;
          const byAgent = brokerState.bindings.get(agentId);
          assertRuntimeIdentity(host, { agentId, providerId, nativeSessionId: actualNativeSessionId }, returnedAgentId);
          if (!byAgent && !byNative && brokerState.bindings.size >= 4096) throw new BrokerError(429, 'capacity_exceeded', 'The local session binding registry is full.');
          const binding = byAgent ?? byNative ?? { hostId: host.id, providerId, nativeSessionId: actualNativeSessionId, agentId,
            generation: host.generation, ...(creatorSubject ? { creatorSubject } : {}), ...(parentNativeSessionId ? { parentNativeSessionId } : {}),
            ...(action === 'create' && body.conversationKind ? { sourceRelation: { id: String(body.conversationId), kind: body.conversationKind as 'side' | 'ask', sourceNativeSessionId: String(body.sourceNativeSessionId), nativeSourceRef: associationSource(host, providerId, String(body.sourceNativeSessionId)), createdAt: new Date(now()).toISOString() } } : {}) };
          if (binding.parentNativeSessionId !== parentNativeSessionId) throw new BrokerError(409, 'session_binding_conflict', 'The native session parent conflicts with its existing binding.');
          if (creatorSubject && binding.creatorSubject !== creatorSubject) throw new BrokerError(409, 'session_binding_conflict', 'The native session belongs to another user.');
          if (action === 'create' && body.conversationKind) {
            const relation = binding.sourceRelation;
            if (!relation || relation.id !== body.conversationId || relation.kind !== body.conversationKind || relation.sourceNativeSessionId !== body.sourceNativeSessionId
              || relation.nativeSourceRef && nativeSessionRefKey(relation.nativeSourceRef) !== nativeSessionRefKey(source!)) throw new BrokerError(409, 'session_binding_conflict', 'The returned session has a different source relationship.');
          }
          const { generation: _generation, recovery: _recovery, ...saved } = binding;
          const savedIndex = draft.bindings.findIndex(value => value.agentId === agentId);
          if (savedIndex < 0) draft.bindings.push(saved); else draft.bindings[savedIndex] = saved;
          let nextSharing: HostSharing | undefined;
          let creation: { fingerprint: string; agentId: string } | undefined;
          if (!attaching) {
            const previous = draft.creations.find(([id]) => id === key);
            if (previous && (previous[1].fingerprint !== fingerprint || previous[1].agentId !== agentId)) throw new BrokerError(409, 'request_conflict', 'The saved creation result changed.');
            creation = previous?.[1] ?? { fingerprint, agentId };
            if (!previous) draft.creations.push([key, creation]);
            if (shared) {
              const receipt = exactSharedReceipt(draft);
              if (receipt.agentId !== undefined && receipt.agentId !== agentId) throw new BrokerError(409, 'creation_outcome_unknown', 'Shared creation result changed.');
              nextSharing = new HostSharing(draft.sharing, () => {}); nextSharing.complete(receipt.key, agentId); draft.sharing = nextSharing.snapshot();
            }
            if (trackAssociation) {
              if (!exactAdmission(brokerState.associations)) throw new BrokerError(409, 'association_outcome_unknown', 'Source completion requires its exact durable admission.');
              draft.associations = structuredClone(brokerState.associations);
              draft.associations.admissions = draft.associations.admissions.filter(row => row.id !== admissionId);
              if (draft.associations.revision >= Number.MAX_SAFE_INTEGER) throw new BrokerError(409, 'association_capacity', 'Association revision is exhausted.');
              draft.associations.revision++;
              assertAssociationCapacity(draft.associations);
            }
          }
          const unchanged = isDeepStrictEqual(draft, brokerState.snapshot());
          if (unchanged) {
            binding.generation = generation;
            runtimeBindings.set(agentId, { generation, agentId: returnedAgentId });
            attached.set(nativeKey, Promise.resolve(binding));
          }
          return { value: binding, ...(unchanged ? { unchanged: true as const } : {}), publish() {
            brokerState.assertHostCurrent(host, generation);
            if (draft.associations) brokerState.associations = draft.associations;
            if (creation) brokerState.completedCreations.set(key, creation);
            if (nextSharing) brokerState.sharing = nextSharing;
            binding.generation = host.generation;
            runtimeBindings.set(agentId, { generation, agentId: returnedAgentId });
            brokerState.bindings.set(agentId, binding); brokerState.nativeBindings.set(nativeKey, binding); pendingBindingSlots.delete(slot);
            attached.set(nativeKey, Promise.resolve(binding));
          } };
        });
      })().finally(() => { if (pendingBindingSlots.get(slot) === claim) pendingBindingSlots.delete(slot); });
    };
    if (attaching) {
      const requestKey = JSON.stringify([key, body.takeOver ?? null]);
      let result = attachmentRequests.get(requestKey);
      if (!result) {
        result = operation(); attachmentRequests.set(requestKey, result);
        void result.finally(() => { if (attachmentRequests.get(requestKey) === result) attachmentRequests.delete(requestKey); }).catch(() => undefined);
      }
      const binding = await result;
      if (binding.parentNativeSessionId !== parentNativeSessionId) {
        throw new BrokerError(409, 'session_binding_conflict', 'The native session parent conflicts with its existing binding.');
      }
      assertMutationAccess(); await recoverBinding(host, binding); return binding;
    }
    let existing = creations.get(key);
    if (existing && existing.fingerprint !== fingerprint) throw new BrokerError(409, 'request_conflict', 'This request identity was already used with different settings.');
    if (!existing) {
      if (creations.size >= 4096) throw new BrokerError(429, 'capacity_exceeded', 'The local creation ledger is full.', true);
      const pending = { fingerprint, result: undefined as unknown as Promise<Binding> };
      pending.result = operation().catch(async error => {
        // Unknown source retries may read a durable result witness; they never repeat native creation.
        if (trackAssociation && creations.get(key) === pending) creations.delete(key);
        if (error instanceof BrokerError && error.creationRejected) {
          if (safeHostRejection && (trackAssociation && exactAdmission(brokerState.associations) || shared && brokerState.sharing.snapshot().reservations.some(row => row.key === shared.reservation.key))) await brokerState.commit(draft => {
            brokerState.assertHostCurrent(host, admittedGeneration);
            if (trackAssociation) {
              if (!exactAdmission(brokerState.associations)) throw new BrokerError(409, 'association_outcome_unknown', 'Safe source rejection requires its exact admission.');
              draft.associations = structuredClone(brokerState.associations);
              draft.associations.admissions = draft.associations.admissions.filter(row => row.id !== admissionId); draft.associations.revision++;
              assertAssociationCapacity(draft.associations);
            }
            let nextSharing: HostSharing | undefined;
            if (shared) { exactSharedReceipt(draft); nextSharing = new HostSharing(draft.sharing, () => {}); nextSharing.release(shared.reservation.key); draft.sharing = nextSharing.snapshot(); }
            return { value: undefined, publish() { if (draft.associations) brokerState.associations = draft.associations; if (nextSharing) brokerState.sharing = nextSharing; } };
          });
          if (creations.get(key) === pending) creations.delete(key);
        }
        throw error;
      });
      creations.set(key, pending); existing = pending;
    }
    const binding = await existing.result;
    brokerState.assertHostCurrent(host, admittedGeneration);
    const completed = brokerState.completedCreations.get(key);
    if (trackAssociation && exactAdmission(brokerState.associations)) throw new BrokerError(409, 'association_outcome_unknown', 'A partially saved source completion requires exact reconciliation before activation.');
    if (!completed || completed.fingerprint !== fingerprint || completed.agentId !== binding.agentId || brokerState.bindings.get(binding.agentId) !== binding
      || binding.hostId !== host.id || binding.providerId !== providerId || creatorSubject && binding.creatorSubject !== creatorSubject) throw new BrokerError(409, 'creation_outcome_unknown', 'The complete creation result requires reconciliation.');
    if (shared && exactSharedReceipt(brokerState.snapshot()).agentId !== binding.agentId) throw new BrokerError(409, 'creation_outcome_unknown', 'The shared completion requires reconciliation.');
    assertMutationAccess(); await recoverBinding(host, binding); return binding;
  }
  /** The caller's deadline does not cancel or replace the shared creation promise. */
  async function waitForCreation(result: Promise<Binding>): Promise<Binding> {
    let timer: unknown;
    try {
      return await Promise.race([result, new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => reject(new BrokerError(504, 'session_create_pending',
          'The Host is still opening this session. Retry checks the same pending creation without creating another session.')),
        options.rpcTimeoutMs ?? 30_000);
      })]);
    } finally { clearTimeout(timer); }
  }
  async function userMutation(host: Host, action: string, body: Record<string, unknown>, subject?: string): Promise<Binding> {
    brokerState.assertHostCurrent(host);
    if (action === 'create' && body.conversationKind !== undefined && (!['side', 'ask'].includes(String(body.conversationKind)) || typeof body.sourceNativeSessionId !== 'string' || body.editNativeSessionId !== undefined)) {
      throw new BrokerError(400, 'invalid_request', 'A Side or Ask requires a source session.');
    }
    if (action === 'create') body = { ...body, conversationId: body.operationId };
    if (action === 'create' && brokerState.associations.freezes.some(row => row.hostId === host.id && row.receipt.request.operationId === body.operationId && row.receipt.request.preparation)) throw new BrokerError(409, 'succession_identity_conflict', 'Operation identity belongs to native prefix succession.');
    if (action === 'create' && ['editNativeSessionId', 'editTurnId', 'editMessageId'].some(key => body[key] !== undefined)) {
      if (body.sourceNativeSessionId !== undefined || ['editNativeSessionId', 'editTurnId', 'editMessageId'].some(key => typeof body[key] !== 'string' || !(body[key] as string).trim())) throw new BrokerError(400, 'invalid_request', 'A complete native prompt identity is required.');
      if (!host.providers.some(provider => provider.providerId === body.providerId && provider.promptEditing)) throw new BrokerError(400, 'unsupported_configuration', 'Prompt editing is unavailable on this Host. Update the Controller.');
    }
    if (action === 'create') {
      if (body.creationSource !== undefined && !isCreationSource(body.creationSource)) throw new BrokerError(400, 'invalid_request', 'A strict creation source is required.');
      const legacy = body.editNativeSessionId ?? body.sourceNativeSessionId;
      const provenance: CreationSource | undefined = body.creationSource === undefined
        ? legacy === undefined ? undefined : { providerId: required(body.providerId, 'providerId'), nativeSessionId: required(legacy, 'sourceNativeSessionId') }
        : body.creationSource;
      if (provenance && legacy !== undefined && (provenance.providerId !== body.providerId || provenance.nativeSessionId !== legacy)) throw new BrokerError(400, 'invalid_request', 'Creation source contradicts the native source identity.');
      if (provenance) {
        if (!host.providers.some(provider => provider.providerId === provenance.providerId)) throw new BrokerError(400, 'invalid_provider', 'The source provider is unavailable on this Host.');
        requireAccess(host.id, subject);
        const source = brokerState.nativeBindings.get(JSON.stringify([host.id, provenance.providerId, provenance.nativeSessionId]));
        if (!source || !sessionAllowed(source, subject)) throw new SharingError(403, 'session_forbidden', 'Source session access is unavailable. Open an accessible source session first.');
        // Canonicalize before both create ledgers; inferred legacy source is semantically identical.
        body = { ...body, creationSource: { providerId: provenance.providerId, nativeSessionId: provenance.nativeSessionId } };
      }
    }
    if (owner(subject)) return mutate(host, action, body);
    requireAccess(host.id, subject);
    const providerId = host.legacyDsh ? 'dsh' : required(body.providerId, 'providerId');
    if (action !== 'create') {
      const nativeSessionId = required(body.nativeSessionId, 'nativeSessionId');
      const existing = brokerState.nativeBindings.get(JSON.stringify([host.id, providerId, nativeSessionId]));
      if (existing && sessionAllowed(existing, subject)) {
        await recoverBinding(host, existing); return existing;
      }
      if (action === 'child/attach') {
        const parentId = required(body.parentNativeSessionId, 'parentNativeSessionId');
        const parent = brokerState.nativeBindings.get(JSON.stringify([host.id, providerId, parentId]));
        if (parent && sessionAllowed(parent, subject)) {
          await recoverBinding(host, parent);
          const result = await sessionRead(host, parent, `/v1/sessions/${encodeURIComponent(parent.agentId)}/snapshot`);
          const data = JSON.parse(result.body);
          const children: unknown = data?.payload?.runtimeInfo?.childSessions;
          if (result.status === 200 && Array.isArray(children) && children.some(child => child?.nativeSessionId === nativeSessionId)) {
            requireAccess(host.id, subject);
            if (existing && existing.creatorSubject !== subject) throw new SharingError(403, 'session_forbidden', 'Session access is unavailable.');
            return mutate(host, action, body, subject);
          }
        }
      }
      throw new SharingError(403, 'session_forbidden', 'Only your own sessions can be attached.');
    }
    if (!host.providers.some(provider => provider.providerId === providerId)) throw new SharingError(400, 'invalid_provider', 'The selected provider is unavailable on this Host.');
    if (host.legacyDsh && ['cwd', 'model', 'reasoningEffort', 'planning', 'creationSource', 'sourceNativeSessionId', 'editNativeSessionId', 'editTurnId', 'editMessageId'].some(key => body[key] !== undefined)) throw new SharingError(400, 'unsupported_configuration', 'This Host uses native settings.');
    const operationId = required(body.operationId, 'operationId');
    const fingerprint = JSON.stringify({ providerId, ...creationFingerprintSettings(body, ['conversationKind', 'cwd', 'workspaceId', 'model', 'reasoningEffort', 'planning', 'creationSource', 'sourceNativeSessionId', 'editNativeSessionId', 'editTurnId', 'editMessageId']) });
    const reservation = new HostSharing(brokerState.sharing.snapshot(), () => {}).reserve(host.id, subject!, providerId, operationId, fingerprint);
    const creationKey = JSON.stringify([host.id, providerId, reservation.nativeRequestId]);
    const pending = sharedCreates.get(reservation.key);
    if (pending) {
      if (pending.fingerprint !== fingerprint) throw new SharingError(409, 'operation_conflict', 'This creation operation has different settings.');
      return pending.result;
    }
    if (reservation.agentId && !options.successionEnrollment && !options.initialState?.associations) {
      const binding = brokerState.bindings.get(reservation.agentId);
      if (!binding || binding.hostId !== host.id || binding.providerId !== providerId || !sessionAllowed(binding, subject)) throw new SharingError(409, 'creation_outcome_unknown', 'The saved shared result requires reconciliation.');
      await recoverBinding(host, binding); return binding;
    }
    if (!reservation.fresh && !reservation.agentId && !brokerState.completedCreations.has(creationKey)) {
      const admissionId = createHash('sha256').update(creationKey).digest('hex');
      if (!body.sourceNativeSessionId || !brokerState.associations.admissions.some(row => row.id === admissionId)) throw new SharingError(409, 'creation_outcome_unknown', 'A previous creation is unresolved. Its quota reservation is retained; ask the Host owner to reconcile it.');
    }
    const operation = mutate(host, action, { ...body, operationId: reservation.nativeRequestId }, subject, { subject: subject!, operationId, fingerprint, reservation });
    const sharedOperation = { fingerprint, result: operation }; sharedCreates.set(reservation.key, sharedOperation);
    try { return await operation; } finally { if (sharedCreates.get(reservation.key) === sharedOperation) sharedCreates.delete(reservation.key); }
  }
  async function sharedCatalog(host: Host, action: string, query: URLSearchParams, subject: string): Promise<RpcResponse> {
    const providerId = host.legacyDsh ? 'dsh' : query.get('providerId');
    const owned = [...brokerState.bindings.values()].filter(binding => binding.hostId === host.id && binding.providerId === providerId && binding.creatorSubject === subject && !binding.parentNativeSessionId);
    const revisionResult = await rpc(host, 'GET', `/remote/catalog/revision${query.size ? '?' + query : ''}`);
    requireAccess(host.id, subject);
    if (revisionResult.status !== 200) return revisionResult;
    const revision = createHash('sha256').update(JSON.stringify([JSON.parse(revisionResult.body).revision, owned.map(value => value.nativeSessionId)])).digest('hex');
    if (action === 'catalog/revision') return { status: 200, body: JSON.stringify({ revision }) };
    if (host.legacyDsh) {
      const result = await rpc(host, 'GET', `/remote/catalog${query.size ? '?' + query : ''}`);
      requireAccess(host.id, subject);
      if (result.status !== 200) return result;
      const page = JSON.parse(result.body);
      return { status: 200, body: JSON.stringify({ ...page, revision, items: Array.isArray(page.items) ? page.items.filter((item: { nativeSessionId?: string }) => owned.some(value => value.nativeSessionId === item.nativeSessionId)) : [] }) };
    }
    const offset = Number(query.get('cursor') ?? 0); const limit = Number(query.get('limit') ?? 30);
    if (!Number.isSafeInteger(offset) || offset < 0 || !Number.isSafeInteger(limit) || limit < 1 || limit > 100) throw new SharingError(400, 'invalid_cursor', 'Invalid session page.');
    const items = [];
    for (const binding of owned.slice(offset, offset + limit)) {
      const parameters = new URLSearchParams({ providerId: binding.providerId, nativeSessionId: binding.nativeSessionId });
      const result = await rpc(host, 'GET', `/remote/catalog/session?${parameters}`);
      requireAccess(host.id, subject);
      if (result.status === 404) continue;
      if (result.status !== 200) return result;
      const summary = JSON.parse(result.body);
      if (summary.nativeSessionId !== binding.nativeSessionId || summary.providerId !== binding.providerId) throw new SharingError(502, 'invalid_host_response', 'Host returned a different session summary.');
      items.push(summary);
    }
    requireAccess(host.id, subject);
    const next = offset + limit;
    return { status: 200, body: JSON.stringify({ items, hasMore: next < owned.length, ...(next < owned.length ? { nextCursor: String(next) } : {}), revision }) };
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
    const succession = /^\/v1\/remote\/hosts\/([^/]+)\/succession\/(describe|prepare|commit|cancel|status|reconcile)$/.exec(url.pathname);
    if (succession) {
      requireOwner(subject); requireAccess(succession[1]!, subject);
      if (request.method !== 'POST') return json(405, { error: 'Method is not allowed.' });
      return json(200, await successionAction(requireHost(succession[1]!), succession[2]!, await readBody(request)));
    }
    if (url.pathname === '/v1/remote/controller-release' && request.method === 'GET') {
      requireOwner(subject);
      const refresh = url.searchParams.get('refresh') === '1';
      const release = await (options.controllerReleases ?? controllerReleases).latest({ refresh });
      if (!release) return json(200, { release });
      const versions = [...new Set([...brokerState.hosts.values()].flatMap(host => {
        const version = host.controller?.remoteUpdate && controllerUpgradeBridgeVersion(release, host.controller);
        return version ? [version] : [];
      }))];
      const results = await Promise.allSettled(versions.map(version => readUpgradeBridge(version, refresh)));
      const bridges = results.flatMap(result => result.status === 'fulfilled' ? [result.value] : []);
      return json(200, { release, ...(bridges[0] ? { bridgeRelease: bridges[0] } : {}),
        ...(bridges.length > 1 ? { bridgeReleases: bridges } : {}),
        ...(results.some(result => result.status === 'rejected') ? { bridgeError: 'An upgrade component for older Controllers is unavailable. Refresh and retry after it is published.' } : {}) });
    }

    const controllerUpdate = /^\/v1\/remote\/hosts\/([^/]+)\/controller-update$/.exec(url.pathname);
    if (controllerUpdate) {
      requireOwner(subject); requireAccess(controllerUpdate[1]!, subject);
      const host = requireHost(controllerUpdate[1]!);
      if (!host.controller?.remoteUpdate) return json(409, { error: 'Install the release launcher locally before using remote updates.' });
      if (!['GET', 'POST'].includes(request.method)) return json(405, { error: 'Method is not allowed.' });
      let body: string | undefined;
      if (request.method === 'POST') {
        const input = await readBody(request);
        const release = await (options.controllerReleases ?? controllerReleases).latest();
        const bridgeVersion = release && controllerUpgradeBridgeVersion(release, host.controller);
        const bridge = bridgeVersion ? await readUpgradeBridge(bridgeVersion) : undefined;
        const target = release && controllerUpdateTarget(release, host.controller, bridge);
        if (!target || input.version !== target.version
          || typeof input.operationId !== 'string' || !/^[A-Za-z0-9_-]{8,128}$/.test(input.operationId)) return json(409, { error: 'Refresh the Controller release and Host list before confirming this update.' });
        body = JSON.stringify({ version: target.version, operationId: input.operationId });
      }
      const result = await rpc(host, request.method as 'GET' | 'POST', '/remote/controller-update', undefined, body);
      return new Response(result.body, { status: result.status, headers: { 'content-type': 'application/json', 'cache-control': 'no-store' } });
    }
    const providerSettings = /^\/v1\/remote\/hosts\/([^/]+)\/provider-settings$/.exec(url.pathname);
    if (providerSettings) {
      requireOwner(subject); requireAccess(providerSettings[1]!, subject);
      if (!['GET', 'POST'].includes(request.method)) return json(405, { error: 'Method is not allowed.' });
      const host = requireHost(providerSettings[1]!);
      if (!host.providerManagement) return json(409, { error: 'Update the Controller to manage providers.' });
      let body: string | undefined;
      if (request.method === 'POST') {
        const input = await readBody(request);
        if (!isHostProviderChange(input)) return json(400, { error: 'Invalid provider preferences.' });
        body = JSON.stringify(input);
      }
      const result = await rpc(host, request.method as 'GET' | 'POST', '/remote/provider-settings', undefined, body);
      requireOwner(principal(context)); requireAccess(providerSettings[1]!, principal(context));
      return new Response(result.body, { status: result.status, headers: { 'content-type': 'application/json', 'cache-control': 'no-store' } });
    }
    if (url.pathname === '/v1/remote/teams' || url.pathname === '/v1/remote/teams/create' || url.pathname === '/v1/remote/teams/action' || url.pathname === '/v1/remote/teams/delete') {
      requireOwner(subject);
      const recipientAware = request.headers.get('x-arc-team-recipients') === '1';
      if (url.pathname === '/v1/remote/teams' && request.method === 'GET') {
        try { return json(200, { teams: brokerState.teams.filter(team => hostAllowed(team.source.hostId, subject)).map(team => teams.readForClient(team.id, recipientAware)) }); }
        catch (error) { return json(409, { error: error instanceof Error ? error.message : 'Team request failed.' }); }
      }
      if (request.method !== 'POST') return json(405, { error: 'Method is not allowed.' });
      const input = await readBody(request); requireOwner(principal(context));
      try {
        if (url.pathname.endsWith('/create') && isTeamCreate(input)) {
          requireAccess(input.source.hostId, principal(context));
          const result = await teams.create(input);
          requireOwner(principal(context)); requireAccess(input.source.hostId, principal(context));
          return json(200, teams.readForClient(result.id, recipientAware));
        }
        if (url.pathname.endsWith('/action') && isTeamAction(input)) {
          const team = brokerState.teams.find(team => team.id === input.teamId);
          if (!team) return json(404, { error: 'Team not found.' });
          requireAccess(team.source.hostId, principal(context));
          if (input.action === 'add_member') requireAccess(input.hostId, principal(context));
          const result = await teams.action(input);
          requireOwner(principal(context)); requireAccess(team.source.hostId, principal(context));
          if (input.action === 'add_member') requireAccess(input.hostId, principal(context));
          return json(200, teams.readForClient(result.id, recipientAware));
        }
        if (url.pathname.endsWith('/delete') && isTeamDelete(input)) {
          const team = brokerState.teams.find(team => team.id === input.teamId);
          if (!team) return json(404, { error: 'Team not found.' });
          requireAccess(team.source.hostId, principal(context));
          await teams.delete(input.teamId);
          return json(200, { teamId: input.teamId, deleted: true });
        }
        return json(400, { error: 'Invalid Team request.' });
      } catch (error) { return json(409, { error: error instanceof Error ? error.message : 'Team request failed.' }); }
    }
    if (url.pathname === '/v1/remote/call-for-support' || url.pathname === '/v1/remote/call-for-support/profiles' || url.pathname === '/v1/remote/call-for-support/enablement') {
      requireOwner(subject);
      const resolveVisible = (hostId: string, providerId: string, nativeSessionId: string) => hostAllowed(hostId, subject) ? resolveRole(hostId, providerId, nativeSessionId) : undefined;
      const view = () => ({ profiles: structuredClone(brokerState.callForSupport?.profiles ?? []), enablement: projectEnablement(brokerState.callForSupport, resolveVisible) });
      if (url.pathname === '/v1/remote/call-for-support') return request.method === 'GET' ? json(200, view()) : json(405, { error: 'Method is not allowed.' });
      if (request.method !== 'POST') return json(405, { error: 'Method is not allowed.' });
      const input = await readBody(request); requireOwner(principal(context));
      try {
        if (url.pathname.endsWith('/profiles')) {
          if (!isCallForSupportProfileCommand(input)) return json(400, { error: 'Invalid support profile request.' });
          const profile = await callForSupportChange(state => executeProfileCommand(state, input, now()));
          requireOwner(principal(context));
          return json(200, { ...(profile ? { profile } : {}), ...view() });
        }
        const target = input as { hostId?: unknown; providerId?: unknown; nativeSessionId?: unknown; profileIds?: unknown };
        if (!target || typeof target !== 'object' || Object.keys(target).sort().join() !== 'hostId,nativeSessionId,profileIds,providerId' || typeof target.hostId !== 'string'
          || typeof target.providerId !== 'string' || typeof target.nativeSessionId !== 'string' || !Array.isArray(target.profileIds) || !target.profileIds.every(id => typeof id === 'string')) {
          return json(400, { error: 'Invalid Call For Support enablement.' });
        }
        requireAccess(target.hostId, principal(context));
        const worker = { hostId: target.hostId, providerId: target.providerId, nativeSessionId: target.nativeSessionId };
        await callForSupportChange(state => setEnablement(state, resolveRole, worker, target.profileIds as string[], now()));
        requireOwner(principal(context));
        return json(200, view());
      } catch (error) {
        if (error instanceof CallForSupportProfileError) return json(error.code === 'not_found' ? 404 : error.code === 'invalid' ? 400 : 409, { code: error.code, error: error.message });
        throw error;
      }
    }
    const tpm = /^\/v1\/remote\/hosts\/([^/]+)\/tpm(?:\/(create|action|work))?$/.exec(url.pathname);
    if (tpm) {
      requireOwner(subject); requireAccess(tpm[1]!, subject);
      const host = requireHost(tpm[1]!);
      const generation = host.generation, installationId = host.installationId;
      const requireTpmLifetime = () => { brokerState.assertHostCurrent(host, generation); requireOwner(principal(context)); requireAccess(host.id, principal(context)); };
      if (!host.tpmManagement) return request.method === 'GET' && !tpm[2]
        ? json(200, { supported: false, supportedProviders: [], works: [] })
        : json(409, { error: 'Update the Controller to use TPM.' });
      const action = tpm[2];
      const method = action === 'create' || action === 'action' ? 'POST' : 'GET';
      if (request.method !== method) return json(405, { error: 'Method is not allowed.' });
      let body: string | undefined;
      let expectedId: string | undefined;
      if (action === 'work') {
        if (url.searchParams.size !== 1 || !url.searchParams.has('id')) throw new BrokerError(400, 'invalid_request', 'A TPM work ID is required.');
        expectedId = required(url.searchParams.get('id'), 'id');
        if (expectedId.length > 128) throw new BrokerError(400, 'invalid_request', 'The TPM work ID is invalid.');
      } else if (!action && url.searchParams.size) {
        const cursor = url.searchParams.get('cursor');
        if (url.searchParams.size !== 1 || !cursor || cursor.length > 128) throw new BrokerError(400, 'invalid_request', 'The TPM catalog cursor is invalid.');
      } else if (url.searchParams.size) throw new BrokerError(400, 'invalid_request', 'TPM query parameters are invalid.');
      if (method === 'POST') {
        const input = await readBody(request);
        requireTpmLifetime();
        if (action === 'create' ? !isTpmCreate(input) : !isTpmAction(input)) throw new BrokerError(400, 'invalid_request', 'The TPM request is invalid.');
        if (action === 'create' && !host.providers.some(provider => provider.providerId === input.providerId)) throw new BrokerError(400, 'invalid_provider', 'The selected provider is unavailable on this Host.');
        if (action === 'action') expectedId = input.id as string;
        body = JSON.stringify(input);
      }
      const path = `/remote/tpm${action ? '/' + action : ''}${action === 'work' ? '?' + new URLSearchParams({ id: expectedId! }) : !action && url.searchParams.has('cursor') ? '?' + new URLSearchParams({ cursor: url.searchParams.get('cursor')! }) : ''}`;
      requireTpmLifetime();
      const result = await rpc(host, method, path, undefined, body);
      requireTpmLifetime();
      if (!action && result.status === 404) return json(200, { supported: false, works: [] });
      if (result.status >= 200 && result.status < 300) {
        let value: unknown;
        try { value = JSON.parse(result.body); } catch { throw new BrokerError(502, 'invalid_host_response', 'The Host returned an invalid TPM response.'); }
        if (action ? !isTpmWork(value) || (expectedId !== undefined && value.id !== expectedId) : !isTpmList(value)) throw new BrokerError(502, 'invalid_host_response', 'The Host returned an invalid TPM response.');
        const works = isTpmWork(value) ? [value] : isTpmList(value) ? value.works : [];
        for (const work of works) {
          const main = work.mainSessionRef;
          const source = work.mainBinding?.kind === 'fixed' ? work.mainBinding.source : work.mainBinding?.origin;
          if (main && (main.controllerId !== installationId || main.nativeSessionId !== work.mainNativeSessionId)
            || source && source.controllerId !== installationId
            || main && work.mainBinding?.kind === 'fixed' && nativeSessionRefKey(main) !== nativeSessionRefKey(work.mainBinding.source)) {
            throw new BrokerError(502, 'invalid_host_response', 'The Host returned an invalid TPM reference.');
          }
        }
      }
      return rawJson(result);
    }
    const hostStatus = /^\/v1\/remote\/hosts\/([^/]+)\/status$/.exec(url.pathname);
    if (hostStatus) {
      requireAccess(hostStatus[1]!, subject);
      if (request.method !== 'GET') return json(405, { error: 'Method is not allowed.' });
      const target = requireHost(hostStatus[1]!);
      // A Controller that did not offer this read would treat the request as a protocol error and drop its connection.
      if (!target.hostStatus) throw new BrokerError(501, 'unsupported_command', 'Update the Controller on this Host to see its status.');
      const result = await rpc(target, 'GET', '/remote/host-status');
      requireAccess(hostStatus[1]!, principal(context));
      let value: unknown;
      try { value = JSON.parse(result.body); } catch { value = undefined; }
      if (result.status !== 200 || !isHostStatus(value)) throw new BrokerError(502, 'invalid_host_response', 'The Host returned an invalid status.');
      return new Response(JSON.stringify(ownerOnlyHostStatus(value, owner(principal(context)))), { status: 200, headers: { 'content-type': 'application/json', 'cache-control': 'no-store' } });
    }
    const codexDaemon = /^\/v1\/remote\/hosts\/([^/]+)\/codex-daemon$/.exec(url.pathname);
    if (codexDaemon) {
      requireOwner(subject); requireAccess(codexDaemon[1]!, subject);
      if (!['GET', 'POST'].includes(request.method)) return json(405, { error: 'Method is not allowed.' });
      const host = requireHost(codexDaemon[1]!);
      if (!host.providers.some(provider => provider.providerId === 'codex' && provider.daemonControl)) {
        throw new BrokerError(400, 'unsupported_configuration', 'This Host does not support remote shared Codex daemon control.');
      }
      let body: string | undefined;
      if (request.method === 'POST') {
        const input = await readBody(request);
        if (!isCodexDaemonRestart(input)) throw new BrokerError(400, 'invalid_request', 'Refresh daemon state before confirming restart.');
        body = JSON.stringify(input);
      }
      const result = await rpc(host, request.method as 'GET' | 'POST', '/remote/codex-daemon', undefined, body);
      requireOwner(principal(context)); requireAccess(codexDaemon[1]!, principal(context));
      return new Response(result.body, { status: result.status, headers: { 'content-type': 'application/json', 'cache-control': 'no-store' } });
    }
    const vscodeTunnel = /^\/v1\/remote\/hosts\/([^/]+)\/vscode-tunnel(?:\/(start|stop))?$/.exec(url.pathname);
    if (vscodeTunnel) {
      requireOwner(subject); requireAccess(vscodeTunnel[1]!, subject);
      const action = vscodeTunnel[2];
      if ((!action && request.method !== 'GET') || (action && request.method !== 'POST')) return json(405, { error: 'Method is not allowed.' });
      const body = action ? await readBody(request) : undefined;
      if (action === 'start' && body?.acceptLicense !== true) return json(400, { error: 'Accept the VS Code Server license terms before starting.' });
      const result = await rpc(requireHost(vscodeTunnel[1]!), action ? 'POST' : 'GET', `/remote/vscode-tunnel${action ? `/${action}` : ''}`, undefined,
        action ? JSON.stringify(action === 'start' ? { acceptLicense: true } : {}) : undefined);
      requireOwner(principal(context)); requireAccess(vscodeTunnel[1]!, principal(context));
      return new Response(result.body, { status: result.status, headers: { 'content-type': 'application/json', 'cache-control': 'no-store' } });
    }
    const previewSession = /^\/v1\/sessions\/([^/]+)\/previews$/.exec(url.pathname);
    if (previewSession && request.method === 'POST') {
      requireOwner(subject);
      const binding = brokerState.bindings.get(previewSession[1]!);
      if (!binding || !sessionAllowed(binding, subject)) throw new BrokerError(404, 'session_unavailable', 'Session is unavailable.');
      const body = await readBody(request);
      const target = required(body.target, 'target'); const itemId = required(body.itemId, 'itemId');
      if (body.pathMode !== undefined && body.pathMode !== 'strip' && body.pathMode !== 'preserve') throw new BrokerError(400, 'invalid_path_mode', 'Choose strip or preserve path mode.');
      const result = await rpc(requireHost(binding.hostId), 'POST', '/remote/previews', undefined,
        JSON.stringify({ target, source: { sessionId: binding.agentId, itemId }, pathMode: body.pathMode ?? 'strip' }));
      return new Response(result.body, { status: result.status, headers: { 'content-type': 'application/json' } });
    }
    const previewHost = /^\/v1\/remote\/hosts\/([^/]+)\/previews(?:\/([A-Za-z0-9_-]+)\/(unregister|renew))?$/.exec(url.pathname);
    if (previewHost) {
      requireOwner(subject); requireAccess(previewHost[1]!, subject);
      if (!previewHost[2] && request.method === 'GET') {
        const snapshot = previews.list(previewHost[1]!);
        return json(200, { ...snapshot, registrations: snapshot.registrations.filter(value => value.status === 'active') });
      }
      if (previewHost[2] && request.method === 'POST') {
        await readBody(request);
        if (previewHost[3] === 'renew') {
          const registration = previews.list(previewHost[1]!).registrations.find(value => value.id === previewHost[2]);
          if (!registration || registration.status === 'unregistered' || registration.pendingUnregister) return json(409, { error: 'Preview is unavailable or has been unregistered.' });
          const nameId = previews.nameId(previewHost[1]!, previewHost[2]);
          if (previews.list(previewHost[1]!).registrations.some(value => value.id !== registration.id && value.status === 'active'
            && value.expiresAt > now() && !value.pendingUnregister && previews.nameId(previewHost[1]!, value.id) === nameId))
            return json(409, { error: 'A newer registration uses this tunnel name. Open the current preview.' });
          const result = await rpc(requireHost(previewHost[1]!), 'POST', '/remote/previews/renew', undefined, JSON.stringify({ id: previewHost[2] }));
          return new Response(result.body, { status: result.status, headers: { 'content-type': 'application/json' } });
        }
        await previews.unregister(previewHost[1]!, previewHost[2]);
        return json(200, { registration: previews.list(previewHost[1]!).registrations.find(value => value.id === previewHost[2]) });
      }
      return json(405, { error: 'Method is not allowed.' });
    }
    if (url.pathname === '/v1/remote/hosts' && request.method === 'GET') return json(200, { hosts: visibleHosts(subject) });
    if (url.pathname === '/v1/remote/pairings') {
      requireOwner(subject);
      if (request.method === 'GET') return json(200, { availablePurposes: accountBacked && options.gatewaySetup !== false ? ['host-only', 'gateway-setup'] : ['host-only'],
        pairings: [...brokerState.pairings].sort((a, b) => b.createdAt - a.createdAt).map(item => visiblePairing(item, now())) });
      if (request.method !== 'POST') return json(405, { error: 'Method is not allowed.' });
      const body = await readBody(request);
      const purpose = body.purpose ?? 'host-only';
      if (Object.keys(body).some(key => !['purpose', 'recoverHostId'].includes(key)) || !isPairingPurpose(purpose)) throw new BrokerError(400, 'invalid_request', 'Select a supported pairing purpose.');
      const recoverHostId = body.recoverHostId === undefined ? undefined : required(body.recoverHostId, 'recoverHostId');
      if (recoverHostId && (recoverHostId.length > 512 || purpose !== 'host-only' || !accountBacked || !options.ownerSubject || !options.successionEnrollment)) throw new BrokerError(400, 'host_recovery_unavailable', 'Recovery requires an authenticated owner and a retained succession identity.');
      if (options.gatewaySetup === false && purpose !== 'host-only') throw new BrokerError(403, 'unsupported_purpose', 'Gateway setup is unavailable for this authentication provider.');
      if (!accountBacked && purpose !== 'host-only') throw new BrokerError(400, 'unsupported_purpose', 'Gateway setup requires an account-backed Relay.');
      const key = `arc_${ids.token()}`;
      const createdAt = now(); const expires = createdAt + (options.keyLifetimeMs ?? (accountBacked ? 10 * 60 * 1000 : 24 * 60 * 60 * 1000));
      const item: SavedPairingKey = { id: ids.uuid(), purpose, createdAt, expiresAt: expires };
      await brokerState.commit(draft => {
        let recovery: HostRecoverySelection | undefined;
        if (recoverHostId) {
          const installationId = brokerState.retainedIdentities().get(recoverHostId);
          if (!installationId || brokerState.hosts.has(recoverHostId) || [...brokerState.hosts.values()].some(host => host.installationId === installationId)) throw new BrokerError(409, 'host_recovery_unavailable', 'The selected historical Host is unavailable for recovery.');
          let marker = draft.revokedHosts?.find(host => host.hostId === recoverHostId);
          if (!marker) {
            marker = { hostId: recoverHostId, installationId, revocationId: ids.uuid() };
            (draft.revokedHosts ??= []).push(marker);
          }
          recovery = { hostId: marker.hostId, installationId: marker.installationId, revocationId: marker.revocationId };
          item.recovery = recovery;
          draft.keys = draft.keys.filter(([, value]) => value.installationId !== installationId || value.recovery?.revocationId === marker.revocationId);
          if (draft.sharing) for (const grant of draft.sharing.grants) if (grant.hostId === recoverHostId) grant.revoked = true;
        }
        draft.keys = draft.keys.filter(([, value]) => value.expires > now());
        if (draft.keys.length >= 128) throw new BrokerError(429, 'capacity_exceeded', 'Too many active temporary keys.');
        if ((draft.pairings?.length ?? 0) >= MAX_PAIRING_HISTORY) throw new BrokerError(429, 'pairing_history_full', 'Delete old pairing key records before creating another key.');
        const credential: DeviceCredential = { expires, purpose, pairingId: item.id, ...(recovery ? { recovery, installationId: recovery.installationId } : {}), ...(accountBacked ? { requiresRotation: true } : {}) };
        draft.keys.push([keyHash(key), credential]);
        (draft.pairings ??= []).push(item);
        return { value: undefined, publish() {
          for (const hash of brokerState.keys.keys()) if (!draft.keys.some(([saved]) => saved === hash)) brokerState.keys.delete(hash);
          brokerState.pairings = draft.pairings!;
          brokerState.revokedHosts = draft.revokedHosts;
          brokerState.sharing = new HostSharing(draft.sharing, () => {});
          brokerState.keys.set(keyHash(key), credential); options.onPairing?.(key, expires);
        } };
      // No key or access removal is published, and no external grant effect occurs, before admission.
      }, true);
      return json(201, { ...visiblePairing(item, now()), key, serverUrl: options.publicUrl ?? context.serverUrl ?? new URL(request.url).origin,
        ...(accountBacked && options.publicUrl ? { command: `export AGENT_HOST_SERVER='${options.publicUrl.replaceAll("'", "'\\''")}'\nexport AGENT_HOST_REMOTE_KEY='${key}'\nagent-remote-controller start` } : {}) });
    }
    const pairingAction = /^\/v1\/remote\/pairings\/([^/]+)(\/revoke)?$/.exec(url.pathname);
    if (pairingAction) {
      requireOwner(subject);
      const revoke = pairingAction[2] === '/revoke';
      if (request.method !== (revoke ? 'POST' : 'DELETE')) return json(405, { error: 'Method is not allowed.' });
      const body = await readBody(request);
      if (Object.keys(body).length) throw new BrokerError(400, 'invalid_request', 'No pairing management parameters are accepted.');
      await brokerState.commit(draft => {
        const item = draft.pairings?.find(item => item.id === pairingAction[1]);
        if (!item) throw new BrokerError(404, 'pairing_not_found', 'Pairing key record is unavailable.');
        if (revoke && pairingStatus(item, now()) === 'used') throw new BrokerError(409, 'pairing_used', 'This key has been used. Manage the paired Host to revoke its access.');
        if (item.usedAt === undefined) draft.keys = draft.keys.filter(([, key]) => key.pairingId !== item.id);
        if (revoke) item.revokedAt ??= now();
        else draft.pairings = draft.pairings!.filter(value => value.id !== item.id);
        return { value: undefined, publish() {
          brokerState.pairings = draft.pairings ?? [];
          for (const hash of brokerState.keys.keys()) if (!draft.keys.some(([saved]) => saved === hash)) brokerState.keys.delete(hash);
          credentialExpiry.enforce();
        } };
      });
      return json(200, { ok: true });
    }
    const management = /^\/v1\/remote\/hosts\/([^/]+)\/(rotate|stop)$/.exec(url.pathname);
    if (management && request.method === 'POST') {
      requireOwner(subject);
      const body = await readBody(request);
      const host = requireHost(management[1]!);
      if (management[2] === 'rotate') {
        if (Object.keys(body).length) throw new BrokerError(400, 'invalid_request', 'No parameters are accepted.');
        if (!accountBacked || !host.issueCredential) throw new BrokerError(409, 'host_upgrade_required', 'Update and reconnect Agent Host before rotating its credential.');
        await host.issueCredential();
        return json(200, {ok:true,status:'pending'});
      }
      if (Object.keys(body).some(key => key !== 'operationId')) throw new BrokerError(400, 'invalid_request', 'Stop accepts only an operation identity.');
      const result = await rpc(host, 'POST', '/remote/stop', undefined, JSON.stringify({ operationId: required(body.operationId, 'operationId') }));
      return rawJson(result);
    }
    const reading = /^\/v1\/remote\/hosts\/([^/]+)\/smart-reading$/.exec(url.pathname);
    if (reading) {
      requireOwner(subject);
      const host = brokerState.hosts.get(reading[1]!);
      if (!host) throw new BrokerError(404, 'host_not_found', 'The Remote Host is unknown.');
      if (request.method === 'GET') return json(200, { providers: host.smartReading ?? [] });
      if (request.method !== 'PUT') return json(405, { error: 'Method is not allowed.' });
      if (!journals) throw new BrokerError(409, 'journals_unavailable', 'This Relay does not keep session journals.');
      const body = await readBody(request);
      if (Object.keys(body).some(key => key !== 'providerId' && key !== 'enabled') || typeof body.enabled !== 'boolean') {
        throw new BrokerError(400, 'invalid_request', 'Name a provider and whether smart reading is on for it.');
      }
      const providerId = required(body.providerId, 'providerId');
      const enabled = body.enabled;
      if (enabled && !host.smartReading?.includes(providerId) && (host.smartReading?.length ?? 0) >= 64) {
        throw new BrokerError(400, 'invalid_request', 'Smart reading names at most 64 providers per Host.');
      }
      const providers = await brokerState.commit(draft => {
        brokerState.assertHostCurrent(host);
        const saved = draft.hosts.find(value => value.id === host.id);
        if (!saved) throw new BrokerError(404, 'host_not_found', 'The Remote Host is unknown.');
        const next = new Set(saved.smartReading ?? []);
        if (enabled) next.add(providerId); else next.delete(providerId);
        if (next.size > 64) throw new BrokerError(400, 'invalid_request', 'Smart reading names at most 64 providers per Host.');
        const list = [...next].sort();
        if (list.length > 0) saved.smartReading = list; else delete saved.smartReading;
        return { value: list, publish() {
          host.smartReading = list.length > 0 ? list : undefined;
          if (!enabled) journalSessions?.stopReading(host.id, providerId);
        } };
      });
      return json(200, { providers });
    }
    const revoking = /^\/v1\/remote\/hosts\/([^/]+)\/revoke$/.exec(url.pathname);
    if (accountBacked && revoking && request.method === 'POST') {
      requireOwner(subject);
      await readBody(request);
      const host = brokerState.hosts.get(revoking[1]!);
      if (!host) throw new BrokerError(404, 'host_not_found', 'The Remote Host is unknown.');
      let droppedDeletion: string | undefined;
      await brokerState.commit(draft => {
        droppedDeletion = undefined;
        brokerState.assertHostCurrent(host);
        if (brokerState.retainedIdentities().get(host.id) === host.installationId) {
          const marker: RevokedHost = { hostId: host.id, installationId: host.installationId, revocationId: ids.uuid(), revokedAt: now() };
          draft.revokedHosts = [...(draft.revokedHosts ?? []).filter(item => item.hostId !== host.id), marker];
        }
        if (draft.sharing) for (const grant of draft.sharing.grants) if (grant.hostId === host.id) grant.revoked = true;
        for (const item of draft.pairings ?? []) if (item.recovery?.hostId === host.id && item.usedAt === undefined) item.revokedAt ??= now();
        draft.keys = draft.keys.filter(([, credential]) => credential.installationId !== host.installationId);
        draft.bindings = draft.bindings.filter(binding => binding.hostId !== host.id);
        draft.creations = draft.creations.filter(([, value]) => draft.bindings.some(binding => binding.agentId === value.agentId));
        draft.hosts = draft.hosts.filter(value => value.id !== host.id);
        if (journals) {
          const pending = (draft.journalDeletions ?? []).filter(id => id !== host.id);
          // A revoke always succeeds: when the list is full, the oldest pending deletion is dropped.
          if (pending.length >= JOURNAL_DELETION_LIMIT) droppedDeletion = pending.shift();
          draft.journalDeletions = [...pending, host.id];
        }
        draft.previews = (draft.previews ?? []).filter(value => value.hostId !== host.id);
        return { value: undefined, publish() {
          brokerState.revokedHosts = draft.revokedHosts;
          brokerState.pairings = draft.pairings ?? [];
          brokerState.sharing = new HostSharing(draft.sharing, () => {});
          for (const [key, credential] of brokerState.keys) if (credential.installationId === host.installationId) brokerState.keys.delete(key);
          for (const [id, binding] of brokerState.bindings) if (binding.hostId === host.id) {
            brokerState.bindings.delete(id); runtimeBindings.delete(id); const key = JSON.stringify([host.id, binding.providerId, binding.nativeSessionId]);
            brokerState.nativeBindings.delete(key); attached.delete(key);
          }
          for (const [key, value] of brokerState.completedCreations) if (!brokerState.bindings.has(value.agentId)) { brokerState.completedCreations.delete(key); creations.delete(key); }
          for (const key of creations.keys()) if (key.startsWith(`[${JSON.stringify(host.id)},`)) creations.delete(key);
          for (const key of attachmentRequests.keys()) if (JSON.parse(JSON.parse(key)[0])[0] === host.id) attachmentRequests.delete(key);
          brokerState.hosts.delete(host.id);
          previews.forget(host.id);
          if (journals) {
            brokerState.journalDeletions = draft.journalDeletions ?? [];
            deletion.revoked(host.id, droppedDeletion);
          }
          if (host.socket) { const socket = host.socket; disconnected(host, socket, 'access_revoked', 1008); socket.close(1008, 'Device revoked'); }
        } };
      });
      return json(200, { ok: true });
    }
    const refs = /^\/v1\/remote\/hosts\/([^/]+)\/session\/refs$/.exec(url.pathname);
    if (refs && (request.method === 'GET' || request.method === 'POST')) {
      requireAccess(refs[1]!, subject);
      const host = requireHost(refs[1]!);
      const input = request.method === 'POST' ? await readBody(request) : { providerId: url.searchParams.get('providerId'), nativeSessionId: url.searchParams.get('nativeSessionId') };
      const providerId = required(input.providerId, 'providerId'), nativeSessionId = required(input.nativeSessionId, 'nativeSessionId');
      // References name other sessions, so a page may change them only where it may open both sessions.
      const allowed = (provider: string, session: string) => {
        const binding = brokerState.nativeBindings.get(JSON.stringify([host.id, provider, session]));
        return owner(subject) || !!binding && sessionAllowed(binding, subject);
      };
      if (!allowed(providerId, nativeSessionId)) throw new SharingError(403, 'session_forbidden', 'Session access is unavailable.');
      // Older Controllers refuse the route and close their uplink, so only Controllers that declare references are asked.
      if (!host.providers.some(provider => provider.providerId === providerId && provider.sessionReferences)) throw new BrokerError(400, 'unsupported_configuration', 'Session references are unavailable. Update the Controller.');
      if (request.method === 'GET') return rawJson(await rpc(host, 'GET', `/remote/session/refs?${new URLSearchParams({ providerId, nativeSessionId })}`));
      const target = input.target as { providerId?: unknown; nativeSessionId?: unknown } | undefined;
      if ((input.action !== 'add' && input.action !== 'remove') || typeof target?.providerId !== 'string' || typeof target.nativeSessionId !== 'string'
        || Object.keys(input).some(key => !['providerId', 'nativeSessionId', 'action', 'target'].includes(key))) throw new BrokerError(400, 'invalid_request', 'Name the reference to add or remove.');
      if (input.action === 'add' && !allowed(target.providerId, target.nativeSessionId)) throw new SharingError(403, 'session_forbidden', 'Session access is unavailable.');
      return rawJson(await rpc(host, 'POST', '/remote/session/refs', undefined, JSON.stringify({ providerId, nativeSessionId, action: input.action,
        target: { providerId: target.providerId, nativeSessionId: target.nativeSessionId } })));
    }
    const call = /^\/v1\/remote\/hosts\/([^/]+)\/session\/call$/.exec(url.pathname);
    if (call && request.method === 'POST') {
      // Session commands reach every session of a Host, so only its owner sends them.
      if (!owner(subject)) throw new SharingError(403, 'session_forbidden', 'Session commands are available to the Host owner.');
      requireAccess(call[1]!, subject);
      const host = requireHost(call[1]!);
      if (!host.providers.some(provider => provider.sessionCommands)) throw new BrokerError(400, 'unsupported_configuration', 'Session commands are unavailable. Update the Controller.');
      const input = await readBody(request);
      const command = input.request as Record<string, unknown> | undefined;
      if (!command || typeof command !== 'object' || Array.isArray(command) || Object.keys(input).some(key => key !== 'request')) throw new BrokerError(400, 'invalid_request', 'A session command is required.');
      // Permission settings need a recent sign-in in the website; the same holds for commands.
      const settings = command.command === 'set' && command.settings && typeof command.settings === 'object' ? Object.keys(command.settings) : [];      if (settings.some(settingId => context.authorizeMessage?.(JSON.stringify({ type: 'set_session_setting', payload: { settingId } })) === false)) {
        throw new BrokerError(403, 'reauthentication_required', 'Sign in again in the website before changing permission settings.');
      }
      return rawJson(await rpc(host, 'POST', '/remote/session/call', undefined, JSON.stringify({ request: command })));
    }
    const rename = /^\/v1\/remote\/hosts\/([^/]+)\/session\/rename$/.exec(url.pathname);
    if (rename && request.method === 'POST') {
      requireAccess(rename[1]!, subject);
      const host = requireHost(rename[1]!);
      const input = await readBody(request);
      const providerId = required(input.providerId, 'providerId'), nativeSessionId = required(input.nativeSessionId, 'nativeSessionId');
      const binding = brokerState.nativeBindings.get(JSON.stringify([host.id, providerId, nativeSessionId]));
      if (!owner(subject) && (!binding || !sessionAllowed(binding, subject))) throw new SharingError(403, 'session_forbidden', 'Session access is unavailable.');
      if (!host.providers.some(provider => provider.providerId === providerId && provider.sessionRename)) throw new BrokerError(400, 'unsupported_configuration', 'Native session renaming is unavailable. Update the Controller.');
      const title = required(input.title, 'title').trim();
      if (!title || title.length > 512 || /[\u0000-\u001f\u007f]/.test(title) || Object.keys(input).some(key => !['providerId', 'nativeSessionId', 'title', 'operationId'].includes(key))) throw new BrokerError(400, 'invalid_request', 'Enter a session name of up to 512 characters.');
      const result = await rpc(host, 'POST', '/remote/session/rename', undefined, JSON.stringify({ providerId, nativeSessionId, title, operationId: required(input.operationId, 'operationId') }));
      requireAccess(host.id, subject);
      if (!owner(subject) && (!binding || !sessionAllowed(binding, subject))) throw new SharingError(403, 'session_forbidden', 'Session access is unavailable.');
      return rawJson(result);
    }
    const listing = /^\/v1\/remote\/hosts\/([^/]+)\/catalog\/listing$/.exec(url.pathname);
    if (listing) {
      requireOwner(subject); requireAccess(listing[1]!, subject);
      const host = requireHost(listing[1]!);
      if (request.method !== 'GET' && request.method !== 'POST') throw new BrokerError(405, 'method_not_allowed', 'Use GET or POST.');
      const input = request.method === 'POST' ? await readBody(request) : undefined;
      const providerId = required(input?.providerId ?? url.searchParams.get('providerId'), 'providerId');
      if (host.legacyDsh || !host.providers.some(provider => provider.providerId === providerId)) throw new BrokerError(400, 'invalid_provider', 'The selected provider is unavailable on this Host.');
      if (input && Object.keys(input).some(key => key !== 'providerId')) throw new BrokerError(400, 'invalid_request', 'Only providerId is accepted.');
      const result = await rpc(host, request.method, `/remote/catalog/listing${input ? '' : '?' + new URLSearchParams({ providerId })}`, undefined, input ? JSON.stringify({ providerId }) : undefined);
      requireOwner(principal(context)); requireAccess(host.id, principal(context));
      return rawJson(result);
    }
    const directory = /^\/v1\/remote\/hosts\/([^/]+)\/(catalog(?:\/revision)?|workspaces|workspace-folders(?:\/create)?|models|child\/attach|attach|create)$/.exec(url.pathname);
    if (directory) {
      requireAccess(directory[1]!, subject);
      const action = directory[2]!;
      if (action.startsWith('workspace-folders')) requireOwner(subject);
      const host = requireHost(directory[1]!);
      if (action === 'models' && request.method === 'GET' && host.legacyDsh) return json(200, { models: [] });
      if (['catalog', 'catalog/revision', 'workspaces', 'workspace-folders', 'models'].includes(action) && request.method === 'GET') {
        const query = new URLSearchParams(url.search);
        const providerId = query.get('providerId');
        if (!host.legacyDsh && (!providerId || !host.providers.some((provider) => provider.providerId === providerId))) throw new BrokerError(400, 'invalid_provider', 'The selected provider is unavailable on this Host.');
        if (host.legacyDsh) query.delete('providerId');
        if (!owner(subject) && action.startsWith('catalog')) {
          return rawJson(await sharedCatalog(host, action, query, subject!));
        }
        const result = await rpc(host, 'GET', `/remote/${action}${query.size ? '?' + query : ''}`);
        requireAccess(host.id, subject);
        return rawJson(result);
      }
      if (action === 'workspace-folders/create' && request.method === 'POST') {
        const payload = await readBody(request);
        const providerId = required(payload.providerId, 'providerId');
        if (host.legacyDsh || !host.providers.some(provider => provider.providerId === providerId)) throw new BrokerError(400, 'invalid_provider', 'The selected provider is unavailable on this Host.');
        const result = await rpc(host, 'POST', '/remote/workspace-folders/create', undefined, JSON.stringify({
          providerId, parentPath: required(payload.parentPath, 'parentPath'), name: required(payload.name, 'name'),
        }));
        requireAccess(host.id, subject); requireOwner(subject);
        return rawJson(result);
      }
      if (['attach', 'child/attach', 'create'].includes(action) && request.method === 'POST') {
        const operation = userMutation(host, action, await readBody(request), subject);
        const binding = await (action === 'create' ? waitForCreation(operation) : operation);
        if (!sessionAllowed(binding, subject)) throw new SharingError(403, 'session_forbidden', 'Session access is unavailable.');
        return json(200, { agentId: binding.agentId, nativeSessionId: binding.nativeSessionId }); }
    }
    const session = /^\/v1\/sessions\/([^/]+)\/(snapshot|timeline)$/.exec(url.pathname);
    const binding = session && brokerState.bindings.get(session[1]!);
    if (binding && request.method === 'GET') {
      if (!sessionAllowed(binding, subject)) throw new SharingError(403, 'session_forbidden', 'Session access is unavailable.');
      const host = requireHost(binding.hostId); await recoverBinding(host, binding);
      const result = await sessionRead(host, binding, url.pathname + url.search);
      if (!sessionAllowed(binding, subject)) throw new SharingError(403, 'session_forbidden', 'Session access is unavailable.');
      return rawJson(result);
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
      brokerState.keys.clear(); brokerState.hosts.clear(); brokerState.bindings.clear(); runtimeBindings.clear(); brokerState.nativeBindings.clear(); attached.clear(); creations.clear();
    },
  };
}
