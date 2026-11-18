import { TeamRuntime } from './team.js';
import { type JournalRelayMessage, type OutboxHostCall, type TeamHostCall } from '@orchardworks/agent-remote-protocol';
import { directoryNativeEffect, directoryOperationId } from './directory-mutation.js';
import { SessionSuccessionEnrollment } from './session-succession-enrollment.js';
import { successionTpmRouting } from './session-succession-tpm.js';
import { SessionSuccessionService } from './session-succession-service.js';
import { SuccessionPreparationRejected } from './local-succession-preparation.js';
import { SessionSuccessionBoundary } from './session-succession-boundary.js';
import { type SessionSuccessionStore } from './session-succession-store.js';
import type { SessionSuccessionContextStore } from './session-succession-context.js';
import type { SessionSuccessionCoordinator } from './session-succession.js';
import { nativeSessionRefKey, type NativeSessionRef, type TrustedSuccessionContext } from '@orchardworks/agent-remote-protocol';
import { TpmCoordinator, type TpmSessionAccess } from './tpm.js';
import { SessionBindings } from '@orchardworks/agent-session-runtime';
import type { HostProviderDiscovery } from './provider-discovery.js';
import { createCodexDaemonControl } from './codex-daemon-control.js';
import { RELAY_DIAGNOSTIC_PATH, parseRelayDiagnosticBatch, type RelayDiagnostic } from '@orchardworks/agent-remote-protocol/model';
import { createControllerUpdater } from './controller-update.js';
import type { ControllerIdentity, ControllerUpdateStatus } from '@orchardworks/agent-remote-protocol';
import { createIdleSessions } from './idle-sessions.js';
import { createHostStatusReader, hostStatusPaths } from './host-status.js';
import { allowedWorkspace, protectHostDirectory } from './execution-policy.js';
import { SessionRoles, type SessionRole } from './session-role-succession.js';
import { roleSessionConfig } from './role-session-creation.js';
import { WorkerSupport } from './call-for-support-worker.js';
import { createControllerPreviews } from './previews.js';
import { createVscodeTunnelManager, type VscodeTunnelOptions } from './vscode-tunnel.js';
import { createOperationCache, OperationCacheError } from '@orchardworks/agent-session-runtime';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import type { AgentSession, AgentSessionConfig } from '@orchardworks/agent-provider-sdk';
import { type HostEnvironment } from '@orchardworks/agent-remote-protocol';
import { createSessionStatePublisher, liveSessionState } from './session-state-publisher.js';
import { createSessionReplies } from './session-replies.js';
import { SessionOutbox } from './session-outbox.js';
import { createTerminalRefresh } from './publisher/terminal-refresh.js';
import { createAdmission } from './session-core/admission.js';
import { createSessionCatalog, catalogSessionStates } from './session-core/catalog.js';
import { handoffRefusal, nativeFamily as familyOf } from './session-core/family.js';
import * as lineage from './session-core/lineage.js';
import { bounded, HostRequestError, json, positiveTimeout } from './session-core/requests.js';
import type { AgentHostProviderRegistration, AgentHostRuntime, AgentHostRuntimeOptions, SessionBinding as Binding } from './session-core/types.js';
import { createUplinkFence } from './session-core/uplink-fence.js';
import { createAttachment } from './session-core/attachment.js';
import { createControlRoutes } from './session-core/control-routes.js';
import { createSessionCommands } from './session-core/session-commands.js';
import type { SessionCoreContext } from './session-core/context.js';
import { createSuccessionWiring } from './session-core/succession-wiring.js';
import { createJournalPublisher } from './publisher/journal-publisher.js';
import { loadResourceIdKey } from './resource-id-key.js';
import { FileResourceIdIndex } from './resource-id-index-file.js';
import { type SessionCallerCatalog } from './session-callers.js';
import { type SessionRefContext } from './session-refs.js';
import { type SessionCaller, type SessionCallResult } from './session-routes.js';
import { CliError } from './cli-output.js';
import { runHostRequest } from './host-command.js';
import { InputImageStore, InputResourceStore, createAgentRemoteRelay, createRemoteHostUplinkClient, type AgentRemoteHttpResult, RemoteHostCatalog, type RemoteHostControlRequest, type RemoteHostUplinkClient, type RemoteHostUplinkDiagnostic, type SessionWireAgent, type SessionWireOperationExecutor } from '@orchardworks/agent-session-runtime';

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
  /** What the modules of the session core share; filled below, once every part it holds exists. */
  const ctx = {} as SessionCoreContext;
  const successionWiring = createSuccessionWiring(ctx);
  const successionConfig = options.succession;
  const nativeSuccession = successionConfig && 'stateDirectory' in successionConfig ? successionConfig.native : undefined;
  const successionService: SessionSuccessionService | undefined = successionConfig && 'stateDirectory' in successionConfig
    ? new SessionSuccessionService(successionConfig.stateDirectory, successionConfig.controllerId, {
      ...successionWiring.ports(),
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
  const originalCreation = (target: NativeSessionRef) => lineage.originalCreation(succession?.store, target);
  const originalNativePrefix = (target: NativeSessionRef) => lineage.originalNativePrefix(succession?.store, target);
  const genericSuccessionSource = (target: NativeSessionRef) => lineage.genericSuccessionSource(succession?.store, target);
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
  const { project, acquireSession } = createAttachment(ctx);
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
    successionWiring.bindProvider(observed);
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
  const { callSession, callRole, sessionRefs } = createSessionCommands(ctx, options);
  const automationAccess: TpmSessionAccess = {
    controllerId: successionConfig?.controllerId ?? options.controllerId ?? 'local',
    sessionRouting: successionService?.executionRouting ?? {
      resolve: anchor => ({ anchor, target: anchor, operationIds: [] }),
      assertCurrent: (anchor, actual) => { if (admission.stopped || nativeSessionRefKey(anchor) !== nativeSessionRefKey(actual)) throw new Error('Execution recipient is unavailable.'); },
    },
    ...(successionService ? { mainRouting: successionTpmRouting(successionService, successionConfig!.controllerId, successionWiring.acquireNative) } : {}),
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
  workerSupport?.onChange(() => { void successionWiring.applyWorkerTools().catch(() => undefined); });
  const workerSupportTimer = workerSupport ? setInterval(() => { if (!admission.closed) void workerSupport.refresh(automationAccess.controllerId).catch(() => undefined); }, options.team?.tickMs ?? 3000) : undefined;
  workerSupportTimer?.unref?.();
  const enrollment = successionService ? new SessionSuccessionEnrollment(successionService, successionConfig!.controllerId, () => [...registrations.values()], () => tpm?.store.all() ?? [], source => successionWiring.authorizeSuccessionRead(source, source), directoryOperation) : undefined;
  const enrollFromRelay = async (request: RemoteHostControlRequest, context: TrustedSuccessionContext) => {
    if (!options.succession?.enrollment || !enrollment || admission.stopped) return json(403, { code: 'succession_enrollment_unavailable', error: 'Trusted succession enrollment is unavailable.' });
    await tpm?.ready;
    if (request.path === '/remote/create') {
      if (request.method !== 'POST' || context.installationId !== successionConfig!.controllerId) return json(403, { code: 'succession_enrollment_unavailable', error: 'Succession Controller authority does not match.' });
      return control(request, structuredClone(context));
    }
    return enrollment.control(request, context);
  };
  Object.assign(ctx, {
    options, admission, relay, bindings, idle, operationCache, catalogs, hostStatus, cancelTimeoutMs, successionReady, successionService, succession, successionBoundary,
    tpm, team, enrollment, sessionRefs, roles, workerSupport, workerToolsApplied, nativeAttachments, successionConfig, nativeSuccession,
    registrations, prepared, uncertainAgents, journals, terminalRefresh, automationAccess, sessionCatalog, create, controlRequest, genericSuccessionSource,
    nativePrefixExtensions: successionWiring.nativePrefixExtensions,
    registration, liveAgent, nativeRef, mutationFamily, directoryOperation, tracked, project, callSession, authorizeSuccessionRead: successionWiring.authorizeSuccessionRead,
    workerExtensions: successionWiring.workerExtensions, markShared: successionWiring.markShared, nativeFamily, originalCreation, originalNativePrefix, assertHandoffState, acquireSession,
  } satisfies SessionCoreContext);
  for (const value of registrations.values()) successionWiring.bindProvider(value);
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
