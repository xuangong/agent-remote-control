import { TeamRuntime } from './team.js';
import { isTeamSeat, type TeamHostCall } from '@orchardworks/agent-remote-protocol';
import { directoryNativeEffect, directoryOperationId, type DirectoryMutationEvidence } from './directory-mutation.js';
import { admitNativeOwnerTransfer } from './native-owner-admission.js';
import { isCreationSource } from '@orchardworks/agent-remote-protocol';
import { SessionSuccessionEnrollment } from './session-succession-enrollment.js';
import { successionTpmRouting } from './session-succession-tpm.js';
import { SessionSuccessionService, type SessionSuccessionPorts, type SessionExecutionRouting } from './session-succession-service.js';
import { captureSuccessionTimeline } from './session-succession-capture.js';
import { SuccessionPreparationRejected, successionCreationHandle, nativePrefixResumeHandle, type NativePromptEditTarget, type RetainedSuccessionVerification } from './local-succession-preparation.js';
import { SessionSuccessionBoundary } from './session-succession-boundary.js';
import { SOURCE_WITNESS_RESULT_BYTES, validSourceWitnessIdentity, type SessionSuccessionStore } from './session-succession-store.js';
import { jsonBytes } from './succession-persistence.js';
import type { SessionSuccessionContextStore } from './session-succession-context.js';
import type { SessionSuccessionCoordinator } from './session-succession.js';
import { nativeSessionRefKey, nativePrefixSegmentAncestors, isNativeSessionRef, isSuccessionRequest, type NativeSessionRef, type NativePrefixSelection, type TrustedSuccessionContext } from '@orchardworks/agent-remote-protocol';
import { TpmCoordinator, type TpmOptions, type TpmSessionAccess } from './tpm.js';
import { isTpmCreate, isTpmAction } from '@orchardworks/agent-remote-protocol';
import { SessionBindings, SessionBindingError } from '@orchardworks/agent-remote-relay';
import { createNativeStartBackoff, nativeStartTarget } from './native-start-backoff.js';
import type { HostProviderDiscovery } from './provider-discovery.js';
import {NativeSessionOwnerError, type NativeOwnerIdentity, type NativeHandoffGrant} from './native-session-owner.js';
import { createCodexDaemonControl } from './codex-daemon-control.js';
import { RELAY_DIAGNOSTIC_PATH, parseRelayDiagnosticBatch, type RelayDiagnostic } from '@orchardworks/agent-remote-hosted/relay-diagnostics';
import { createControllerUpdater } from './controller-update.js';
import type { ControllerIdentity, ControllerUpdateStatus } from '@orchardworks/agent-remote-protocol';
import { createIdleSessions } from './idle-sessions.js';
import { browseWorkspaceFolders, createWorkspaceFolder, WorkspaceFolderError } from './workspace-folders.js';
import { allowedWorkspace, HostExecutionPolicyError, protectHostDirectory, type HostExecutionPolicy } from './execution-policy.js';
import { createControllerPreviews } from './previews.js';
import { createVscodeTunnelManager, type VscodeTunnelOptions } from './vscode-tunnel.js';
import { createOperationCache, OperationCacheError, type OperationCacheOptions } from '@orchardworks/agent-remote-relay';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import type { AgentProviderAdapter, AgentSession, AgentSessionConfig, AgentSessionExtensions, AgentEmptyCreationResult, AgentNativeValidityToken, AgentPersistenceHandle, AgentSessionResumeOptions } from '@orchardworks/agent-provider-sdk';
import { AgentOperationRejectedError, AgentSessionInUseError, AgentRuntimeError, serializeAgentEmptyCreationResult, serializeAgentInputMaterialization } from '@orchardworks/agent-provider-sdk';
import { PROTOCOL_VERSION, type HostEnvironment } from '@orchardworks/agent-remote-protocol';
import { InputImageStore, type InputImageStoreOptions, InputResourceStore, type InputResourceStoreOptions, createAgentRemoteRelay, createRemoteHostUplinkClient, type AgentRemoteHttpResult, type AgentRemoteRelay,
  RemoteHostCatalog, RemoteHostCatalogError, UnsupportedAgentCapabilityError, type RemoteHostControlRequest, type RemoteHostUplinkClient, type RemoteHostUplinkDiagnostic, type RemoteSessionSummary,
  type RemoteHostSessionLease, type SessionWireAgent, type SessionWireOperationExecutor } from '@orchardworks/agent-remote-relay';

export interface AgentHostWorkspace { id: string; name: string; path: string }
export interface AgentHostDirectory {
  readonly providerId: string;
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
  reconcileIdleSession?(nativeSessionId: string): Promise<boolean>;
  sessionReleased?(nativeSessionId: string): Promise<void> | void;
  sessionWorkspace?(nativeSessionId: string, handle?: AgentPersistenceHandle): Promise<string | undefined>;
  setSourceAccessCheck?(check: (nativeSessionId: string) => Promise<void>): void;
  setSourceBindingReader?(reader: import('./session-reference.js').SourceBindingReader): void;
  /** Host validates committed ancestry; exact saved prefix handles may reconstruct preparation attachments. */
  setSourceReferenceAncestors?(resolve: (nativeSessionId: string, preparationHandle?: AgentPersistenceHandle) => Promise<readonly string[]>): void;
  sourceReferences?(): Promise<Array<{ nativeSessionId: string; sourceNativeSessionId: string }>>;
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
  shutdownTimeoutMs?: number;
  cancelTimeoutMs?: number;
  executionPolicy?: HostExecutionPolicy;
  operationCache?: OperationCacheOptions;
  tpm?: TpmOptions;
  team?: { stateDirectory: string; request?: (call: TeamHostCall) => Promise<unknown>; tickMs?: number };
  /** Internal wiring until provider readiness and product projection are certified together. */
  succession?: { controllerId: string; enrollment?: true } & ({
    stateDirectory: string;
    /** Adapter-owned evidence. No provider is inferred to support succession from idle status. */
    native?: Pick<SessionSuccessionPorts, 'supports' | 'supportsBoundedProjection' | 'createIdle' | 'reconcileDelivery'> & {
      inspect: (source: NativeSessionRef) => Promise<Omit<import('./local-succession-preparation.js').SuccessionReadiness, 'boundary' | 'inFlightInputs'>>;
    };
  } | {
    store: SessionSuccessionStore;
    contexts: SessionSuccessionContextStore;
    coordinator: SessionSuccessionCoordinator;
  });
  inputImages?: InputImageStoreOptions;
  inputResources?: InputResourceStoreOptions;
}
export interface AgentHostRequestDiagnostic {
  event: 'host_request_started' | 'host_request_completed';
  requestId: string;
  operation: 'session_attach' | 'session_create' | 'catalog_read' | 'host_control';
  elapsedMs: number;
  status?: number;
  code?: string;
}
export interface AgentHostRuntime {
  readonly executionRouting?: SessionExecutionRouting;
  readonly relay: AgentRemoteRelay;
  addRegistration(registration: AgentHostProviderRegistration): void;
  control(request: RemoteHostControlRequest): Promise<AgentRemoteHttpResult>;
  enrollFromRelay(request: RemoteHostControlRequest, context: TrustedSuccessionContext): Promise<AgentRemoteHttpResult>;
  executeOperation(scope: string): SessionWireOperationExecutor;
  acquireSession(agentId: string): Promise<RemoteHostSessionLease | undefined>;
  setRelayConnected(connected: boolean): void;
  beginControllerRestart(): boolean;
  cancelControllerRestart(): void;
  resolveSession(agentId: string): ReturnType<AgentRemoteRelay['requireAgent']> | undefined;
  close(): Promise<void>;
}
export interface AgentHostOptions extends AgentHostRuntimeOptions {
  providerDiscovery?: HostProviderDiscovery;
  codexDaemon?: { stateDir: string; restart(operationId: string): Promise<void> };
  controller?: { identity: ControllerIdentity; stateDir: string; restart(version: string, clean?: boolean): void | Promise<void> };
  vscodeTunnel?: Omit<VscodeTunnelOptions, 'installationId'>;
  preview?: { stateDirectory: string; ttlMs?: number; protectedPorts?: number[]; diagnostic?(event: string): void };
  /** Owner-visible Controller failure signals; see controller-health.ts. */
  health?: { snapshot(): object };
  installationId: string;
  name: string;
  environment?: HostEnvironment;
  onRelayDiagnostics?: (entries: RelayDiagnostic[]) => void | Promise<void>;
  onDiagnostic?: (diagnostic: AgentHostUplinkDiagnostic) => void | Promise<void>;
  uplink: { url: string; remoteKey: string; onCredential?: (credential: string) => Promise<void> };
}
export interface AgentHostUplinkDiagnostic extends RemoteHostUplinkDiagnostic { uplinkGeneration: number }
export interface AgentHost {
  readonly ready: Promise<{ hostId: string }>;
  controllerInfo(): Promise<{ identity: ControllerIdentity | undefined; status: ControllerUpdateStatus | undefined }>;
  updateController(version: string, operationId: string, clean?: boolean): Promise<ControllerUpdateStatus>;
  shareContext(): Promise<{ hostId: string; providers: Array<{ providerId: string; displayName: string }> }>;
  shareCatalog(query: { hostId: string; providerId: string; nativeSessionId?: string; cursor?: string }): Promise<AgentRemoteHttpResult>;
  readonly state: 'connecting' | 'registered' | 'disconnected' | 'rejected' | 'closed';
  replaceUplink(uplink: AgentHostOptions['uplink']): Promise<{ hostId: string }>;
  close(): Promise<void>;
}

