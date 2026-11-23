/**
 * The Controller's public shapes: what a provider registration, the runtime and the host offer and take. Types only; no behaviour.
 */
import type { OutboxHostCall, TeamHostCall } from '@orchardworks/agent-remote-protocol';
import type { DirectoryMutationEvidence } from '../directory-mutation.js';
import type { SessionSuccessionPorts, SessionExecutionRouting } from '../session-succession-service.js';
import type { NativePromptEditTarget } from '../local-succession-preparation.js';
import type { SessionSuccessionStore } from '../session-succession-store.js';
import type { SessionSuccessionContextStore } from '../session-succession-context.js';
import type { SessionSuccessionCoordinator } from '../session-succession.js';
import type { NativeSessionRef, TrustedSuccessionContext } from '@orchardworks/agent-remote-protocol';
import type { TpmOptions } from '../tpm.js';
import type { StateFiles } from '../state-file.js';
import type { NativeOwnerIdentity, NativeHandoffGrant } from '../native-session-owner.js';
import type { HostExecutionPolicy } from '../execution-policy.js';
import type { OperationCacheOptions } from '@orchardworks/agent-session-runtime';
import type { AgentProviderAdapter, AgentSession, AgentSessionConfig, AgentSessionExtensions, AgentEmptyCreationResult, AgentPersistenceHandle, AgentSessionResumeOptions } from '@orchardworks/agent-provider-sdk';
import type { SessionStatePublisher } from '../session-state-publisher.js';
import type { SessionOutbox } from '../session-outbox.js';
import type { JournalPublisher, JournalPublisherDiagnostic } from '../publisher/journal-publisher.js';
import type { SessionCallerCatalog, SessionCallerEndpoint, SessionCallerStore, SessionHostAccessSource } from '../session-callers.js';
import type { SessionRefContext, SessionRefStore } from '../session-refs.js';
import type { SessionCaller, SessionCallResult } from '../session-routes.js';
import type { InputImageStoreOptions, InputResourceStoreOptions, AgentRemoteHttpResult, AgentRemoteRelay, RemoteHostControlRequest, RemoteSessionSummary, RemoteHostSessionLease, SessionWireOperationExecutor } from '@orchardworks/agent-session-runtime';

