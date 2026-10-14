import { TeamBroker, teamMessageBudgetBytes } from './teams.js';
import { compactTeamDeliveries, trimTeamDeliveryReceipts, validSavedTeam, type SavedTeam } from './team-delivery.js';
import type { TeamResourceStore } from './team-resources.js';
import { isTeamCreate, isTeamAction } from '@orchardworks/agent-remote-protocol';
import { sessionIdentityMessage } from './session-identity.js';
import { isCreationSource, type CreationSource } from '@orchardworks/agent-remote-protocol';
import { relationChangeKey, isRelationChangeReceipt, type RelationChangeReservation, type RelationChangeReceipt } from '@orchardworks/agent-remote-protocol';
import type { RelationChangeReset, BrokerRelationChange } from './relation-changes.js';
import { isDeepStrictEqual } from 'node:util';
import { retainedHostIdentities, retainedRecoveryInstallations, type HostRecoverySelection, type RevokedHost } from './host-recovery.js';
import { validBrokerAssociations, migrateBrokerAssociations, type BrokerAssociationState } from './succession-associations.js';
import { isNativeSessionRef, isPrimaryRole, isSuccessionRecord, isSuccessionDescription, isSuccessionActionResult, nativeSessionRefKey, successionFreezeKey, successionAuthorityKey, type NativeSessionRef, type SuccessionAssociationFreeze, type BoundedSuccessionAssociationFreeze, type PrimaryRole, type SuccessionRecord, type SuccessionActionResult } from '@orchardworks/agent-remote-protocol';
import { type SuccessionAssociationAuthority, isSuccessionAssociationAuthority } from '@orchardworks/agent-remote-protocol';
import { isTpmAction, isTpmCreate, isTpmList, isTpmWork } from '@orchardworks/agent-remote-protocol';
import { validSessionRelationUpdate, validSourceRelation, type SourceRelation, type SessionRelation } from './session-relations.js';
import { isHostProviderChange } from '@orchardworks/agent-remote-protocol';
import type {NativeSessionOwner} from '@orchardworks/agent-remote-protocol';
import { isCodexDaemonRestart } from '@orchardworks/agent-remote-protocol';
import type { DiagnosticJournal } from './diagnostic-journal.js';
import { relayDiagnosticsForVersion, RELAY_DIAGNOSTIC_PATH, type RelayDiagnostic } from './relay-diagnostics.js';
import { controllerReleases } from './controller-releases.js';
import { decodeClientMessage, PROTOCOL_VERSION, controllerUpdateTarget, controllerUpgradeBridgeVersion, type ControllerRelease, type ControllerIdentity } from '@orchardworks/agent-remote-protocol';
import { MAX_PAIRING_HISTORY, pairingStatus, visiblePairing, type SavedPairingKey } from './pairing-keys.js';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { decodeRemoteHostUplinkMessage, type RemoteHostUplinkMessage, type HostEnvironment, isPairingPurpose, type PairingPurpose } from '@orchardworks/agent-remote-protocol';
import { sessionAttachFailure } from './session-errors.js';
import { HostSharing, SharingError, type HostSharingState } from './host-sharing.js';
import { createHostPreviews, type HostPreviewState } from './host-previews.js';
import type { TunnelSocket } from '@orchardworks/agent-remote-tunnel';
import { BROKER_MAX_BODY_BYTES, BROKER_MAX_FRAME_BYTES, defaultBrokerScheduler, RELAY_SOCKET_OPEN, type BrokerRequestContext, type BrokerScheduler, type RelaySocket } from './transport.js';
import { isSuccessionCapacityError, remainingAssociationRevisions, SUCCESSION_FEATURE_BYTES } from './succession-capacity.js';

type SharedCreation = { subject: string; operationId: string; fingerprint: string; reservation: ReturnType<HostSharing['reserve']> };
type RpcResponse = { status: number; body: string; requestId?: string };
type ProviderDescriptor = { providerId: string; displayName: string; promptEditing?: true; sessionRename?: true; daemonControl?: true };
type DeviceCredential = { recovery?: HostRecoverySelection; pairingId?: string; purpose?: PairingPurpose; claimedAt?: number; expires: number; installationId?: string; kind?: 'device'; requiresRotation?: boolean };
type Host = {
  successionEnrollmentVersion?: 1 | 2;
  providerManagement?: true;
  tpmManagement?: true;
  teamManagement?: true;
  connectionId?: string; stopDiagnostics?(): void;
  pairingPurpose?: PairingPurpose;
  environment?: HostEnvironment;
  controller?: ControllerIdentity;
  tunnelToken?: string;
  ready?: boolean; credentialRotation?: boolean; gatewayKeyRequested?: boolean; issueCredential?(): Promise<void>;
  id: string; installationId: string; name: string; providers: ProviderDescriptor[]; legacyDsh: boolean; generation: number; socket?: RelaySocket;
  pending: Map<string, { resolve(value: RpcResponse): void; reject(error: Error): void; timer: unknown; method: 'GET' | 'POST'; path: string; diagnostic: boolean; startedAt: number }>;
  streams: Map<string, { publicAgentId: string; runtimeAgentId: string; socket: RelaySocket; subject?: string; authorized?(): boolean; ready: boolean; buffered: string[]; timer?: unknown }>;
};
type Binding = { hostId: string; providerId: string; nativeSessionId: string; agentId: string; generation: number;
  creatorSubject?: string; parentNativeSessionId?: string; sourceRelation?: SourceRelation; recovery?: Promise<void> };