export function createAgentHost(options: AgentHostOptions): AgentHost {
  if (options.succession?.enrollment && options.succession.controllerId !== options.installationId) throw new Error('Succession Controller identity must match the installed Controller.');
  const stateDirectory = options.preview?.stateDirectory ?? options.vscodeTunnel?.stateDirectory;
  const runtime = createAgentHostRuntime({ ...options, ...(options.team ? { team: { ...options.team, request: (call: TeamHostCall) => connection.client.teamRequest(call) } } : {}), controllerId: options.installationId,
    ...(options.inputImages ? {} : stateDirectory ? { inputImages: { directory: join(stateDirectory, 'input-images') } } : {}),
    ...(options.inputResources ? {} : stateDirectory ? { inputResources: { directory: join(stateDirectory, 'input-resources') } } : {}) });
  options.providerDiscovery?.onRegistration(runtime.addRegistration);
  runtime.setRelayConnected(false);
  const updater = options.controller ? createControllerUpdater({ ...options.controller, beginRestart: runtime.beginControllerRestart, cancelRestart: runtime.cancelControllerRestart }) : undefined;
  const codexDaemon = options.codexDaemon ? createCodexDaemonControl(options.codexDaemon) : undefined;
  const previews = options.preview ? createControllerPreviews(options.preview) : undefined;
  const vscodeTunnel = options.vscodeTunnel ? createVscodeTunnelManager({ ...options.vscodeTunnel, installationId: options.installationId }) : undefined;
  let state: AgentHost['state'] = 'connecting';
  let generation = 0;
  let closed = false;
  interface Connection { client: RemoteHostUplinkClient; superseded: boolean }
  let connection: Connection;
  let credentialPersistence: Promise<void> = Promise.resolve();
  const describeProviders = () => options.registrations.filter(item => options.providerEnabled?.(item.directory.providerId) !== false).map(({ adapter, directory }) => ({ providerId: adapter.descriptor.providerId, displayName: adapter.descriptor.displayName, ...(codexDaemon && adapter.descriptor.providerId === 'codex' ? { daemonControl: true as const } : {}), ...(directory.renameSession ? { sessionRename: true as const } : {}), ...(directory.supportsPromptEditing ? { promptEditing: true as const } : {}) }));
  const connect = (config: AgentHostOptions['uplink']): Connection => {
    runtime.setRelayConnected(false);
    const current = ++generation;
    return { superseded: false, client: createRemoteHostUplinkClient({ relay: runtime.relay, installationId: options.installationId, name: options.name, environment: options.environment, controller: options.controller?.identity,
      ...(options.team ? { teamManagement: true } : {}),
      ...(options.tpm ? { tpmManagement: true } : {}),
      ...(options.succession?.enrollment ? { successionEnrollment: { control: runtime.enrollFromRelay } } : {}),
      providers: describeProviders(), ...(options.providerDiscovery ? { providerChanges: { current: describeProviders, subscribe: options.providerDiscovery.subscribe } } : {}), url: config.url, remoteKey: config.remoteKey,
      onCredential: config.onCredential ? credential => {
        const pending = credentialPersistence.catch(() => undefined).then(async () => {
          if (generation !== current || closed) throw new Error('Host credential persistence was superseded.');
          await config.onCredential!(credential);
        });
        credentialPersistence = pending;
        return pending;
      } : undefined,
      resolveSession: runtime.resolveSession, acquireSession: runtime.acquireSession, control: async request => request.method === 'POST' && request.path === RELAY_DIAGNOSTIC_PATH ? receiveRelayDiagnostics(request.body, options.onRelayDiagnostics) : request.path === '/remote/controller-update' ? (async () => {
        try {
          if (request.method === 'GET') {
            if (!updater && !options.onRelayDiagnostics) return { status: 404, body: '' };
            // Health rides on the update status, which every Relay already forwards to the owner unchanged.
            return { status: 200, body: JSON.stringify({ ...(await updater?.status()), ...(options.onRelayDiagnostics ? { diagnosticDelivery: 3 } : {}),
              ...(options.health ? { health: options.health.snapshot() } : {}) }) };
          }
          if (!updater) return { status: 404, body: '' };
          const body = JSON.parse(request.body ?? '{}');
          return { status: 202, body: JSON.stringify(await updater.request(body.version, body.operationId)) };
        } catch (error) { return { status: 409, body: JSON.stringify({ error: error instanceof Error ? error.message : 'Controller update failed.',
          ...(request.method === 'GET' && options.onRelayDiagnostics ? { diagnosticDelivery: 3 } : {}) }) }; }
      })() : request.path === '/remote/provider-settings' && options.providerDiscovery ? options.providerDiscovery.control(request) : request.path === '/remote/codex-daemon' && codexDaemon ? codexDaemon.control(request) : request.path.startsWith('/remote/vscode-tunnel') && vscodeTunnel ? vscodeTunnel.control(request)
        : request.path.startsWith('/remote/previews') && previews ? previews.control(request) : runtime.control(request),
      operationExecutor: scope => runtime.executeOperation(scope),
      previews: previews ? { snapshot: previews.snapshot, subscribe: previews.subscribe, disconnected: previews.disconnected,
        registered: info => previews.registered({ ...info, url: config.url }) } : undefined,
      onDiagnostic: options.onDiagnostic ? diagnostic => options.onDiagnostic!({ ...diagnostic, uplinkGeneration: current }) : undefined,
      onStateChange(next) { if (generation === current && !closed) { state = next; runtime.setRelayConnected(next === 'registered'); vscodeTunnel?.setRelayConnected(next === 'registered'); } } }) };
  };
  connection = connect(options.uplink);
  const ready = connection.client.ready;
  async function shareContext() {
    if (closed || state !== 'registered') throw new Error('The Host is not registered. Wait for reconnection, then run share again.');
    const current = connection;
    const { hostId } = await current.client.ready;
    if (current !== connection || closed || state !== 'registered') throw new Error('The Host connection changed. Run share again.');
    return { hostId, providers: options.registrations.filter(item => options.providerEnabled?.(item.directory.providerId) !== false).map(({ adapter }) => ({
      providerId: adapter.descriptor.providerId, displayName: adapter.descriptor.displayName })) };
  }
  let closePromise: Promise<void> | undefined;
  return {
    ready,
    get state() { return state; },
    shareContext,
    async controllerInfo() { return { identity: options.controller?.identity, status: await updater?.status() }; },
    async updateController(version, operationId, clean) {
      if (!updater || closed) throw new Error('Controller updates are unavailable.');
      return updater.request(version, operationId, clean);
    },
    async shareCatalog(query) {
      const current = connection;
      if ((await shareContext()).hostId !== query.hostId) throw new Error('The Host connection changed. Run share again.');
      const params = new URLSearchParams({ providerId: query.providerId });
      if (query.nativeSessionId !== undefined) params.set('nativeSessionId', query.nativeSessionId);
      else { params.set('limit', '20'); if (query.cursor) params.set('cursor', query.cursor); }
      const result = await runtime.control({ requestId: randomUUID(), method: 'GET',
        path: `/remote/catalog${query.nativeSessionId !== undefined ? '/session' : ''}?${params}` });
      if (current !== connection || closed || state !== 'registered') throw new Error('The Host connection changed. Run share again.');
      return result;
    },
    async replaceUplink(config) {
      if (closed) throw new Error('Agent Host is closed.');
      const prior = connection;
      const requested = connect(config);
      connection = requested;
      prior.superseded = true;
      await prior.client.close();
      try { return await requested.client.ready; } catch (error) {
        if (requested.superseded) throw new Error('Agent Host uplink replacement was superseded.');
        throw error;
      }
    },
    close() { return closePromise ??= (async () => { closed = true; generation += 1; state = 'closed';
      connection.superseded = true;
      await bounded(Promise.allSettled([updater?.close(), connection.client.close(), previews?.close(), vscodeTunnel?.close(), runtime.close()]), options.shutdownTimeoutMs ?? 5000);
    })(); },
  };
}

/** Browsers poll catalog revisions every few seconds; a full native listing can take seconds, so checks reuse one this recent. */
const catalogRevisionMaxAgeMs = 15_000;

function hasCurrentNativeEvidence(owner: Pick<AgentProviderAdapter | AgentSession, 'nativeEvidence'>): boolean {
  const evidence = owner.nativeEvidence?.availability(); return evidence?.status === 'configured' && evidence.version === 2;
}

interface Binding { agentId: string; providerId: string; nativeSessionId: string; parentNativeSessionId?: string }