export interface AgentHostWorkspace { id: string; name: string; path: string }
export interface AgentHostDirectory {
  readonly providerId: string;
  readonly listing?: import('../session-listing.js').HostSessionListing;
  sessionSummary?(nativeSessionId: string): Promise<RemoteSessionSummary | undefined>;
  readonly supportsSourceReferences?: boolean;
  /** Adapter-owned pre-effect promise for this exact create mode: the authoritative native reader ID
   * has nonempty trim, <=512 UTF-16 units and a valid same-controller/provider NativeSessionRef.
   * Must cover every selected downstream mode while create can run; mutable uncertified modes return false.
   * Independent of source-tool availability, projection certification and source-grant durability. */
  supportsBoundedSourceCreate?(input: Parameters<AgentHostDirectory['create']>[0]): Promise<boolean>;
  validateSessionRename?(nativeSessionId: string, title: string): Promise<void>;
  sessionTitle?(nativeSessionId: string): Promise<string | undefined>;
  renameSession?(nativeSessionId: string, title: string): Promise<string>;
  readonly supportsPromptEditing?: boolean;
  validatePromptEdit?(target: { nativeSessionId: string; turnId: string; messageId: string }): Promise<void>;
  supportsNativePrefix?(target: NativePromptEditTarget): Promise<boolean>;
  createNativePrefix?(target: NativePromptEditTarget, extensions: AgentSessionExtensions, evidence: DirectoryMutationEvidence | undefined, candidateKnown: (handle: AgentPersistenceHandle) => Promise<void>): Promise<AgentPersistenceHandle>;
  verifyNativePrefix?(target: NativePromptEditTarget, handle: AgentPersistenceHandle): Promise<void>;
  /** Active work uses tools served by the Controller process. */
  requiresController?(nativeSessionId: string): boolean;
  /** Must guarantee disposal only detaches this client's idle runtime connection. */
  canReleaseSession?(nativeSessionId: string): boolean;
  /** When this process last wrote to a session whose transcript something else has written to since; none when it did not diverge. */
  divergedAt?(nativeSessionId: string): number | undefined;
  /**
   * Checks a quiet session's transcript by its content now: true when it holds what something else wrote. `listedUpdatedAt` is the
   * transcript's update time a listing just read, which spares reading it again.
   */
  checkDivergence?(nativeSessionId: string, listedUpdatedAt?: number): Promise<boolean>;
  reconcileIdleSession?(nativeSessionId: string): Promise<boolean>;
  sessionReleased?(nativeSessionId: string): Promise<void> | void;
  sessionWorkspace?(nativeSessionId: string, handle?: AgentPersistenceHandle): Promise<string | undefined>;
  setSourceAccessCheck?(check: (nativeSessionId: string) => Promise<void>): void;
  /** What the sessions this directory creates and resumes may use of the Host; set only for adapters that apply it. */
  setSessionHostAccess?(source: SessionHostAccessSource): void;
  setSourceBindingReader?(reader: import('../session-reference.js').SourceBindingReader): void;
  /** Host validates committed ancestry; exact saved prefix handles may reconstruct preparation attachments. */
  setSourceReferenceAncestors?(resolve: (nativeSessionId: string, preparationHandle?: AgentPersistenceHandle) => Promise<readonly string[]>): void;
  sourceReferences?(): Promise<Array<{ nativeSessionId: string; sourceNativeSessionId: string }>>;
  /** The source a session references through the grant it holds or inherits; none for a session without one. */
  sourceReference?(nativeSessionId: string): Promise<import('../session-reference.js').SourceReferenceState | undefined>;
  /** Removes or restores a session's source reference; true when that changed it. */
  setSourceReferenceRemoved?(nativeSessionId: string, removed: boolean): Promise<boolean>;
  /** Native history copy only; role succession and task ownership are separate. */
  forkSession?(nativeSessionId: string): Promise<string>;
  list(): Promise<readonly RemoteSessionSummary[]> | readonly RemoteSessionSummary[];
  workspaces(): Promise<readonly AgentHostWorkspace[]> | readonly AgentHostWorkspace[];
  models?(): Promise<unknown> | unknown;
  create(input: Omit<AgentSessionConfig, 'sessionId'> & { workspaceId?: string; sourceNativeSessionId?: string; editNativeSessionId?: string; editTurnId?: string; editMessageId?: string }, evidence?: DirectoryMutationEvidence): Promise<string>;
  setSessionHandoffAdmission?(handler: (nativeSessionId: string, current: NativeOwnerIdentity, next: NativeOwnerIdentity) => NativeHandoffGrant): void;
  setSessionHandoffHandler?(handler: (nativeSessionId: string, next: NativeOwnerIdentity) => Promise<void>): void;
  open(nativeSessionId: string, options?: { takeOver?: string; extensions?: AgentSessionExtensions; nativeCreation?: AgentEmptyCreationResult; nativePrefix?: AgentPersistenceHandle; resumeHandle?: AgentPersistenceHandle; resumeOptions?: AgentSessionResumeOptions }): Promise<AgentSession>;
  openChild?(parentNativeSessionId: string, nativeSessionId: string): Promise<AgentSession>;
  close(): Promise<void> | void;
}
export interface AgentHostProviderRegistration {
  adapter: AgentProviderAdapter;
  directory: AgentHostDirectory;
  preservesWorkOnDisconnect?: boolean;
  /** Trust native permission controls without disabling Host workspace admission. */
  nativePermissionControl?: boolean;
  /** Version reported by the native CLI this registration runs. */
  nativeVersion?: string;
}
export interface AgentHostRuntimeOptions {
  /** Trusted process configuration; never read from a create request. */
  controllerId?: string;
  registrations: readonly AgentHostProviderRegistration[];
  providerEnabled?: (providerId: string) => boolean;
  onRequestDiagnostic?: (diagnostic: AgentHostRequestDiagnostic) => void;
  idleGraceMs?: number;
  idleReconcileMs?: number;
  onSessionLifecycleDiagnostic?: (diagnostic: { event: 'session_idle_released' | 'session_idle_restored' | 'session_idle_reconciled'; agentId: string; providerId: string }) => void;
  /** Told what the journal publisher could not publish. The entries carry no conversation content. */
  onJournalDiagnostic?: (diagnostic: JournalPublisherDiagnostic) => void;
  shutdownTimeoutMs?: number;
  cancelTimeoutMs?: number;
  executionPolicy?: HostExecutionPolicy;
  operationCache?: OperationCacheOptions;
  tpm?: TpmOptions;
  team?: { stateDirectory: string; request?: (call: TeamHostCall) => Promise<unknown>; tickMs?: number;
    /** The Relay routes Team recipients across a generic succession of their session. */
    genericSuccession?(): boolean;
    /** The Relay runs tasks for this Controller's sessions. */
    tasks?(): boolean };
  /** Internal wiring until provider readiness and product projection are certified together. */
  succession?: { controllerId: string; enrollment?: true } & ({
    stateDirectory: string;
    /** The role and context state files; the default is the disk under `stateDirectory`. `storeBytes` lowers the ceiling of one state file. */
    files?: { roles?: StateFiles; contexts?: StateFiles; storeBytes?: number };
    /** Adapter-owned evidence. No provider is inferred to support succession from idle status. */
    native?: Pick<SessionSuccessionPorts, 'supports' | 'supportsBoundedProjection' | 'createIdle' | 'reconcileDelivery'> & {
      inspect: (source: NativeSessionRef) => Promise<Omit<import('../local-succession-preparation.js').SuccessionReadiness, 'boundary' | 'inFlightInputs'>>;
    };
  } | {
    store: SessionSuccessionStore;
    contexts: SessionSuccessionContextStore;
    coordinator: SessionSuccessionCoordinator;
  });
  inputImages?: InputImageStoreOptions;
  inputResources?: InputResourceStoreOptions;
  /** Where each session's latest reply is kept across restarts; without it, replies are known only while this process runs. */
  sessionRepliesFile?: string;
  /** Where the secret of stable resource ids is kept; without it resource ids are random per process. */
  resourceIdKeyFile?: string;
  /** Where the resources that stay readable across a restart are remembered; used only with `resourceIdKeyFile`. */
  resourceIdIndexFile?: string;
  /** Delivers messages that waited on the Relay for this Host; receipts of claimed messages are kept in file. */
  outbox?: { file: string; request(call: OutboxHostCall): Promise<unknown> };
  /** Credentials through which sessions' shell commands reach this Controller as themselves. */
  sessionCallers?: { store: SessionCallerStore; endpoint: SessionCallerEndpoint; skills?: string; sessionBin?: string };
  /** The sessions each session refers to; without it, sessions have only their source. */
  sessionRefs?: SessionRefStore;
  /** This Host's identity at the Relay, once registered; session addresses start with it. */
  hostId?: () => Promise<string | undefined>;
  /** The website's origin, where session links open. */
  siteOrigin?: () => string | undefined;
}
export interface AgentHostRequestDiagnostic {
  event: 'host_request_started' | 'host_request_completed';
  requestId: string;
  operation: 'session_attach' | 'session_create' | 'catalog_read' | 'host_control';
  elapsedMs: number;
  status?: number;
  code?: string;
  /**
   * The native session an attach opens, so a repeating failure names its session. Like Codex request
   * diagnostics, the log carries a digest of the native identity rather than the identity itself.
   */
  providerId?: string;
  sessionRef?: string;
  /** The result repeats an earlier native start failure instead of starting the session again. */
  backoff?: true;
  /** The class and code of the error behind a generic failure; native error text can carry content, so it is never recorded. */
  cause?: string;
}
export interface AgentHostRuntime {
  readonly executionRouting?: SessionExecutionRouting;
  /** Role routing, which Team recipients follow across every committed succession. */
  readonly roleRouting?: SessionExecutionRouting;
  readonly relay: AgentRemoteRelay;
  /** Session states the Relay shares with the owner's pages. */
  readonly sessionStates: SessionStatePublisher;
  /** Publishes the sessions of providers that declare journal support to their journals on the Relay. */
  readonly journals: JournalPublisher;
  /** The Host's sessions as session commands read them. */
  readonly sessionCatalog: SessionCallerCatalog;
  /** The sessions each session refers to, for session commands; absent without a reference store. */
  readonly sessionRefs?: SessionRefContext;
  /** Messages that waited on the Relay for this Host, delivered while the Relay acknowledges the outbox. */
  readonly outbox?: SessionOutbox;
  /** Answers one session command; forward sends requests naming other Hosts to them. */
  callSession(request: unknown, caller: SessionCaller, forward?: (hostId: string, request: Record<string, unknown>) => Promise<SessionCallResult>): Promise<SessionCallResult>;
  /** Answers one role command of the session that asks. */
  callRole(request: unknown, caller: SessionCaller): Promise<SessionCallResult>;
  addRegistration(registration: AgentHostProviderRegistration): void;
  control(request: RemoteHostControlRequest): Promise<AgentRemoteHttpResult>;
  enrollFromRelay(request: RemoteHostControlRequest, context: TrustedSuccessionContext): Promise<AgentRemoteHttpResult>;
  executeOperation(scope: string): SessionWireOperationExecutor;
  acquireSession(agentId: string): Promise<RemoteHostSessionLease | undefined>;
  setRelayConnected(connected: boolean): void;
  /** The complete set of this Host's sessions that pages show (`journal_shown`), as journal session keys; they stay resident. */
  sessionsShown(sessionKeys: readonly string[]): void;
  beginControllerRestart(): boolean;
  cancelControllerRestart(): void;
  resolveSession(agentId: string): ReturnType<AgentRemoteRelay['requireAgent']> | undefined;
  close(): Promise<void>;
}
/** A session's binding: the Controller-local handle of its runtime, and the native session it holds. */
export interface SessionBinding { agentId: string; providerId: string; nativeSessionId: string; parentNativeSessionId?: string }
