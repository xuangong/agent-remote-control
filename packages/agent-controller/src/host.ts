import { TeamRuntime } from './team.js';
import { type JournalRelayMessage, type OutboxHostCall, type TeamHostCall } from '@orchardworks/agent-remote-protocol';
import { directoryNativeEffect, directoryOperationId } from './directory-mutation.js';
import { admitNativeOwnerTransfer } from './native-owner-admission.js';
import { SessionSuccessionEnrollment } from './session-succession-enrollment.js';
import { successionTpmRouting } from './session-succession-tpm.js';
import { SessionSuccessionService } from './session-succession-service.js';
import { captureSuccessionTimeline } from './session-succession-capture.js';
import { SuccessionPreparationRejected, nativePrefixResumeHandle, type RetainedSuccessionVerification } from './local-succession-preparation.js';
import { SessionSuccessionBoundary } from './session-succession-boundary.js';
import { type SessionSuccessionStore } from './session-succession-store.js';
import type { SessionSuccessionContextStore } from './session-succession-context.js';
import type { SessionSuccessionCoordinator } from './session-succession.js';
import { nativeSessionRefKey, nativePrefixSegmentAncestors, type NativeSessionRef, type NativePrefixSelection, type TrustedSuccessionContext } from '@orchardworks/agent-remote-protocol';
import { TpmCoordinator, type TpmSessionAccess } from './tpm.js';
import { SessionBindings } from '@orchardworks/agent-session-runtime';
import type { HostProviderDiscovery } from './provider-discovery.js';
import { NativeSessionOwnerError } from './native-session-owner.js';
import { createCodexDaemonControl } from './codex-daemon-control.js';
import { RELAY_DIAGNOSTIC_PATH, parseRelayDiagnosticBatch, type RelayDiagnostic } from '@orchardworks/agent-remote-protocol/model';
import { createControllerUpdater } from './controller-update.js';
import type { ControllerIdentity, ControllerUpdateStatus } from '@orchardworks/agent-remote-protocol';
import { createIdleSessions } from './idle-sessions.js';
import { createHostStatusReader, hostStatusPaths } from './host-status.js';
import { allowedWorkspace, HostExecutionPolicyError, protectHostDirectory } from './execution-policy.js';
import { SessionRoles, type SessionRole } from './session-role-succession.js';
import { roleSessionConfig } from './role-session-creation.js';
import { WorkerSupport } from './call-for-support-worker.js';
import { createControllerPreviews } from './previews.js';
import { createVscodeTunnelManager, type VscodeTunnelOptions } from './vscode-tunnel.js';
import { createOperationCache, OperationCacheError } from '@orchardworks/agent-session-runtime';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import type { AgentProviderAdapter, AgentSession, AgentSessionConfig, AgentSessionExtensions, AgentNativeValidityToken, AgentSessionTool } from '@orchardworks/agent-provider-sdk';
import { AgentOperationRejectedError, bindAgentSessionTools, serializeAgentEmptyCreationResult, serializeAgentInputMaterialization } from '@orchardworks/agent-provider-sdk';
import { PROTOCOL_VERSION, type HostEnvironment } from '@orchardworks/agent-remote-protocol';
import { createSessionStatePublisher, liveSessionState } from './session-state-publisher.js';
import { createSessionReplies } from './session-replies.js';
import { SessionOutbox } from './session-outbox.js';
import { createTerminalRefresh } from './publisher/terminal-refresh.js';
import { createAdmission } from './session-core/admission.js';
import { createSessionCatalog, catalogSessionStates } from './session-core/catalog.js';
import { handoffRefusal, nativeFamily as familyOf } from './session-core/family.js';
import { hasHeldChild, mayReconcileIdle, mayReleaseIdle } from './session-core/idle-release.js';
import * as lineage from './session-core/lineage.js';
import { bounded, HostRequestError, json, boundedSourceIdentity, positiveTimeout } from './session-core/requests.js';
import type { AgentHostDirectory, AgentHostProviderRegistration, AgentHostRuntime, AgentHostRuntimeOptions, SessionBinding as Binding } from './session-core/types.js';
import { createUplinkFence } from './session-core/uplink-fence.js';
import { createControlRoutes } from './session-core/control-routes.js';
import type { SessionCoreContext } from './session-core/context.js';
import { createJournalPublisher } from './publisher/journal-publisher.js';
import { loadResourceIdKey } from './resource-id-key.js';
import { FileResourceIdIndex } from './resource-id-index-file.js';
import { sessionHostAccess, type SessionCallerCatalog } from './session-callers.js';
import { pendingReferenceNote, type SessionRefContext } from './session-refs.js';
import { withReferenceNotes } from './session-reference-notes.js';
import { handleSessionRequest, type SessionActions, type SessionCaller, type SessionCallerRef, type SessionCallResult } from './session-routes.js';
import { CliError, operationUuid } from './cli-output.js';
import { runHostRequest } from './host-command.js';
import { handleRoleRequest } from './role-routes.js';
import { InputImageStore, InputResourceStore, createAgentRemoteRelay, createRemoteHostUplinkClient, type AgentRemoteHttpResult, RemoteHostCatalog, type RemoteHostControlRequest, type RemoteHostUplinkClient, type RemoteHostUplinkDiagnostic, type RemoteHostSessionLease, type SessionWireAgent, type SessionWireOperation, type SessionWireOperationExecutor } from '@orchardworks/agent-session-runtime';

export type { AgentHostDirectory, AgentHostProviderRegistration, AgentHostRequestDiagnostic, AgentHostRuntime, AgentHostRuntimeOptions, AgentHostWorkspace } from './session-core/types.js';

/** The Controller's host: the runtime of its sessions with the uplink, the updater and the processes around it. */
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
  /** Sends a command naming another Host there, through the Relay as the signed-in command line. */
  forwardCommand?(scope: string, hostId: string, request: Record<string, unknown>): Promise<SessionCallResult>;
  /** A request to the Relay as the signed-in command line, for what only the Relay keeps. */
  relayRequest?(method: 'GET' | 'POST', path: string, body?: unknown): Promise<{ status: number; data: any }>;
}
export interface AgentHostUplinkDiagnostic extends RemoteHostUplinkDiagnostic { uplinkGeneration: number }
export interface AgentHost {
  readonly ready: Promise<{ hostId: string }>;
  controllerInfo(): Promise<{ identity: ControllerIdentity | undefined; status: ControllerUpdateStatus | undefined }>;
  updateController(version: string, operationId: string, clean?: boolean): Promise<ControllerUpdateStatus>;
  readonly sessionCatalog: SessionCallerCatalog;
  readonly sessionRefs?: SessionRefContext;
  /** Answers one resource command (session, group, host) from this Host's sockets; requests naming other Hosts go through the Relay. */
  command(scope: string, request: unknown, caller: SessionCaller): Promise<SessionCallResult>;
  readonly state: 'connecting' | 'registered' | 'disconnected' | 'rejected' | 'closed';
  replaceUplink(uplink: AgentHostOptions['uplink']): Promise<{ hostId: string }>;
  close(): Promise<void>;
}