export function createAgentHostRuntime(options: AgentHostRuntimeOptions): AgentHostRuntime {
  if (options.executionPolicy) options = { ...options, registrations: options.registrations.map(registration => ({ ...registration,
    directory: protectHostDirectory(registration.directory, { ...options.executionPolicy!,
      lockPermissions: registration.nativePermissionControl ? false : options.executionPolicy!.lockPermissions }) })) };
  if (!options.registrations.length && !options.providerEnabled) throw new Error('Agent Host requires at least one provider registration.');
  const registrations = new Map<string, AgentHostProviderRegistration>();
  const prepared = new Map<string, AgentSession>();
  const nativeAttachments = new WeakMap<SessionWireAgent, { session: AgentSession; nativeCreation?: string; nativePrefix?: string }>();
  for (const registration of options.registrations) {
    const id = registration.adapter.descriptor.providerId;
    if (registration.directory.providerId !== id) throw new Error(`Directory provider identity does not match ${id}.`);
    if (registrations.has(id)) throw new Error(`Duplicate Agent Host provider: ${id}.`);
    registrations.set(id, registration);
  }
  const relayAdapters = options.registrations.map(({ adapter }) => ({
    descriptor: adapter.descriptor,
    async createSession(config: AgentSessionConfig) {
      const session = prepared.get(config.sessionId);
      if (!session) throw new Error('Agent Host projection session is unavailable.');
      prepared.delete(config.sessionId);
      return session;
    },
    resumeSession: adapter.resumeSession.bind(adapter),
  }));
  const successionConfig = options.succession;
  const nativeSuccession = successionConfig && 'stateDirectory' in successionConfig ? successionConfig.native : undefined;
  const successionService: SessionSuccessionService | undefined = successionConfig && 'stateDirectory' in successionConfig
    ? new SessionSuccessionService(successionConfig.stateDirectory, successionConfig.controllerId, {
      async supports(source, targetProviderId) {
        await authorizeSuccessionRead(source, source);
        const target = registration(targetProviderId);
        if (options.providerEnabled?.(targetProviderId) === false || !target.adapter.readSessionHistory
          || !target.directory.setSourceBindingReader || !target.directory.sourceReferences) return false;
        if (nativeSuccession) return await nativeSuccession.supports(source, targetProviderId) === true;
        return target.directory.supportsSourceReferences === true && hasCurrentNativeEvidence(target.adapter) && hasCurrentNativeEvidence(registration(source.providerId).adapter);
      },
      async supportsBoundedProjection(source, targetProviderId) {
        await authorizeSuccessionRead(source, source);
        if (nativeSuccession) return await nativeSuccession.supportsBoundedProjection?.(source, targetProviderId) === true;
        return boundedSourceIdentity(successionConfig.controllerId) && boundedSourceIdentity(targetProviderId) && hasCurrentNativeEvidence(registration(targetProviderId).adapter) && hasCurrentNativeEvidence(registration(source.providerId).adapter);
      },
      async supportsNativePrefix(source, selection) {
        await authorizeSuccessionRead(source, source);
        await nativePrefixExtensions(source, () => source.nativeSessionId);
        const directory = registration(source.providerId).directory;
        if (!boundedSourceIdentity(source.controllerId) || !boundedSourceIdentity(source.providerId) || !directory.createNativePrefix || !directory.verifyNativePrefix) return false;
        const lease = await acquireNative(source);
        try {
          const session = nativeAttachments.get(lease.agent)?.session;
          const handle = (await session?.runtimeInfo())?.persistence;
          if (!session?.promptEditEvidence || session.promptEditEvidence.version !== 1 || !handle) return false;
          nativePrefixResumeHandle(source.providerId, source.nativeSessionId, handle);
          return await directory.supportsNativePrefix?.({ nativeSessionId: source.nativeSessionId, turnId: selection.turnId, messageId: selection.messageId }) === true;
        } finally { lease.release(); }
      },
      async createNativePrefix(request, candidateKnown) {
        const selection = request.preparation;
        if (!selection) throw new Error('Native prefix selection is missing.');
        await authorizeSuccessionRead(request.from, request.from);
        let actual: string | undefined;
        const extensions = await nativePrefixExtensions(request.from, () => actual), directory = registration(request.from.providerId).directory;
        if (!directory.createNativePrefix) throw new Error('Native prefix creation is unavailable.');
        const handle = await directory.createNativePrefix({ nativeSessionId: request.from.nativeSessionId, turnId: selection.turnId, messageId: selection.messageId }, extensions, undefined, async handle => {
          actual = handle.sessionId;
          await candidateKnown({ target: { controllerId: request.from.controllerId, providerId: handle.providerId, nativeSessionId: handle.sessionId }, handle });
        });
        actual = handle.sessionId;
        return { target: { controllerId: request.from.controllerId, providerId: handle.providerId, nativeSessionId: handle.sessionId }, handle };
      },
      async verifyNativePrefix(prepared, handle) {
        const selection = prepared.preparation, directory = registration(prepared.from.providerId).directory;
        if (!selection || !directory.verifyNativePrefix) throw new Error('Native prefix verification is unavailable.');
        await directory.verifyNativePrefix({ nativeSessionId: prepared.from.nativeSessionId, turnId: selection.turnId, messageId: selection.messageId }, handle);
      },
      async inspect(source, preparation) {
        const lease = await acquireNative(source);
        try { return await inspectSuccession(source, lease, preparation); } finally { lease.release(); }
      },
      async selectNativeCreation(source, operationId, targetProviderId) {
        await authorizeSuccessionRead(source, source);
        const evidence = registration(targetProviderId).adapter.nativeEvidence;
        if (!hasCurrentNativeEvidence(registration(targetProviderId).adapter)) return undefined;
        const role = succession?.store.all().find(state => nativeSessionRefKey(state.role.current) === nativeSessionRefKey(source))?.role;
        if (!role) throw new Error('Native succession role is unavailable.');
        const config = { sessionId: directoryOperationId(operationId), cwd: role.workspace.canonicalCwd, ...(source.providerId === targetProviderId ? { selectionSourceSessionId: source.nativeSessionId } : {}) };
        return () => evidence!.createEmpty(config);
      },
      retainVerification,
      async createIdle(source, operationId, targetProviderId) {
        if (!nativeSuccession) throw new SuccessionPreparationRejected('succession_unsupported_provider', 'Idle candidate creation is unavailable.');
        await authorizeSuccessionRead(source, source);
        return nativeSuccession.createIdle(source, operationId, targetProviderId);
      },
      async captureTimeline(source) {
        await authorizeSuccessionRead(source, source);
        const lease = await acquireNative(source);
        try { return await captureSuccessionTimeline(lease.agent); } finally { lease.release(); }
      },
      authorizeRead: authorizeSuccessionRead,
      async readHistory(source, query) {
        await authorizeSuccessionRead(source, source);
        const adapter = registration(source.providerId).adapter;
        if (!adapter.readSessionHistory) throw new Error('Routed native history is unavailable.');
        return adapter.readSessionHistory(source.nativeSessionId, query);
      },
      async reconcileDelivery(delivery) {
        if (!delivery.preparedInput) return nativeSuccession?.reconcileDelivery(delivery);
        const lease = await acquireNative(delivery.target);
        try {
          const evidence = nativeAttachments.get(lease.agent)?.session.nativeEvidence;
          if (!evidence || evidence.availability().status !== 'configured' || (evidence.availability() as { version?: number }).version !== 2) return undefined;
          const result = await evidence.inspectInput(delivery.preparedInput.witness);
          return result.status === 'materialized' ? { outcome: 'materialized', nativeEvidence: serializeAgentInputMaterialization(result) } : undefined;
        } finally { lease.release(); }
      },
    }) : undefined;
  const succession: { controllerId: string; store: SessionSuccessionStore; contexts: SessionSuccessionContextStore; coordinator: SessionSuccessionCoordinator } | undefined = successionService ? { controllerId: successionConfig!.controllerId, store: successionService.store, contexts: successionService.contexts, coordinator: successionService.coordinator }
    : successionConfig && 'store' in successionConfig ? successionConfig : undefined;
  const successionReady = Promise.all([succession?.store.ready, succession?.contexts.ready, successionService?.ready]);
  void successionReady.catch(() => undefined);
  const nativeRef = (binding: Pick<Binding, 'providerId' | 'nativeSessionId'>): NativeSessionRef => ({
    controllerId: succession?.controllerId ?? options.controllerId ?? 'local', providerId: binding.providerId, nativeSessionId: binding.nativeSessionId,
  });
  const operationCache = createOperationCache(options.operationCache);
  const successionBoundary: SessionSuccessionBoundary | undefined = succession ? new SessionSuccessionBoundary(succession.contexts,
    target => succession.coordinator.assertAdmission(target), target => {
      const role = succession.store.all().find(state => nativeSessionRefKey(state.role.current) === nativeSessionRefKey(target))?.role;
      return role ? { roleId: role.id, roleRevision: role.revision } : undefined;
    }, operationCache, assertHandoffState, target => succession.coordinator.assertReservation(target), target => !!originalCreation(target), async operationId => { await successionService?.reconcileFirstInput(operationId); }) : undefined;
  succession?.coordinator.setAdmission(successionBoundary!);
  const relay = createAgentRemoteRelay({ providers: relayAdapters, operationCache, operationLifecycle: {
    settingIntent: (agent, accept) => successionBoundary ? successionBoundary.settingIntent(nativeRef(bindingFor(agent)), accept) : accept(),
    target: agent => { const binding = bindingFor(agent); return JSON.stringify([binding.providerId, binding.nativeSessionId]); },
    admit: () => { if (draining) throw new OperationCacheError('controller_updating', 'Controller is updating. Reconnect before retrying.'); },
    beforeDispatch: agent => { if (succession) succession.coordinator.assertAdmission(nativeRef(bindingFor(agent))); },
    mutationTargets: agent => succession ? [nativeSessionRefKey(nativeRef(bindingFor(agent)))] : [],
    admission: (agent, _operation, _scope, entry) => {
      if (!successionBoundary || !succession) return () => {};
      const target = nativeRef(bindingFor(agent));
      try { succession.coordinator.assertAdmission(target); }
      catch (error) { throw new OperationCacheError('operation_rejected', error instanceof Error ? error.message : 'Session handoff admission is closed.'); }
      return successionBoundary.admit([target], entry.key);
    },
    run: (_agent, operation, scope, entry, work) => successionBoundary ? successionBoundary.run(operation, scope, work, entry) : work(),
    dispatch: async (agent, operation, scope, work) => {
      const result = await work();
      return successionBoundary ? successionBoundary.inputResult(nativeRef(bindingFor(agent)), operation, scope, result) : result;
    },
    retain: agent => idle.retain(bindingFor(agent).agentId),
    uncertain: agent => { uncertainAgents.add(bindingFor(agent).agentId); },
  }, ...(options.inputImages ? { inputImageStore: new InputImageStore(options.inputImages) } : {}),
    ...(options.inputResources ? { inputResourceStore: new InputResourceStore(options.inputResources) } : {}) });
  const catalogs = new Map(options.registrations.map(({ directory }) => [directory.providerId, new RemoteHostCatalog({ roots: directory.list, revisionMaxAgeMs: catalogRevisionMaxAgeMs })]));
  const bindings = new SessionBindings();
  const pending = new Set<Promise<unknown>>();
  const idle = createIdleSessions({ graceMs: options.idleGraceMs, reconcileMs: options.idleReconcileMs });
  const uncertainAgents = new Set<string>();
  const cancelTimeoutMs = positiveTimeout(options.cancelTimeoutMs ?? 5000);
  const shutdownTimeoutMs = positiveTimeout(options.shutdownTimeoutMs ?? 5000);
  let draining = false;
  let closed = false;
  let closePromise: Promise<void> | undefined;

  function assertHandoffState(target: NativeSessionRef, captured?: { epoch: string; seq: number }, allowMissing = false): void {
    const family = nativeFamily(target.providerId, target.nativeSessionId);
    const own = family.find(binding => binding.nativeSessionId === target.nativeSessionId);
    if (!own && allowMissing) return;
    const state = own && liveAgent(own.agentId)?.handoffAdmissionState();
    if (!state || !state.connected || !state.synchronized || state.closed || state.status !== 'idle' || state.activeTurn
      || state.pendingInteractions || state.commandWork || state.settingWork || (tpm?.hasUnsettledRecipient(target) || team?.hasUnsettledRecipient(target))) {
      throw new SuccessionPreparationRejected('succession_not_quiescent', 'Session has active, unknown or unsynchronized Host work.');
    }
    const cursor = own && liveAgent(own.agentId)?.timelineCursor();
    if (captured && (!cursor || cursor.epoch !== captured.epoch || cursor.seq !== captured.seq)) throw new SuccessionPreparationRejected('succession_boundary_changed', 'Source history changed beyond the captured handoff boundary.');
    for (const child of family.filter(binding => binding !== own)) {
      const childState = liveAgent(child.agentId)?.handoffAdmissionState();
      if (!childState || !childState.connected || !childState.synchronized || childState.activeTurn || childState.status !== 'idle'
        || childState.pendingInteractions || childState.commandWork || childState.settingWork) throw new SuccessionPreparationRejected('succession_not_quiescent', 'Session has unresolved child work.');
    }
  }
  function nativeFamily(providerId: string, nativeSessionId: string): Binding[] {
    const ids = new Set([nativeSessionId]);
    const family: Binding[] = [];
    for (;;) {
      const found = [...bindings.values()].filter(binding => binding.providerId === providerId && !family.includes(binding)
        && (binding.nativeSessionId === nativeSessionId || binding.parentNativeSessionId && ids.has(binding.parentNativeSessionId)));
      if (!found.length) return family;
      for (const binding of found) {family.push(binding); ids.add(binding.nativeSessionId);}
    }
  }
  function mutationFamily(targets: readonly NativeSessionRef[]): NativeSessionRef[] {
    return [...new Map(targets.flatMap(target => [target, ...nativeFamily(target.providerId, target.nativeSessionId).map(nativeRef)])
      .map(target => [nativeSessionRefKey(target), target] as const)).values()];
  }
  function directoryOperation<T>(scope: string, operationId: string, kind: string, targets: readonly NativeSessionRef[], parameters: unknown,
    dispatch: () => Promise<T>, validate?: () => Promise<void>): Promise<T> {
    const captured = mutationFamily(targets);
    const association = kind === 'relation_reserve';
    return operationCache.execute({ operationId: directoryOperationId([kind, operationId]), scope, kind,
      target: JSON.stringify(targets.map(nativeSessionRefKey)), parameters }, {
      mutationTargets: captured.map(nativeSessionRefKey), admit: entry => association
        ? successionBoundary?.admitAssociation(captured, entry.key) : successionBoundary?.admit(captured, entry.key),
      run: (entry, work) => successionBoundary ? successionBoundary.run({ operationId, kind: 'execute_command', parameters: {}, maximumResultBytes: 256 * 1024 }, scope, work, entry) : work(),
      validate, beforeDispatch: () => association ? successionBoundary?.recheckAssociation(captured) : successionBoundary?.recheck(captured), dispatch, maximumResultBytes: 256 * 1024,
    });
  }
  function bindHandoff(directory: AgentHostDirectory) {
    if (successionBoundary) directory.setSessionHandoffAdmission?.((nativeSessionId, current, next) =>
      admitNativeOwnerTransfer(operationCache, successionBoundary, mutationFamily([nativeRef({ providerId: directory.providerId, nativeSessionId })]), current, next));
    directory.setSessionHandoffHandler?.(async (nativeSessionId, next) => {
    await tpm?.handoff(directory.providerId, nativeSessionId);
    const family = nativeFamily(directory.providerId, nativeSessionId);
    for (const binding of family) relay.sessionControls?.setNativeOwner(binding.agentId, next);
    for (const binding of family.reverse()) await relay.closeAgent(binding.agentId);
  }); }
  function bindSourceReader(directory: AgentHostDirectory) {
    if (!successionService) return;
    directory.setSourceBindingReader?.(async (reader, source, query, legacyRead, canonicalReader) => {
      await successionReady;
      return successionService.bindings(directory.providerId).read(reader, source, query, legacyRead, canonicalReader);
    });
  }
  for (const {directory} of registrations.values()) { bindHandoff(directory); bindSourceReader(directory); bindSourceReferenceAncestry(directory); }
  function bindSourceReferenceAncestry(directory: AgentHostDirectory) {
    if (!successionService) return;
    directory.setSourceReferenceAncestors?.(async (id, preparationHandle) => {
      await successionReady;
      let target = nativeRef({ providerId: directory.providerId, nativeSessionId: id });
      if (preparationHandle) {
        const saved = originalNativePrefix(target);
        if (!saved || JSON.stringify(saved.handle) !== JSON.stringify(preparationHandle)) throw new Error('Source attachment lacks exact saved native prefix evidence.');
        target = saved.source;
      }
      const ancestry = nativePrefixSegmentAncestors(target, successionService.store.all().flatMap(state => state.operations.filter(row => row.phase === 'committed')));
      return [...new Set([...ancestry.map(ref => ref.nativeSessionId), id])];
    });
  }
  function originalCreation(target: NativeSessionRef): AgentEmptyCreationResult | undefined {
    let result: AgentEmptyCreationResult | undefined;
    for (const state of succession?.store.all() ?? []) for (const operation of state.operations) {
      const progress = succession!.store.progress(operation.operationId);
      const candidate = operation.to ?? progress?.orphanCandidate;
      if (!candidate || nativeSessionRefKey(candidate) !== nativeSessionRefKey(target)) continue;
      const evidence = progress?.nativeCreation;
      if (!evidence) continue;
      const outcome = evidence.outcome;
      if (!outcome || outcome.status === 'not_dispatched') throw new Error('Native creation evidence is not resumable.');
      successionCreationHandle(target.providerId, target.nativeSessionId, outcome);
      if (result && serializeAgentEmptyCreationResult(result) !== serializeAgentEmptyCreationResult(outcome)) throw new Error('Native creation attachment identity conflicts.');
      result = outcome;
    }
    return result;
  }
  function originalNativePrefix(target: NativeSessionRef): { handle: AgentPersistenceHandle; source: NativeSessionRef } | undefined {
    let result: { handle: AgentPersistenceHandle; source: NativeSessionRef } | undefined;
    for (const state of succession?.store.all() ?? []) for (const operation of state.operations) {
      const progress = succession!.store.progress(operation.operationId), candidate = operation.to ?? progress?.orphanCandidate;
      if (!candidate || nativeSessionRefKey(candidate) !== nativeSessionRefKey(target) || !operation.preparation) continue;
      if (!progress?.nativePrefix?.handle || progress.nativeCreation) throw new Error('Original native prefix evidence is unavailable.');
      const handle = nativePrefixResumeHandle(target.providerId, target.nativeSessionId, progress.nativePrefix.handle);
      if (result && (JSON.stringify(result.handle) !== JSON.stringify(handle) || nativeSessionRefKey(result.source) !== nativeSessionRefKey(operation.from))) throw new Error('Native prefix attachment identity conflicts.');
      result = { handle, source: operation.from };
    }
    return result;
  }
  /** Rebuild each native attachment from stable role anchors and its own actual recipient. */
  async function nativePrefixExtensions(source: NativeSessionRef, actual: () => string | undefined): Promise<AgentSessionExtensions> {
    const directory = registration(source.providerId).directory;
    const ancestry = nativePrefixSegmentAncestors(source, successionService!.store.all().flatMap(state => state.operations.filter(row => row.phase === 'committed')));
    const grants = (await directory.sourceReferences?.() ?? []).filter(grant => ancestry.some(ref => ref.nativeSessionId === grant.nativeSessionId));
    if (grants.length > 1) throw new Error('Source reference ancestry is ambiguous.');
    const sourceTools = grants.length === 1 && !!directory.setSourceReferenceAncestors && !!directory.setSourceBindingReader;
    const teamTools = await team?.extensions(source.providerId, source.nativeSessionId, actual);
    const tpmTools = await tpm?.extensions(source.providerId, source.nativeSessionId, actual);
    if (teamTools && tpmTools) throw new SuccessionPreparationRejected('succession_prefix_extensions_unavailable', 'Native recipient has conflicting role extensions.');
    if (directory.requiresController?.(source.nativeSessionId) && !sourceTools && !teamTools && !tpmTools) throw new SuccessionPreparationRejected('succession_prefix_extensions_unavailable', 'Native prefix extensions cannot be reconstructed.');
    return teamTools ?? tpmTools ?? {};
  }
  async function authorizeSuccessionRead(reader: NativeSessionRef, source: NativeSessionRef): Promise<void> {
    for (const target of [reader, source]) {
      const creation = originalCreation(target), prefix = originalNativePrefix(target);
      if (target.controllerId !== (successionConfig?.controllerId ?? options.controllerId ?? 'local')) throw new HostExecutionPolicyError('Source is outside this Controller.');
      if (options.providerEnabled?.(target.providerId) === false) throw new HostExecutionPolicyError('Source provider is disabled.');
      const directory = registration(target.providerId).directory;
      const cwd = directory.sessionWorkspace ? await directory.sessionWorkspace(target.nativeSessionId, prefix?.handle ?? (creation?.status === 'created' ? creation.handle : undefined))
        : (await directory.list()).find(item => item.nativeSessionId === target.nativeSessionId)?.workspace;
      if (!cwd) throw new HostExecutionPolicyError('Source workspace is unavailable.');
      if (options.executionPolicy) await allowedWorkspace(options.executionPolicy, cwd);
    }
  }
  async function inspectSuccession(source: NativeSessionRef, lease: RemoteHostSessionLease, preparation?: NativePrefixSelection) {
    const session = nativeAttachments.get(lease.agent)?.session;
    if (preparation ? !session?.promptEditEvidence || session.promptEditEvidence.version !== 1 : !nativeSuccession && (!session || !hasCurrentNativeEvidence(session))) throw new SuccessionPreparationRejected('succession_unsupported_provider', 'This provider has not certified quiescent succession.');
    const context = succession?.contexts.forTarget(source);
    if (!preparation && context?.deliveries.some(item => item.preparedInput && !['started', 'handled'].includes(item.inputAcceptance?.disposition ?? '') && ['accepted', 'unknown', 'materialized'].includes(item.state))) await successionService?.reconcileFirstInput(context.operationId);
    await successionBoundary?.reconcileCoverage(source);
    const binding = bindings.getByNative(source.providerId, source.nativeSessionId);
    const managedPrefix = !!binding && liveAgent(binding.agentId) === lease.agent && !!successionBoundary && succession!.contexts.coverageAvailable(source);
    const state = preparation ? { ...await session!.promptEditEvidence!.inspectReadiness(), managed: managedPrefix } : nativeSuccession ? await nativeSuccession.inspect(source) : { ...await session!.nativeEvidence!.inspectReadiness(), managed: succession!.contexts.coverageAvailable(source) };
    if (operationCache.hasUnsettledMutation(nativeSessionRefKey(source)) || (tpm?.hasUnsettledRecipient(source) || team?.hasUnsettledRecipient(source))) {
      throw new SuccessionPreparationRejected('succession_delivery_unresolved', 'Reconcile unsettled operations before succession.');
    }
    assertHandoffState(source);
    const boundary = lease.agent.timelineCursor?.();
    if (!boundary) throw new SuccessionPreparationRejected('succession_boundary_unavailable', 'The native history boundary is unavailable.');
    return { ...state, boundary, inFlightInputs: successionBoundary?.pending(source) ?? 0 };
  }
  async function retainVerification(prepared: import('@orchardworks/agent-remote-protocol').PreparedSuccession): Promise<RetainedSuccessionVerification> {
    const entries: Array<{ target: NativeSessionRef; lease: RemoteHostSessionLease; session: AgentSession; token?: AgentNativeValidityToken; isCurrent?: (token: AgentNativeValidityToken) => boolean }> = [];
    const releases: Array<() => void> = [];
    let released = false;
    const release = () => { if (released) return; released = true; for (const close of releases.reverse()) close(); };
    const assertCurrent = () => {
      if (released) throw new Error('Succession verification attachment was released.');
      for (const entry of entries) {
        const binding = bindings.getByNative(entry.target.providerId, entry.target.nativeSessionId);
        if (!binding || liveAgent(binding.agentId) !== entry.lease.agent || nativeAttachments.get(entry.lease.agent)?.session !== entry.session
          || entry.token && !entry.isCurrent?.(entry.token)) throw new Error('Native succession attachment or evidence changed.');
      }
    };
    try {
      const requireEvidence = !!prepared.preparation || !!succession?.store.progress(prepared.operationId)?.nativeCreation;
      for (const target of [prepared.from, prepared.to]) {
        const lease = await acquireNative(target); releases.push(() => lease.release());
        const session = nativeAttachments.get(lease.agent)?.session;
        if (!session) throw new Error('Native succession attachment is unavailable.');
        const evidence = prepared.preparation ? session.promptEditEvidence : session.nativeEvidence;
        if (requireEvidence && (prepared.preparation ? !session.promptEditEvidence || session.promptEditEvidence.version !== 1 : !hasCurrentNativeEvidence(session))) throw new Error('Native succession attachment evidence is unavailable.');
        // Establish a settled baseline on this exact retained attachment before capturing its token.
        const baseline = await inspectSuccession(target, lease, prepared.preparation);
        if (!baseline.idle || !baseline.managed || baseline.pendingInputs || baseline.inFlightInputs || baseline.pendingInteractions || baseline.activeChildren) throw new Error('Native succession attachment is not settled.');
        const token = requireEvidence ? evidence!.captureValidity() : undefined;
        entries.push({ target, lease, session, token, ...(evidence ? { isCurrent: value => evidence.isCurrent(value) } : {}) });
        assertCurrent();
      }
      assertCurrent();
      return { assertCurrent, release, inspect: async target => {
        const entry = entries.find(item => nativeSessionRefKey(item.target) === nativeSessionRefKey(target));
        if (!entry) throw new Error('Succession inspection target is outside retained attachments.');
        assertCurrent();
        await authorizeSuccessionRead(target, target);
        assertCurrent();
        const result = await inspectSuccession(target, entry.lease, prepared.preparation);
        assertCurrent();
        return result;
      } };
    } catch (error) { release(); throw error; }
  }
  async function acquireNative(target: NativeSessionRef): Promise<RemoteHostSessionLease> {
    if (target.controllerId !== successionConfig?.controllerId || options.providerEnabled?.(target.providerId) === false) throw new Error('Succession target is unavailable.');
    await authorizeSuccessionRead(target, target);
    const binding = await tracked(project(target.providerId, randomUUID(), target.nativeSessionId));
    const lease = await acquireSession(binding.agentId);
    if (!lease) throw new Error('Native succession session is unavailable.');
    return lease;
  }
  function tracked<T>(operation: Promise<T>): Promise<T> {
    pending.add(operation);
    void operation.finally(() => pending.delete(operation)).catch(() => undefined);
    return operation;
  }
  function registration(providerId: string): AgentHostProviderRegistration {
    const value = registrations.get(providerId);
    if (!value) throw new HostRequestError(400, 'invalid_provider', 'The selected provider is unavailable on this Host.');
    return value;
  }
  function operationScope(request: RemoteHostControlRequest): string {
    return request.operationScope ?? 'local';
  }
  function bindingFor(agent: SessionWireAgent): Binding {
    for (const binding of bindings.values()) {
      const agentId = binding.agentId;
      if (liveAgent(agentId) === agent) return binding;
    }
    throw new OperationCacheError('invalid_operation_target', 'The native session binding is unavailable.');
  }
  function liveAgent(agentId: string) {
    try { return relay.requireAgent(agentId); } catch { return undefined; }
  }
  function executeOperation(scope: string): SessionWireOperationExecutor {
    return relay.executeOperation(scope);
  }
  function lifecycle(event: 'session_idle_released' | 'session_idle_restored' | 'session_idle_reconciled', binding: Binding) {
    try { options.onSessionLifecycleDiagnostic?.({ event, agentId: binding.agentId, providerId: binding.providerId }); }
    catch { /* Diagnostics cannot change session lifetime. */ }
  }
  function watch(binding: Binding) {
    idle.watch(binding.agentId, () => {
      if (closed || uncertainAgents.has(binding.agentId) || bindings.isPending(binding.providerId, binding.nativeSessionId)) return false;
      const source = registration(binding.providerId).directory;
      if (!source.canReleaseSession?.(binding.nativeSessionId) || !liveAgent(binding.agentId)?.canReleaseIdle()) return false;
      // A native child projection shares its ancestor's connection, even with no browser currently attached.
      for (const child of bindings.values()) {
        if (child.providerId === binding.providerId && child.parentNativeSessionId === binding.nativeSessionId
          && (liveAgent(child.agentId) || idle.hasDemand(child.agentId))) return false;
      }
      return true;
    }, async () => {
      await relay.closeAgent(binding.agentId);
      await registration(binding.providerId).directory.sessionReleased?.(binding.nativeSessionId);
      lifecycle('session_idle_released', binding);
    }, async isCurrent => {
      const source = registration(binding.providerId).directory;
      const agent = liveAgent(binding.agentId);
      if (!source.reconcileIdleSession || !agent?.canReleaseIdle()) return false;
      for (const child of bindings.values()) {
        if (child.providerId === binding.providerId && child.parentNativeSessionId === binding.nativeSessionId
          && (liveAgent(child.agentId) || idle.hasDemand(child.agentId))) return false;
      }
      // Discovery can resolve a child before the complete family check finishes.
      // Keep that partial progress protected if the check fails or becomes stale.
      uncertainAgents.add(binding.agentId);
      if (!await source.reconcileIdleSession(binding.nativeSessionId) || !isCurrent()
        || liveAgent(binding.agentId) !== agent || !agent.canReleaseIdle()
        || !source.canReleaseSession?.(binding.nativeSessionId)) return false;
      // Native quiescence permits detachment, but does not settle or replay an unknown operation.
      uncertainAgents.delete(binding.agentId);
      lifecycle('session_idle_reconciled', binding);
      return true;
    });
  }
  async function acquireSession(agentId: string): Promise<RemoteHostSessionLease | undefined> {
    const binding = bindings.getByAgent(agentId);
    if (closed || !binding) return undefined;
    const release = idle.retain(agentId);
    let parent: RemoteHostSessionLease | undefined;
    try {
      if (binding.parentNativeSessionId) {
        const parentBinding = bindings.getByNative(binding.providerId, binding.parentNativeSessionId);
        if (parentBinding) {
          parent = await acquireSession(parentBinding.agentId);
          if (!parent) throw new Error('Native parent session is unavailable.');
        }
      }
      await idle.wait(agentId);
      await tracked(project(binding.providerId, agentId, binding.nativeSessionId, binding.parentNativeSessionId));
      const agent = closed ? undefined : liveAgent(agentId);
      if (!agent) { release(); parent?.release(); return undefined; }
      let released = false;
      return { agent, release() { if (released) return; released = true; release(); parent?.release(); } };
    } catch (error) { release(); parent?.release(); throw error; }
  }
  async function project(providerId: string, proposedAgentId: string, nativeSessionId: string, parentNativeSessionId?: string, takeOver?: string, takeoverAdmitted = false, takeoverScope = 'host:takeover', qualifiedResult = false): Promise<Binding> {
    await successionReady;
    const nativeCreation = originalCreation(nativeRef({ providerId, nativeSessionId }));
    const creationIdentity = nativeCreation ? serializeAgentEmptyCreationResult(nativeCreation) : undefined;
    const nativePrefix = originalNativePrefix(nativeRef({ providerId, nativeSessionId }));
    const prefixIdentity = nativePrefix ? JSON.stringify(nativePrefix.handle) : undefined;
    const assertAttachment = (agent: SessionWireAgent | undefined) => {
      if (prefixIdentity && (!agent || nativeAttachments.get(agent)?.nativePrefix !== prefixIdentity)) throw new Error('Existing Host attachment does not match the original native prefix handle.');
      if (creationIdentity && (!agent || nativeAttachments.get(agent)?.nativeCreation !== creationIdentity)) throw new Error('Existing Host attachment does not match the original native creation evidence.');
    };
    const existing = bindings.getByNative(providerId, nativeSessionId);
    if (takeOver && !takeoverAdmitted) {
      const target = nativeRef({ providerId, nativeSessionId });
      return directoryOperation(takeoverScope, JSON.stringify([proposedAgentId, takeOver]), 'native_owner_takeover', [target], { takeOver },
        () => project(providerId, proposedAgentId, nativeSessionId, parentNativeSessionId, takeOver, true, takeoverScope));
    }
    const bound = await bindings.bind({ providerId, agentId: proposedAgentId, nativeSessionId, ...(parentNativeSessionId ? { parentNativeSessionId } : {}) }, {
      ...(qualifiedResult ? { validateResult(binding: Binding) {
        if (![binding.agentId, binding.nativeSessionId].every(boundedSourceIdentity)) throw new Error('Qualified source projection selected an unbounded canonical identity after native creation; the full Host witness remains available for reconciliation.');
      } } : {}),
      discard: binding => relay.closeAgent(binding.agentId),
      attach: async binding => {
      proposedAgentId = binding.agentId;
      if (existing) {
        await idle.wait(proposedAgentId);
        const agent = liveAgent(proposedAgentId);
        if (agent) { assertAttachment(agent); idle.touch(proposedAgentId); return; }
      }
      const source = registration(providerId).directory;
      let parent: RemoteHostSessionLease | undefined;
      try {
        if (parentNativeSessionId) {
          const parentBinding = bindings.getByNative(providerId, parentNativeSessionId);
          if (parentBinding?.agentId === proposedAgentId) throw new Error('Native parent binding is invalid.');
          if (parentBinding) {
            parent = await acquireSession(parentBinding.agentId);
            if (!parent) throw new Error('Native parent session is unavailable.');
          }
        }
        const extensions = nativePrefix ? await nativePrefixExtensions(nativePrefix.source, () => nativeSessionId) : await team?.extensions(providerId, nativeSessionId) ?? await tpm?.extensions(providerId, nativeSessionId);
        const open = () => source.open(nativeSessionId, { ...(takeOver ? { takeOver } : {}), ...(extensions ? { extensions } : {}), ...(nativePrefix ? { nativePrefix: nativePrefix.handle } : {}), ...(nativeCreation ? { nativeCreation, resumeHandle: succession?.contexts.forTarget(nativeRef({ providerId, nativeSessionId }))?.resumeHandle, resumeOptions: { initializeEmpty: succession?.contexts.canInitializeEmpty(nativeRef({ providerId, nativeSessionId })) === true } } : {}) });
        const nativeSession = parentNativeSessionId === undefined ? await (takeOver
          ? directoryNativeEffect(successionBoundary?.currentEntry(), successionBoundary?.currentEntry()?.targets ?? [], async () => {
            try { return await open(); } catch (error) {
              if (error instanceof NativeSessionOwnerError && ['native_owner_changed', 'native_session_owned', 'succession_admission_closed'].includes(error.code)) throw new AgentOperationRejectedError(error.code, error.message);
              throw error;
            }
          }) : open())
          : source.openChild ? await source.openChild(parentNativeSessionId, nativeSessionId)
          : (() => { throw new HostRequestError(400, 'child_attachment_unavailable', 'This provider does not support native child attachment.'); })();
        const annotated = tpm ? await tpm.annotateSession(providerId, nativeSessionId, nativeSession) : nativeSession;
        const session = successionBoundary ? successionBoundary.wrap(nativeRef(binding), annotated) : annotated;
        if (closed) {
          await session.dispose().catch(() => undefined);
          throw new HostRequestError(503, 'host_closed', 'Agent Host is closed.');
        }
        prepared.set(proposedAgentId, session);
        const response = await relay.createAgent({ protocolVersion: PROTOCOL_VERSION, type: 'create_agent', payload: {
          requestId: `host:${proposedAgentId}`, operationId: randomUUID(), agentId: proposedAgentId, providerId, config: { sessionId: proposedAgentId },
        } }).catch(async (error: unknown) => {
          if (prepared.get(proposedAgentId) === session) {
            prepared.delete(proposedAgentId);
            await session.dispose().catch(() => undefined);
          }
          throw error;
        });
        if (response.payload.sessionId !== nativeSessionId) { await relay.closeAgent(proposedAgentId); throw new Error('Provider returned a different native session identity.'); }
        nativeAttachments.set(relay.requireAgent(proposedAgentId), { session: nativeSession, ...(creationIdentity ? { nativeCreation: creationIdentity } : {}), ...(prefixIdentity ? { nativePrefix: prefixIdentity } : {}) });
        for (const relative of nativeFamily(providerId, nativeSessionId)) relay.sessionControls?.setNativeOwner(relative.agentId, undefined);
        watch(binding);
        if (existing) lifecycle('session_idle_restored', binding);
      } catch (error) { prepared.delete(proposedAgentId); throw error; }
      finally { parent?.release(); }
      },
    });
    assertAttachment(liveAgent(bound.agentId));
    return bound;
  }
  async function create(request: RemoteHostControlRequest, payload: Record<string, unknown>, context?: TrustedSuccessionContext): Promise<AgentRemoteHttpResult> {
    const providerId = string(payload.providerId, 'providerId');
    const operationId = string(payload.operationId, 'operationId');
    const proposedAgentId = request.sessionId;
    if (!proposedAgentId) throw new HostRequestError(400, 'invalid_request', 'A proposed Agent identity is required.');
    if (payload.sourceNativeSessionId !== undefined && (typeof payload.sourceNativeSessionId !== 'string' || !payload.sourceNativeSessionId || payload.sourceNativeSessionId.length > 256)) throw new HostRequestError(400, 'invalid_request', 'Source session identity is invalid.');
    const editKeys = ['editNativeSessionId', 'editTurnId', 'editMessageId'] as const;
    const editing = editKeys.some(key => payload[key] !== undefined);
    if (editing && (editKeys.some(key => typeof payload[key] !== 'string' || !(payload[key] as string).trim() || (payload[key] as string).length > 256) || payload.sourceNativeSessionId !== undefined)) throw new HostRequestError(400, 'invalid_request', 'A complete native prompt identity is required.');
    const legacySource = payload.sourceNativeSessionId ?? payload.editNativeSessionId;
    if (payload.creationSource !== undefined && !isCreationSource(payload.creationSource)) throw new HostRequestError(400, 'invalid_request', 'Creation source must contain only a provider and native session identity.');
    const provenance = payload.creationSource === undefined ? (typeof legacySource === 'string' ? { providerId, nativeSessionId: legacySource } : undefined) : payload.creationSource;
    if (provenance && legacySource !== undefined && (provenance.providerId !== providerId || provenance.nativeSessionId !== legacySource)) throw new HostRequestError(400, 'invalid_request', 'Creation source contradicts the native source identity.');
    const source = provenance ? nativeRef(provenance) : undefined;
    const targets = source ? mutationFamily([source]) : [];
    const settings = {
      ...(editing ? { editNativeSessionId: payload.editNativeSessionId as string, editTurnId: payload.editTurnId as string, editMessageId: payload.editMessageId as string } : {}),
      ...(typeof payload.sourceNativeSessionId === 'string' ? { sourceNativeSessionId: payload.sourceNativeSessionId } : {}),
      ...(typeof payload.cwd === 'string' ? { cwd: payload.cwd } : {}),
      ...(typeof payload.workspaceId === 'string' ? { workspaceId: payload.workspaceId } : {}),
      ...(typeof payload.model === 'string' ? { model: payload.model } : {}),
      ...(typeof payload.reasoningEffort === 'string' ? { reasoningEffort: payload.reasoningEffort } : {}),
      ...(typeof payload.planning === 'boolean' ? { planning: payload.planning } : {}),
    };
    const selected = registration(providerId), directory = selected.directory;
    const scope = operationScope(request);
    const qualified = (context?.successionEnrollmentVersion ?? 0) >= 2 && !!settings.sourceNativeSessionId && !!enrollment;
    const sourceReader = settings.sourceNativeSessionId ? nativeRef({ providerId, nativeSessionId: settings.sourceNativeSessionId }) : undefined;
    // An exact durable source result is forward recovery, including after cache expiry/restart.
    const savedCreation = sourceReader && enrollment ? await enrollment.sourceResult(scope, operationId, sourceReader, settings, directory) : undefined;
    // A pending witness is uncertainty, even if a producer certificate later disappears.
    if (qualified && !savedCreation) enrollment!.assertSourceCreateAvailable(scope, operationId, sourceReader!, settings);
    const maximumResultBytes = savedCreation ? Math.max(1, jsonBytes(savedCreation.reader.nativeSessionId)) : qualified ? SOURCE_WITNESS_RESULT_BYTES : 1024;
    const nativeSessionId = await operationCache.execute<string>({
      operationId,
      scope,
      kind: 'create_agent',
      target: providerId,
      parameters: { ...settings, ...(source ? { creationSource: source } : {}) },
    }, {
      mutationTargets: targets.map(nativeSessionRefKey),
      admit: entry => savedCreation ? undefined : successionBoundary?.admit(targets, entry.key),
      run: (entry, work) => successionBoundary ? successionBoundary.run({ operationId, kind: 'execute_command', parameters: {}, maximumResultBytes }, scope, work, entry) : work(),
      validate: async () => {
        if (source) await authorizeSuccessionRead(source, source);
        if (editing && !directory.supportsPromptEditing) throw new HostRequestError(400, 'unsupported_configuration', 'Prompt editing is unavailable on this Host/provider. Update the Controller.');
        if (settings.sourceNativeSessionId && !directory.supportsSourceReferences) throw new HostRequestError(400, 'unsupported_configuration', 'This Host/provider does not support source-session tools. Update the Host or use /fork.');
        if (options.executionPolicy) {
          const selected = payload.workspaceId === undefined ? undefined
            : (await directory.workspaces()).find(workspace => workspace.id === payload.workspaceId);
          if (payload.workspaceId !== undefined && !selected) throw new HostExecutionPolicyError('Unknown local Host workspace.');
          await allowedWorkspace(options.executionPolicy, typeof payload.cwd === 'string' ? payload.cwd : selected?.path ?? options.executionPolicy.defaultWorkspace);
        }
        if (editing) {
          try { await directory.validatePromptEdit?.({ nativeSessionId: settings.editNativeSessionId!, turnId: settings.editTurnId!, messageId: settings.editMessageId! }); }
          catch (error) {
            if (error instanceof HostExecutionPolicyError || error instanceof AgentRuntimeError) throw error;
            throw new OperationCacheError('operation_rejected', error instanceof Error ? error.message : 'The selected prompt could not be verified.');
          }
        }
        if (bindings.isReserved(proposedAgentId)) {
          throw new HostRequestError(409, 'session_binding_conflict', 'The proposed Agent identity is already reserved.');
        }
        if (qualified && !savedCreation) {
          if (!validSourceWitnessIdentity(scope, operationId) || !boundedSourceIdentity(proposedAgentId) || !isNativeSessionRef(sourceReader)) throw new HostRequestError(400, 'invalid_request', 'Qualified source witness and proposed Agent identities must fit their reviewed bounds.');
          if (await directory.supportsBoundedSourceCreate?.(settings) !== true) throw new HostRequestError(400, 'unsupported_configuration', 'This directory create mode has not certified bounded source results.');
        }
      },
      beforeDispatch: () => { if (!savedCreation) successionBoundary?.recheck(targets); },
      dispatch: entry => {
        if (savedCreation) return Promise.resolve(savedCreation.reader.nativeSessionId);
        const create = () => directoryNativeEffect(entry, targets.map(nativeSessionRefKey), evidence => directory.create(settings, evidence));
        const work = () => settings.sourceNativeSessionId && enrollment
          ? enrollment.sourceMutation(scope, operationId, sourceReader!, settings, create,
            async id => (await directory.sourceReferences?.())?.some(grant => grant.nativeSessionId === id && grant.sourceNativeSessionId === settings.sourceNativeSessionId) === true, qualified, directory) : create();
        return work();
      },
      maximumResultBytes,
    });
    return json(200, publicBinding(await tracked(project(providerId, proposedAgentId, nativeSessionId, undefined, undefined, false, undefined, qualified && !savedCreation))));
  }
  const nativeStarts = createNativeStartBackoff();
  async function control(request: RemoteHostControlRequest, context?: TrustedSuccessionContext): Promise<AgentRemoteHttpResult> {
    const requestId = request.requestId && /^[a-zA-Z0-9-]{1,80}$/.test(request.requestId) ? request.requestId : randomUUID();
    const operation = request.path === '/remote/attach' || request.path === '/remote/child/attach' ? 'session_attach'
      : request.path === '/remote/create' ? 'session_create' : request.method === 'GET' ? 'catalog_read' : 'host_control';
    const started = Date.now();
    const diagnostic = (event: AgentHostRequestDiagnostic['event'], status?: number, code?: string) => {
      try { options.onRequestDiagnostic?.({ event, requestId, operation, elapsedMs: Date.now() - started,
        ...(status === undefined ? {} : { status }), ...(code ? { code } : {}) }); } catch { /* Diagnostics cannot change request outcomes. */ }
    };
    diagnostic('host_request_started');
    const start = nativeStartTarget(request.path, request.method, request.body);
    const backedOff = start && nativeStarts.blocked(start);
    const result = backedOff || await controlRequest(request, context);
    if (start && !backedOff) nativeStarts.settle(start, result);
    const data = result.status >= 400 ? JSON.parse(result.body) : {};
    diagnostic('host_request_completed', result.status, typeof data.code === 'string' ? data.code : undefined);
    return result.status >= 400 ? { ...result, body: JSON.stringify({ ...data, requestId }) } : result;
  }
  async function controlRequest(request: RemoteHostControlRequest, context?: TrustedSuccessionContext): Promise<AgentRemoteHttpResult> {
    try {
      await successionReady;
      if (closed) throw new HostRequestError(503, 'host_closed', 'Agent Host is closed.');
      if (draining && request.method === 'POST') throw new HostRequestError(503, 'controller_updating', 'Controller is updating. Reconnect before retrying.');
      const url = new URL(request.path, 'http://agent-host.local');
      const payload = request.method === 'POST' ? body(request.body) : undefined;
      if (url.pathname === '/remote/succession/enrollment' || options.succession?.enrollment && url.pathname.startsWith('/remote/succession') && request.method === 'POST') return json(403, { code: 'succession_authority_required', error: 'Use the authenticated Relay association reservation.' });
      if (url.pathname.startsWith('/remote/succession')) {
        if (!successionService || !succession) return json(404, { code: 'succession_unavailable', error: 'Session succession is unavailable.' });
        try {
          if (request.method === 'GET' && url.pathname === '/remote/succession/status') {
            const record = succession.coordinator.status(string(url.searchParams.get('operationId'), 'operationId'));
            await authorizeSuccessionRead(record.from, record.to ?? record.from);
            return json(200, record);
          }
          if (request.method === 'POST' && url.pathname === '/remote/succession/prepare' && isSuccessionRequest(payload)) {
            await authorizeSuccessionRead(payload.from, payload.from);
            return json(200, await successionService.prepare(payload));
          }
          if (request.method === 'POST' && payload && ['commit', 'cancel', 'reconcile'].some(action => url.pathname === `/remote/succession/${action}`)) {
            const operationId = string(payload.operationId, 'operationId');
            const record = succession.coordinator.status(operationId);
            await authorizeSuccessionRead(record.from, record.to ?? record.from);
            if (succession.store.read(record.roleId).associationAuthority) throw new Error('An authenticated association reservation is required.');
            if (url.pathname.endsWith('/commit')) {
              if (!Number.isSafeInteger(payload.expectedRevision) || (payload.expectedRevision as number) < 1) throw new Error('A valid expected revision is required.');
              return json(200, await successionService.commit(operationId, payload.expectedRevision as number));
            }
            if (url.pathname.endsWith('/cancel')) return json(200, await succession.coordinator.cancel(operationId));
            if (record.phase === 'committed') return json(200, { materialized: await successionService.reconcileFirstInput(operationId) });
            return json(200, await succession.coordinator.reconcileReady(operationId));
          }
          return json(400, { code: 'invalid_succession_request', error: 'Invalid session succession request.' });
        } catch (error) {
          if (error instanceof HostExecutionPolicyError) throw error;
          return json(409, { code: error instanceof SuccessionPreparationRejected ? error.code : 'succession_request_failed', error: error instanceof Error ? error.message : 'Session succession failed.' });
        }
      }
      if (url.pathname === '/remote/team/create-seat') {
        if (!team) return json(404, {error: 'Update the Controller to use Teams.'});
        if (request.method !== 'POST' || !isTeamSeat(payload)) return json(400, {error: 'Invalid Team session request.'});
        try { return json(200, await team.create(payload)); }
        catch (error) { return json(409, {error: error instanceof Error ? error.message : 'Team session creation failed.'}); }
      }
      if (url.pathname.startsWith('/remote/tpm')) {
        if (!tpm) return json(404, { code: 'tpm_unavailable', error: 'TPM is unavailable on this Controller.' });
        try {
          await tpm.ready;
          if (request.method === 'GET' && url.pathname === '/remote/tpm') return json(200, await tpm.list(url.searchParams.get('cursor') ?? undefined));
          if (request.method === 'GET' && url.pathname === '/remote/tpm/work') return json(200, await tpm.get(string(url.searchParams.get('id'), 'id')));
          if (request.method === 'POST' && url.pathname === '/remote/tpm/create' && isTpmCreate(payload)) {
            const scope = operationScope(request);
            const create = () => tpm.create(payload, scope);
            const source = nativeRef({ providerId: payload.providerId, nativeSessionId: payload.mainNativeSessionId });
            const current = enrollment ? await enrollment.tpmSource(source) : source;
            const existing = tpm.store.all().some(record => record.createKey === JSON.stringify([scope, payload.operationId]));
            const work = await (existing ? create() : directoryOperation(scope, payload.operationId, 'tpm_create', [source, current], payload,
              () => enrollment ? enrollment.tpmMutation(scope, payload.operationId, source, payload, create,
                async work => tpm.store.get(work.id).creation === 'accepted' && !!tpm.store.get(work.id).work.tpmNativeSessionId) : create()));
            if (enrollment && tpm.store.get(work.id).creation === 'accepted') await enrollment.recoverTpm(tpm.store.get(work.id));
            return json(200, work);
          }
          if (request.method === 'POST' && url.pathname === '/remote/tpm/action' && isTpmAction(payload)) {
            const validateRecovery = async () => {
              try { tpm.validateCreationRecovery(payload, operationScope(request)); }
              catch (error) {
                if (error instanceof AgentOperationRejectedError) throw new OperationCacheError(error.code, error.message);
                throw error;
              }
            };
            if (enrollment && payload.action === 'resolve' && payload.intentId === 'creation') {
              const work = tpm.store.get(payload.id).work;
              const source = work.mainSessionRef ?? nativeRef({providerId:work.providerId, nativeSessionId:work.mainNativeSessionId});
              if (tpm.store.get(work.id).creation === 'accepted') {
                const updated = await tpm.action(payload, operationScope(request));
                await enrollment.recoverTpmAction(tpm.store.get(updated.id), operationScope(request), payload.operationId, source, payload);
                return json(200, updated);
              }
              const current = await enrollment.tpmSource(source);
              const targets = [source, current, ...(payload.nativeSessionId ? [nativeRef({ providerId: work.providerId, nativeSessionId: payload.nativeSessionId })] : [])];
              return json(200, await directoryOperation(operationScope(request), payload.operationId, 'tpm_creation_recovery', targets, payload,
                () => enrollment.mutation(operationScope(request), payload.operationId, source, payload,
                  () => tpm.action(payload, operationScope(request)), async updated => {
                    const record = tpm.store.get(updated.id);
                    if (record.creation !== 'accepted' || !record.work.tpmNativeSessionId) return false;
                    await enrollment.recoverTpm(record);
                    return true;
                  }), validateRecovery));
            }
            if (payload.action === 'resolve' && payload.intentId === 'creation' && payload.resolution === 'accepted'
              && tpm.store.get(payload.id).creation !== 'accepted') {
              const record = tpm.store.get(payload.id);
              const targets = [nativeRef({ providerId: record.work.providerId, nativeSessionId: record.work.mainNativeSessionId }),
                ...(payload.nativeSessionId ? [nativeRef({ providerId: record.work.providerId, nativeSessionId: payload.nativeSessionId })] : [])];
              return json(200, await directoryOperation(operationScope(request), payload.operationId, 'tpm_creation_recovery', targets, payload,
                () => tpm.action(payload, operationScope(request)), validateRecovery));
            }
            return json(200, await tpm.action(payload, operationScope(request)));
          }
          return json(400, { code: 'invalid_tpm_request', error: 'Invalid TPM request.' });
        } catch (error) { return json(409, { code: 'tpm_request_failed', error: error instanceof OperationCacheError && error.code === 'operation_outcome_unknown'
          ? `TPM operation remains unresolved. ${error.message}` : error instanceof Error ? error.message : 'TPM request failed.' }); }
      }
      const selectedProvider = request.method === 'GET' ? url.searchParams.get('providerId') : payload?.providerId;
      const existing = request.sessionId ? bindings.getByAgent(request.sessionId) : undefined;
      // Uplink recovery may rebind a still-live session after its provider is disabled.
      // It must not open another native session or revive an idle released session.
      const recovering = request.method === 'POST' && (url.pathname === '/remote/attach' || url.pathname === '/remote/child/attach')
        && existing?.providerId === selectedProvider && existing?.nativeSessionId === payload?.nativeSessionId
        && !!existing && !!liveAgent(existing.agentId) && payload?.takeOver === undefined;
      if (!recovering && typeof selectedProvider === 'string' && options.providerEnabled?.(selectedProvider) === false) {
        throw new HostRequestError(403, 'provider_disabled', 'This provider is disabled or unavailable on the Host. Enable it in Settings.');
      }
      if (request.method === 'GET') {
        const providerId = string(url.searchParams.get('providerId'), 'providerId');
        const directory = registration(providerId).directory;
        if (url.pathname === '/remote/workspace-folders') return json(200, await browseWorkspaceFolders(url.searchParams, options.executionPolicy, (await directory.workspaces())[0]?.path));
        if (url.pathname === '/remote/workspaces') return json(200, { workspaces: await directory.workspaces() });
        if (url.pathname === '/remote/models') return json(200, await (directory.models?.() ?? { models: [] }));
        const catalog = catalogs.get(providerId)!;
        if (url.pathname === '/remote/catalog') return json(200, await catalog.page({ cursor: url.searchParams.get('cursor') ?? undefined,
          limit: url.searchParams.has('limit') ? Number(url.searchParams.get('limit')) : undefined }));
        if (url.pathname === '/remote/catalog/session') {
          const nativeSessionId = string(url.searchParams.get('nativeSessionId'), 'nativeSessionId');
          const summary = await catalog.session(nativeSessionId);
          if (!summary) throw new HostRequestError(404, 'session_unavailable', 'The native session is unavailable.');
          return json(200, summary);
        }
        if (url.pathname === '/remote/catalog/revision') return json(200, { revision: await catalog.revision() });
      }
      if (request.method === 'POST') {
        const payload = body(request.body);
        if (url.pathname === '/remote/session/rename') {
          const providerId = string(payload.providerId, 'providerId');
          const nativeSessionId = string(payload.nativeSessionId, 'nativeSessionId');
          const title = string(payload.title, 'title').trim();
          if (!title || title.length > 512 || /[\u0000-\u001f\u007f]/.test(title) || request.sessionId || Object.keys(payload).some(key => !['providerId', 'nativeSessionId', 'title', 'operationId'].includes(key))) {
            throw new HostRequestError(400, 'invalid_request', 'A valid session name is required.');
          }
          const directory = registration(providerId).directory;
          if (!directory.renameSession) throw new HostRequestError(400, 'unsupported_configuration', 'Native session renaming is unavailable. Update the Controller.');
          const targets = mutationFamily([nativeRef({ providerId, nativeSessionId })]);
          let result: { title: string };
          try {
            result = await operationCache.execute({ operationId: string(payload.operationId, 'operationId'), scope: operationScope(request),
              kind: 'rename_session', target: JSON.stringify([providerId, nativeSessionId]), parameters: { title } }, {
              mutationTargets: targets.map(nativeSessionRefKey), admit: entry => successionBoundary?.admit(targets, entry.key),
              run: (entry, work) => successionBoundary ? successionBoundary.run({ operationId: String(payload.operationId), kind: 'execute_command', parameters: {}, maximumResultBytes: 8192 }, operationScope(request), work, entry) : work(),
              validate: () => directory.validateSessionRename?.(nativeSessionId, title),
              beforeDispatch: () => successionBoundary?.recheck(targets),
              dispatch: entry => directoryNativeEffect(entry, targets.map(nativeSessionRefKey), async () => ({ title: await directory.renameSession!(nativeSessionId, title) })),
            });
          } catch (error) {
            if (!(error instanceof OperationCacheError) || error.code !== 'operation_outcome_unknown') throw error;
            const confirmed = await directory.sessionTitle?.(nativeSessionId).catch(() => undefined);
            if (confirmed === title) return json(200, { title: confirmed });
            throw new OperationCacheError('operation_outcome_unknown', 'The session name could not be confirmed. Retry to check the same change.');
          }
          // A retry must not overwrite newer native metadata with its cached result.
          const currentTitle = await directory.sessionTitle?.(nativeSessionId);
          return json(200, { title: currentTitle ?? result.title });
        }
        if (url.pathname === '/remote/workspace-folders/create') {
          registration(string(payload.providerId, 'providerId'));
          if (request.sessionId) throw new HostRequestError(400, 'invalid_request', 'Folder creation does not target a session.');
          return json(201, await createWorkspaceFolder(payload.parentPath, payload.name, options.executionPolicy));
        }
        if (url.pathname === '/remote/stop') {
          if (Object.keys(payload).some(key => key !== 'operationId') || request.sessionId) {
            throw new HostRequestError(400, 'invalid_request', 'Stop requires only an operation identity.');
          }
          const operationId = string(payload.operationId, 'operationId');
          const targetBindings = [...bindings.values()].filter(binding => liveAgent(binding.agentId));
          const targets = targetBindings.map(binding => binding.agentId);
          const mutationTargets = succession ? [...new Map(targetBindings.map(binding => { const target = nativeRef(binding); return [nativeSessionRefKey(target), target] as const; })).values()] : [];
          const results = await operationCache.execute({
            operationId,
            scope: operationScope(request),
            kind: 'stop_host_sessions',
            target: 'host',
            parameters: null,
          }, {
            mutationTargets: mutationTargets.map(nativeSessionRefKey),
            admit: entry => successionBoundary?.admit(mutationTargets, entry.key),
            run: (entry, work) => successionBoundary ? successionBoundary.run({ operationId, kind: 'cancel', parameters: null, maximumResultBytes: 256 * 1024 }, operationScope(request), work, entry) : work(),
            dispatch: () => Promise.all(targets.map(cancelAgent)),
            maximumResultBytes: 256 * 1024,
          });
          return json(200, { results });
        }
        if (url.pathname === '/remote/create') return await create(request, payload, context);
        if (url.pathname === '/remote/attach' || url.pathname === '/remote/child/attach') {
          if (!request.sessionId) throw new HostRequestError(400, 'invalid_request', 'A proposed Agent identity is required.');
          const providerId = string(payload.providerId, 'providerId');
          const nativeSessionId = string(payload.nativeSessionId, 'nativeSessionId');
          const parent = url.pathname === '/remote/child/attach' ? string(payload.parentNativeSessionId, 'parentNativeSessionId') : undefined;
          const takeOver = payload.takeOver === undefined ? undefined : string(payload.takeOver, 'takeOver');
          if (takeOver && (parent || !/^[a-f\d-]{36}$/i.test(takeOver))) throw new HostRequestError(400, 'invalid_request', 'A native owner generation is required for takeover.');
          return json(200, publicBinding(await tracked(project(providerId, request.sessionId, nativeSessionId, parent, takeOver, false, operationScope(request)))));
        }
      }
      throw new HostRequestError(400, 'invalid_request', 'Remote Host request is invalid.');
    } catch (error) {
      if (error instanceof AgentOperationRejectedError) return json(operationErrorStatus(error.code), { error: error.message, code: error.code });
      if (error instanceof NativeSessionOwnerError) return json(409, {error: error.message, code: error.code, ...(error.owner ? {nativeOwner: error.owner} : {})});
      if (error instanceof AgentRuntimeError) return json(error.code === 'native_session_unavailable' ? 404 : 503, { error: error.message, code: error.code });
      if (error instanceof AgentSessionInUseError) return json(409, { error: error.message, code: 'session_in_use' });
      if (error instanceof HostExecutionPolicyError) return json(403, { error: error.message, code: 'local_execution_policy' });
      if (error instanceof WorkspaceFolderError) return json(error.status, { error: error.message, code: error.code });
      if (error instanceof OperationCacheError) return json(operationErrorStatus(error.code), { error: error.message, code: error.code });
      if (error instanceof SessionBindingError) return json(error.status, { error: error.message, code: error.code });
      if (error instanceof HostRequestError) return json(error.status, { error: error.message, code: error.code });
      if (error instanceof RemoteHostCatalogError) return json(error.status, { error: error.message, code: error.code });
      if (request.method === 'GET') return json(503, { error: 'The Remote Host catalog is unavailable.', code: 'catalog_unavailable' });
      if (request.path === '/remote/attach' || request.path === '/remote/child/attach') return json(503, { error: 'The Host could not open the native session. Check the Controller log and reopen it from the session list.', code: 'session_attach_failed' });
      return json(503, { error: 'Remote Host operation outcome is unknown.', code: 'mutation_outcome_unknown' });
    }
  }
  async function cancelAgent(agentId: string) {
    const release = idle.retain(agentId);
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      await Promise.race([relay.requireAgent(agentId).cancel(), new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => reject(new Error('Cancellation deadline exceeded.')), cancelTimeoutMs);
      })]);
      return { agentId, status: 'cancelled' as const };
    } catch (error) {
      return error instanceof UnsupportedAgentCapabilityError
        ? { agentId, status: 'unsupported' as const, message: 'The native session does not support cancellation.' }
        : { agentId, status: 'failed' as const, message: 'Native cancellation did not complete.' };
    } finally { clearTimeout(timer); release(); }
  }
  function addRegistration(value: AgentHostProviderRegistration): void {
    if (closed || draining) throw new Error('Host cannot register a provider while stopping.');
    const id = value.adapter.descriptor.providerId;
    if (id !== value.directory.providerId || registrations.has(id)) throw new Error('Invalid or duplicate provider registration.');
    const registration = options.executionPolicy ? { ...value, directory: protectHostDirectory(value.directory, {
      ...options.executionPolicy, lockPermissions: value.nativePermissionControl ? false : options.executionPolicy.lockPermissions,
    }) } : value;
    relay.registerProvider({ descriptor: value.adapter.descriptor,
      async createSession(config) { const session = prepared.get(config.sessionId); if (!session) throw new Error('Agent Host projection session is unavailable.'); prepared.delete(config.sessionId); return session; },
      resumeSession: value.adapter.resumeSession.bind(value.adapter),
    });
    registrations.set(id, registration);
    catalogs.set(id, new RemoteHostCatalog({ roots: registration.directory.list, revisionMaxAgeMs: catalogRevisionMaxAgeMs }));
    bindHandoff(registration.directory);
    bindSourceReader(registration.directory);
    bindSourceReferenceAncestry(registration.directory);
  }
  const automationAccess: TpmSessionAccess = {
    controllerId: successionConfig?.controllerId ?? options.controllerId ?? 'local',
    sessionRouting: successionService?.executionRouting ?? {
      resolve: anchor => ({ anchor, target: anchor, operationIds: [] }),
      assertCurrent: (anchor, actual) => { if (closed || draining || nativeSessionRefKey(anchor) !== nativeSessionRefKey(actual)) throw new Error('Execution recipient is unavailable.'); },
    },
    ...(successionService ? { mainRouting: successionTpmRouting(successionService, successionConfig!.controllerId, acquireNative) } : {}),
    available: () => !closed && !draining,
    supportedProviders: () => [...registrations.values()].filter(({ adapter }) => options.providerEnabled?.(adapter.descriptor.providerId) !== false
      && adapter.descriptor.sessionExtensions?.instructions && adapter.descriptor.sessionExtensions?.tools).map(({ adapter }) => adapter.descriptor.providerId),
    async acquire(providerId, nativeSessionId) {
      if (closed || draining || options.providerEnabled?.(providerId) === false) throw new Error('TPM session provider is unavailable.');
      const binding = await tracked(project(providerId, randomUUID(), nativeSessionId));
      const lease = await acquireSession(binding.agentId);
      if (!lease) throw new Error('TPM native session is unavailable.');
      try { if (options.executionPolicy) await allowedWorkspace(options.executionPolicy, lease.agent.snapshot().payload.runtimeInfo.cwd); }
      catch (error) { lease.release(); throw error; }
      return lease;
    },
    async recover(providerId, nativeSessionId, extensions) {
      if (closed || draining || options.providerEnabled?.(providerId) === false) throw new Error('TPM provider is unavailable.');
      const existing = bindings.getByNative(providerId, nativeSessionId);
      if (existing && (liveAgent(existing.agentId) || bindings.isPending(providerId, nativeSessionId))) throw new Error('Close the recovered session before binding it as a TPM.');
      const session = await directoryNativeEffect(successionBoundary?.currentEntry(), successionBoundary?.currentEntry()?.targets ?? [], async () => registration(providerId).directory.open(nativeSessionId, { extensions }));
      const info = await session.runtimeInfo();
      if (info.sessionId !== nativeSessionId) throw new Error('Recovered native session identity does not match.');
      if (options.executionPolicy) await allowedWorkspace(options.executionPolicy, info.cwd);
    },
    create: (providerId, cwd, extensions) => directoryNativeEffect(successionBoundary?.currentEntry(), successionBoundary?.currentEntry()?.targets ?? [], evidence => registration(providerId).directory.create({ ...(cwd ? { cwd } : {}), ...extensions }, evidence)),
    execute: executeOperation('host:tpm'),
  };
  const tpm = options.tpm ? new TpmCoordinator(options.tpm, automationAccess) : undefined;
  const team = options.team?.request ? new TeamRuntime(options.team.stateDirectory, {...automationAccess, sessionRouting: automationAccess.sessionRouting!, execute: executeOperation('host:team')}, options.team.request, options.team.tickMs) : undefined;
  const enrollment = successionService ? new SessionSuccessionEnrollment(successionService, successionConfig!.controllerId, () => [...registrations.values()], () => tpm?.store.all() ?? [], source => authorizeSuccessionRead(source, source), directoryOperation) : undefined;
  const enrollFromRelay = async (request: RemoteHostControlRequest, context: TrustedSuccessionContext) => {
    if (!options.succession?.enrollment || !enrollment || closed || draining) return json(403, { code: 'succession_enrollment_unavailable', error: 'Trusted succession enrollment is unavailable.' });
    await tpm?.ready;
    if (request.path === '/remote/create') {
      if (request.method !== 'POST' || context.installationId !== successionConfig!.controllerId) return json(403, { code: 'succession_enrollment_unavailable', error: 'Succession Controller authority does not match.' });
      return control(request, structuredClone(context));
    }
    return enrollment.control(request, context);
  };
  return { relay, executionRouting: successionService?.executionRouting, addRegistration, control: request => control(request), enrollFromRelay, executeOperation, acquireSession, setRelayConnected: idle.setConnected,
    beginControllerRestart() {
      if (closed || draining) return false;
      // An owner-confirmed update closes admission immediately. Shutdown and the
      // launcher bound cleanup time; session state must not indefinitely defer it.
      draining = true;
      return true;
    },
    cancelControllerRestart() { if (!closed) draining = false; },
    resolveSession(agentId) { idle.touch(agentId); return liveAgent(agentId); },
    close(): Promise<void> { return closePromise ??= (async () => {
      closed = true; draining = true;
      await bounded(successionReady, shutdownTimeoutMs).catch(() => undefined);
      await bounded(team?.close() ?? Promise.resolve(), shutdownTimeoutMs).catch(() => undefined);
      await bounded(tpm?.close() ?? Promise.resolve(), shutdownTimeoutMs).catch(() => undefined);
      try {
        await bounded(successionBoundary?.close() ?? Promise.resolve(), shutdownTimeoutMs);
      } finally {
        successionBoundary?.retireCoverageEvidence();
        bindings.close();
        const releasing = idle.close();
        for (const catalog of catalogs.values()) catalog.dispose();
        const cleanup = Promise.allSettled([releasing, relay.close(), ...[...registrations.values()].map(({ directory }) => Promise.resolve(directory.close())), ...pending]);
        await bounded(cleanup, shutdownTimeoutMs);
      }
    })(); } };
}