class BrokerError extends Error {
  constructor(readonly status: number, readonly code: string, message: string, readonly creationRejected = false, readonly requestId?: string, readonly nativeOwner?: NativeSessionOwner) { super(message); }
}
export interface RemoteHostBrokerState {
  teams?: SavedTeam[];
  revokedHosts?: RevokedHost[];
  associations?: BrokerAssociationState;
  pairings?: SavedPairingKey[];
  previews?: HostPreviewState[];
  sharing?: HostSharingState;
  keys: Array<[string, DeviceCredential]>;
  hosts: Array<Pick<Host, 'id' | 'installationId' | 'name' | 'providers' | 'legacyDsh' | 'credentialRotation' | 'gatewayKeyRequested' | 'environment' | 'pairingPurpose' | 'controller' | 'providerManagement' | 'tpmManagement' | 'teamManagement'>>;
  bindings: Array<Omit<Binding, 'generation' | 'recovery'>>;
  creations: Array<[string, { fingerprint: string; agentId: string }]>;
}
export interface HostBrokerOptions {
  /** Hosted authentication capability; never enables standalone Gateway access. */
  gatewaySetup?: boolean;
  teamResources?: TeamResourceStore;
  /** Internal opt-in; only a Gateway-authenticated tenant can supply this authority. */
  successionEnrollment?: SuccessionAssociationAuthority;
  /** Pure synchronous selection from the complete post-increment Broker draft; no native effects. */
  successionProjectionAllowance?: (context: { hostId: string; broker: Readonly<RemoteHostBrokerState>; freeze: Omit<BoundedSuccessionAssociationFreeze, 'maxProjectionBytes'> }) => number;
  diagnostics?: DiagnosticJournal;
  ownerSubject?: string;
  userStreamCount?(subject: string): number;
  controllerReleases?: Pick<typeof controllerReleases, 'latest'> & Partial<Pick<typeof controllerReleases, 'version'>>;
  origin: string;
  rpcTimeoutMs?: number;
  heartbeatIntervalMs?: number;
  heartbeatTimeoutMs?: number;
  keyLifetimeMs?: number;
  publicUrl?: string;
  onPairing?(key: string, expiresAt: number): void;
  /** Account security and credential management, independent of storage durability. */
  accountBacked?: boolean;
  /** Legacy account-mode option. Prefer accountBacked in hosted compositions. */
  durable?: boolean;
  initialState?: RemoteHostBrokerState;
  onStateChange?(state: RemoteHostBrokerState): void | Promise<void>;
  now?(): number;
  scheduler?: BrokerScheduler;
}
export function createHostBroker(options: HostBrokerOptions) {
  const accountBacked = options.accountBacked ?? options.durable ?? false;
  const origin = new URL(options.origin).origin;
  if (options.successionEnrollment && (!accountBacked || !options.onStateChange || !isSuccessionAssociationAuthority(options.successionEnrollment) || options.successionEnrollment.origin !== origin || options.successionEnrollment.ownerSubject !== options.ownerSubject)) throw new Error('Succession enrollment requires a durable authenticated tenant authority.');
  const now = options.now ?? Date.now;
  const scheduler = options.scheduler ?? defaultBrokerScheduler;
  const setTimeout = scheduler.setTimeout.bind(scheduler);
  const clearTimeout = scheduler.clearTimeout.bind(scheduler);
  const heartbeat = { intervalMs: options.heartbeatIntervalMs ?? 30_000, timeoutMs: options.heartbeatTimeoutMs ?? 10_000 };
  if (!Number.isSafeInteger(heartbeat.intervalMs) || !Number.isSafeInteger(heartbeat.timeoutMs) || heartbeat.timeoutMs < 1 || heartbeat.timeoutMs >= heartbeat.intervalMs || heartbeat.intervalMs > 600_000) {
    throw new RangeError('Host heartbeat deadlines require 0 < timeout < interval <= 600000 milliseconds.');
  }
  const uplinkCleanups = new Map<RelaySocket, () => void>();
  const clients = new Set<RelaySocket>();
  function track(client: RelaySocket) { clients.add(client); client.onClose(() => clients.delete(client)); }
  const keys = new Map<string, DeviceCredential>();
  const hosts = new Map<string, Host>();
  let pairings = structuredClone(options.initialState?.pairings ?? []);
  let revokedHosts = structuredClone(options.initialState?.revokedHosts);
  const bindings = new Map<string, Binding>();
  const runtimeBindings = new Map<string, { generation: number; agentId: string }>();
  const activeStreamCount = (subject: string) => [...hosts.values()].reduce((sum, host) => sum + [...host.streams.values()].filter(stream => stream.subject === subject).length, 0);
  const pendingBindingSlots = new Map<string, { admissionId?: string; nativeKey?: string; creationKey?: string }>();
  const nativeBindings = new Map<string, Binding>();
  const attached = new Map<string, Promise<Binding>>();
  const attachmentRequests = new Map<string, Promise<Binding>>();
  const creations = new Map<string, { fingerprint: string; result: Promise<Binding> }>();
  const completedCreations = new Map<string, { fingerprint: string; agentId: string }>();
  for (const [hash, key] of options.initialState?.keys ?? []) if (key.expires > now()) keys.set(hash, structuredClone(key));
  for (const item of options.initialState?.hosts ?? []) hosts.set(item.id, { ...item, generation: 0, pending: new Map(), streams: new Map() });
  for (const host of hosts.values()) options.diagnostics?.record(host.id, { event: 'relay_started' });
  for (const item of options.initialState?.bindings ?? []) {
    const binding = { ...item, generation: -1 };
    bindings.set(binding.agentId, binding);
    nativeBindings.set(JSON.stringify([binding.hostId, binding.providerId, binding.nativeSessionId]), binding);
    attached.set(JSON.stringify([binding.hostId, binding.providerId, binding.nativeSessionId]), Promise.resolve(binding));
  }
  for (const [key, value] of options.initialState?.creations ?? []) {
    const binding = bindings.get(value.agentId);
    if (binding) { completedCreations.set(key, value); creations.set(key, { fingerprint: value.fingerprint, result: Promise.resolve(binding) }); }
  }
  let associations = migrateBrokerAssociations(options.initialState?.associations ?? { version: 5, revision: 0, admissions: [], freezes: [], relationChanges: [], relationResets: [] });
  let teamState = structuredClone(options.initialState?.teams ?? []);
  if (!teamState.every(validSavedTeam)) throw new Error('Invalid saved Teams.');
  for (const team of teamState) compactTeamDeliveries(team, now());
  trimTeamDeliveryReceipts(teamState, 2 * 1024 * 1024);
  function snapshot(): RemoteHostBrokerState {
    return { teams: structuredClone(teamState), ...(revokedHosts ? { revokedHosts: structuredClone(revokedHosts) } : {}), ...(options.successionEnrollment || options.initialState?.associations ? { associations: structuredClone(associations) } : {}), pairings: structuredClone(pairings), previews: previews.snapshot(), ...(options.ownerSubject ? { sharing: sharing.snapshot() } : {}), keys: [...keys].map(([key, value]) => [key, structuredClone(value)]),
      hosts: [...hosts.values()].map(({ id, installationId, name, providers, legacyDsh, credentialRotation, gatewayKeyRequested, environment, pairingPurpose, controller, providerManagement, tpmManagement, teamManagement }) => ({ ...(teamManagement ? { teamManagement } : {}), ...(tpmManagement ? { tpmManagement } : {}), ...(providerManagement ? { providerManagement } : {}), ...(controller ? { controller } : {}), ...(pairingPurpose ? { pairingPurpose } : {}), ...(environment ? { environment } : {}), id, installationId, name, providers, legacyDsh, ...(credentialRotation ? {credentialRotation} : {}), ...(gatewayKeyRequested ? { gatewayKeyRequested } : {}) })),
      bindings: [...bindings.values()].map(({ generation: _generation, recovery: _recovery, ...binding }) => binding),
      creations: [...completedCreations] };
  }
  let sharing = new HostSharing(options.initialState?.sharing, () => {});
  let unavailable = false;
  let commits: Promise<unknown> = Promise.resolve();
  const previews = createHostPreviews({ initial: options.initialState?.previews,
    save: (value, publish) => {
      const owners = value.map(item => hosts.get(item.hostId));
      return commit(draft => {
        for (const host of owners) { if (!host) throw new BrokerError(404, 'host_revoked', 'Preview Host access was revoked.'); assertHostCurrent(host); }
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
  function assertAvailable() { if (unavailable) throw new BrokerError(503, 'state_unavailable', 'Relay state is unavailable.'); }
  function assertHostCurrent(host: Host, generation?: number) {
    assertAvailable();
    if (hosts.get(host.id) !== host) throw new BrokerError(401, 'host_revoked', 'Host access was revoked.');
    if (generation !== undefined && host.generation !== generation) throw new BrokerError(503, 'host_reconnected', 'The Host connection changed.');
  }
  function retainedIdentities(next = associations) {
    try { return retainedHostIdentities({ hosts: [...hosts.values()], associations: next, revokedHosts }); }
    catch (error) { throw new BrokerError(409, 'host_recovery_capacity', error instanceof Error ? error.message : 'Retained Host identities are unavailable.'); }
  }
  function failClosed() {
    unavailable = true;
    for (const cleanup of [...uplinkCleanups.values()]) cleanup();
    for (const host of hosts.values()) if (host.socket) disconnected(host, host.socket, 'relay_state_unavailable', 1011);
    for (const client of clients) client.close(1011, 'Relay state is unavailable');
  }
  function commit<T>(stage: (draft: RemoteHostBrokerState) => { value: T; unchanged?: true; publish(): void }, preEffect = false): Promise<T> {
    const operation = commits.then(async () => {
      assertAvailable();
      const draft = structuredClone(snapshot());
      const result = stage(draft);
      if (result.unchanged) return result.value;
      try { await options.onStateChange?.(draft); }
      catch (error) {
        if (preEffect && isSuccessionCapacityError(error)) throw new BrokerError(error.status, error.code, error.message);
        failClosed(); throw error;
      }
      assertAvailable();
      result.publish();
      return result.value;
    });
    commits = operation.catch(() => undefined);
    return operation;
  }
  const teams = new TeamBroker({
    resources: options.teamResources,
    now, read: () => teamState,
    change: update => commit(draft => {
      const next = structuredClone(teamState), value = structuredClone(update(next));
      trimTeamDeliveryReceipts(next, 2 * 1024 * 1024);
      if (isDeepStrictEqual(next, teamState)) return { value, unchanged: true, publish() {} };
      if (!next.every(team => validSavedTeam(team) && teamMessageBudgetBytes(team) <= 128 * 1024) || Buffer.byteLength(JSON.stringify(next)) > 2 * 1024 * 1024) throw new Error('Team storage capacity reached.');
      draft.teams = next; return { value, publish() { teamState = next; } };
    }),
    assertHost(hostId, providerId) { const host = requireHost(hostId); if (!host.teamManagement) throw new Error('Update the Controller to use Teams.'); if (!host.providers.some(provider => provider.providerId === providerId)) throw new Error('Provider is unavailable on this Host.'); },
    async createSeat(hostId, seat) {
      const result = await rpc(requireHost(hostId), 'POST', '/remote/team/create-seat', undefined, JSON.stringify(seat));
      const value = JSON.parse(result.body); if (result.status !== 200) throw new Error(value.error ?? 'Team session creation failed.'); return value;
    },
  });
  function assertAssociationCapacity(state: BrokerAssociationState) {
    if (!validBrokerAssociations(state) || state.revision > Number.MAX_SAFE_INTEGER - remainingAssociationRevisions(state)) throw new BrokerError(409, 'association_capacity', 'Association storage or revision headroom is exhausted.');
    retainedIdentities(state);
  }
  function associationChange<T>(change: (state: BrokerAssociationState) => T, preEffect = false): Promise<T> {
    return commit(draft => {
      const next = structuredClone(associations), value = change(next);
      if (isDeepStrictEqual(next, associations)) return { value, unchanged: true, publish() {} };
      if (next.revision >= Number.MAX_SAFE_INTEGER) throw new BrokerError(409, 'association_capacity', 'Association revision is exhausted.');
      next.revision++;
      assertAssociationCapacity(next);
      draft.associations = next;
      return { value, publish() { associations = next; } };
    }, preEffect);
  }
  function assertAssociationOpen(source: NativeSessionRef) {
    if (associations.relationChanges.some(item => item.phase !== 'committed' && item.reservation.lineage.some(ref => nativeSessionRefKey(ref) === nativeSessionRefKey(source)))) throw new BrokerError(409, 'relation_change_pending', 'Source relationships are reserved by a pending edit.', true);
    if (associations.freezes.some(item => !item.released && item.receipt.lineage.some(ref => nativeSessionRefKey(ref) === nativeSessionRefKey(source)))) throw new BrokerError(409, 'succession_associations_frozen', 'Source relationships are reserved by succession.', true);
  }
  function assertAssociationMutable(source: NativeSessionRef): void {
    assertAssociationOpen(source);
    if (associations.freezes.some(item => item.projection && [...item.receipt.lineage, item.projection.role.current].some(ref => nativeSessionRefKey(ref) === nativeSessionRefKey(source)))) {
      throw new BrokerError(409, 'succession_relationship_updates_unavailable', 'Trusted relationship updates are not enabled for this primary role.');
    }
  }
  function assertAssociationCreationOpen(source: NativeSessionRef) {
    assertAssociationOpen(source);
    const current = associations.freezes.filter(row => row.projection && [...row.receipt.lineage, row.projection.role.current].some(ref => nativeSessionRefKey(ref) === nativeSessionRefKey(source))).at(-1)?.projection?.role.current;
    if (current && nativeSessionRefKey(current) !== nativeSessionRefKey(source)) throw new BrokerError(409, 'session_superseded', 'Source session has been superseded.', true);
  }
  const associationSource = (host: Host, providerId: string, nativeSessionId: string): NativeSessionRef => ({ controllerId: host.installationId, providerId, nativeSessionId });
  async function associationRpc(host: Host, input: unknown): Promise<Record<string, any>> {
    const generation = host.generation; assertHostCurrent(host);
    if (!options.successionEnrollment || !host.successionEnrollmentVersion) throw new BrokerError(409, 'succession_enrollment_unavailable', 'Trusted succession enrollment was not negotiated.');
    const response = await rpc(host, 'POST', '/remote/succession/enrollment', undefined, JSON.stringify(input));
    assertHostCurrent(host, generation);
    let payload: Record<string, any>;
    try { payload = JSON.parse(response.body); } catch { throw new BrokerError(502, 'invalid_host_response', 'Invalid succession response.'); }
    if (response.status !== 200) throw new BrokerError(response.status, String(payload.code ?? 'succession_enrollment_failed'), String(payload.error ?? 'Succession enrollment failed.'));
    return payload;
  }
  async function successionAction(host: Host, action: string, input: Record<string, unknown>) {
    const generation = host.generation; assertHostCurrent(host);
    if (!options.successionEnrollment || !host.successionEnrollmentVersion) throw new BrokerError(409, 'succession_enrollment_unavailable', 'Trusted succession enrollment was not negotiated.');
    if (action === 'describe') {
      if (Object.keys(input).some(name => !['providerId', 'nativeSessionId'].includes(name))) throw new BrokerError(400, 'invalid_succession_request', 'Only the source selection may be supplied.');
      const providerId = required(input.providerId, 'providerId'), nativeSessionId = required(input.nativeSessionId, 'nativeSessionId');
      const described = await associationRpc(host, { action, providerId, nativeSessionId });
      const result = { role: described.role, targets: described.targets, eligibility: described.eligibility };
      if (!isSuccessionDescription(result) || result.role.current.controllerId !== host.installationId) throw new BrokerError(502, 'invalid_host_response', 'Invalid handoff description.');
      if (host.successionEnrollmentVersion !== 2 || !options.successionProjectionAllowance) result.eligibility = { status: 'unavailable', code: 'succession_preparation_unavailable', reason: 'New handoff requires the current Host and Relay capability.' };
      return result;
    }
    const selectionKeys = ['providerId', 'nativeSessionId', 'expectedRevision', 'targetProviderId'];
    const allowed = action === 'prepare' || action === 'cancel' ? ['operationId', ...selectionKeys] : action === 'status' ? ['operationId', 'includeContext'] : ['operationId'];
    if (Object.keys(input).some(name => !allowed.includes(name))) throw new BrokerError(400, 'invalid_succession_request', 'Only source selection and operation identity may be supplied.');
    if (input.includeContext !== undefined && input.includeContext !== true) throw new BrokerError(400, 'invalid_succession_request', 'Context status must be explicitly requested.');
    const operationId = required(input.operationId, 'operationId');
    let frozen = associations.freezes.find(item => item.hostId === host.id && item.receipt.request.operationId === operationId);
    if (action === 'prepare' || action === 'cancel' && selectionKeys.some(name => Object.hasOwn(input, name))) {
      const providerId = required(input.providerId, 'providerId'), nativeSessionId = required(input.nativeSessionId, 'nativeSessionId');
      const source = associationSource(host, providerId, nativeSessionId);
      const targetProviderId = input.targetProviderId === undefined ? undefined : required(input.targetProviderId, 'targetProviderId');
      if (!Number.isSafeInteger(input.expectedRevision) || (input.expectedRevision as number) < 1) throw new BrokerError(400, 'invalid_succession_request', 'A current role revision is required.');
      const assertSameRequest = (receipt: SuccessionAssociationFreeze) => {
        const prior = receipt.request;
        if (nativeSessionRefKey(prior.from) !== nativeSessionRefKey(source) || prior.expectedRevision !== input.expectedRevision || (prior.targetProviderId ?? prior.from.providerId) !== (targetProviderId ?? providerId)) throw new BrokerError(409, 'succession_identity_conflict', 'Succession operation identity changed.');
      };
      if (frozen) {
        assertSameRequest(frozen.receipt);
      } else {
        if (action === 'prepare' && (host.successionEnrollmentVersion !== 2 || !options.successionProjectionAllowance)) throw new BrokerError(409, 'succession_preparation_unavailable', 'New succession preparation requires negotiated v2 and projection admission.');
        const described = await associationRpc(host, { action: 'describe', providerId, nativeSessionId });
        if (!isPrimaryRole(described.role) || !Array.isArray(described.lineage) || described.role.current.controllerId !== host.installationId
          || described.lineage.length !== described.role.revision || !described.lineage.every(isNativeSessionRef)
          || nativeSessionRefKey(described.lineage[0]!) !== nativeSessionRefKey(described.role.origin)
          || nativeSessionRefKey(described.lineage.at(-1)!) !== nativeSessionRefKey(described.role.current)
          || !described.lineage[(input.expectedRevision as number) - 1]
          || nativeSessionRefKey(described.lineage[(input.expectedRevision as number) - 1]!) !== nativeSessionRefKey(source)
          || action === 'prepare' && described.role.revision !== input.expectedRevision) throw new BrokerError(409, 'invalid_host_response', 'The selected primary role revision could not be verified.');
        frozen = await commit(draft => {
          const state = structuredClone(associations);
          assertHostCurrent(host, generation);
          const duplicate = state.freezes.find(item => item.hostId === host.id && item.receipt.request.operationId === operationId);
          if (duplicate) { assertSameRequest(duplicate.receipt); return { value: duplicate, unchanged: true, publish() {} }; }
          if (state.freezes.filter(item => item.receipt.request.roleId === described.role.id).length >= 512) throw new BrokerError(409, 'succession_role_capacity', 'Succession role history is full; reconcile existing operations.');
          for (const ref of described.lineage as NativeSessionRef[]) assertAssociationOpen(ref);
          if (action === 'cancel') {
            // A new v1 receipt cannot prepare a native candidate; retain it before asking the Host to cancel.
            const receipt: SuccessionAssociationFreeze = { version: 1, token: randomUUID(), authority: options.successionEnrollment!, controllerId: host.installationId,
              request: { operationId, roleId: described.role.id, expectedRevision: input.expectedRevision as number, from: source, ...(targetProviderId ? { targetProviderId } : {}) },
              associationRevision: state.revision, lineage: described.lineage, relations: [] };
            if (state.revision >= Number.MAX_SAFE_INTEGER) throw new BrokerError(409, 'association_capacity', 'Association revision is exhausted.');
            state.revision++;
            const result = { hostId: host.id, receipt, cancelOnly: true as const }; state.freezes.push(result);
            assertAssociationCapacity(state); draft.associations = state;
            return { value: result, publish() { associations = state; } };
          }
          if (state.admissions.some(admission => described.lineage.some((ref: NativeSessionRef) => nativeSessionRefKey(ref) === nativeSessionRefKey(admission.source)))) throw new BrokerError(409, 'association_outcome_unknown', 'Settle source creation before succession.');
          const proposal: Omit<BoundedSuccessionAssociationFreeze, 'maxProjectionBytes'> = { version: 2, token: randomUUID(), authority: options.successionEnrollment!, controllerId: host.installationId,
            request: { operationId, roleId: described.role.id, expectedRevision: input.expectedRevision as number, from: source, ...(targetProviderId ? { targetProviderId } : {}) },
            associationRevision: state.revision, lineage: described.lineage,
            relations: [...bindings.values()].filter(binding => binding.hostId === host.id && binding.sourceRelation).map(binding => ({
              relationId: binding.sourceRelation!.id, kind: binding.sourceRelation!.kind, readerRef: associationSource(host, binding.providerId, binding.nativeSessionId),
              sourceRef: binding.sourceRelation!.nativeSourceRef ?? associationSource(host, binding.providerId, binding.sourceRelation!.sourceNativeSessionId), linked: binding.sourceRelation!.linked ?? true, revision: binding.sourceRelation!.revision ?? 0,
            })) };
          if (state.revision >= Number.MAX_SAFE_INTEGER) throw new BrokerError(409, 'association_capacity', 'Association revision is exhausted.');
          state.revision++;
          draft.associations = state;
          let maxProjectionBytes: number;
          try { maxProjectionBytes = options.successionProjectionAllowance!({ hostId: host.id, broker: structuredClone(draft), freeze: structuredClone(proposal) }); }
          catch (error) { if (isSuccessionCapacityError(error)) throw new BrokerError(error.status, error.code, error.message); failClosed(); throw error; }
          if (!Number.isSafeInteger(maxProjectionBytes) || maxProjectionBytes < 1 || maxProjectionBytes > SUCCESSION_FEATURE_BYTES) throw new BrokerError(409, 'succession_projection_capacity_exceeded', 'No valid committed projection allowance is available.');
          const receipt: SuccessionAssociationFreeze = { ...proposal, version: 2, maxProjectionBytes };
          const result = { hostId: host.id, receipt }; state.freezes.push(result);
          if (!validBrokerAssociations(state)) throw new BrokerError(409, 'association_capacity', 'Association storage is full or invalid.');
          retainedIdentities(state);
          return { value: result, publish() { associations = state; } };
        }, true);
      }
    }
    if (frozen?.receipt.version === 2 && host.successionEnrollmentVersion !== 2) throw new BrokerError(409, 'succession_enrollment_unavailable', 'Saved bounded succession requires negotiated v2 recovery.');
    if (!frozen) throw new BrokerError(404, 'succession_not_found', 'No frozen succession operation exists.');
    if (successionAuthorityKey(frozen.receipt.authority) !== successionAuthorityKey(options.successionEnrollment!)) throw new BrokerError(409, 'succession_authority_changed', 'The frozen authority requires reconciliation.');
    const receipt = frozen.receipt;
    async function withContextStatus(result: SuccessionActionResult): Promise<SuccessionActionResult> {
      if (!input.includeContext || result.record.phase !== 'committed') return result;
      const current = await associationRpc(host, { action: 'status', freeze: receipt, includeContext: true });
      const observed = { ...result, ...(current.context === undefined ? {} : { context: current.context }) };
      if (!current.freeze || successionFreezeKey(current.freeze) !== successionFreezeKey(receipt)
        || !isDeepStrictEqual(current.record, result.record) || !isSuccessionActionResult(observed)) throw new BrokerError(502, 'invalid_host_response', 'The handoff context status could not be verified.');
      return observed;
    }
    if (frozen.released === 'committed' && frozen.projection && ['status', 'reconcile', 'commit'].includes(action)) {
      if (action !== 'status') await associationRpc(host, { action: 'release', freeze: frozen.receipt });
      const result = { record: structuredClone(frozen.projection.receipt), role: structuredClone(frozen.projection.role), locator: { hostId: host.id, providerId: frozen.projection.role.current.providerId, nativeSessionId: frozen.projection.role.current.nativeSessionId } };
      return withContextStatus(result);
    }
    const result = await associationRpc(host, { action, freeze: frozen.receipt });
    if (!isSuccessionRecord(result.record) || !isPrimaryRole(result.role) || !result.freeze || successionFreezeKey(result.freeze) !== successionFreezeKey(frozen.receipt)
      || result.record.operationId !== operationId || result.record.roleId !== frozen.receipt.request.roleId) throw new BrokerError(502, 'invalid_host_response', 'The saved succession receipt could not be verified.');
    if (['committed', 'rejected', 'cancelled'].includes(result.record.phase)) {
      const confirmed = await associationRpc(host, { action: 'status', freeze: frozen.receipt });
      if (!isDeepStrictEqual(confirmed, result)) throw new BrokerError(409, 'succession_decision_changed', 'Read back the durable succession decision before releasing associations.');
      await associationChange(state => {
        assertHostCurrent(host, generation);
        const item = state.freezes.find(item => item.receipt.token === frozen!.receipt.token)!;
        if (item.released) {
          if (item.released !== result.record.phase || item.projection && !isDeepStrictEqual(item.projection, { version: 1, role: result.role, receipt: result.record })) throw new BrokerError(409, 'succession_decision_changed', 'The released succession decision changed.');
          return;
        }
        item.released = result.record.phase;
        if (result.record.phase === 'committed') item.projection = { version: 1, role: result.role as PrimaryRole, receipt: result.record as SuccessionRecord };
      });
    }
    if (['committed', 'rejected', 'cancelled'].includes(result.record.phase)) await associationRpc(host, { action: 'release', freeze: frozen.receipt });
    return withContextStatus({ record: result.record, role: result.role, locator: { hostId: host.id, providerId: result.role.current.providerId, nativeSessionId: result.role.current.nativeSessionId } });
  }
  function relationAccess(subject: string, reservation: RelationChangeReservation) {
    requireOwner(subject);
    const host = requireHost(reservation.hostId);
    if (host.installationId !== reservation.controllerId || !options.successionEnrollment || successionAuthorityKey(options.successionEnrollment) !== successionAuthorityKey(reservation.authority)) throw new SharingError(403, 'session_forbidden', 'Relation authority is unavailable.');
    const binding = nativeBindings.get(JSON.stringify([host.id, reservation.readerRef.providerId, reservation.readerRef.nativeSessionId]));
    const source = nativeBindings.get(JSON.stringify([host.id, reservation.sourceRef.providerId, reservation.sourceRef.nativeSessionId]));
    if (!binding || !source || !sessionAllowed(binding, subject) || !sessionAllowed(source, subject) || !hostAllowed(host.id, subject) || !host.providers.some(row => row.providerId === reservation.current.providerId)) throw new SharingError(403, 'session_forbidden', 'Session access is unavailable.');
    const relation = binding.sourceRelation;
    const nativeSource = relation?.nativeSourceRef ?? associationSource(host, binding.providerId, relation?.sourceNativeSessionId ?? '');
    if (!relation || relation.id !== reservation.relationId || relation.kind !== reservation.kind || nativeSessionRefKey(nativeSource) !== nativeSessionRefKey(reservation.sourceRef)) throw new SharingError(409, 'relation_conflict', 'The immutable source relationship changed.');
    return { host, binding, relation };
  }
  function savedRelationOperation(subject: string, selection: { hostId: string; operationId: string }) {
    const saved = associations.relationChanges.find(row => row.reservation.hostId === selection.hostId && row.reservation.operationId === selection.operationId);
    if (!saved) throw new SharingError(404, 'relation_change_not_found', 'No pending relationship operation exists.');
    relationAccess(subject, saved.reservation); return saved;
  }
  async function relationHostStatus(host: Host, saved: BrokerRelationChange): Promise<RelationChangeReceipt | undefined> {
    const result = await associationRpc(host, { action: 'relation_status', reservation: saved.reservation });
    if (result.receipt === null) return undefined;
    if (!isRelationChangeReceipt(result.receipt) || relationChangeKey(result.receipt.reservation) !== relationChangeKey(saved.reservation)
      || saved.hostReceipt && ({ reserved: 0, applied: 1, released: 2 })[result.receipt.phase] < ({ reserved: 0, applied: 1, released: 2 })[saved.hostReceipt.phase]) throw new BrokerError(502, 'invalid_host_response', 'Exact relation receipt could not be verified.');
    const expectedRevision = saved.reservation.associationRevision + (result.receipt.phase === 'reserved' ? 0 : Number(saved.reservation.previousMember !== saved.reservation.linked));
    if (result.receipt.associationRevision !== expectedRevision) throw new BrokerError(409, 'relation_receipt_conflict', 'Host relation receipt revision changed.');
    return result.receipt;
  }
  const relationContinuations = new Map<string, Promise<{ operation: BrokerRelationChange }>>();
  function continueRelationChange(subject: string, initial: BrokerRelationChange): Promise<{ operation: BrokerRelationChange }> {
    const key = initial.reservation.operationId, existing = relationContinuations.get(key);
    if (existing) return existing;
    const running = (async () => {
      let saved = savedRelationOperation(subject, initial.reservation), reservation = saved.reservation;
      const { host, binding } = relationAccess(subject, reservation), generation = host.generation;
      const access = () => {
        assertHostCurrent(host, generation); assertAssociationCapacity(associations);
        const current = relationAccess(subject, reservation);
        if (current.binding !== binding) throw new SharingError(403, 'session_forbidden', 'Session access changed.');
        return current;
      };
      if (saved.phase === 'committed') return { operation: structuredClone(saved) };
      let receipt = await relationHostStatus(access().host, saved);
      if (!receipt) {
        if (saved.phase !== 'reserved') throw new BrokerError(409, 'relation_host_outcome_unknown', 'Committed metadata requires its durable Host reservation.');
        await associationRpc(access().host, { action: 'relation_reserve', reservation });
        receipt = await relationHostStatus(access().host, saved);
        if (!receipt) throw new BrokerError(409, 'relation_host_outcome_unknown', 'Host reservation remains unknown.');
      }
      if (saved.phase === 'reserved') {
        if (receipt.phase !== 'reserved' || receipt.associationRevision !== reservation.associationRevision) throw new BrokerError(409, 'relation_receipt_conflict', 'Host reservation outcome changed.');
        await commit(draft => {
          const { binding, relation } = access();
          const next = structuredClone(associations), operation = next.relationChanges.find(row => row.reservation.operationId === key)!;
          if (operation.phase !== 'reserved' || relation.revision !== undefined && relation.revision !== reservation.expectedRelationRevision || (relation.linked ?? true) !== reservation.previousLinked) throw new SharingError(409, 'relation_conflict', 'Relationship revision changed.');
          const changed = { ...relation, nativeSourceRef: reservation.sourceRef, linked: reservation.linked, revision: reservation.expectedRelationRevision + 1 };
          operation.phase = 'metadata_committed'; operation.hostReceipt = receipt; next.revision++;
          assertAssociationCapacity(next);
          draft.associations = next; draft.bindings.find(row => row.agentId === binding.agentId)!.sourceRelation = changed;
          return { value: undefined, publish() { associations = next; binding.sourceRelation = changed; } };
        });
        saved = savedRelationOperation(subject, reservation);
      }
      if (receipt.phase === 'reserved') {
        await associationRpc(access().host, { action: 'relation_apply', reservation });
        receipt = await relationHostStatus(access().host, saved);
      }
      const expectedAssociationRevision = reservation.associationRevision + Number(reservation.previousMember !== reservation.linked);
      if (!receipt || receipt.phase === 'reserved' || receipt.associationRevision !== expectedAssociationRevision) throw new BrokerError(409, 'relation_host_outcome_unknown', 'Applied relation overlay could not be verified.');
      await associationChange(state => {
        const { relation } = access();
        if ((relation.revision ?? 0) !== reservation.expectedRelationRevision + 1 || (relation.linked ?? true) !== reservation.linked) throw new SharingError(409, 'relation_conflict', 'Committed relationship metadata changed.');
        const operation = state.relationChanges.find(row => row.reservation.operationId === key)!;
        if (operation.phase === 'metadata_committed') { operation.phase = 'overlay_applied'; operation.hostReceipt = receipt; }
      });
      saved = savedRelationOperation(subject, reservation);
      if (receipt.phase !== 'released') {
        await associationRpc(access().host, { action: 'relation_release', reservation, associationRevision: receipt.associationRevision });
        receipt = await relationHostStatus(access().host, saved);
      }
      if (!receipt || receipt.phase !== 'released' || receipt.associationRevision !== expectedAssociationRevision) throw new BrokerError(409, 'relation_host_outcome_unknown', 'Released relation overlay could not be verified.');
      await associationChange(state => { access(); const operation = state.relationChanges.find(row => row.reservation.operationId === key)!; operation.phase = 'committed'; operation.hostReceipt = receipt; });
      return { operation: structuredClone(savedRelationOperation(subject, reservation)) };
    })();
    relationContinuations.set(key, running); void running.finally(() => relationContinuations.delete(key)).catch(() => undefined); return running;
  }
  function relationIntent(subject: string, input: import('./session-relations.js').SessionRelationUpdate): RelationChangeReset['intent'] {
    requireOwner(subject);
    if (!input.operationId || input.expectedRoleRevision === undefined) throw new SharingError(409, 'relation_operation_required', 'Retain an operation identity and current role revision for this edit.');
    const host = requireHost(input.hostId);
    const binding = nativeBindings.get(JSON.stringify([host.id, input.providerId, input.nativeSessionId]));
    const relation = binding?.sourceRelation;
    if (!relation || relation.kind !== 'side' || relation.id !== input.id || relation.sourceNativeSessionId !== input.sourceNativeSessionId) throw new SharingError(409, 'relation_conflict', 'The immutable source relationship changed.');
    const sourceRef = relation.nativeSourceRef ?? associationSource(host, binding!.providerId, relation.sourceNativeSessionId);
    const source = nativeBindings.get(JSON.stringify([host.id, sourceRef.providerId, sourceRef.nativeSessionId]));
    if (!options.successionEnrollment || !binding || !source || !sessionAllowed(binding, subject) || !sessionAllowed(source, subject)
      || !hostAllowed(host.id, subject) || !host.providers.some(row => row.providerId === binding.providerId)) throw new SharingError(403, 'session_forbidden', 'Relation authority is unavailable.');
    return { version: 1, operationId: input.operationId, authority: options.successionEnrollment, hostId: host.id, controllerId: host.installationId,
      readerRef: associationSource(host,binding.providerId,binding.nativeSessionId), sourceRef, relationId: relation.id, linked: input.linked,
      expectedRelationRevision: input.expectedRevision, expectedRoleRevision: input.expectedRoleRevision };
  }
  function assertExactRelationIntent(intent: RelationChangeReset['intent'], reservation: RelationChangeReservation | RelationChangeReset['intent']) {
    const expected = { version: 1, operationId: reservation.operationId, authority: reservation.authority, hostId: reservation.hostId, controllerId: reservation.controllerId,
      readerRef: reservation.readerRef, sourceRef: reservation.sourceRef, relationId: reservation.relationId, linked: reservation.linked,
      expectedRelationRevision: reservation.expectedRelationRevision, expectedRoleRevision: reservation.expectedRoleRevision };
    if (!isDeepStrictEqual(intent, expected)) throw new SharingError(409, 'relation_identity_conflict', 'Relationship operation identity changed.');
  }
  function assertRelationNotReset(state: BrokerAssociationState, intent: RelationChangeReset['intent']) {
    const reset = state.relationResets.find(row => row.intent.operationId === intent.operationId);
    if (reset) { assertExactRelationIntent(intent, reset.intent); throw new SharingError(409, 'relation_change_reset', 'This exact relationship edit was safely reset before any effect.'); }
  }
  async function reserveRelationUpdate(subject: string, input: import('./session-relations.js').SessionRelationUpdate, host: Host, projection: PrimaryRole) {
    requireOwner(subject);
    const generation = host.generation; assertHostCurrent(host);
    if (!input.operationId || input.expectedRoleRevision === undefined) throw new SharingError(409, 'relation_operation_required', 'Retain an operation identity and current role revision for this edit.');
    const intent = relationIntent(subject,input);
    assertRelationNotReset(associations,intent);
    const previous = associations.relationChanges.find(row => row.reservation.operationId === input.operationId);
    const sameIntent = (saved: BrokerRelationChange) => assertExactRelationIntent(intent,saved.reservation);
    if (previous) { sameIntent(previous); relationAccess(subject, previous.reservation); return continueRelationChange(subject, previous); }
    const catalogGeneration = associations.revision;
    const described = await associationRpc(host, { action: 'describe', providerId: projection.current.providerId, nativeSessionId: projection.current.nativeSessionId });
    if (described.relationUpdates !== 1) throw new BrokerError(409, 'succession_relationship_updates_unavailable', 'Trusted relationship updates were not negotiated.');
    if (!isPrimaryRole(described.role) || described.role.id !== projection.id || described.role.revision !== input.expectedRoleRevision || nativeSessionRefKey(described.role.current) !== nativeSessionRefKey(projection.current) || !Number.isSafeInteger(described.associationRevision) || !Array.isArray(described.sourceParticipants)) throw new BrokerError(409, 'invalid_host_response', 'Current relation role could not be verified.');
    const saved = await associationChange(state => {
      assertHostCurrent(host, generation);
      const duplicate = state.relationChanges.find(row => row.reservation.operationId === input.operationId); if (duplicate) { sameIntent(duplicate); return duplicate; }
      assertRelationNotReset(state,relationIntent(subject,input));
      if (state.revision !== catalogGeneration) throw new SharingError(409, 'relation_catalog_changed', 'Source relationship catalog changed during Host description. Retry before reserving.');
      if (state.relationChanges.length >= 1024) throw new BrokerError(409, 'association_capacity', 'Relation operation capacity is exhausted.');
      for (const ref of described.lineage as NativeSessionRef[]) assertAssociationOpen(ref);
      if (state.admissions.some(row => described.lineage.some((ref: NativeSessionRef) => nativeSessionRefKey(ref) === nativeSessionRefKey(row.source)))) throw new SharingError(409, 'association_outcome_unknown', 'Settle source creation before editing relationships.');
      const binding = nativeBindings.get(JSON.stringify([host.id,input.providerId,input.nativeSessionId])), relation = binding?.sourceRelation;
      if (!relation || relation.id !== input.id || relation.kind !== 'side' || relation.sourceNativeSessionId !== input.sourceNativeSessionId || (relation.revision ?? 0) !== input.expectedRevision) throw new SharingError(409, 'relation_conflict', 'This side relationship changed.');
      const sourceRef = relation.nativeSourceRef ?? associationSource(host, binding!.providerId, relation.sourceNativeSessionId);
      const reservation: RelationChangeReservation = { version:1,operationId:input.operationId!,token:randomUUID(),authority:options.successionEnrollment!,hostId:host.id,controllerId:host.installationId,roleId:described.role.id,expectedRoleRevision:described.role.revision,origin:described.role.origin,current:described.role.current,lineage:described.lineage,associationRevision:described.associationRevision,catalogRevision:state.revision,
        relationId:relation.id,kind:relation.kind,readerRef:associationSource(host,binding!.providerId,binding!.nativeSessionId),sourceRef,expectedRelationRevision:input.expectedRevision,previousLinked:relation.linked??true,linked:input.linked,previousMember:described.sourceParticipants.some((row:{readerRef:NativeSessionRef})=>nativeSessionRefKey(row.readerRef)===nativeSessionRefKey(associationSource(host,binding!.providerId,binding!.nativeSessionId))),
        relations:[...bindings.values()].filter(row=>row.hostId===host.id&&row.sourceRelation).map(row=>({relationId:row.sourceRelation!.id,kind:row.sourceRelation!.kind,readerRef:associationSource(host,row.providerId,row.nativeSessionId),sourceRef:row.sourceRelation!.nativeSourceRef??associationSource(host,row.providerId,row.sourceRelation!.sourceNativeSessionId),linked:row.sourceRelation!.linked??true,revision:row.sourceRelation!.revision??0})) };
      relationAccess(subject,reservation);
      const operation: BrokerRelationChange={reservation,phase:'reserved'};state.relationChanges.push(operation);return operation;
    }, true);
    return continueRelationChange(subject,saved);
  }

  function changeSharing<T>(change: (draft: HostSharing) => T): Promise<T> {
    return commit(state => {
      const draft = new HostSharing(state.sharing, () => {});
      const value = change(draft); state.sharing = draft.snapshot();
      return { value, publish() { sharing = draft; } };
    });
  }
  const sharedCreates = new Map<string, { fingerprint: string; result: Promise<Binding> }>();
  const principal = (context: BrokerRequestContext) => context.principalSubject?.();
  const owner = (subject?: string) => options.ownerSubject === undefined || subject === options.ownerSubject;
  const hostAllowed = (hostId: string, subject?: string) => !unavailable && hosts.has(hostId) && (owner(subject) || (subject !== undefined && sharing.allowed(hostId, subject)));
  const sessionAllowed = (binding: Binding, subject?: string) => bindings.get(binding.agentId) === binding && hostAllowed(binding.hostId, subject) && (owner(subject) || binding.creatorSubject === subject);
  function requireOwner(subject?: string) {
    if (!owner(subject)) throw new SharingError(403, 'owner_required', 'Only the Host owner can manage this Host.');
  }
  function requireAccess(hostId: string, subject?: string) {
    if (!hosts.has(hostId)) throw new SharingError(404, 'host_not_found', 'Host is unavailable.');
    if (!hostAllowed(hostId, subject)) throw new SharingError(403, 'host_forbidden', 'Host access is unavailable.');
  }
  function visibleHosts(subject?: string) {
    return [...hosts.values()].filter(host => hostAllowed(host.id, subject)).map(({ id, name, providers, legacyDsh, socket, ready, credentialRotation, environment, controller, providerManagement, tpmManagement, teamManagement }) => ({
      ...(teamManagement ? { teamManagement } : {}),
      ...(tpmManagement ? { tpmManagement } : {}),
      ...(providerManagement ? { providerManagement } : {}),
      ...(controller ? { controller } : {}),
      ...(environment ? { environment } : {}),
      ...(credentialRotation ? {credentialRotation:true} : {}), id, name, online: ready === true && socket?.readyState === RELAY_SOCKET_OPEN, providers,
      ...(accountBacked && owner(subject) ? { managed: true } : {}),
      ...(options.ownerSubject ? { access: owner(subject) ? 'owner' as const : 'shared' as const } : {}),
      ...(!owner(subject) && subject ? { sessionQuota: sharing.quota(id, subject) } : {}),
      ...(legacyDsh ? { providerId: 'dsh' } : providers.length === 1 ? { providerId: providers[0]!.providerId } : {}),
    }));
  }

  const permitted = async (context: BrokerRequestContext) => !context.authorize || await context.authorize() === true;
  const expiryChecks = new Set<() => void>();
  function expire(client: RelaySocket, expiry: () => number | undefined, code: () => number = () => 1008, close = (code: number) => client.close(code, 'Credential expired')) {
    let timer: unknown;
    let active = true;
    const check = () => {
      if (!active) return;
      clearTimeout(timer);
      const expiresAt = expiry();
      if (expiresAt === undefined) return;
      if (expiresAt <= now()) { cleanup(); close(code()); return; }
      timer = setTimeout(check, Math.min(60_000, expiresAt - now()));
    };
    const cleanup = () => { active = false; clearTimeout(timer); expiryChecks.delete(check); };
    expiryChecks.add(check); client.onClose(cleanup); check();
    return cleanup;
  }
  const keyHash = (key: string) => createHash('sha256').update(key).digest('hex');
  const requireHost = (id: string) => {
    const host = hosts.get(id);
    if (!host) throw new BrokerError(404, 'host_not_found', 'The Remote Host is unknown.');
    assertAvailable();
    if (!host.ready || host.socket?.readyState !== RELAY_SOCKET_OPEN) throw new BrokerError(503, 'host_offline', 'The Remote Host is offline.', true);
    return host;
  };
  function send(host: Host, message: RemoteHostUplinkMessage) {
    assertHostCurrent(host);
    if (host.socket?.readyState !== RELAY_SOCKET_OPEN) throw new BrokerError(503, 'host_offline', 'The Remote Host is offline.', true);
    if (host.socket.bufferedAmount !== undefined && host.socket.bufferedAmount > BROKER_MAX_FRAME_BYTES) throw new BrokerError(503, 'host_backpressure', 'The Remote Host connection is busy.', true);
    host.socket.send(JSON.stringify(message));
  }
  function diagnostic(host: Host, details: Omit<RelayDiagnostic, 'id' | 'timestamp' | 'source' | 'hostId' | 'relayInstanceId'>) {
    options.diagnostics?.record(host.id, { ...details, connectionId: host.connectionId });
  }
  function rpc(host: Host, method: 'GET' | 'POST', path: string, sessionId?: string, body?: string, diagnosticRequest = false): Promise<RpcResponse> {
    assertHostCurrent(host);
    const generation = host.generation;
    if (host.pending.size >= 128) return Promise.reject(new BrokerError(429, 'host_busy', 'Too many pending Remote Host requests.', true));
    const requestId = randomUUID(), startedAt = now();
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        host.pending.delete(requestId);
        if (!diagnosticRequest) diagnostic(host, {event:'rpc_timeout', requestId, operation: diagnosticOperation(path), durationMs: Math.max(0, now()-startedAt)});
        try { send(host, { uplinkVersion: 2, type: 'rpc_cancel', requestId }); } catch { /* An offline host has no request to cancel. */ }
        const attach = path === '/remote/attach' || path === '/remote/child/attach';
        reject(new BrokerError(504, attach ? 'session_attach_timeout' : method === 'GET' ? 'host_read_timeout' : 'host_timeout', attach
          ? 'The Host did not confirm opening the session before the Relay deadline. It may still be opening; wait briefly and reopen the same session.'
          : method === 'GET' ? 'The Host did not return the requested data before the Relay deadline. Try reading it again.'
          : 'The Host did not confirm the operation before the Relay deadline. Its outcome is unknown; check the session before retrying.', false, requestId));
      }, diagnosticRequest ? 5000 : options.rpcTimeoutMs ?? (path === '/remote/provider-settings' ? 45000 : 30000));
      host.pending.set(requestId, { resolve(value) {
        try { assertHostCurrent(host, generation); resolve(value); } catch (error) { reject(error as Error); }
      }, reject, timer, method, path, diagnostic: diagnosticRequest, startedAt });
      try { send(host, { uplinkVersion: 2, type: 'rpc_request', requestId, method, path, ...(sessionId ? { sessionId } : {}), ...(body === undefined ? {} : { body }) }); }
      catch (error) { clearTimeout(timer); host.pending.delete(requestId); if (!diagnosticRequest) diagnostic(host, {event:'rpc_failed',requestId,operation:diagnosticOperation(path),reason:error instanceof BrokerError && error.code==='host_backpressure'?'host_backpressure':'write_failed'}); reject(error); }
    });
  }
  function disconnected(host: Host, socket: RelaySocket, reason: RelayDiagnostic['reason'] = 'socket_closed', closeCode?: number, heartbeatAgeMs?: number, wasClean?: boolean) {
    uplinkCleanups.get(socket)?.();
    if (host.socket !== socket) return;
    host.stopDiagnostics?.(); host.stopDiagnostics=undefined;
    diagnostic(host, {event:'host_disconnected',reason,closeCode,heartbeatAgeMs,wasClean,pendingRequests:[...host.pending.values()].filter(p=>!p.diagnostic).length,streams:host.streams.size});
    previews.disconnect(host.id); host.tunnelToken = undefined;
    host.socket = undefined; host.ready = false;
    for (const [requestId, pending] of host.pending) {
      clearTimeout(pending.timer);
      const attach = pending.path === '/remote/attach' || pending.path === '/remote/child/attach';
      pending.reject(new BrokerError(503, 'host_offline', attach
        ? 'The Host disconnected while opening the session. Wait for it to reconnect, then reopen the same session.'
        : pending.method === 'GET' ? 'The Host disconnected while reading data. Wait for it to reconnect and try again.'
        : 'The Host disconnected before confirming the operation. Its outcome is unknown; check the session before retrying.', false, requestId));
    }
    host.pending.clear();
    for (const stream of host.streams.values()) {
      clearTimeout(stream.timer);
      stream.socket.close(reason === 'access_revoked' ? 1008 : 1012, reason === 'access_revoked' ? 'Host access revoked' : 'Remote Host disconnected');
    }
    host.streams.clear();
  }
  function register(socket: RelaySocket, credential: DeviceCredential, context: BrokerRequestContext, credentialHash: string, enrollmentRequested?: 1 | 2, teamRequested = false, resourcesRequested = false) {
    let host: Host | undefined;
    let pendingCredential: {hash: string; value: DeviceCredential} | undefined;
    let issuing: Promise<void> | undefined;
    let retired = false, heartbeatStarted = false;
    let timer: unknown, heartbeatTimer: unknown, heartbeatDeadline: unknown;
    let pendingNonce: string | undefined;
    let lastHeartbeatAck = now();
    let cancelExpiry = () => {};
    function cleanup() {
      retired = true;
      clearTimeout(timer); clearTimeout(heartbeatTimer); clearTimeout(heartbeatDeadline);
      pendingNonce = undefined; cancelExpiry(); uplinkCleanups.delete(socket);
    }
    function closeConnection(code: number, reason: string) {
      if (retired) return;
      cleanup(); if (host) disconnected(host, socket, diagnosticCloseReason(reason), code, Math.max(0,now()-lastHeartbeatAck));
      socket.close(code, reason);
    }
    uplinkCleanups.set(socket, cleanup);
    cancelExpiry = expire(socket, () => keys.get(credentialHash) === credential ? Math.min(credential.expires, context.connectionExpiresAt?.() ?? credential.expires) : 0, () => keys.get(credentialHash) !== credential ? 1008 : context.connectionExpiryCode?.() ?? 1008, code => closeConnection(code, 'Credential expired'));
    if (!retired) timer = setTimeout(() => closeConnection(1008, 'Registration deadline exceeded'), 10_000);
    socket.onError(() => closeConnection(1011, 'Host transport failed'));
    socket.onClose(details => { cleanup(); if (host) disconnected(host, socket, 'socket_closed', details?.code, Math.max(0, now() - lastHeartbeatAck), details?.wasClean); });
    const current = () => !retired && host?.socket === socket && host.ready === true;
    function sendHeartbeat() {
      if (!current()) return;
      const nonce = randomUUID(); pendingNonce = nonce;
      heartbeatDeadline = setTimeout(() => {
        if (current() && pendingNonce === nonce) closeConnection(1012, 'Host heartbeat timed out');
      }, heartbeat.timeoutMs);
      heartbeatTimer = setTimeout(sendHeartbeat, heartbeat.intervalMs);
      try { send(host!, { uplinkVersion: 2, type: 'heartbeat', nonce }); }
      catch { closeConnection(1012, 'Host heartbeat delivery failed'); }
    }
    function registered() {
      if (retired || !host || host.socket !== socket) return;
      host.tunnelToken ??= randomBytes(32).toString('base64url');
      send(host, { uplinkVersion: 2, type: 'registered', ...(host.teamManagement && resourcesRequested && options.teamResources ? {teamResources:true} : {}), ...(host.teamManagement ? {teamManagement: true} : {}), hostId: host.id, ...(host.successionEnrollmentVersion && options.successionEnrollment ? { successionEnrollment: options.successionEnrollment, ...(host.successionEnrollmentVersion === 2 ? { successionEnrollmentVersion: 2 as const } : {}) } : {}), pairingPurpose: host.pairingPurpose ?? (host.gatewayKeyRequested ? 'gateway-setup' : 'host-only'), heartbeat, tunnelToken: host.tunnelToken });
      if (retired || host.socket !== socket) return;
      host.ready = true;
      if (!heartbeatStarted) {
        heartbeatStarted = true; lastHeartbeatAck = now(); heartbeatTimer = setTimeout(sendHeartbeat, heartbeat.intervalMs);
        diagnostic(host, {event:'host_registered'});
        const connectedHost = host;
        let diagnosticVersion: number | undefined;
        const canDeliverDiagnostics = () => !retired && connectedHost.socket === socket && connectedHost.pending.size <= 16
          && (socket.bufferedAmount === undefined || socket.bufferedAmount === 0);
        host.stopDiagnostics = options.diagnostics?.connect(host.id, async entries => {
          if (!canDeliverDiagnostics()) return {status:503};
          if (diagnosticVersion === undefined) {
            const result = await rpc(connectedHost, 'GET', '/remote/controller-update', undefined, undefined, true);
            // Diagnostics can remain available when the independent updater status fails.
            try { const version = JSON.parse(result.body).diagnosticDelivery; if (Number.isSafeInteger(version) && version >= 1) diagnosticVersion = version; } catch { /* No capability advertised. */ }
            if (diagnosticVersion === undefined) {
              if (result.status === 404 || result.status === 200) diagnosticVersion = 0;
              else return result;
            }
          }
          if (!diagnosticVersion) return {status:404};
          if (!canDeliverDiagnostics()) return {status:503};
          const compatible = relayDiagnosticsForVersion(entries, diagnosticVersion);
          if (!compatible.length) return { status: 204 };
          return rpc(connectedHost, 'POST', RELAY_DIAGNOSTIC_PATH, undefined, JSON.stringify({ entries: compatible }), true);
        });
      }
    }
    let registration: Promise<void> | undefined;
    socket.onMessage((raw, binary) => {
      return receive(raw, binary).catch(() => closeConnection(1011, 'Host message could not be processed'));
    });
    async function receive(raw: string, binary: boolean) {
      if (registration) await registration;
      if (retired) return;
      try {
      assertAvailable();
      if (socket.readyState !== RELAY_SOCKET_OPEN || keys.get(credentialHash) !== credential) return closeConnection(1008, 'Device credential revoked');
      if (context.connectionExpiresAt && Math.min(credential.expires, context.connectionExpiresAt() ?? credential.expires) <= now()) return closeConnection(credential.expires <= now() ? 1008 : (context.connectionExpiryCode?.() ?? 1008), 'Credential expired');
      const decoded = binary ? undefined : decodeRemoteHostUplinkMessage(raw.toString());
      if (!decoded || decoded.status !== 'ok') return closeConnection(1008, 'Invalid uplink envelope');
      const message = decoded.value;
      if (!host) {
        if (message.type !== 'register' || credential.claimedAt !== undefined || credential.expires <= now() || (credential.installationId && credential.installationId !== message.installationId)) return closeConnection(1008, 'Registration is not authorized');
        const invitation = credential.requiresRotation === true || credential.installationId === undefined;
        if (credential.requiresRotation && !message.credentialRotation) return closeConnection(1008, 'Update Agent Host to enroll this device');
        registration = commit(draft => {
          if (keys.get(credentialHash) !== credential || credential.claimedAt !== undefined || credential.expires <= now() || (credential.installationId && credential.installationId !== message.installationId)) throw new BrokerError(401, 'device_revoked', 'Registration is not authorized');
          const savedCredential = draft.keys.find(([hash]) => hash === credentialHash)![1];
          savedCredential.installationId = message.installationId;
          if (accountBacked && invitation) savedCredential.claimedAt = now();
          if (accountBacked) {
            if (!savedCredential.requiresRotation) savedCredential.expires = Number.MAX_SAFE_INTEGER;
            // Reconnection proves possession of this key, not which overlapping recovery key was saved.
            const retainOverlap = credential.kind === 'device' && retainedRecoveryInstallations(draft).has(message.installationId);
            if (!retainOverlap) draft.keys = draft.keys.filter(([hash, key]) => hash === credentialHash || key.installationId !== message.installationId);
          }
          const existing = [...hosts.values()].find(value => value.installationId === message.installationId);
          const historical = [...retainedIdentities()].find(([, installationId]) => installationId === message.installationId);
          const recovery = credential.recovery;
          if (recovery) {
            const marker = revokedHosts?.find(item => item.hostId === recovery.hostId);
            if (existing || !marker || marker.installationId !== message.installationId || marker.revocationId !== recovery.revocationId
              || hosts.has(recovery.hostId)) throw new BrokerError(401, 'host_recovery_changed', 'This recovery invitation no longer authorizes the selected Host.');
          } else if (!existing && historical) throw new BrokerError(401, 'host_recovery_required', 'Create a recovery pairing for the retained Host identity.');
          if (!existing && hosts.size >= 128) throw new BrokerError(429, 'host_capacity', 'Host capacity reached');
          const purpose = existing
            ? existing.pairingPurpose ?? (existing.gatewayKeyRequested ? 'gateway-setup' : 'host-only')
            : credential.purpose ?? 'host-only';
          const providers = 'providers' in message ? [...message.providers] : [{ providerId: 'dsh', displayName: 'DeepSeek DSH' }];
          const next = { id: existing?.id ?? recovery?.hostId ?? randomUUID(), installationId: message.installationId, name: message.name, environment: message.environment, controller: message.controller, providerManagement: message.providerManagement, tpmManagement: message.tpmManagement, teamManagement: teamRequested ? true as const : undefined, pairingPurpose: purpose,
            ...(existing?.gatewayKeyRequested ? { gatewayKeyRequested: true } : {}),
            providers, legacyDsh: 'providerId' in message, ...(message.credentialRotation ? {credentialRotation:true} : {credentialRotation:undefined}) };
          draft.hosts = draft.hosts.filter(value => value.id !== next.id); draft.hosts.push(next);
          const pairing = draft.pairings?.find(value => value.id === credential.pairingId);
          if (pairing && pairing.usedAt === undefined) {
            pairing.usedAt = now(); pairing.hostId = next.id; pairing.hostName = next.name;
          }
          if (recovery) for (const item of draft.pairings ?? []) {
            if (item.recovery?.hostId === recovery.hostId && item.usedAt === undefined) item.revokedAt ??= now();
          }
          return { value: undefined, publish() {
            Object.assign(credential, savedCredential);
            pairings = draft.pairings ?? [];
            for (const hash of keys.keys()) if (!draft.keys.some(([saved]) => saved === hash)) keys.delete(hash);
            host = existing ?? { ...next, generation: 0, pending: new Map(), streams: new Map() };
            hosts.set(host.id, host);
            if (host.socket) { const previous = host.socket; disconnected(host, previous, 'connection_replaced', 1012); previous.close(1012, 'Host connection replaced'); }
            Object.assign(host, next); host.successionEnrollmentVersion = options.successionEnrollment ? enrollmentRequested : undefined; host.connectionId=randomUUID(); host.generation += 1; clearTimeout(timer);
            if (!retired && socket.readyState === RELAY_SOCKET_OPEN) {
              host.socket = socket;
              host.issueCredential = message.credentialRotation ? () => issueCredential(false, true) : undefined;
              if (!accountBacked || !message.credentialRotation || credential.kind === 'device') {
                registered();
              }
            }
          } };
        });
        try { await registration; } finally { registration = undefined; }
        if (accountBacked && message.credentialRotation && credential.kind !== 'device') await issueCredential(invitation);
        return;
      }
      if (host.socket !== socket) return;
      if (message.type === 'credential_saved') {
        if (!pendingCredential) return closeConnection(1008, 'No pending device credential');
        const pending = pendingCredential, currentHost = host, generation = host.generation;
        await commit(draft => {
          assertHostCurrent(currentHost, generation);
          if (retired || currentHost.socket !== socket || keys.get(credentialHash) !== credential || pendingCredential !== pending
            || !draft.keys.some(([hash, key]) => hash === pending.hash && isDeepStrictEqual(key, pending.value)
              && key.installationId === currentHost.installationId)) throw new BrokerError(401, 'device_revoked', 'Device credential is unavailable.');
          draft.keys = draft.keys.filter(([hash, value]) => value.installationId !== host!.installationId || hash === pending.hash);
          return {value:undefined,publish() {
            for (const [hash,value] of keys) if (value.installationId === host!.installationId && hash !== pending.hash) keys.delete(hash);
            credentialHash = pending.hash; credential = keys.get(pending.hash)!; pendingCredential = undefined;
          }};
        });
        registered();
      } else if (message.type === 'heartbeat_ack') {
        if (pendingNonce === message.nonce) { clearTimeout(heartbeatDeadline); pendingNonce = undefined; lastHeartbeatAck=now(); }
      } else if (message.type === 'team_request') {
        const current = host, generation = host.generation;
        void (async () => {
          let status = 200, body: string;
          try { assertHostCurrent(current, generation); body = JSON.stringify(await teams.hostCall(current.id, message.call, () => assertHostCurrent(current, generation))); }
          catch (error) { status = 409; body = JSON.stringify({ error: error instanceof Error ? error.message : 'Team request failed.' }); }
          if (current.socket === socket && current.generation === generation) send(current, { uplinkVersion: 2, type: 'team_response', requestId: message.requestId, status, body });
        })().catch(() => closeConnection(1011, 'Team response delivery failed'));
      } else if (message.type === 'rpc_response') {
        const pending = host.pending.get(message.requestId);
        if (pending) { clearTimeout(pending.timer); host.pending.delete(message.requestId); if (!pending.diagnostic && message.status>=400) diagnostic(host, {event:'rpc_failed',requestId:message.requestId,operation:diagnosticOperation(pending.path),status:message.status,durationMs:Math.max(0,now()-pending.startedAt)}); pending.resolve(message); }
      } else if (message.type === 'stream_opened') {
        const stream = host.streams.get(message.streamId);
        if (stream && stream.socket.readyState === RELAY_SOCKET_OPEN && stream.authorized?.() !== false) { clearTimeout(stream.timer); if(!stream.ready)diagnostic(host,{event:'stream_ready',streamId:message.streamId}); stream.ready = true; for (const buffered of stream.buffered) send(host, { uplinkVersion: 2, type: 'stream_message', streamId: message.streamId, message: buffered }); stream.buffered = []; }
      } else if (message.type === 'stream_message') {
        const stream = host.streams.get(message.streamId);
        if (stream?.socket.readyState === RELAY_SOCKET_OPEN && stream.authorized?.() !== false) {
          if (stream.socket.bufferedAmount !== undefined && stream.socket.bufferedAmount > BROKER_MAX_FRAME_BYTES) stream.socket.close(1013, 'Slow browser connection');
          else {
            try { stream.socket.send(sessionIdentityMessage(message.message, stream.runtimeAgentId, stream.publicAgentId, 'server')); }
            catch { stream.socket.close(1008, 'Invalid Remote Host session identity'); }
          }
        }
      } else if (message.type === 'stream_close') {
        const stream = host.streams.get(message.streamId); host.streams.delete(message.streamId); if(stream)diagnostic(host,{event:'stream_closed',streamId:message.streamId,closeCode:message.code}); stream?.socket.close(message.code, message.reason);
      } else if (message.type === 'provider_snapshot') {
        if (!host.providerManagement) return closeConnection(1008, 'Provider management was not advertised');
        const currentHost = host;
        await commit(draft => {
          if (currentHost.socket !== socket) throw new BrokerError(409, 'host_replaced', 'Host connection changed.');
          const saved = draft.hosts.find(value => value.id === currentHost.id);
          if (!saved) throw new BrokerError(404, 'host_unavailable', 'Host is unavailable.');
          saved.providers = [...message.providers];
          return { value: undefined, publish() { if (currentHost.socket === socket) currentHost.providers = [...message.providers]; } };
        });
      } else if (message.type === 'preview_snapshot') {
        await previews.update(host.id, message.snapshot);
      } else closeConnection(1008, 'Unexpected uplink message');
      } catch (error) {
        const code = error instanceof BrokerError && error.status === 401 ? 1008 : error instanceof BrokerError && error.status === 429 ? 1013 : 1011;
        closeConnection(code, code === 1011 ? 'Host message could not be processed' : (error as Error).message);
      }
    }
    async function issueCredential(consumeInvitation: boolean, preEffect = false): Promise<void> {
      if (issuing) return issuing;
      if (pendingCredential) throw new BrokerError(409, 'rotation_pending', 'A device credential is awaiting confirmation.');
      const value = `arc_device_${randomBytes(32).toString('base64url')}`;
      const nextHash = keyHash(value);
      const currentHost = host, generation = host?.generation;
      const operation = commit(draft => {
        if (!currentHost || retired || currentHost.socket !== socket || keys.get(credentialHash) !== credential) throw new BrokerError(401, 'device_revoked', 'Device is no longer connected.');
        assertHostCurrent(currentHost, generation);
        if (!consumeInvitation && retainedRecoveryInstallations(draft).has(currentHost.installationId)
          && draft.keys.filter(([, key]) => key.installationId === currentHost.installationId && key.kind === 'device').length > 1) {
          throw new BrokerError(409, 'rotation_pending', 'Retained recovery credentials require explicit reconciliation.');
        }
        if (draft.keys.length >= 128 && !consumeInvitation) throw new BrokerError(429, 'capacity_exceeded', 'Too many device credentials.');
        const next: DeviceCredential = {expires:Number.MAX_SAFE_INTEGER,installationId:currentHost.installationId,kind:'device'};
        if (consumeInvitation) draft.keys = draft.keys.filter(([hash]) => hash !== credentialHash);
        draft.keys.push([nextHash,next]);
        return {value:undefined,publish() {
          keys.set(nextHash,next); pendingCredential = {hash:nextHash,value:next};
          if (consumeInvitation) {keys.delete(credentialHash);credentialHash=nextHash;credential=next;}
        }};
      // A requested rotation has produced no new usable authorization before this commit.
      // Invitation consumption follows registration and retains terminal fail-closed handling.
      }, preEffect).then(() => {
        if (!currentHost || retired || currentHost.socket !== socket || pendingCredential?.hash !== nextHash || !keys.has(nextHash)) return;
        assertHostCurrent(currentHost, generation);
        send(currentHost, {uplinkVersion:2,type:'credential_issued',credential:value});
      });
      issuing=operation;
      try {await operation;} finally {issuing=undefined;}
    }
  }
  function runtimeAgentId(host: Host, binding: Binding): string {
    const runtime = runtimeBindings.get(binding.agentId);
    return runtime?.generation === host.generation ? runtime.agentId : binding.agentId;
  }
  function assertRuntimeIdentity(host: Host, binding: Pick<Binding, 'agentId' | 'providerId' | 'nativeSessionId'>, agentId: string): void {
    const occupied = bindings.get(agentId);
    if (occupied && !sameBinding(occupied, host.id, binding.providerId, binding.nativeSessionId)) {
      throw new BrokerError(409, 'session_binding_conflict', 'The Remote Host session identity belongs to another binding.');
    }
    for (const [publicId, runtime] of runtimeBindings) {
      const other = bindings.get(publicId);
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
  async function recoverBinding(host: Host, binding: Binding): Promise<void> {
    assertHostCurrent(host);
    if (bindings.get(binding.agentId) !== binding) throw new BrokerError(404, 'session_unavailable', 'The session binding was revoked.');
    if (binding.generation === host.generation) return;
    if (!binding.recovery) {
      const generation = host.generation;
      binding.recovery = (async () => {
        if (binding.parentNativeSessionId) {
          const parent = nativeBindings.get(JSON.stringify([host.id, binding.providerId, binding.parentNativeSessionId]));
          if (!parent) throw new BrokerError(409, 'parent_binding_missing', 'The native parent session must be attached before its child.');
          await recoverBinding(host, parent);
        }
        const path = binding.parentNativeSessionId ? '/remote/child/attach' : '/remote/attach';
        const body = host.legacyDsh ? { nativeSessionId: binding.nativeSessionId } : {
          providerId: binding.providerId, nativeSessionId: binding.nativeSessionId,
          ...(binding.parentNativeSessionId ? { parentNativeSessionId: binding.parentNativeSessionId } : {}),
        };
        const result = await rpc(host, 'POST', path, binding.agentId, JSON.stringify(body));
        assertHostCurrent(host, generation);
        if (bindings.get(binding.agentId) !== binding) throw new BrokerError(404, 'session_unavailable', 'The session binding was revoked.');
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
        await commit(() => {
          assertHostCurrent(host, generation);
          if (bindings.get(binding.agentId) !== binding) throw new BrokerError(404, 'session_unavailable', 'The session binding was revoked.');
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
    const durable = new Set(associations.admissions.map(row => row.id));
    let bindingClaims = durable.size, creationClaims = durable.size;
    for (const claim of pendingBindingSlots.values()) {
      if (claim.admissionId && durable.has(claim.admissionId)) continue;
      if (!claim.nativeKey || !nativeBindings.has(claim.nativeKey)) bindingClaims++;
      if (claim.creationKey && !completedCreations.has(claim.creationKey)) creationClaims++;
    }
    if (bindings.size + bindingClaims > 4096 || completedCreations.size + creationClaims > 4096) throw new BrokerError(429, 'capacity_exceeded', 'Session completion capacity is reserved by pending operations.', true);
    assertAssociationCapacity(associations);
  }
  async function mutate(host: Host, action: string, body: Record<string, unknown>, creatorSubject?: string, shared?: SharedCreation): Promise<Binding> {
    assertHostCurrent(host); const admittedGeneration = host.generation;
    const callerSubject = creatorSubject ?? options.ownerSubject;
    const providerId = host.legacyDsh ? 'dsh' : required(body.providerId, 'providerId');
    if (!host.providers.some((provider) => provider.providerId === providerId)) throw new BrokerError(400, 'invalid_provider', 'The selected provider is unavailable on this Host.');
    if (host.legacyDsh && action === 'create' && ['cwd', 'model', 'reasoningEffort', 'planning', 'creationSource', 'sourceNativeSessionId', 'editNativeSessionId', 'editTurnId', 'editMessageId'].some((key) => body[key] !== undefined)) {
      throw new BrokerError(400, 'unsupported_configuration', 'This Host uses native model settings and a registered workspace.');
    }
    if (host.legacyDsh && action === 'child/attach') throw new BrokerError(400, 'unsupported_operation', 'This Host does not support native child attachment.');
    const attaching = action !== 'create';
    const nativeSessionId = attaching ? required(body.nativeSessionId, 'nativeSessionId') : randomUUID();
    const parentNativeSessionId = action === 'child/attach' ? required(body.parentNativeSessionId, 'parentNativeSessionId') : undefined;
    if (parentNativeSessionId) creatorSubject ??= nativeBindings.get(JSON.stringify([host.id, providerId, parentNativeSessionId]))?.creatorSubject;
    const key = JSON.stringify([host.id, providerId, action === 'create' ? required(body.operationId, 'operationId') : nativeSessionId]);
    const source = action === 'create' && typeof body.sourceNativeSessionId === 'string' ? associationSource(host, providerId, body.sourceNativeSessionId) : undefined;
    const sourceBindingKey = action === 'create' && isCreationSource(body.creationSource) ? JSON.stringify([host.id, body.creationSource.providerId, body.creationSource.nativeSessionId]) : undefined;
    const sourceBinding = sourceBindingKey ? nativeBindings.get(sourceBindingKey) : undefined;
    const assertMutationAccess = () => {
      assertHostCurrent(host, admittedGeneration); requireAccess(host.id, callerSubject);
      if (sourceBindingKey && (!sourceBinding || nativeBindings.get(sourceBindingKey) !== sourceBinding || !sessionAllowed(sourceBinding, callerSubject))) throw new SharingError(403, 'session_forbidden', 'Source session access changed.');
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
      const existingBinding = attaching ? nativeBindings.get(key) : undefined;
      if (existingBinding && existingBinding.parentNativeSessionId !== parentNativeSessionId) {
        throw new BrokerError(409, 'session_binding_conflict', 'The native session parent conflicts with its existing binding.');
      }
      const slot = JSON.stringify([attaching ? 'attach' : 'create', key]);
      const claim = { ...(trackAssociation ? { admissionId } : {}), ...(attaching ? { nativeKey: key } : { creationKey: key }) };
      return (async () => {
        await commit(() => {
          assertMutationAccess();
          if (pendingBindingSlots.has(slot)) throw new BrokerError(409, 'request_conflict', 'This session has a different in-flight request.');
          pendingBindingSlots.set(slot, claim);
          try { assertSessionSlots(); } catch (error) { pendingBindingSlots.delete(slot); throw error; }
          return { value: undefined, unchanged: true, publish() {} };
        });
        const proposedAgentId = existingBinding?.agentId ?? randomUUID();
        const generation = host.generation;
        const request = host.legacyDsh
          ? { nativeSessionId, ...(body.workspaceId === undefined ? {} : { workspaceId: required(body.workspaceId, 'workspaceId') }) }
          : action === 'create'
            ? { providerId, operationId: required(body.operationId, 'operationId'),
                ...optionalSettings(body, ['cwd', 'workspaceId', 'model', 'reasoningEffort', 'planning', 'creationSource', 'sourceNativeSessionId', 'editNativeSessionId', 'editTurnId', 'editMessageId']) }
            : { providerId, nativeSessionId, ...(parentNativeSessionId ? { parentNativeSessionId } : {}), ...(body.takeOver === undefined ? {} : {takeOver: required(body.takeOver, 'takeOver')}) };
        if (source) assertAssociationCreationOpen(source);
        let recoverSource = false;
        if (trackAssociation || shared) await commit(draft => {
          assertMutationAccess();
          let nextSharing: HostSharing | undefined;
          if (shared) {
            if (trackAssociation && exactAdmission(associations) && shared.reservation.fresh) throw new BrokerError(409, 'creation_outcome_unknown', 'The saved source admission is missing its shared quota receipt.');
            nextSharing = new HostSharing(draft.sharing, () => {});
            const reservation = nextSharing.reserve(host.id, shared.subject, providerId, shared.operationId, shared.fingerprint);
            draft.sharing = nextSharing.snapshot(); exactSharedReceipt(draft);
            if (reservation.agentId !== undefined) throw new BrokerError(409, 'creation_outcome_unknown', 'A completed shared reservation requires its exact creation result.');
          }
          let next = associations;
          if (trackAssociation) {
            assertAssociationCreationOpen(source!);
            const previous = exactAdmission(associations);
            if (previous) recoverSource = true;
            else {
              if (shared && !shared.reservation.fresh) throw new BrokerError(409, 'creation_outcome_unknown', 'A previous shared creation has no source admission; reconcile its exact outcome.');
              next = structuredClone(associations);
              next.admissions.push({ id: admissionId, fingerprint: admissionFingerprint, source: source! });
              if (next.revision >= Number.MAX_SAFE_INTEGER) throw new BrokerError(409, 'association_capacity', 'Association revision is exhausted.');
              next.revision++;
              assertAssociationCapacity(next);
              draft.associations = next;
            }
          }
          const unchanged = isDeepStrictEqual(draft, snapshot());
          return { value: undefined, ...(unchanged ? { unchanged: true as const } : {}), publish() { associations = next; if (nextSharing) sharing = nextSharing; } };
        }, !associations.admissions.some(row => row.id === admissionId) && (!shared || shared.reservation.fresh));
        await commit(() => {
          assertMutationAccess(); assertSessionSlots();
          if (trackAssociation && !exactAdmission(associations)) throw new BrokerError(409, 'association_outcome_unknown', 'Source dispatch requires its durable admission.');
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
        assertHostCurrent(host, generation);
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
        return commit(draft => {
          if (source) assertAssociationCreationOpen(source);
          if (hosts.get(host.id) !== host || host.generation !== generation) throw new BrokerError(503, 'host_reconnected', 'The Remote Host changed while the session operation was completing.');
          const byNative = nativeBindings.get(nativeKey);
          const agentId = byNative?.agentId ?? returnedAgentId;
          const byAgent = bindings.get(agentId);
          assertRuntimeIdentity(host, { agentId, providerId, nativeSessionId: actualNativeSessionId }, returnedAgentId);
          if (!byAgent && !byNative && bindings.size >= 4096) throw new BrokerError(429, 'capacity_exceeded', 'The local session binding registry is full.');
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
              if (!exactAdmission(associations)) throw new BrokerError(409, 'association_outcome_unknown', 'Source completion requires its exact durable admission.');
              draft.associations = structuredClone(associations);
              draft.associations.admissions = draft.associations.admissions.filter(row => row.id !== admissionId);
              if (draft.associations.revision >= Number.MAX_SAFE_INTEGER) throw new BrokerError(409, 'association_capacity', 'Association revision is exhausted.');
              draft.associations.revision++;
              assertAssociationCapacity(draft.associations);
            }
          }
          const unchanged = isDeepStrictEqual(draft, snapshot());
          if (unchanged) {
            binding.generation = generation;
            runtimeBindings.set(agentId, { generation, agentId: returnedAgentId });
            attached.set(nativeKey, Promise.resolve(binding));
          }
          return { value: binding, ...(unchanged ? { unchanged: true as const } : {}), publish() {
            assertHostCurrent(host, generation);
            if (draft.associations) associations = draft.associations;
            if (creation) completedCreations.set(key, creation);
            if (nextSharing) sharing = nextSharing;
            binding.generation = host.generation;
            runtimeBindings.set(agentId, { generation, agentId: returnedAgentId });
            bindings.set(agentId, binding); nativeBindings.set(nativeKey, binding); pendingBindingSlots.delete(slot);
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
          if (safeHostRejection && (trackAssociation && exactAdmission(associations) || shared && sharing.snapshot().reservations.some(row => row.key === shared.reservation.key))) await commit(draft => {
            assertHostCurrent(host, admittedGeneration);
            if (trackAssociation) {
              if (!exactAdmission(associations)) throw new BrokerError(409, 'association_outcome_unknown', 'Safe source rejection requires its exact admission.');
              draft.associations = structuredClone(associations);
              draft.associations.admissions = draft.associations.admissions.filter(row => row.id !== admissionId); draft.associations.revision++;
              assertAssociationCapacity(draft.associations);
            }
            let nextSharing: HostSharing | undefined;
            if (shared) { exactSharedReceipt(draft); nextSharing = new HostSharing(draft.sharing, () => {}); nextSharing.release(shared.reservation.key); draft.sharing = nextSharing.snapshot(); }
            return { value: undefined, publish() { if (draft.associations) associations = draft.associations; if (nextSharing) sharing = nextSharing; } };
          });
          if (creations.get(key) === pending) creations.delete(key);
        }
        throw error;
      });
      creations.set(key, pending); existing = pending;
    }
    const binding = await existing.result;
    assertHostCurrent(host, admittedGeneration);
    const completed = completedCreations.get(key);
    if (trackAssociation && exactAdmission(associations)) throw new BrokerError(409, 'association_outcome_unknown', 'A partially saved source completion requires exact reconciliation before activation.');
    if (!completed || completed.fingerprint !== fingerprint || completed.agentId !== binding.agentId || bindings.get(binding.agentId) !== binding
      || binding.hostId !== host.id || binding.providerId !== providerId || creatorSubject && binding.creatorSubject !== creatorSubject) throw new BrokerError(409, 'creation_outcome_unknown', 'The complete creation result requires reconciliation.');
    if (shared && exactSharedReceipt(snapshot()).agentId !== binding.agentId) throw new BrokerError(409, 'creation_outcome_unknown', 'The shared completion requires reconciliation.');
    assertMutationAccess(); await recoverBinding(host, binding); return binding;
  }
  async function userMutation(host: Host, action: string, body: Record<string, unknown>, subject?: string): Promise<Binding> {
    assertHostCurrent(host);
    if (action === 'create' && body.conversationKind !== undefined && (!['side', 'ask'].includes(String(body.conversationKind)) || typeof body.sourceNativeSessionId !== 'string' || body.editNativeSessionId !== undefined)) {
      throw new BrokerError(400, 'invalid_request', 'A Side or Ask requires a source session.');
    }
    if (action === 'create') body = { ...body, conversationId: body.operationId };
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
        const source = nativeBindings.get(JSON.stringify([host.id, provenance.providerId, provenance.nativeSessionId]));
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
      const existing = nativeBindings.get(JSON.stringify([host.id, providerId, nativeSessionId]));
      if (existing && sessionAllowed(existing, subject)) {
        await recoverBinding(host, existing); return existing;
      }
      if (action === 'child/attach') {
        const parentId = required(body.parentNativeSessionId, 'parentNativeSessionId');
        const parent = nativeBindings.get(JSON.stringify([host.id, providerId, parentId]));
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
    const reservation = new HostSharing(sharing.snapshot(), () => {}).reserve(host.id, subject!, providerId, operationId, fingerprint);
    const creationKey = JSON.stringify([host.id, providerId, reservation.nativeRequestId]);
    const pending = sharedCreates.get(reservation.key);
    if (pending) {
      if (pending.fingerprint !== fingerprint) throw new SharingError(409, 'operation_conflict', 'This creation operation has different settings.');
      return pending.result;
    }
    if (reservation.agentId && !options.successionEnrollment && !options.initialState?.associations) {
      const binding = bindings.get(reservation.agentId);
      if (!binding || binding.hostId !== host.id || binding.providerId !== providerId || !sessionAllowed(binding, subject)) throw new SharingError(409, 'creation_outcome_unknown', 'The saved shared result requires reconciliation.');
      await recoverBinding(host, binding); return binding;
    }
    if (!reservation.fresh && !reservation.agentId && !completedCreations.has(creationKey)) {
      const admissionId = createHash('sha256').update(creationKey).digest('hex');
      if (!body.sourceNativeSessionId || !associations.admissions.some(row => row.id === admissionId)) throw new SharingError(409, 'creation_outcome_unknown', 'A previous creation is unresolved. Its quota reservation is retained; ask the Host owner to reconcile it.');
    }
    const operation = mutate(host, action, { ...body, operationId: reservation.nativeRequestId }, subject, { subject: subject!, operationId, fingerprint, reservation });
    const sharedOperation = { fingerprint, result: operation }; sharedCreates.set(reservation.key, sharedOperation);
    try { return await operation; } finally { if (sharedCreates.get(reservation.key) === sharedOperation) sharedCreates.delete(reservation.key); }
  }
  async function sharedCatalog(host: Host, action: string, query: URLSearchParams, subject: string): Promise<RpcResponse> {
    const providerId = host.legacyDsh ? 'dsh' : query.get('providerId');
    const owned = [...bindings.values()].filter(binding => binding.hostId === host.id && binding.providerId === providerId && binding.creatorSubject === subject && !binding.parentNativeSessionId);
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
    assertAvailable();
    if (!await permitted(context)) throw new BrokerError(403, 'forbidden', 'This endpoint is available only to the local application.');
    if (request.method === 'POST') {
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
      const versions = [...new Set([...hosts.values()].flatMap(host => {
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
    if (url.pathname === '/v1/remote/teams' || url.pathname === '/v1/remote/teams/create' || url.pathname === '/v1/remote/teams/action') {
      requireOwner(subject);
      if (url.pathname === '/v1/remote/teams' && request.method === 'GET') return json(200, { teams: teams.list().filter(team => hostAllowed(team.source.hostId, subject)) });
      if (request.method !== 'POST') return json(405, { error: 'Method is not allowed.' });
      const input = await readBody(request); requireOwner(principal(context));
      try {
        if (url.pathname.endsWith('/create') && isTeamCreate(input)) {
          requireAccess(input.source.hostId, principal(context));
          const result = await teams.create(input);
          requireOwner(principal(context)); requireAccess(input.source.hostId, principal(context));
          return json(200, result);
        }
        if (url.pathname.endsWith('/action') && isTeamAction(input)) {
          const team = teams.list().find(team => team.id === input.teamId);
          if (!team) return json(404, { error: 'Team not found.' });
          requireAccess(team.source.hostId, principal(context));
          if (input.action === 'add_member') requireAccess(input.hostId, principal(context));
          const result = await teams.action(input);
          requireOwner(principal(context)); requireAccess(team.source.hostId, principal(context));
          if (input.action === 'add_member') requireAccess(input.hostId, principal(context));
          return json(200, result);
        }
        return json(400, { error: 'Invalid Team request.' });
      } catch (error) { return json(409, { error: error instanceof Error ? error.message : 'Team request failed.' }); }
    }
    const tpm = /^\/v1\/remote\/hosts\/([^/]+)\/tpm(?:\/(create|action|work))?$/.exec(url.pathname);
    if (tpm) {
      requireOwner(subject); requireAccess(tpm[1]!, subject);
      const host = requireHost(tpm[1]!);
      const generation = host.generation, installationId = host.installationId;
      const requireTpmLifetime = () => { assertHostCurrent(host, generation); requireOwner(principal(context)); requireAccess(host.id, principal(context)); };
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
      const binding = bindings.get(previewSession[1]!);
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
        pairings: [...pairings].sort((a, b) => b.createdAt - a.createdAt).map(item => visiblePairing(item, now())) });
      if (request.method !== 'POST') return json(405, { error: 'Method is not allowed.' });
      const body = await readBody(request);
      const purpose = body.purpose ?? 'host-only';
      if (Object.keys(body).some(key => !['purpose', 'recoverHostId'].includes(key)) || !isPairingPurpose(purpose)) throw new BrokerError(400, 'invalid_request', 'Select a supported pairing purpose.');
      const recoverHostId = body.recoverHostId === undefined ? undefined : required(body.recoverHostId, 'recoverHostId');
      if (recoverHostId && (recoverHostId.length > 512 || purpose !== 'host-only' || !accountBacked || !options.ownerSubject || !options.successionEnrollment)) throw new BrokerError(400, 'host_recovery_unavailable', 'Recovery requires an authenticated owner and a retained succession identity.');
      if (options.gatewaySetup === false && purpose !== 'host-only') throw new BrokerError(403, 'unsupported_purpose', 'Gateway setup is unavailable for this authentication provider.');
      if (!accountBacked && purpose !== 'host-only') throw new BrokerError(400, 'unsupported_purpose', 'Gateway setup requires an account-backed Relay.');
      const key = `arc_${randomBytes(32).toString('base64url')}`;
      const createdAt = now(); const expires = createdAt + (options.keyLifetimeMs ?? (accountBacked ? 10 * 60 * 1000 : 24 * 60 * 60 * 1000));
      const item: SavedPairingKey = { id: randomUUID(), purpose, createdAt, expiresAt: expires };
      await commit(draft => {
        let recovery: HostRecoverySelection | undefined;
        if (recoverHostId) {
          const installationId = retainedIdentities().get(recoverHostId);
          if (!installationId || hosts.has(recoverHostId) || [...hosts.values()].some(host => host.installationId === installationId)) throw new BrokerError(409, 'host_recovery_unavailable', 'The selected historical Host is unavailable for recovery.');
          let marker = draft.revokedHosts?.find(host => host.hostId === recoverHostId);
          if (!marker) {
            marker = { hostId: recoverHostId, installationId, revocationId: randomUUID() };
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
          for (const hash of keys.keys()) if (!draft.keys.some(([saved]) => saved === hash)) keys.delete(hash);
          pairings = draft.pairings!;
          revokedHosts = draft.revokedHosts;
          sharing = new HostSharing(draft.sharing, () => {});
          keys.set(keyHash(key), credential); options.onPairing?.(key, expires);
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
      await commit(draft => {
        const item = draft.pairings?.find(item => item.id === pairingAction[1]);
        if (!item) throw new BrokerError(404, 'pairing_not_found', 'Pairing key record is unavailable.');
        if (revoke && pairingStatus(item, now()) === 'used') throw new BrokerError(409, 'pairing_used', 'This key has been used. Manage the paired Host to revoke its access.');
        if (item.usedAt === undefined) draft.keys = draft.keys.filter(([, key]) => key.pairingId !== item.id);
        if (revoke) item.revokedAt ??= now();
        else draft.pairings = draft.pairings!.filter(value => value.id !== item.id);
        return { value: undefined, publish() {
          pairings = draft.pairings ?? [];
          for (const hash of keys.keys()) if (!draft.keys.some(([saved]) => saved === hash)) keys.delete(hash);
          for (const check of expiryChecks) check();
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
    const revoking = /^\/v1\/remote\/hosts\/([^/]+)\/revoke$/.exec(url.pathname);
    if (accountBacked && revoking && request.method === 'POST') {
      requireOwner(subject);
      await readBody(request);
      const host = hosts.get(revoking[1]!);
      if (!host) throw new BrokerError(404, 'host_not_found', 'The Remote Host is unknown.');
      await commit(draft => {
        assertHostCurrent(host);
        if (retainedIdentities().get(host.id) === host.installationId) {
          const marker: RevokedHost = { hostId: host.id, installationId: host.installationId, revocationId: randomUUID(), revokedAt: now() };
          draft.revokedHosts = [...(draft.revokedHosts ?? []).filter(item => item.hostId !== host.id), marker];
        }
        if (draft.sharing) for (const grant of draft.sharing.grants) if (grant.hostId === host.id) grant.revoked = true;
        for (const item of draft.pairings ?? []) if (item.recovery?.hostId === host.id && item.usedAt === undefined) item.revokedAt ??= now();
        draft.keys = draft.keys.filter(([, credential]) => credential.installationId !== host.installationId);
        draft.bindings = draft.bindings.filter(binding => binding.hostId !== host.id);
        draft.creations = draft.creations.filter(([, value]) => draft.bindings.some(binding => binding.agentId === value.agentId));
        draft.hosts = draft.hosts.filter(value => value.id !== host.id);
        draft.previews = (draft.previews ?? []).filter(value => value.hostId !== host.id);
        return { value: undefined, publish() {
          revokedHosts = draft.revokedHosts;
          pairings = draft.pairings ?? [];
          sharing = new HostSharing(draft.sharing, () => {});
          for (const [key, credential] of keys) if (credential.installationId === host.installationId) keys.delete(key);
          for (const [id, binding] of bindings) if (binding.hostId === host.id) {
            bindings.delete(id); runtimeBindings.delete(id); const key = JSON.stringify([host.id, binding.providerId, binding.nativeSessionId]);
            nativeBindings.delete(key); attached.delete(key);
          }
          for (const [key, value] of completedCreations) if (!bindings.has(value.agentId)) { completedCreations.delete(key); creations.delete(key); }
          for (const key of creations.keys()) if (key.startsWith(`[${JSON.stringify(host.id)},`)) creations.delete(key);
          for (const key of attachmentRequests.keys()) if (JSON.parse(JSON.parse(key)[0])[0] === host.id) attachmentRequests.delete(key);
          hosts.delete(host.id);
          previews.forget(host.id);
          if (host.socket) { const socket = host.socket; disconnected(host, socket, 'access_revoked', 1008); socket.close(1008, 'Device revoked'); }
        } };
      });
      return json(200, { ok: true });
    }
    const rename = /^\/v1\/remote\/hosts\/([^/]+)\/session\/rename$/.exec(url.pathname);
    if (rename && request.method === 'POST') {
      requireAccess(rename[1]!, subject);
      const host = requireHost(rename[1]!);
      const input = await readBody(request);
      const providerId = required(input.providerId, 'providerId'), nativeSessionId = required(input.nativeSessionId, 'nativeSessionId');
      const binding = nativeBindings.get(JSON.stringify([host.id, providerId, nativeSessionId]));
      if (!owner(subject) && (!binding || !sessionAllowed(binding, subject))) throw new SharingError(403, 'session_forbidden', 'Session access is unavailable.');
      if (!host.providers.some(provider => provider.providerId === providerId && provider.sessionRename)) throw new BrokerError(400, 'unsupported_configuration', 'Native session renaming is unavailable. Update the Controller.');
      const title = required(input.title, 'title').trim();
      if (!title || title.length > 512 || /[\u0000-\u001f\u007f]/.test(title) || Object.keys(input).some(key => !['providerId', 'nativeSessionId', 'title', 'operationId'].includes(key))) throw new BrokerError(400, 'invalid_request', 'Enter a session name of up to 512 characters.');
      const result = await rpc(host, 'POST', '/remote/session/rename', undefined, JSON.stringify({ providerId, nativeSessionId, title, operationId: required(input.operationId, 'operationId') }));
      requireAccess(host.id, subject);
      if (!owner(subject) && (!binding || !sessionAllowed(binding, subject))) throw new SharingError(403, 'session_forbidden', 'Session access is unavailable.');
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
      if (['attach', 'child/attach', 'create'].includes(action) && request.method === 'POST') { const binding = await userMutation(host, action, await readBody(request), subject);
        if (!sessionAllowed(binding, subject)) throw new SharingError(403, 'session_forbidden', 'Session access is unavailable.');
        return json(200, { agentId: binding.agentId, nativeSessionId: binding.nativeSessionId }); }
    }
    const session = /^\/v1\/sessions\/([^/]+)\/(snapshot|timeline)$/.exec(url.pathname);
    const binding = session && bindings.get(session[1]!);
    if (binding && request.method === 'GET') {
      if (!sessionAllowed(binding, subject)) throw new SharingError(403, 'session_forbidden', 'Session access is unavailable.');
      const host = requireHost(binding.hostId); await recoverBinding(host, binding);
      const result = await sessionRead(host, binding, url.pathname + url.search);
      if (!sessionAllowed(binding, subject)) throw new SharingError(403, 'session_forbidden', 'Session access is unavailable.');
      return rawJson(result);
    }
    throw new BrokerError(404, 'route_not_found', 'Unknown Remote Host route.');
  }
  async function upgrade(request: Request, context: BrokerRequestContext, url: URL) {
    assertAvailable();
    if (url.pathname === '/ws/remote-host') {
      const header = request.headers.get('authorization');
      const hash = header?.startsWith('Bearer ') ? keyHash(header.slice(7)) : undefined;
      const key = hash ? keys.get(hash) : undefined;
      if (!key || key.claimedAt !== undefined || key.expires <= now()) return rejectUpgrade(401);
      return { accept(client: RelaySocket) {
        if (unavailable || keys.get(hash!) !== key || key.claimedAt !== undefined || key.expires <= now()) { client.close(1008, 'Device credential revoked'); return; }
        track(client);
        register(client, key, context, hash!, url.searchParams.get('successionEnrollment') === '2' ? 2 : url.searchParams.get('successionEnrollment') === '1' ? 1 : undefined, url.searchParams.get('team') === '1', url.searchParams.get('teamResources') === '1');
      } };
    }
    const match = /^\/v1\/sessions\/([^/]+)\/events$/.exec(url.pathname);
    const binding = match && bindings.get(match[1]!);
    if (!binding || !sessionAllowed(binding, principal(context)) || !await permitted(context) || request.headers.get('origin') !== origin) return rejectUpgrade(403);
    let host: Host;
    try { host = requireHost(binding.hostId); await recoverBinding(host, binding); } catch { return rejectUpgrade(503); }
    const subject = principal(context);
    const userStreams = () => subject === undefined ? 0 : options.userStreamCount?.(subject) ?? activeStreamCount(subject);
    if (host.streams.size >= 128 || userStreams() >= 32) return rejectUpgrade(429);
    return { accept(client: RelaySocket) {
      if (!sessionAllowed(binding, principal(context))) { client.close(1008, 'Session access is unavailable'); return; }
      if (host.streams.size >= 128 || userStreams() >= 32) { client.close(1013, 'Remote stream capacity reached'); return; }
      track(client);
      const expiry = () => sessionAllowed(binding, principal(context)) ? context.connectionExpiresAt?.() : 0;
      expire(client, expiry);
      if (client.readyState !== RELAY_SOCKET_OPEN) return;
      const streamId = randomUUID(); const stream: Host['streams'] extends Map<string, infer Value> ? Value : never = { publicAgentId: binding.agentId, runtimeAgentId: runtimeAgentId(host, binding), socket: client, subject: principal(context), authorized: () => { const end = expiry(); return end === undefined || end > now(); }, ready: false, buffered: [] };
      host.streams.set(streamId, stream);
      diagnostic(host,{event:'stream_opening',streamId,agentId:binding.agentId});
      const opening = setTimeout(() => { diagnostic(host,{event:'stream_open_timeout',streamId}); client.close(1013, 'Remote stream opening timed out'); }, options.rpcTimeoutMs ?? 30_000);
      stream.timer = opening;
      client.onError(() => undefined);
      let messageWindow = now(); let messageCount = 0; let imageChunkCount = 0; let imageChunkBytes = 0; let resourceCount = 0; let resourceBytes = 0;
      client.onMessage((raw, binary) => {
        if (binary) return client.close(1003, 'Text protocol required');
        if (now()-messageWindow >= 60_000) { messageWindow=now(); messageCount=0; imageChunkCount=0; imageChunkBytes=0; resourceCount=0; resourceBytes=0; }
        let publicMessage: { type?: string; payload?: { locator?: unknown } };
        try { publicMessage = JSON.parse(raw.toString()); } catch { return client.close(1008, 'Invalid session message'); }
        if (publicMessage?.type === 'image_upload_chunk') {
          const bytes = Buffer.byteLength(raw.toString());
          imageChunkBytes += bytes;
          if (bytes > 48 * 1024 || ++imageChunkCount > 2048 || imageChunkBytes > 48 * 1024 * 1024) return client.close(1008, 'Image upload rate exceeded');
        } else if (publicMessage?.type === 'resource_upload_chunk' || publicMessage?.type === 'resource_download_request') {
          const bytes = Buffer.byteLength(raw.toString()); resourceBytes += bytes;
          if (bytes > 48 * 1024 || ++resourceCount > 8192 || resourceBytes > 192 * 1024 * 1024) return client.close(1008, 'Resource transfer rate exceeded');
        } else if (++messageCount > 120) return client.close(1008, 'Control message rate exceeded');
        if (context.authorizeMessage?.(raw.toString()) === false) {
          const decoded = decodeClientMessage(raw.toString());
          if (decoded.status !== 'ok' || !('payload' in decoded.value) || !('requestId' in decoded.value.payload)) return client.close(1008, 'Invalid session message');
          client.send(JSON.stringify({ protocolVersion: PROTOCOL_VERSION, type: 'protocol_error', payload: {
            requestId: decoded.value.payload.requestId, code: 'reauthentication_required',
            message: 'Sign in again before changing session permissions. Then retry the change.', recoverable: true,
          } }));
          return;
        }
        if (!owner(subject)) {
          try { if (publicMessage.type === 'resource_resolve_request' && !(typeof publicMessage.payload?.locator === 'string' && /^input-image:[a-f0-9-]{36}$/.test(publicMessage.payload.locator))) return client.close(1008, 'Only the Host owner can resolve local files'); }
          catch { return client.close(1008, 'Invalid session message'); }
        }
        const expiresAt = expiry();
        if (expiresAt !== undefined && expiresAt <= now()) return client.close(1008, 'Credential expired');
        let outgoing: string;
        try { outgoing = sessionIdentityMessage(raw.toString(), stream.publicAgentId, stream.runtimeAgentId, 'client'); }
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
    return url.pathname === '/v1/remote/controller-release' || /^\/v1\/remote\/(hosts|pairings|teams)(\/|$)/.test(url.pathname) || !!(session && bindings.has(session[1]!));
  };
  const handlesUpgrade = (url: URL) => {
    const session = /^\/v1\/sessions\/([^/]+)\//.exec(url.pathname);
    return url.pathname === '/ws/remote-host' || !!(session && bindings.has(session[1]!));
  };
  function authenticateDevice(value: string) {
    if (unavailable || !accountBacked) return undefined;
    const hash = keyHash(value); const credential = keys.get(hash);
    if (!credential || credential.kind !== 'device' || credential.requiresRotation || !credential.installationId || credential.expires <= now()) return undefined;
    const host = [...hosts.values()].find(host => host.installationId === credential.installationId);
    if (!host) return undefined;
    return { hostId: host.id, hostName: host.name, pairingPurpose: host.pairingPurpose ?? (host.gatewayKeyRequested ? 'gateway-setup' : 'host-only'),
      current: () => !unavailable && keys.get(hash) === credential && credential.expires > now() && hosts.get(host.id) === host };
  }
  return {
    previews,
    authenticateDevice,
    async markGatewayKeyRequested(value: string): Promise<boolean> {
      return commit(draft => {
        const device = authenticateDevice(value);
        if (!device || device.pairingPurpose !== 'gateway-setup') return { value: false, publish() {} };
        draft.hosts.find(host => host.id === device.hostId)!.gatewayKeyRequested = true;
        return { value: true, publish() { hosts.get(device.hostId)!.gatewayKeyRequested = true; } };
      });
    },
    gatewayKeyHost(hostId: string, subject: string) {
      const host = hosts.get(hostId);
      return !unavailable && owner(subject) && host?.gatewayKeyRequested ? { hostId: host.id, hostName: host.name } : undefined;
    },
    ownsHost: (hostId: string, subject: string) => hosts.has(hostId) && owner(subject),
    tunnelHost: (token: string) => [...hosts.values()].find(host => host.ready && host.socket?.readyState === RELAY_SOCKET_OPEN && host.tunnelToken === token)?.id,
    acceptTunnel(token: string, socket: TunnelSocket) {
      const host = [...hosts.values()].find(host => host.ready && host.socket?.readyState === RELAY_SOCKET_OPEN && host.tunnelToken === token);
      if (!host || unavailable) { socket.close(1008, 'Tunnel authorization expired'); return; }
      previews.attach(host.id, socket);
    },
    snapshot,
    activeStreamCount,
    settled: () => commits.then(() => undefined),
    visibleHosts,
    hasHost: (hostId: string) => hosts.has(hostId),
    canAccessHost: hostAllowed,
    canStarSession: (item: { hostId: string; providerId: string; nativeSessionId: string }, subject: string) => {
      const host = hosts.get(item.hostId);
      if (!hostAllowed(item.hostId, subject) || !host?.providers.some(provider => provider.providerId === item.providerId)) return false;
      const binding = nativeBindings.get(JSON.stringify([item.hostId, item.providerId, item.nativeSessionId]));
      return owner(subject) || !!binding && sessionAllowed(binding, subject);
    },
    sessionRelations(subject: string): SessionRelation[] {
      const result: SessionRelation[] = [];
      for (const binding of bindings.values()) {
        const relation = binding.sourceRelation, host = hosts.get(binding.hostId);
        if (!relation || !host || !sessionAllowed(binding, subject)) continue;
        const nativeSourceRef = relation.nativeSourceRef ?? associationSource(host, binding.providerId, relation.sourceNativeSessionId);
        const fixed = nativeBindings.get(JSON.stringify([binding.hostId,nativeSourceRef.providerId,nativeSourceRef.nativeSessionId]));
        if (!fixed || !sessionAllowed(fixed,subject)) continue;
        const operation = associations.relationChanges.filter(row => row.reservation.hostId === host.id && row.reservation.relationId === relation.id && nativeSessionRefKey(row.reservation.readerRef) === nativeSessionRefKey(associationSource(host,binding.providerId,binding.nativeSessionId))).at(-1);
        const latest = associations.freezes.filter(row => row.hostId === host.id && row.projection
          && [...row.receipt.lineage, row.projection.role.current].some(ref => nativeSessionRefKey(ref) === nativeSessionRefKey(nativeSourceRef))).at(-1);
        const projection = latest?.projection;
        const enrolled = latest?.receipt.relations.some(value => value.relationId === relation.id && value.linked
          && nativeSessionRefKey(value.readerRef) === nativeSessionRefKey(associationSource(host,binding.providerId,binding.nativeSessionId)));
        const pending = operation && operation.phase !== 'committed';
        const role = projection?.role ?? (operation ? { id:operation.reservation.roleId,origin:operation.reservation.origin,current:operation.reservation.current,revision:operation.reservation.expectedRoleRevision } : undefined);
        const follows = (relation.linked ?? true) && !pending && !!role && (enrolled || operation?.phase === 'committed' && operation.reservation.linked);
        const selected = follows ? role!.current : nativeSourceRef;
        if (!host.providers.some(row => row.providerId === selected.providerId)) continue;
        const resolved = nativeBindings.get(JSON.stringify([binding.hostId,selected.providerId,selected.nativeSessionId]));
        if (resolved && !sessionAllowed(resolved,subject)) continue;
        const navigationRef = operation?.reservation.current;
        const navigationBinding = navigationRef ? nativeBindings.get(JSON.stringify([host.id,navigationRef.providerId,navigationRef.nativeSessionId])) : undefined;
        const identity = (value: Binding, title: string) => ({ hostId:value.hostId,providerId:value.providerId,nativeSessionId:value.nativeSessionId,agentId:value.agentId,title });
        if (!resolved && !owner(subject)) continue;
        result.push({id:relation.id,kind:relation.kind,createdAt:relation.createdAt,linked:relation.linked??true,revision:relation.revision??0,nativeSourceRef,
          hostLocator:{hostId:host.id,controllerId:host.installationId}, sourceBinding:follows?{kind:'primary_role',roleId:role!.id,origin:role!.origin}:{kind:'fixed',source:nativeSourceRef},
          ...(pending && navigationRef && host.providers.some(row=>row.providerId===navigationRef.providerId)
            && (navigationBinding ? sessionAllowed(navigationBinding,subject) : owner(subject))
            ? {navigationSource:navigationBinding?identity(navigationBinding,'Source session'):{hostId:host.id,providerId:navigationRef.providerId,nativeSessionId:navigationRef.nativeSessionId,agentId:'',title:'Source session'}} : {}),
          ...(role?{roleRevision:role.revision}:{}), ...(operation?{operation:{operationId:operation.reservation.operationId,phase:operation.phase}}:{}),
          source:resolved?identity(resolved,'Source session'):{hostId:host.id,providerId:selected.providerId,nativeSessionId:selected.nativeSessionId,agentId:'',title:'Source session'},target:identity(binding,relation.kind==='ask'?'Ask':'Side')});
      }
      return result.sort((a,b)=>a.createdAt.localeCompare(b.createdAt)||a.id.localeCompare(b.id));
    },
    async importSessionRelation(subject: string, input: Record<string, unknown>): Promise<void> {
      if (!validSourceRelation(input) || typeof input.hostId !== 'string' || typeof input.providerId !== 'string' || typeof input.nativeSessionId !== 'string') {
        throw new SharingError(400, 'invalid_relation', 'A complete session relation is required.');
      }
      const binding = nativeBindings.get(JSON.stringify([input.hostId, input.providerId, input.nativeSessionId]));
      const source = nativeBindings.get(JSON.stringify([input.hostId, input.providerId, input.sourceNativeSessionId]));
      const allowed = () => binding && source && binding !== source && sessionAllowed(binding, subject) && sessionAllowed(source, subject);
      if (!allowed()) throw new SharingError(403, 'session_forbidden', 'Session access is unavailable.');
      assertAssociationMutable(associationSource(hosts.get(input.hostId)!, input.providerId, input.sourceNativeSessionId));
      const proven = [...completedCreations.values()].some(value => {
        if (value.agentId !== binding!.agentId) return false;
        try { return JSON.parse(value.fingerprint).sourceNativeSessionId === input.sourceNativeSessionId; } catch { return false; }
      });
      if (!proven) throw new SharingError(403, 'unverified_relation', 'The source relationship could not be verified.');
      const relation: SourceRelation = { id: input.id, kind: input.kind, sourceNativeSessionId: input.sourceNativeSessionId, createdAt: input.createdAt };
      await commit(draft => {
        if (!allowed() || bindings.get(binding!.agentId) !== binding) throw new SharingError(403, 'session_forbidden', 'Session access is unavailable.');
        assertAssociationMutable(associationSource(hosts.get(input.hostId as string)!, input.providerId as string, input.sourceNativeSessionId as string));
        if (options.successionEnrollment || draft.associations) { draft.associations = structuredClone(associations); draft.associations.revision++; }
        const prior = binding!.sourceRelation;
        if (prior && (prior.kind !== relation.kind || prior.id !== relation.id || prior.sourceNativeSessionId !== relation.sourceNativeSessionId)) {
          throw new SharingError(409, 'relation_conflict', 'This session already has a different relationship.');
        }
        const saved = draft.bindings.find(item => item.agentId === binding!.agentId)!;
        saved.sourceRelation = prior ?? relation;
        return { value: undefined, publish() { if (draft.associations) associations = draft.associations; binding!.sourceRelation = saved.sourceRelation; } };
      });
    },
    async updateSessionRelation(subject: string, input: unknown): Promise<void | { operation: BrokerRelationChange }> {
      if (!validSessionRelationUpdate(input)) throw new SharingError(400, 'invalid_relation', 'A complete session relation and current revision are required.');
      const host = hosts.get(input.hostId);
      if (host) {
        const nativeRelation = nativeBindings.get(JSON.stringify([host.id,input.providerId,input.nativeSessionId]))?.sourceRelation;
        const source = nativeRelation?.nativeSourceRef ?? associationSource(host,input.providerId,input.sourceNativeSessionId);
        if (input.operationId && associations.relationResets.some(row=>row.intent.operationId===input.operationId)) assertRelationNotReset(associations,relationIntent(subject,input));
        const projection = associations.freezes.filter(row => row.hostId === host.id && row.projection && [...row.receipt.lineage, row.projection.role.current].some(ref => nativeSessionRefKey(ref) === nativeSessionRefKey(source))).at(-1)?.projection;
        if (projection) return reserveRelationUpdate(subject, input, host, projection.role);
        assertAssociationMutable(source);
      }
      await commit(draft => {
        if (!host) throw new SharingError(404, 'host_not_found', 'Host is unavailable.');
        assertHostCurrent(host);
        assertAssociationMutable(associationSource(host, input.providerId, input.sourceNativeSessionId));
        const binding = nativeBindings.get(JSON.stringify([input.hostId, input.providerId, input.nativeSessionId]));
        const source = nativeBindings.get(JSON.stringify([input.hostId, input.providerId, input.sourceNativeSessionId]));
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
        if (options.successionEnrollment || draft.associations) { draft.associations = structuredClone(associations); draft.associations.revision++; }
        draft.bindings.find(item => item.agentId === binding.agentId)!.sourceRelation = next;
        return { value: undefined, publish() { if (draft.associations) associations = draft.associations; binding.sourceRelation = next; } };
      });
    },
    async resetSessionRelationChange(subject: string, input: unknown): Promise<{ reset: RelationChangeReset } | { operation: BrokerRelationChange }> {
      if (!validSessionRelationUpdate(input)) throw new SharingError(400,'invalid_relation','An exact retained relationship intent is required.');
      const host = requireHost(input.hostId);
      const selected = await associationChange(state => {
        assertHostCurrent(host);
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
    canAccessSession: (agentId: string, subject: string) => { const binding = bindings.get(agentId); return !!binding && sessionAllowed(binding, subject); },
    async manageShares(subject: string, hostId: string, action: 'shares' | 'share' | 'revoke-share', targetSubject?: string, targetLabel?: string, sessionLimit?: number) {
      assertAvailable();
      requireOwner(subject);
      const host = hosts.get(hostId);
      if (!host) throw new SharingError(404, 'host_not_found', 'Host is unavailable.');
      if (action === 'shares') return { shares: sharing.list(hostId) };
      if (!targetSubject || targetSubject === options.ownerSubject) throw new SharingError(400, 'invalid_recipient', 'Choose another user.');
      if (action === 'share') await changeSharing(draft => { assertHostCurrent(host); draft.set(hostId, targetSubject, targetLabel ?? targetSubject, sessionLimit!); });
      else {
        await changeSharing(draft => { assertHostCurrent(host); draft.revoke(hostId, targetSubject); });
        for (const [streamId, stream] of host.streams) if (stream.subject === targetSubject) {
          host.streams.delete(streamId); stream.buffered = []; clearTimeout(stream.timer);
          stream.socket.close(1008, 'Host share revoked');
          try { send(host, { uplinkVersion: 2, type: 'stream_close', streamId, code: 1008, reason: 'Host share revoked' }); } catch { /* The Host may be offline. */ }
        }
      }
      for (const check of expiryChecks) check();
      return { ok: true };
    },
    enforceExpiry() { for (const check of expiryChecks) check(); },
    disconnect(code = 1008) {
      for (const host of hosts.values()) if (host.socket) { const socket = host.socket; disconnected(host, socket, code===1008?'access_revoked':'authority_unavailable', code); socket.close(code, code === 1008 ? 'Access revoked' : 'Authority temporarily unavailable'); }
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
      unavailable = true;
      previews.close();
      for (const cleanup of [...uplinkCleanups.values()]) cleanup();
      for (const host of hosts.values()) if (host.socket) disconnected(host, host.socket, 'relay_closed', 1001);
      for (const client of clients) client.close(1001, 'Broker closed');
      clients.clear();
      keys.clear(); hosts.clear(); bindings.clear(); runtimeBindings.clear(); nativeBindings.clear(); attached.clear(); creations.clear();
    },
  };
}
function required(value: unknown, name: string): string {
  if (typeof value !== 'string' || !value.trim() || value.length > 512) throw new BrokerError(400, 'invalid_request', `${name} must be a nonempty string.`);
  return value;
}
function requiredHostIdentity(value: unknown, name: string): string {
  if (typeof value !== 'string' || !value.trim() || value.length > 512) throw new BrokerError(502, 'invalid_host_response', `The Remote Host returned an invalid ${name}.`);
  return value;
}
function creationFingerprintSettings(body: Record<string, unknown>, names: readonly string[]): Record<string, string | boolean | CreationSource> {
  const settings = optionalSettings(body, names);
  // Validated legacy source/edit fields already uniquely determine provenance.
  // Keep their persisted identity unchanged, including redundant explicit input.
  if (body.sourceNativeSessionId !== undefined || body.editNativeSessionId !== undefined) delete settings.creationSource;
  return settings;
}
function optionalSettings(body: Record<string, unknown>, names: readonly string[]): Record<string, string | boolean | CreationSource> {
  const result: Record<string, string | boolean | CreationSource> = {};
  for (const name of names) {
    const value = body[name];
    if (value === undefined) continue;
    if (name === 'planning') {
      if (typeof value !== 'boolean') throw new BrokerError(400, 'invalid_request', 'planning must be a boolean.');
      result[name] = value;
    } else if (name === 'creationSource') {
      if (!isCreationSource(value)) throw new BrokerError(400, 'invalid_request', 'A strict creation source is required.');
      result[name] = { providerId: value.providerId, nativeSessionId: value.nativeSessionId };
    } else result[name] = required(value, name);
  }
  return result;
}
function sameBinding(binding: Binding, hostId: string, providerId: string, nativeSessionId: string): boolean {
  return binding.hostId === hostId && binding.providerId === providerId && binding.nativeSessionId === nativeSessionId;
}
async function readBody(request: Request): Promise<Record<string, unknown>> {
  const parts: Uint8Array[] = []; let size = 0;
  const reader = request.body?.getReader();
  if (reader) {
    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        size += value.byteLength;
        if (size > BROKER_MAX_BODY_BYTES) {
          void reader.cancel().catch(() => undefined);
          throw new BrokerError(413, 'request_too_large', 'The request body is too large.');
        }
        parts.push(value);
      }
    } finally { reader.releaseLock(); }
  }
  let value: unknown;
  try { value = JSON.parse(Buffer.concat(parts).toString() || '{}'); } catch { throw new BrokerError(400, 'invalid_json', 'The request body must be JSON.'); }
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new BrokerError(400, 'invalid_request', 'The request body must be an object.');
  return value as Record<string, unknown>;
}
function json(status: number, value: unknown) { return rawJson({ status, body: JSON.stringify(value) }); }
function rawJson(result: RpcResponse) {
  const body = [204, 205, 304].includes(result.status) ? null : result.body;
  return new Response(body, { status: result.status, headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' } });
}
function rejectUpgrade(status: number) { return new Response(null, { status }); }

function diagnosticOperation(path: string): RelayDiagnostic['operation'] {
  const pathname=path.split('?')[0]!;
  if(pathname.startsWith('/remote/catalog'))return 'catalog';
  if(pathname.endsWith('/attach'))return 'attach';
  if(pathname==='/remote/create')return 'create';
  if(pathname==='/remote/controller-update')return 'controller_update';
  if(pathname.startsWith('/remote/previews'))return 'preview';
  if(pathname.startsWith('/v1/sessions/'))return 'session_read';
  return 'other';
}
function diagnosticCloseReason(reason:string): RelayDiagnostic['reason'] {
  switch(reason) {
    case 'Host heartbeat timed out': return 'heartbeat_timeout';
    case 'Host heartbeat delivery failed': return 'heartbeat_delivery_failed';
    case 'Host transport failed': return 'transport_error';
    case 'Credential expired': return 'credential_expired';
    case 'Device credential revoked': return 'access_revoked';
    default: return 'protocol_error';
  }
}
