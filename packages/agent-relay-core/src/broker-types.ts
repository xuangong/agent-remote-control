import type { CallForSupportState } from './call-for-support-profiles.js';
import type { SavedTeam } from './team-delivery.js';
import type { TeamResourceStore } from './team-resources.js';
import type { HostRecoverySelection, RevokedHost } from './host-recovery.js';
import type { BrokerAssociationState } from './succession-associations.js';
import type { BoundedSuccessionAssociationFreeze, NativePrefixSuccessionAssociationFreeze } from '@orchardworks/agent-remote-protocol';
import type { SuccessionAssociationAuthority } from '@orchardworks/agent-remote-protocol';
import type { SourceRelation } from '@orchardworks/agent-remote-protocol/model';
import type { NativeRefusal, NativeSessionOwner } from '@orchardworks/agent-remote-protocol';
import type { RelayIds } from './relay-ids.js';
import type { DiagnosticJournal } from './diagnostic-journal.js';
import type { controllerReleases } from './controller-releases.js';
import type { ControllerIdentity } from '@orchardworks/agent-remote-protocol';
import type { SavedPairingKey } from './pairing-keys.js';
import type { HostEnvironment, PairingPurpose } from '@orchardworks/agent-remote-protocol';
import type { HostSessionState } from '@orchardworks/agent-remote-protocol';
import type { HostSharing, HostSharingState } from './host-sharing.js';
import type { HostPreviewState } from './host-previews.js';
import type { BrokerScheduler, RelaySocket } from './transport.js';
import type { JournalStore } from '@orchardworks/agent-remote-journal';
import type { HostJournals } from './host-journals.js';
import type { JournalConnection } from './journal-uplink.js';
import type { HostStreamEntry } from './journal-host-stream.js';

export type SharedCreation = { subject: string; operationId: string; fingerprint: string; reservation: ReturnType<HostSharing['reserve']> };
export type RpcResponse = { status: number; body: string; requestId?: string };
export type ProviderDescriptor = { providerId: string; displayName: string; promptEditing?: true; sessionRename?: true; sessionReferences?: true; referenceNotes?: true; sessionCommands?: true; daemonControl?: true };
export type DeviceCredential = { recovery?: HostRecoverySelection; pairingId?: string; purpose?: PairingPurpose; claimedAt?: number; expires: number; installationId?: string; kind?: 'device'; requiresRotation?: boolean };
/** A Host's latest session states, kept in memory while it is connected. changedAt: when the state last changed. */
export type HostStates = { confirmedAt?: number; states: Map<string, HostSessionState & { changedAt: number }> };
/** What one subject may see of a Host's session states. confirmedAt: when the Host last confirmed all of them. */
export type VisibleHostStates = { hostId: string; online: boolean; confirmedAt?: number; states: Array<HostSessionState & { changedAt: number }> };
export type Host = {
  sessionStates?: HostStates;
  successionEnrollmentVersion?: 1 | 2 | 3;
  providerManagement?: true;
  tpmManagement?: true;
  /** The Controller answers Host status reads; it said so when it connected. */
  hostStatus?: true;
  /** The Controller delivers messages from the outbox; it said so when it last connected, and the Host keeps it while offline. */
  outbox?: 1;
  /** Providers whose sessions are read from their journals; saved with the Host. Absent: every read goes to the Controller. */
  smartReading?: string[];
  /** The Controller publishes session journals on this connection; set when the Relay acknowledges it, never persisted. */
  journal?: JournalConnection;
  /** The Controller takes the sessions pages show (`journal_shown`) on this journal connection; set on registration, never persisted. */
  journalShown?: true;
  /** The Controller offered session control and the Relay acknowledged it: the Relay owns the leases of this Host's streams. Set on registration, never persisted. */
  control?: true;
  teamManagement?: true;
  teamRecipients?: 1;
  /** Team recipients follow a generic succession of their session on this Host, including to another provider. */
  teamSuccession?: 1;
  /** The Host runs Call For Support groups: requester seats, coordinators and supporters. */
  callForSupport?: 1;
  /** Providers the Host named, with its Call For Support request, as enforcing read-only sessions natively. */
  readOnlyProviders?: string[];
  connectionId?: string; stopDiagnostics?(): void;
  pairingPurpose?: PairingPurpose;
  environment?: HostEnvironment;
  controller?: ControllerIdentity;
  tunnelToken?: string;
  ready?: boolean; credentialRotation?: boolean; gatewayKeyRequested?: boolean; issueCredential?(): Promise<void>;
  id: string; installationId: string; name: string; providers: ProviderDescriptor[]; legacyDsh: boolean; generation: number; socket?: RelaySocket;
  pending: Map<string, { resolve(value: RpcResponse): void; reject(error: Error): void; timer: unknown; method: 'GET' | 'POST'; path: string; diagnostic: boolean; startedAt: number }>;
  streams: Map<string, HostStreamEntry>;
};
export type Binding = { hostId: string; providerId: string; nativeSessionId: string; agentId: string; generation: number;
  creatorSubject?: string; parentNativeSessionId?: string; sourceRelation?: SourceRelation; recovery?: Promise<void> };