class HostRequestError extends Error { constructor(readonly status: number, readonly code: string, message: string) { super(message); } }
function publicBinding(binding: Binding): Omit<Binding, 'providerId'> {
  const { providerId: _providerId, ...value } = binding;
  return value;
}
function operationErrorStatus(code: string): number {
  if (code === 'operation_conflict') return 409;
  if (code === 'operation_capacity_exceeded') return 429;
  if (code === 'native_file_limit' || code === 'operation_outcome_unknown' || code === 'operation_cache_closed' || code === 'operation_clock_invalid') return 503;
  return 400;
}
function string(value: unknown, field: string): string { if (typeof value !== 'string' || !value) throw new HostRequestError(400, 'invalid_request', `${field} is required.`); return value; }
function boundedSourceIdentity(value: unknown): value is string { return typeof value === 'string' && !!value.trim() && value.length <= 512; }
function body(value: string | undefined): Record<string, unknown> { try { const parsed: unknown = JSON.parse(value ?? ''); if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) return parsed as Record<string, unknown>; } catch {} throw new HostRequestError(400, 'invalid_request', 'Remote Host body is invalid.'); }
function json(status: number, value: unknown): AgentRemoteHttpResult { return { status, body: JSON.stringify(value) }; }
function positiveTimeout(value: number): number { if (!Number.isSafeInteger(value) || value < 1) throw new RangeError('Agent Host shutdown timeout must be a positive integer.'); return value; }
async function bounded(operation: Promise<unknown>, timeoutMs: number): Promise<void> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try { await Promise.race([operation, new Promise<void>((resolve) => { timer = setTimeout(resolve, timeoutMs); timer.unref?.(); })]); }
  finally { clearTimeout(timer); }
}

async function receiveRelayDiagnostics(body: string | undefined, sink: AgentHostOptions['onRelayDiagnostics']): Promise<AgentRemoteHttpResult> {
  if (!sink) return { status: 404, body: '' };
  let entries: RelayDiagnostic[] | undefined;
  try { entries = parseRelayDiagnosticBatch(JSON.parse(body ?? 'null')); } catch { /* Invalid JSON is rejected below. */ }
  if (!entries) return { status: 400, body: '{"error":"Invalid relay diagnostic batch."}' };
  try { await sink(entries); return { status: 204, body: '' }; }
  catch { return { status: 503, body: '{"error":"Relay diagnostics could not be appended."}' }; }
}