export function createAgentHost(options: AgentHostOptions): AgentHost {
  if (options.succession?.enrollment && options.succession.controllerId !== options.installationId) throw new Error('Succession Controller identity must match the installed Controller.');
  const stateDirectory = options.preview?.stateDirectory ?? options.vscodeTunnel?.stateDirectory;
  const registeredHostId = async () => fence.closed || state !== 'registered' ? undefined : (await connection.client.ready).hostId;
  let uplinkUrl = options.uplink.url;
  const siteOrigin = () => { const url = new URL(uplinkUrl); url.protocol = url.protocol === 'ws:' ? 'http:' : 'https:'; return url.origin; };
  const runtime = createAgentHostRuntime({ ...options, hostId: registeredHostId, siteOrigin, ...(options.team ? { team: { ...options.team, request: (call: TeamHostCall) => connection.client.teamRequest(call),
    genericSuccession: () => connection.client.teamSuccession, callForSupport: () => connection.client.callForSupport } } : {}), controllerId: options.installationId,
    ...(options.inputImages ? {} : stateDirectory ? { inputImages: { directory: join(stateDirectory, 'input-images') } } : {}),
    ...(options.inputResources ? {} : stateDirectory ? { inputResources: { directory: join(stateDirectory, 'input-resources') } } : {}),
    ...(options.sessionRepliesFile || !stateDirectory ? {} : { sessionRepliesFile: join(stateDirectory, 'session-replies.json') }),
    ...(options.resourceIdKeyFile || !stateDirectory ? {} : { resourceIdKeyFile: join(stateDirectory, 'resource-id.key') }),
    ...(options.resourceIdIndexFile || !stateDirectory ? {} : { resourceIdIndexFile: join(stateDirectory, 'resource-id-index.json') }),
    ...(stateDirectory ? { outbox: { file: join(stateDirectory, 'outbox-receipts.json'), request: (call: OutboxHostCall) => connection.client.outboxRequest(call) } } : {}) });
  options.providerDiscovery?.onRegistration(runtime.addRegistration);
  runtime.setRelayConnected(false);
  const updater = options.controller ? createControllerUpdater({ ...options.controller, beginRestart: runtime.beginControllerRestart, cancelRestart: runtime.cancelControllerRestart }) : undefined;
  const codexDaemon = options.codexDaemon ? createCodexDaemonControl(options.codexDaemon) : undefined;
  const previews = options.preview ? createControllerPreviews(options.preview) : undefined;
  const vscodeTunnel = options.vscodeTunnel ? createVscodeTunnelManager({ ...options.vscodeTunnel, installationId: options.installationId }) : undefined;
  let state: AgentHost['state'] = 'connecting';
  const fence = createUplinkFence();
  interface Connection { client: RemoteHostUplinkClient; superseded: boolean }
  let connection: Connection;
  const describeProviders = () => options.registrations.filter(item => options.providerEnabled?.(item.directory.providerId) !== false).map(({ adapter, directory }) => ({ providerId: adapter.descriptor.providerId, displayName: adapter.descriptor.displayName, ...(codexDaemon && adapter.descriptor.providerId === 'codex' ? { daemonControl: true as const } : {}), ...(directory.renameSession ? { sessionRename: true as const } : {}), ...(directory.supportsPromptEditing ? { promptEditing: true as const } : {}),
    // References are an attribute of every session on a Host that keeps them, whatever created the session, and the
    // Host tells each session's agent when they change.
    ...(options.sessionRefs ? { sessionReferences: true as const, referenceNotes: true as const } : {}),
    // Session commands reach this Host through the Relay too.
    sessionCommands: true as const }));
  /** Every Host route, as the Relay and this computer's command line reach them. */
  const hostControl = async (request: RemoteHostControlRequest): Promise<AgentRemoteHttpResult> => request.method === 'POST' && request.path === RELAY_DIAGNOSTIC_PATH ? receiveRelayDiagnostics(request.body, options.onRelayDiagnostics) : request.path === '/remote/controller-update' ? (async () => {
        try {
          if (request.method === 'GET') {
            if (!updater && !options.onRelayDiagnostics) return { status: 404, body: '' };
            // Health rides on the update status, which every Relay already forwards to the owner unchanged.
            return { status: 200, body: JSON.stringify({ ...(await updater?.status()), ...(options.onRelayDiagnostics ? { diagnosticDelivery: 4 } : {}),
              ...(options.health ? { health: options.health.snapshot() } : {}) }) };
          }
          if (!updater) return { status: 404, body: '' };
          const body = JSON.parse(request.body ?? '{}');
          return { status: 202, body: JSON.stringify(await updater.request(body.version, body.operationId)) };
        } catch (error) { return { status: 409, body: JSON.stringify({ error: error instanceof Error ? error.message : 'Controller update failed.',
          ...(request.method === 'GET' && options.onRelayDiagnostics ? { diagnosticDelivery: 4 } : {}) }) }; }
      })() : request.path === '/remote/provider-settings' && options.providerDiscovery ? options.providerDiscovery.control(request) : request.path === '/remote/codex-daemon' && codexDaemon ? codexDaemon.control(request) : request.path.startsWith('/remote/vscode-tunnel') && vscodeTunnel ? vscodeTunnel.control(request)
        : request.path.startsWith('/remote/previews') && previews ? previews.control(request) : runtime.control(request);
  const connect = (config: AgentHostOptions['uplink']): Connection => {
    uplinkUrl = config.url;
    runtime.setRelayConnected(false);
    runtime.journals.available(undefined);
    const current = fence.begin();
    return { superseded: false, client: createRemoteHostUplinkClient({ relay: runtime.relay, installationId: options.installationId, name: options.name, environment: options.environment, controller: options.controller?.identity,
      ...(options.team ? { teamManagement: true, callForSupport: true,
        readOnlyProviders: options.registrations.filter(({ adapter }) => adapter.descriptor.sessionAccess?.readOnly).map(({ adapter }) => adapter.descriptor.providerId) } : {}),
      ...(options.tpm ? { tpmManagement: true } : {}),
      hostStatus: true,
      ...(runtime.outbox ? { outbox: {
        onAvailable: (available: boolean) => { fence.whenCurrent(current, () => runtime.outbox!.setAvailable(available)); },
        onReady: () => { fence.whenCurrent(current, () => runtime.outbox!.wake()); } } } : {}),
      ...(options.succession?.enrollment ? { successionEnrollment: { control: runtime.enrollFromRelay } } : {}),
      // A Controller with no journal-capable provider does not ask for the grant, and a Relay without it never offers one.
      ...(runtime.journals.capable() ? { journal: {
        available: (writer: { send(json: string): void } | undefined) => { fence.whenCurrent(current, () => runtime.journals.available(writer)); },
        receive: (message: JournalRelayMessage) => { fence.whenCurrent(current, () => runtime.journals.receive(message)); } } } : {}),
      sessionStates: runtime.sessionStates,
      providers: describeProviders(), ...(options.providerDiscovery ? { providerChanges: { current: describeProviders, subscribe: options.providerDiscovery.subscribe } } : {}), url: config.url, remoteKey: config.remoteKey,
      onCredential: config.onCredential ? credential => fence.persistCredential(current, config.onCredential!, credential) : undefined,
      resolveSession: runtime.resolveSession, acquireSession: runtime.acquireSession, control: hostControl,
      operationExecutor: scope => runtime.executeOperation(scope),
      previews: previews ? { snapshot: previews.snapshot, subscribe: previews.subscribe, disconnected: previews.disconnected,
        registered: info => previews.registered({ ...info, url: config.url }) } : undefined,
      onDiagnostic: options.onDiagnostic ? diagnostic => options.onDiagnostic!({ ...diagnostic, uplinkGeneration: current.generation }) : undefined,
      onStateChange(next) { fence.whenCurrent(current, () => { state = next; runtime.setRelayConnected(next === 'registered'); vscodeTunnel?.setRelayConnected(next === 'registered'); }); } }) };
  };
  connection = connect(options.uplink);
  const ready = connection.client.ready;
  let closePromise: Promise<void> | undefined;
  return {
    ready,
    get state() { return state; },
    sessionCatalog: runtime.sessionCatalog,
    ...(runtime.sessionRefs ? { sessionRefs: runtime.sessionRefs } : {}),
    async command(scope, request, caller) {
      if (scope === 'session') return runtime.callSession(request, caller, options.forwardCommand ? (hostId, forwarded) => options.forwardCommand!('session', hostId, forwarded) : undefined);
      if (scope === 'role') return runtime.callRole(request, caller);
      if (scope !== 'host') return { error: { code: 'invalid_request', message: `Unknown command group: ${scope}.` } };
      if (!request || typeof request !== 'object' || Array.isArray(request)) return { error: { code: 'invalid_request', message: 'The host command is invalid.' } };
      const command = request as Record<string, unknown>, hostId = await registeredHostId();
      const named = typeof command.host === 'string' && !['self', 'local', hostId].includes(command.host) ? command.host : undefined;
      // Only the Relay keeps the account's Hosts; another Host is reached through it.
      if (named || command.command === 'list') {
        if (!options.forwardCommand) return { error: { code: 'host_unreachable', message: 'Other Hosts are reachable through the Relay only.' } };
        return options.forwardCommand('host', named ?? '', command);
      }
      const parse = (result: AgentRemoteHttpResult) => { try { return { status: result.status, data: result.body ? JSON.parse(String(result.body)) : {} }; } catch { return { status: result.status, data: {} }; } };
      return runHostRequest(command, {
        id: async () => hostId,
        host: async (method, path, body) => parse(await hostControl({ requestId: randomUUID(), method, path: `/remote/${path}`, ...(body !== undefined ? { body: JSON.stringify(body) } : {}) })),
        describe: async () => ({ ...(hostId ? { id: hostId } : {}), name: options.name, online: state === 'registered', providers: describeProviders(),
          ...(options.environment ? { environment: options.environment } : {}), ...(options.controller ? { controller: options.controller.identity } : {}),
          ...(updater ? { update: await updater.status() } : {}) }),
        relay: async (method, path, body) => {
          if (!options.relayRequest) throw new CliError('signed_out', 'The Relay is reached as the signed-in owner: run agent-remote-controller login first.');
          return options.relayRequest(method, path, body);
        },
      });
    },
    async controllerInfo() { return { identity: options.controller?.identity, status: await updater?.status() }; },
    async updateController(version, operationId, clean) {
      if (!updater || fence.closed) throw new Error('Controller updates are unavailable.');
      return updater.request(version, operationId, clean);
    },
    async replaceUplink(config) {
      if (fence.closed) throw new Error('Agent Host is closed.');
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
    close() { return closePromise ??= (async () => { fence.close(); state = 'closed';
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

export function createAgentHostRuntime(options: AgentHostRuntimeOptions): AgentHostRuntime {
  if (options.executionPolicy) options = { ...options, registrations: options.registrations.map(registration => ({ ...registration,
    directory: protectHostDirectory(registration.directory, { ...options.executionPolicy!,
      lockPermissions: registration.nativePermissionControl ? false : options.executionPolicy!.lockPermissions }) })) };
  if (!options.registrations.length && !options.providerEnabled) throw new Error('Agent Host requires at least one provider registration.');
  const registrations = new Map<string, AgentHostProviderRegistration>();
  const prepared = new Map<string, AgentSession>();
  const nativeAttachments = new WeakMap<SessionWireAgent, { session: AgentSession; nativeCreation?: string; nativePrefix?: string }>();
  /** Every read of a provider's directory, whoever asks for it (the page's revision check, a listing, the state confirmation), passes the summaries to `listed`. */
  const observeListing = (registration: AgentHostProviderRegistration): AgentHostProviderRegistration => ({ ...registration, directory: new Proxy(registration.directory, {
    get(target, key) {
      if (key === 'list') return async () => {
        const summaries = await target.list();
        // A refresh never fails the listing it rides on.
        try { terminalRefresh.listed(target.providerId, summaries); } catch { /* The next listing tries again. */ }
        return summaries;
      };
      const value = Reflect.get(target, key, target);
      return typeof value === 'function' ? value.bind(target) : value;
    },
  }) });
  for (const registration of options.registrations) {
    const id = registration.adapter.descriptor.providerId;
    if (registration.directory.providerId !== id) throw new Error(`Directory provider identity does not match ${id}.`);
    if (registrations.has(id)) throw new Error(`Duplicate Agent Host provider: ${id}.`);
    registrations.set(id, observeListing(registration));
  }
  /** Only providers whose adapters declare journal support are published; every other provider keeps today's forwarding. */
  const journals = createJournalPublisher({
    providers: () => [...registrations.values()]
      .filter(({ adapter, directory }) => adapter.journal !== undefined && options.providerEnabled?.(directory.providerId) !== false)
      .map(({ adapter }) => adapter.descriptor.providerId),
    ...(options.onJournalDiagnostic ? { diagnostic: options.onJournalDiagnostic } : {}),
  });
  const relayAdapters = options.registrations.map(({ adapter }) => ({
    descriptor: adapter.descriptor,
    ...(adapter.journal === undefined ? {} : { journal: adapter.journal }),
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
        // A generic successor takes over the role its source holds, or the handoff is refused.
        const role = await roles.genericSuccession(source, targetProviderId);
        if (!role.allowed) throw new SuccessionPreparationRejected('succession_role_unavailable', role.reason);
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
        // The successor carries its source's role from creation; the role's tools run only once it is attached.
        const extensions = await roles.extensions(source, () => undefined) ?? workerExtensions(targetProviderId, source, () => undefined);
        const config = { sessionId: directoryOperationId(operationId), cwd: role.workspace.canonicalCwd, ...(source.providerId === targetProviderId ? { selectionSourceSessionId: source.nativeSessionId } : {}),
          ...(extensions ? { extensions } : {}) };
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
  const resourceIdKey = options.resourceIdKeyFile ? loadResourceIdKey(options.resourceIdKeyFile) : undefined;
  const resourceIdIndex = resourceIdKey !== undefined && options.resourceIdIndexFile ? new FileResourceIdIndex(options.resourceIdIndexFile) : undefined;
  const relay = createAgentRemoteRelay({ providers: relayAdapters, ...(resourceIdKey === undefined ? {} : { resourceIdKey }), ...(resourceIdIndex ? { resourceIdIndex } : {}), operationCache, operationLifecycle: {
    settingIntent: (agent, accept) => successionBoundary ? successionBoundary.settingIntent(nativeRef(bindingFor(agent)), accept) : accept(),
    target: agent => { const binding = bindingFor(agent); return JSON.stringify([binding.providerId, binding.nativeSessionId]); },
    admit: () => { if (admission.draining) throw new OperationCacheError('controller_updating', 'Controller is updating. Reconnect before retrying.'); },
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
  const catalogs = new Map([...registrations.values()].map(({ directory }) => [directory.providerId, new RemoteHostCatalog({ roots: directory.list, revisionMaxAgeMs: catalogRevisionMaxAgeMs })]));
  const bindings = new SessionBindings();
  const liveSessionStates = () => [...bindings.values()].flatMap(binding => {
    const live = liveAgent(binding.agentId), state = live && liveSessionState(live.handoffAdmissionState());
    return state ? [{ providerId: binding.providerId, nativeSessionId: binding.nativeSessionId, state }] : [];
  });
  // Each open session's latest reply is read when its timeline moves, and remembered after it is released.
  const sessionReplies = createSessionReplies(options.sessionRepliesFile ? { file: options.sessionRepliesFile } : {});
  const sessionStates = createSessionStatePublisher({
    live: () => {
      for (const binding of bindings.values()) { const live = liveAgent(binding.agentId); if (live) sessionReplies.observe(binding, binding.agentId, live); }
      return liveSessionStates();
    },
    replies: session => sessionReplies.facts(session),
    catalogs: () => [...registrations.values()].filter(({ directory }) => options.providerEnabled?.(directory.providerId) !== false)
      .map(({ directory }) => ({ providerId: directory.providerId, read: async () => catalogSessionStates(await directory.list()) })),
  });
  const hostStatus = createHostStatusReader({ sessions: liveSessionStates,
    paths: () => hostStatusPaths(async () => (await Promise.all([...registrations.values()].filter(({ directory }) => options.providerEnabled?.(directory.providerId) !== false)
      .map(async ({ directory }) => (await directory.workspaces()).map(workspace => workspace.path)))).flat()) });
  const pending = new Set<Promise<unknown>>();
  const idle = createIdleSessions({ graceMs: options.idleGraceMs, reconcileMs: options.idleReconcileMs });
  const uncertainAgents = new Set<string>();
  const cancelTimeoutMs = positiveTimeout(options.cancelTimeoutMs ?? 5000);
  const shutdownTimeoutMs = positiveTimeout(options.shutdownTimeoutMs ?? 5000);
  const admission = createAdmission();
  let closePromise: Promise<void> | undefined;
  const terminalRefresh = createTerminalRefresh({
    now: () => Date.now(),
    directory: providerId => registrations.get(providerId)?.directory,
    bindings: () => bindings.values(),
    bindingOf: (providerId, nativeSessionId) => bindings.getByNative(providerId, nativeSessionId),
    isLive: agentId => !!liveAgent(agentId),
    hasDemand: agentId => idle.hasDemand(agentId),
    expire: agentId => idle.expire(agentId),
    granted: () => journals.granted(),
    stopped: () => admission.stopped,
    attachAndRelease: async agentId => { const lease = await acquireSession(agentId); lease?.release(); idle.expire(agentId); },
    releaseJournal: agentId => journals.release(agentId),
  });

  function assertHandoffState(target: NativeSessionRef, captured?: { epoch: string; seq: number }, allowMissing = false): void {
    const family = nativeFamily(target.providerId, target.nativeSessionId);
    const own = family.find(binding => binding.nativeSessionId === target.nativeSessionId);
    const live = own && liveAgent(own.agentId);
    const refusal = handoffRefusal({ bound: !!own, own: live?.handoffAdmissionState(), ownCursor: live?.timelineCursor(), ...(captured ? { captured } : {}), allowMissing,
      children: family.filter(binding => binding !== own).map(child => liveAgent(child.agentId)?.handoffAdmissionState()),
      unsettledRecipient: !!(tpm?.hasUnsettledRecipient(target) || team?.hasUnsettledRecipient(target)) });
    if (refusal) throw new SuccessionPreparationRejected(refusal.code, refusal.message);
  }
  function nativeFamily(providerId: string, nativeSessionId: string): Binding[] {
    return familyOf(bindings.values(), providerId, nativeSessionId);
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
  for (const value of registrations.values()) { const {directory} = value; bindHandoff(directory); bindSourceReader(directory); bindSourceReferenceAncestry(directory); bindHostAccess(value); }
  function bindHostAccess({ adapter, directory }: AgentHostProviderRegistration) {
    const callers = options.sessionCallers;
    if (callers && adapter.descriptor.sessionHostAccess) directory.setSessionHostAccess?.(sessionHostAccess(callers.store, directory.providerId, callers.endpoint, callers.skills, callers.sessionBin));
  }
  /** A share recipient's session is hidden from session commands and holds no credential. */
  async function markShared(payload: Record<string, unknown> | undefined, providerId: string, nativeSessionId: string) {
    if (payload?.shared === true) await options.sessionCallers?.store.markShared({ providerId, nativeSessionId });
  }
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
  const originalCreation = (target: NativeSessionRef) => lineage.originalCreation(succession?.store, target);
  const originalNativePrefix = (target: NativeSessionRef) => lineage.originalNativePrefix(succession?.store, target);
  const genericSuccessionSource = (target: NativeSessionRef) => lineage.genericSuccessionSource(succession?.store, target);
  /** Rebuild each native attachment from stable role anchors and its own actual recipient. */
  async function nativePrefixExtensions(source: NativeSessionRef, actual: () => string | undefined): Promise<AgentSessionExtensions> {
    const directory = registration(source.providerId).directory;
    const ancestry = nativePrefixSegmentAncestors(source, successionService!.store.all().flatMap(state => state.operations.filter(row => row.phase === 'committed')));
    const grants = (await directory.sourceReferences?.() ?? []).filter(grant => ancestry.some(ref => ref.nativeSessionId === grant.nativeSessionId));
    if (grants.length > 1) throw new Error('Source reference ancestry is ambiguous.');
    const sourceTools = grants.length === 1 && !!directory.setSourceReferenceAncestors && !!directory.setSourceBindingReader;
    const teamTools = await team?.extensions(source, () => { const id = actual(); return id ? { ...source, nativeSessionId: id } : undefined; });
    const tpmTools = await tpm?.extensions(source.providerId, source.nativeSessionId, actual);
    if (teamTools && tpmTools) throw new SuccessionPreparationRejected('succession_prefix_extensions_unavailable', 'Native recipient has conflicting role extensions.');
    if (directory.requiresController?.(source.nativeSessionId) && !sourceTools && !teamTools && !tpmTools) throw new SuccessionPreparationRejected('succession_prefix_extensions_unavailable', 'Native prefix extensions cannot be reconstructed.');
    return teamTools ?? tpmTools ?? workerExtensions(source.providerId, source, () => { const id = actual(); return id ? { ...source, nativeSessionId: id } : undefined; }) ?? {};
  }
  /** Worker tools for a session without a role: declared at creation where providers fix tools then, present only while enabled elsewhere. */
  function workerExtensions(providerId: string, holder: NativeSessionRef | undefined, actual: () => NativeSessionRef | undefined): AgentSessionExtensions | undefined {
    if (!workerSupport) return undefined;
    const capability = registration(providerId).adapter.descriptor.sessionExtensions?.toolNamespaces;
    const enabled = holder ? workerSupport.enabled(holder) : workerSupport.enabledByDefault();
    if (capability === 'creation') return { toolNamespaces: [workerSupport.namespace(actual, !enabled)] };
    // Without tool search, a session gets the namespace while enabled; an 'attachment' adapter receives an enablement change on its next attachment.
    if ((capability === 'live' || capability === 'attachment') && enabled) return { toolNamespaces: [workerSupport.namespace(actual, false)] };
    return undefined;
  }
  /** Applies enablement changes to live sessions whose provider can change tools during a session. */
  async function applyWorkerTools(): Promise<void> {
    if (!workerSupport) return;
    for (const binding of [...bindings.values()]) {
      const agent = liveAgent(binding.agentId), session = agent && nativeAttachments.get(agent)?.session;
      if (!session?.updateToolNamespaces || registration(binding.providerId).adapter.descriptor.sessionExtensions?.toolNamespaces !== 'live') continue;
      const ref = nativeRef(binding);
      if (await roles.extensions(ref, () => ref)) continue;
      const enabled = workerSupport.enabled(ref);
      if ((workerToolsApplied.get(binding.agentId) ?? false) === enabled) continue;
      try { await session.updateToolNamespaces(enabled ? [workerSupport.namespace(() => ref, false)] : []); workerToolsApplied.set(binding.agentId, enabled); }
      catch { /* The next enablement change or attachment applies it again. */ }
    }
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
    const childHeld = () => hasHeldChild(bindings.values(), binding, child => !!liveAgent(child.agentId) || idle.hasDemand(child.agentId));
    idle.watch(binding.agentId, () => mayReleaseIdle({
      closed: admission.closed, uncertain: uncertainAgents.has(binding.agentId), pending: bindings.isPending(binding.providerId, binding.nativeSessionId),
      directoryCanRelease: !!registration(binding.providerId).directory.canReleaseSession?.(binding.nativeSessionId), runtimeCanReleaseIdle: !!liveAgent(binding.agentId)?.canReleaseIdle(),
      childHeld: childHeld(),
    }), async () => {
      await terminalRefresh.releaseJournal(binding);
      await relay.closeAgent(binding.agentId);
      await registration(binding.providerId).directory.sessionReleased?.(binding.nativeSessionId);
      lifecycle('session_idle_released', binding);
    }, async isCurrent => {
      const source = registration(binding.providerId).directory;
      const agent = liveAgent(binding.agentId);
      if (!source.reconcileIdleSession || !mayReconcileIdle({ directoryCanReconcile: true, runtimeCanReleaseIdle: !!agent?.canReleaseIdle(), childHeld: childHeld() }) || !agent) return false;
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
  async function releaseIfDiverged(binding: Binding): Promise<void> {
    const directory = registration(binding.providerId).directory;
    if (!directory.checkDivergence || binding.parentNativeSessionId || !liveAgent(binding.agentId) || !await directory.checkDivergence(binding.nativeSessionId)) return;
    const agent = liveAgent(binding.agentId);
    if (!agent?.canReleaseIdle()) return;
    await terminalRefresh.releaseJournal(binding);
    await relay.closeAgent(binding.agentId);
    await directory.sessionReleased?.(binding.nativeSessionId);
  }
  async function acquireSession(agentId: string): Promise<RemoteHostSessionLease | undefined> {
    const binding = bindings.getByAgent(agentId);
    if (admission.closed || !binding) return undefined;
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
      // A send must not continue from a conversation a terminal has moved on: a diverged, quiet session is released and read again first.
      await releaseIfDiverged(binding);
      await tracked(project(binding.providerId, agentId, binding.nativeSessionId, binding.parentNativeSessionId));
      const agent = admission.closed ? undefined : liveAgent(agentId);
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
        const attached = nativeRef({ providerId, nativeSessionId });
        // A generic successor holds the role of its source, so every attachment of it gets the same extensions.
        const extensions = nativePrefix ? await nativePrefixExtensions(nativePrefix.source, () => nativeSessionId)
          : await roles.extensions(genericSuccessionSource(attached) ?? attached, () => attached) ?? workerExtensions(providerId, attached, () => attached);
        workerToolsApplied.set(proposedAgentId, !!extensions?.toolNamespaces?.some(namespace => namespace.name === 'agent_remote' && !namespace.deferred));
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
        const noted = sessionRefs && parentNativeSessionId === undefined ? withReferenceNotes(nativeSession, {
          pending: () => pendingReferenceNote({ providerId, nativeSessionId }, sessionRefs),
          delivered: revision => sessionRefs.store.markDelivered({ providerId, nativeSessionId }, revision),
        }) : nativeSession;
        const annotated = tpm ? await tpm.annotateSession(providerId, nativeSessionId, noted) : noted;
        const session = successionBoundary ? successionBoundary.wrap(nativeRef(binding), annotated) : annotated;
        if (admission.closed) {
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
        journals.attach({ agentId: proposedAgentId, providerId, nativeSessionId, source: relay.requireAgent(proposedAgentId) });
        if (existing) lifecycle('session_idle_restored', binding);
      } catch (error) { prepared.delete(proposedAgentId); throw error; }
      finally { parent?.release(); }
      },
    });
    assertAttachment(liveAgent(bound.agentId));
    return bound;
  }
  const ctx: SessionCoreContext = {
    options, admission, relay, bindings, idle, operationCache, catalogs, hostStatus, cancelTimeoutMs, successionReady, successionService, succession, successionBoundary,
    get tpm() { return tpm; }, get team() { return team; }, get enrollment() { return enrollment; }, get sessionRefs() { return sessionRefs; },
    registration, liveAgent, nativeRef, mutationFamily, directoryOperation, tracked, project, callSession, authorizeSuccessionRead, workerExtensions, markShared,
  };
  const { create, control, controlRequest } = createControlRoutes(ctx);
  function addRegistration(value: AgentHostProviderRegistration): void {
    if (admission.stopped) throw new Error('Host cannot register a provider while stopping.');
    const id = value.adapter.descriptor.providerId;
    if (id !== value.directory.providerId || registrations.has(id)) throw new Error('Invalid or duplicate provider registration.');
    const registration = options.executionPolicy ? { ...value, directory: protectHostDirectory(value.directory, {
      ...options.executionPolicy, lockPermissions: value.nativePermissionControl ? false : options.executionPolicy.lockPermissions,
    }) } : value;
    relay.registerProvider({ descriptor: value.adapter.descriptor,
      ...(value.adapter.journal === undefined ? {} : { journal: value.adapter.journal }),
      async createSession(config) { const session = prepared.get(config.sessionId); if (!session) throw new Error('Agent Host projection session is unavailable.'); prepared.delete(config.sessionId); return session; },
      resumeSession: value.adapter.resumeSession.bind(value.adapter),
    });
    const observed = observeListing(registration);
    registrations.set(id, observed);
    catalogs.set(id, new RemoteHostCatalog({ roots: observed.directory.list, revisionMaxAgeMs: catalogRevisionMaxAgeMs }));
    bindHandoff(observed.directory);
    bindSourceReader(observed.directory);
    bindSourceReferenceAncestry(observed.directory);
    bindHostAccess(observed);
  }
  const sessionCatalog: SessionCallerCatalog = createSessionCatalog({
    providerIds: () => registrations.keys(),
    enabled: providerId => options.providerEnabled?.(providerId) !== false,
    catalog: providerId => catalogs.get(providerId),
    directory: providerId => registrations.get(providerId)?.directory,
    adapter: providerId => registration(providerId).adapter,
    runtimeState: (providerId, nativeSessionId) => {
      const binding = bindings.getByNative(providerId, nativeSessionId), live = binding && liveAgent(binding.agentId);
      return live?.handoffAdmissionState();
    },
  });
  /** A command line's operation identity as the operation cache takes it: a UUID, derived when the caller chose another form. */
  const cliOperation = operationUuid;
  async function holding<T>(ref: SessionCallerRef, work: (agent: SessionWireAgent) => Promise<T>): Promise<T> {
    const held = await automationAccess.acquire(ref.providerId, ref.nativeSessionId);
    try { return await work(held.agent); } finally { held.release(); }
  }
  const cliExecute = (agent: SessionWireAgent, operationId: string, kind: SessionWireOperation['kind'], parameters: unknown, dispatch: () => Promise<unknown>, validate?: () => Promise<void> | void) =>
    executeOperation('host:cli')(agent, { operationId: cliOperation(operationId), kind, parameters, maximumResultBytes: 1024 }, { dispatch, ...(validate ? { validate } : {}) });
  /** The session commands' changes, run like the website's: through the operation cache, once per operation identity. */
  const sessionActions: SessionActions = {
    async create(input, operationId) {
      const result = await create({ requestId: randomUUID(), method: 'POST', path: '/remote/create', sessionId: randomUUID(), operationScope: 'host:cli',
        body: JSON.stringify({ ...input, operationId: cliOperation(operationId) }) }, { ...input, operationId: cliOperation(operationId) });
      const created = JSON.parse(result.body) as { nativeSessionId?: string };
      if (result.status >= 400 || !created.nativeSessionId) throw new Error('The session could not be created.');
      return { providerId: input.providerId, nativeSessionId: created.nativeSessionId };
    },
    send: (ref, input, operationId) => holding(ref, async agent => {
      if (input.steer && !agent.steer) throw Object.assign(new Error('This session cannot be steered.'), { code: 'unsupported_configuration' });
      const result = await cliExecute(agent, operationId, input.steer ? 'steer' : 'send_message', input.steer ? { text: input.text } : { text: input.text, delivery: null }, async () => {
        const acceptance = input.steer ? await agent.steer!(input.text) : await agent.sendMessage(input.text);
        return acceptance ? { disposition: acceptance.disposition } : {};
      }) as { disposition?: string };
      return result;
    }),
    cancel: (ref, operationId) => holding(ref, async agent => {
      if (!agent.cancel) throw Object.assign(new Error('This session cannot be canceled.'), { code: 'unsupported_configuration' });
      await cliExecute(agent, operationId, 'cancel', {}, async () => { await agent.cancel!(); return { accepted: true }; });
    }),
    inspect: ref => holding(ref, async agent => {
      const payload = agent.snapshot().payload;
      return { status: payload.status, ...(payload.runtimeInfo.planning ? { planning: payload.runtimeInfo.planning.active } : {}),
        settings: (payload.runtimeInfo.settings ?? []).map(setting => ({ id: setting.id, label: setting.label, value: setting.value, ...(setting.mutable !== undefined ? { mutable: setting.mutable } : {}),
          ...(setting.options ? { options: setting.options.map(option => ({ value: option.value, label: option.label })) } : {}) })),
        pendingInteractions: payload.pendingInteractions };
    }),
    answer: (ref, requestId, response, operationId) => holding(ref, async agent => {
      await cliExecute(agent, operationId, 'interaction_response', { requestId, response }, async () => { await agent.respondToInteraction(requestId, response); return { accepted: true }; },
        agent.validateInteractionResponse ? () => agent.validateInteractionResponse!(requestId, response) : undefined);
    }),
    setting: (ref, id, value, operationId) => holding(ref, async agent => {
      if (!agent.setSessionSetting) throw Object.assign(new Error('This session has no settings to change.'), { code: 'unsupported_configuration' });
      await cliExecute(agent, operationId, 'set_session_setting', { settingId: id, value }, async () => { await agent.setSessionSetting!(id, value); return { accepted: true }; });
    }),
    planning: (ref, active, operationId) => holding(ref, async agent => {
      if (!agent.setPlanning) throw Object.assign(new Error('This session has no planning mode.'), { code: 'unsupported_configuration' });
      await cliExecute(agent, operationId, 'set_planning', { active }, async () => { await agent.setPlanning!(active); return { accepted: true }; });
    }),
    async rename(ref, title, operationId) {
      const result = await controlRequest({ requestId: randomUUID(), method: 'POST', path: '/remote/session/rename', operationScope: 'host:cli',
        body: JSON.stringify({ ...ref, title, operationId: cliOperation(operationId) }) });
      const renamed = JSON.parse(result.body) as { title?: string; error?: string; code?: string };
      if (result.status >= 400 || typeof renamed.title !== 'string') throw Object.assign(new Error(renamed.error ?? 'The session could not be renamed.'), { code: renamed.code ?? 'rename_failed' });
      return renamed.title;
    },
    async release(ref) {
      const binding = bindings.getByNative(ref.providerId, ref.nativeSessionId), agent = binding && liveAgent(binding.agentId);
      if (!binding || !agent) return true;
      if (idle.hasDemand(binding.agentId) || !registration(ref.providerId).directory.canReleaseSession?.(ref.nativeSessionId) || !agent.canReleaseIdle()) return false;
      await terminalRefresh.releaseJournal(binding);
      await relay.closeAgent(binding.agentId);
      await registration(ref.providerId).directory.sessionReleased?.(ref.nativeSessionId);
      return true;
    },
  };
  /** One session command; forward reaches other Hosts, for commands that came from this Host's own sockets. */
  /** The tools of the role a session holds, or its worker tools, which role commands run from its shell. */
  async function roleTools(ref: SessionCallerRef): Promise<readonly AgentSessionTool[]> {
    const holder = nativeRef(ref);
    const extensions = await roles.extensions(genericSuccessionSource(holder) ?? holder, () => holder);
    const worker = !extensions && workerSupport?.enabled(holder) ? [workerSupport.namespace(() => holder, false)] : [];
    return bindAgentSessionTools([...(extensions?.tools ?? []), ...[...(extensions?.toolNamespaces ?? []), ...worker].flatMap(namespace => namespace.tools)]);
  }
  function callRole(request: unknown, caller: SessionCaller): Promise<SessionCallResult> {
    return handleRoleRequest(request, caller, session => roleTools(session.ref));
  }
  function callSession(request: unknown, caller: SessionCaller, forward?: (hostId: string, request: Record<string, unknown>) => Promise<SessionCallResult>): Promise<SessionCallResult> {
    return handleSessionRequest(request, caller, { hostId: async () => options.hostId?.(), catalog: sessionCatalog, ...(sessionRefs ? { refs: sessionRefs } : {}), actions: sessionActions,
      isShared: ref => options.sessionCallers?.store.isShared(ref) ?? false, siteOrigin: () => options.siteOrigin?.(), ...(forward ? { forward } : {}) });
  }
  const sessionRefs: SessionRefContext | undefined = options.sessionRefs ? {
    store: options.sessionRefs,
    hostId: async () => options.hostId?.(),
    async grantedSource(holder) {
      if (options.providerEnabled?.(holder.providerId) === false) return undefined;
      return registrations.get(holder.providerId)?.directory.sourceReference?.(holder.nativeSessionId);
    },
    async setGrantRemoved(holder, removed) {
      const directory = registrations.get(holder.providerId)?.directory;
      if (!await directory?.sourceReference?.(holder.nativeSessionId).catch(() => undefined)) return;
      await directory!.setSourceReferenceRemoved?.(holder.nativeSessionId, removed);
    },
    async title(target) {
      if (options.providerEnabled?.(target.providerId) === false) return undefined;
      const summary = await catalogs.get(target.providerId)?.session(target.nativeSessionId);
      return summary ? summary.title ?? '' : undefined;
    },
  } : undefined;
  const automationAccess: TpmSessionAccess = {
    controllerId: successionConfig?.controllerId ?? options.controllerId ?? 'local',
    sessionRouting: successionService?.executionRouting ?? {
      resolve: anchor => ({ anchor, target: anchor, operationIds: [] }),
      assertCurrent: (anchor, actual) => { if (admission.stopped || nativeSessionRefKey(anchor) !== nativeSessionRefKey(actual)) throw new Error('Execution recipient is unavailable.'); },
    },
    ...(successionService ? { mainRouting: successionTpmRouting(successionService, successionConfig!.controllerId, acquireNative) } : {}),
    available: () => !admission.stopped,
    supportedProviders: () => [...registrations.values()].filter(({ adapter }) => options.providerEnabled?.(adapter.descriptor.providerId) !== false
      && adapter.descriptor.sessionExtensions?.instructions && adapter.descriptor.sessionExtensions?.tools).map(({ adapter }) => adapter.descriptor.providerId),
    async acquire(providerId, nativeSessionId) {
      if (admission.stopped || options.providerEnabled?.(providerId) === false) throw new Error('TPM session provider is unavailable.');
      const binding = await tracked(project(providerId, randomUUID(), nativeSessionId));
      const lease = await acquireSession(binding.agentId);
      if (!lease) throw new Error('TPM native session is unavailable.');
      try { if (options.executionPolicy) await allowedWorkspace(options.executionPolicy, lease.agent.snapshot().payload.runtimeInfo.cwd); }
      catch (error) { lease.release(); throw error; }
      return lease;
    },
    async recover(providerId, nativeSessionId, extensions) {
      if (admission.stopped || options.providerEnabled?.(providerId) === false) throw new Error('TPM provider is unavailable.');
      const existing = bindings.getByNative(providerId, nativeSessionId);
      if (existing && (liveAgent(existing.agentId) || bindings.isPending(providerId, nativeSessionId))) throw new Error('Close the recovered session before binding it as a TPM.');
      const session = await directoryNativeEffect(successionBoundary?.currentEntry(), successionBoundary?.currentEntry()?.targets ?? [], async () => registration(providerId).directory.open(nativeSessionId, { extensions }));
      const info = await session.runtimeInfo();
      if (info.sessionId !== nativeSessionId) throw new Error('Recovered native session identity does not match.');
      if (options.executionPolicy) await allowedWorkspace(options.executionPolicy, info.cwd);
    },
    async create(providerId, creation, extensions) {
      const config = roleSessionConfig(registration(providerId).adapter.descriptor, creation, extensions);
      return directoryNativeEffect(successionBoundary?.currentEntry(), successionBoundary?.currentEntry()?.targets ?? [], evidence => registration(providerId).directory.create(config, evidence));
    },
    execute: executeOperation('host:tpm'),
  };
  const tpm = options.tpm ? new TpmCoordinator(options.tpm, automationAccess) : undefined;
  const team = options.team?.request ? new TeamRuntime(options.team.stateDirectory, {...automationAccess, sessionRouting: successionService?.roleRouting ?? automationAccess.sessionRouting!,
    genericSuccession: () => !!successionService && options.team?.genericSuccession?.() === true, callForSupport: () => options.team?.callForSupport?.() === true,
    readOnlyProviders: () => automationAccess.supportedProviders().filter(providerId => registration(providerId).adapter.descriptor.sessionAccess?.readOnly),
    execute: executeOperation('host:team')}, options.team.request, options.team.tickMs) : undefined;
  const roles = new SessionRoles([...(team ? [team] : []), ...(tpm ? [tpmRole(tpm)] : [])]);
  // A message that waited for this Host goes to the session that carries its conversation now, through the same access as roles.
  const outbox = options.outbox ? new SessionOutbox({ file: options.outbox.file, request: options.outbox.request, access: {
    available: automationAccess.available,
    route: target => {
      try {
        const resolved = automationAccess.sessionRouting!.resolve({ controllerId: automationAccess.controllerId, ...target }).target;
        return resolved.controllerId === automationAccess.controllerId ? { providerId: resolved.providerId, nativeSessionId: resolved.nativeSessionId } : target;
      } catch { return target; }
    },
    acquire: automationAccess.acquire,
  } }) : undefined;
  const workerSupport = options.team?.request ? new WorkerSupport({ request: options.team.request, available: () => options.team?.callForSupport?.() === true,
    stateDirectory: options.team.stateDirectory, title: async ref => await registration(ref.providerId).directory.sessionTitle?.(ref.nativeSessionId) }) : undefined;
  const workerToolsApplied = new Map<string, boolean>();
  workerSupport?.onChange(() => { void applyWorkerTools().catch(() => undefined); });
  const workerSupportTimer = workerSupport ? setInterval(() => { if (!admission.closed) void workerSupport.refresh(automationAccess.controllerId).catch(() => undefined); }, options.team?.tickMs ?? 3000) : undefined;
  workerSupportTimer?.unref?.();
  const enrollment = successionService ? new SessionSuccessionEnrollment(successionService, successionConfig!.controllerId, () => [...registrations.values()], () => tpm?.store.all() ?? [], source => authorizeSuccessionRead(source, source), directoryOperation) : undefined;
  const enrollFromRelay = async (request: RemoteHostControlRequest, context: TrustedSuccessionContext) => {
    if (!options.succession?.enrollment || !enrollment || admission.stopped) return json(403, { code: 'succession_enrollment_unavailable', error: 'Trusted succession enrollment is unavailable.' });
    await tpm?.ready;
    if (request.path === '/remote/create') {
      if (request.method !== 'POST' || context.installationId !== successionConfig!.controllerId) return json(403, { code: 'succession_enrollment_unavailable', error: 'Succession Controller authority does not match.' });
      return control(request, structuredClone(context));
    }
    return enrollment.control(request, context);
  };
  return { relay, sessionStates, journals, sessionCatalog, callSession, callRole, ...(sessionRefs ? { sessionRefs } : {}), ...(outbox ? { outbox } : {}), executionRouting: successionService?.executionRouting, roleRouting: successionService?.roleRouting, addRegistration, control: request => control(request), enrollFromRelay, executeOperation, acquireSession, setRelayConnected: idle.setConnected,
    // An owner-confirmed update closes admission immediately. Shutdown and the launcher bound cleanup time; session state must not indefinitely defer it.
    beginControllerRestart: () => admission.beginDrain(),
    cancelControllerRestart() { admission.cancelDrain(); },
    resolveSession(agentId) { idle.touch(agentId); return liveAgent(agentId); },
    close(): Promise<void> { return closePromise ??= (async () => {
      admission.close();
      await bounded(successionReady, shutdownTimeoutMs).catch(() => undefined);
      if (workerSupportTimer) clearInterval(workerSupportTimer);
      await bounded(team?.close() ?? Promise.resolve(), shutdownTimeoutMs).catch(() => undefined);
      await bounded(journals.drain(1000), shutdownTimeoutMs).catch(() => undefined);
      journals.close();
      await bounded(outbox?.close() ?? Promise.resolve(), shutdownTimeoutMs).catch(() => undefined);
      await bounded(tpm?.close() ?? Promise.resolve(), shutdownTimeoutMs).catch(() => undefined);
      try {
        await bounded(successionBoundary?.close() ?? Promise.resolve(), shutdownTimeoutMs);
      } finally {
        successionBoundary?.retireCoverageEvidence();
        sessionReplies.close();
        bindings.close();
        const releasing = idle.close();
        for (const catalog of catalogs.values()) catalog.dispose();
        const cleanup = Promise.allSettled([releasing, relay.close(), ...[...registrations.values()].map(({ directory }) => Promise.resolve(directory.close())), ...pending]);
        await bounded(cleanup, shutdownTimeoutMs);
        resourceIdIndex?.flush();
      }
    })(); } };
}

async function receiveRelayDiagnostics(body: string | undefined, sink: AgentHostOptions['onRelayDiagnostics']): Promise<AgentRemoteHttpResult> {
  if (!sink) return { status: 404, body: '' };
  let entries: RelayDiagnostic[] | undefined;
  try { entries = parseRelayDiagnosticBatch(JSON.parse(body ?? 'null')); } catch { /* Invalid JSON is rejected below. */ }
  if (!entries) return { status: 400, body: '{"error":"Invalid relay diagnostic batch."}' };
  try { await sink(entries); return { status: 204, body: '' }; }
  catch { return { status: 503, body: '{"error":"Relay diagnostics could not be appended."}' }; }
}

/** TPM sessions keep their native history: a prompt edit can branch one, a generic handoff cannot move it. */
function tpmRole(tpm: TpmCoordinator): SessionRole {
  return {
    extensions: (holder, actual) => tpm.extensions(holder.providerId, holder.nativeSessionId, () => actual()?.nativeSessionId),
    genericSuccession: async holder => await tpm.extensions(holder.providerId, holder.nativeSessionId)
      ? { allowed: false, reason: 'A TPM session keeps its native history, so it cannot be handed off. Edit a prompt instead.' } : undefined,
  };
}