export class BrokerError extends Error {
  constructor(readonly status: number, readonly code: string, message: string, readonly creationRejected = false, readonly requestId?: string, readonly nativeOwner?: NativeSessionOwner,
    /** The CLI refused the Controller as a client of the session, for this reason (O48). */
    readonly nativeRefusal?: NativeRefusal) { super(message); }
}
export interface RemoteHostBrokerState {
  teams?: SavedTeam[];
  /** Call For Support profiles and session enablement of this account. */
  callForSupport?: CallForSupportState;
  revokedHosts?: RevokedHost[];
  /** Hosts that were revoked and whose journals are not yet confirmed deleted. */
  journalDeletions?: string[];
  associations?: BrokerAssociationState;
  pairings?: SavedPairingKey[];
  previews?: HostPreviewState[];
  sharing?: HostSharingState;
  keys: Array<[string, DeviceCredential]>;
  hosts: Array<Pick<Host, 'id' | 'installationId' | 'name' | 'providers' | 'legacyDsh' | 'credentialRotation' | 'gatewayKeyRequested' | 'environment' | 'pairingPurpose' | 'controller' | 'providerManagement' | 'tpmManagement' | 'teamManagement' | 'outbox' | 'smartReading'>>;
  bindings: Array<Omit<Binding, 'generation' | 'recovery'>>;
  creations: Array<[string, { fingerprint: string; agentId: string }]>;
}
export interface HostBrokerOptions {
  /** Hosted authentication capability; never enables standalone Gateway access. */
  gatewaySetup?: boolean;
  teamResources?: TeamResourceStore;
  /** Messages waiting for this account's Hosts; Controllers that ask for it poll, claim and settle them over the uplink. */
  outbox?: { hostCall(hostId: string, call: unknown): Promise<unknown> };
  /** Where Host session journals are kept. Without it no Controller is granted journals. */
  journals?: JournalStore;
  /** How long a Controller has to answer a journal request. Defaults to 15 seconds. */
  journalRequestTimeoutMs?: number;
  /** How long a Host that returns with the id of a revoked Host waits for its journals' deletion before it is registered without journals. Default 5000. */
  journalDeletionWaitMs?: number;
  /** How long one journal deletion call may take before the pass gives up on it and the id stays pending. */
  journalDeletionTimeoutMs?: number;
  /** A journal service built elsewhere, such as one shared by every account or one that reaches journal partitions; used instead of `journals`. */
  journalService?: HostJournals;
  /** Internal opt-in; only a Gateway-authenticated tenant can supply this authority. */
  successionEnrollment?: SuccessionAssociationAuthority;
  /** Pure synchronous selection from the complete post-increment Broker draft; no native effects. */
  successionProjectionAllowance?: (context: { hostId: string; broker: Readonly<RemoteHostBrokerState>; freeze: Omit<BoundedSuccessionAssociationFreeze | NativePrefixSuccessionAssociationFreeze, 'maxProjectionBytes'> }) => number;
  diagnostics?: DiagnosticJournal;
  ownerSubject?: string;
  userStreamCount?(subject: string): number;
  /** The most browser streams one Host serves; the default is `HOST_STREAM_LIMIT`. */
  hostStreamLimit?: number;
  controllerReleases?: Pick<typeof controllerReleases, 'latest'> & Partial<Pick<typeof controllerReleases, 'version'>>;
  origin: string;
  rpcTimeoutMs?: number;
  /** Keep the original native creation result receivable after an HTTP caller stops waiting. */
  creationTimeoutMs?: number;
  heartbeatIntervalMs?: number;
  heartbeatTimeoutMs?: number;
  /** How long a connected Host may take to send its registration, in milliseconds. Defaults to 10 seconds. */
  registrationDeadlineMs?: number;
  keyLifetimeMs?: number;
  publicUrl?: string;
  onPairing?(key: string, expiresAt: number): void;
  /** Account security and credential management, independent of storage durability. */
  accountBacked?: boolean;
  /** Legacy account-mode option. Prefer accountBacked in hosted compositions. */
  durable?: boolean;
  initialState?: RemoteHostBrokerState;
  onStateChange?(state: RemoteHostBrokerState): void | Promise<void>;
  /**
   * Bytes the Relay's state may still grow, and may grow before support groups are removed to make room; negative when it is
   * over. A Team change may not grow the account's Teams by more than growth. Absent, only each Team's own bound applies.
   */
  stateRoom?(): { growth: number; retention: number };
  /** A Host's session states or connection changed. */
  onSessionStates?(): void;
  now?(): number;
  scheduler?: BrokerScheduler;
  /** Where ids and secrets come from; defaults to the system's secure source. */
  ids?: RelayIds;
}

