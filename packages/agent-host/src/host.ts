import { createControllerUpdater } from './controller-update.js';
import type { ControllerIdentity } from '@orchardworks/agent-remote-protocol';
import { createIdleSessions } from './idle-sessions.js';
import { browseWorkspaceFolders, createWorkspaceFolder, WorkspaceFolderError } from './workspace-folders.js';
import { allowedWorkspace, HostExecutionPolicyError, protectHostDirectory, type HostExecutionPolicy } from './execution-policy.js';
import { createControllerPreviews } from './previews.js';
import { createVscodeTunnelManager, type VscodeTunnelOptions } from './vscode-tunnel.js';
import { createOperationCache, OperationCacheError, type OperationCacheOptions } from './operation-cache.js';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import type { AgentProviderAdapter, AgentSession, AgentSessionConfig } from '@orchardworks/agent-provider-sdk';
import { AgentSessionInUseError, AgentRuntimeError } from '@orchardworks/agent-provider-sdk';
import { PROTOCOL_VERSION, type HostEnvironment } from '@orchardworks/agent-remote-protocol';
import { InputImageStore, type InputImageStoreOptions, createAgentRemoteRelay, createRemoteHostUplinkClient, type AgentRemoteHttpResult, type AgentRemoteRelay,
  RemoteHostCatalog, RemoteHostCatalogError, UnsupportedAgentCapabilityError, type RemoteHostControlRequest, type RemoteHostUplinkClient, type RemoteHostUplinkDiagnostic, type RemoteSessionSummary,
  type RemoteHostSessionLease, type SessionWireAgent, type SessionWireOperationExecutor } from '@orchardworks/agent-remote-relay';

export interface AgentHostWorkspace { id: string; name: string; path: string }
export interface AgentHostDirectory {
  readonly providerId: string;
  readonly supportsSourceReferences?: boolean;
  readonly supportsPromptEditing?: boolean;
  validatePromptEdit?(target: { nativeSessionId: string; turnId: string; messageId: string }): Promise<void>;
  /** Active work uses tools served by the Controller process. */
  requiresController?(nativeSessionId: string): boolean;
  /** Must guarantee disposal only detaches this client's idle runtime connection. */
  canReleaseSession?(nativeSessionId: string): boolean;
  reconcileIdleSession?(nativeSessionId: string): Promise<boolean>;
  sessionReleased?(nativeSessionId: string): Promise<void> | void;
  sessionWorkspace?(nativeSessionId: string): Promise<string | undefined>;
  setSourceAccessCheck?(check: (nativeSessionId: string) => Promise<void>): void;
  list(): Promise<readonly RemoteSessionSummary[]> | readonly RemoteSessionSummary[];
  workspaces(): Promise<readonly AgentHostWorkspace[]> | readonly AgentHostWorkspace[];
  models?(): Promise<unknown> | unknown;
  create(input: Omit<AgentSessionConfig, 'sessionId'> & { workspaceId?: string; sourceNativeSessionId?: string; editNativeSessionId?: string; editTurnId?: string; editMessageId?: string }): Promise<string>;
  open(nativeSessionId: string): Promise<AgentSession>;
  openChild?(parentNativeSessionId: string, nativeSessionId: string): Promise<AgentSession>;
  close(): Promise<void> | void;
}
export interface AgentHostProviderRegistration { adapter: AgentProviderAdapter; directory: AgentHostDirectory; preservesWorkOnDisconnect?: boolean }
export interface AgentHostRuntimeOptions {
  registrations: readonly AgentHostProviderRegistration[];
  onRequestDiagnostic?: (diagnostic: AgentHostRequestDiagnostic) => void;
  idleGraceMs?: number;
  idleReconcileMs?: number;
  onSessionLifecycleDiagnostic?: (diagnostic: { event: 'session_idle_released' | 'session_idle_restored' | 'session_idle_reconciled'; agentId: string; providerId: string }) => void;
  shutdownTimeoutMs?: number;
  cancelTimeoutMs?: number;
  executionPolicy?: HostExecutionPolicy;
  operationCache?: OperationCacheOptions;
  inputImages?: InputImageStoreOptions;
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
  readonly relay: AgentRemoteRelay;
  control(request: RemoteHostControlRequest): Promise<AgentRemoteHttpResult>;
  executeOperation(scope: string): SessionWireOperationExecutor;
  acquireSession(agentId: string): Promise<RemoteHostSessionLease | undefined>;
  setRelayConnected(connected: boolean): void;
  beginControllerRestart(): boolean;
  cancelControllerRestart(): void;
  resolveSession(agentId: string): ReturnType<AgentRemoteRelay['requireAgent']> | undefined;
  close(): Promise<void>;
}
export interface AgentHostOptions extends AgentHostRuntimeOptions {
  controller?: { identity: ControllerIdentity; stateDir: string; restart(version: string): void | Promise<void> };
  vscodeTunnel?: Omit<VscodeTunnelOptions, 'installationId'>;
  preview?: { stateDirectory: string; ttlMs?: number; protectedPorts?: number[]; diagnostic?(event: string): void };
  installationId: string;
  name: string;
  environment?: HostEnvironment;
  onDiagnostic?: (diagnostic: AgentHostUplinkDiagnostic) => void | Promise<void>;
  uplink: { url: string; remoteKey: string; onCredential?: (credential: string) => Promise<void> };
}
export interface AgentHostUplinkDiagnostic extends RemoteHostUplinkDiagnostic { uplinkGeneration: number }
export interface AgentHost {
  readonly ready: Promise<{ hostId: string }>;
  shareContext(): Promise<{ hostId: string; providers: Array<{ providerId: string; displayName: string }> }>;
  shareCatalog(query: { hostId: string; providerId: string; nativeSessionId?: string; cursor?: string }): Promise<AgentRemoteHttpResult>;
  readonly state: 'connecting' | 'registered' | 'disconnected' | 'rejected' | 'closed';
  replaceUplink(uplink: AgentHostOptions['uplink']): Promise<{ hostId: string }>;
  close(): Promise<void>;
}

export function createAgentHost(options: AgentHostOptions): AgentHost {
  const stateDirectory = options.preview?.stateDirectory ?? options.vscodeTunnel?.stateDirectory;
  const runtime = createAgentHostRuntime({ ...options, ...(options.inputImages ? {} : stateDirectory ? { inputImages: { directory: join(stateDirectory, 'input-images') } } : {}) });
  runtime.setRelayConnected(false);
  const updater = options.controller ? createControllerUpdater({ ...options.controller, beginRestart: runtime.beginControllerRestart, cancelRestart: runtime.cancelControllerRestart }) : undefined;
  const previews = options.preview ? createControllerPreviews(options.preview) : undefined;
  const vscodeTunnel = options.vscodeTunnel ? createVscodeTunnelManager({ ...options.vscodeTunnel, installationId: options.installationId }) : undefined;
  let state: AgentHost['state'] = 'connecting';
  let generation = 0;
  let closed = false;
  interface Connection { client: RemoteHostUplinkClient; superseded: boolean }
  let connection: Connection;
  let credentialPersistence: Promise<void> = Promise.resolve();
  const connect = (config: AgentHostOptions['uplink']): Connection => {
    runtime.setRelayConnected(false);
    const current = ++generation;
    return { superseded: false, client: createRemoteHostUplinkClient({ relay: runtime.relay, installationId: options.installationId, name: options.name, environment: options.environment, controller: options.controller?.identity,
      providers: options.registrations.map(({ adapter, directory }) => ({ providerId: adapter.descriptor.providerId, displayName: adapter.descriptor.displayName, ...(directory.supportsPromptEditing ? { promptEditing: true as const } : {}) })), url: config.url, remoteKey: config.remoteKey,
      onCredential: config.onCredential ? credential => {
        const pending = credentialPersistence.catch(() => undefined).then(async () => {
          if (generation !== current || closed) throw new Error('Host credential persistence was superseded.');
          await config.onCredential!(credential);
        });
        credentialPersistence = pending;
        return pending;
      } : undefined,
      resolveSession: runtime.resolveSession, acquireSession: runtime.acquireSession, control: async request => request.path === '/remote/controller-update' && updater ? (async () => {
        try { const body = request.method === 'POST' ? JSON.parse(request.body ?? '{}') : undefined;
          return { status: request.method === 'POST' ? 202 : 200, body: JSON.stringify(request.method === 'POST' ? await updater.request(body.version, body.operationId) : await updater.status()) };
        } catch (error) { return { status: 409, body: JSON.stringify({ error: error instanceof Error ? error.message : 'Controller update failed.' }) }; }
      })() : request.path.startsWith('/remote/vscode-tunnel') && vscodeTunnel ? vscodeTunnel.control(request)
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
    return { hostId, providers: options.registrations.map(({ adapter }) => ({
      providerId: adapter.descriptor.providerId, displayName: adapter.descriptor.displayName })) };
  }
  let closePromise: Promise<void> | undefined;
  return {
    ready,
    get state() { return state; },
    shareContext,
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
    close() { return closePromise ??= (async () => { closed = true; generation += 1; state = 'closed'; updater?.close();
      connection.superseded = true;
      await bounded(Promise.allSettled([connection.client.close(), previews?.close(), vscodeTunnel?.close(), runtime.close()]), options.shutdownTimeoutMs ?? 5000);
    })(); },
  };
}

interface Binding { agentId: string; providerId: string; nativeSessionId: string; parentNativeSessionId?: string }
interface Projection { agentId: string; parentNativeSessionId?: string; operation: Promise<Binding> }

export function createAgentHostRuntime(options: AgentHostRuntimeOptions): AgentHostRuntime {
  if (options.executionPolicy) options = { ...options, registrations: options.registrations.map(registration => ({ ...registration, directory: protectHostDirectory(registration.directory, options.executionPolicy!) })) };
  if (!options.registrations.length) throw new Error('Agent Host requires at least one provider registration.');
  const registrations = new Map<string, AgentHostProviderRegistration>();
  const prepared = new Map<string, AgentSession>();
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
  const relay = createAgentRemoteRelay({ providers: relayAdapters, ...(options.inputImages ? { inputImageStore: new InputImageStore(options.inputImages) } : {}) });
  const operationCache = createOperationCache(options.operationCache);
  const catalogs = new Map(options.registrations.map(({ directory }) => [directory.providerId, new RemoteHostCatalog({ roots: directory.list })]));
  const bindingsByNative = new Map<string, Binding>();
  const bindingsByAgent = new Map<string, Binding>();
  const projections = new Map<string, Projection>();
  const projectionAgents = new Map<string, string>();
  const pending = new Set<Promise<unknown>>();
  const idle = createIdleSessions({ graceMs: options.idleGraceMs, reconcileMs: options.idleReconcileMs });
  const uncertainAgents = new Set<string>();
  const cancelTimeoutMs = positiveTimeout(options.cancelTimeoutMs ?? 5000);
  const shutdownTimeoutMs = positiveTimeout(options.shutdownTimeoutMs ?? 5000);
  let draining = false;
  let uncertainHostMutation = false;
  let activeOperations = 0;
  let closed = false;
  let closePromise: Promise<void> | undefined;

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
    for (const [agentId, binding] of bindingsByAgent) {
      if (liveAgent(agentId) === agent) return binding;
    }
    throw new OperationCacheError('invalid_operation_target', 'The native session binding is unavailable.');
  }
  function liveAgent(agentId: string) {
    try { return relay.requireAgent(agentId); } catch { return undefined; }
  }
  function executeOperation(scope: string): SessionWireOperationExecutor {
    return async (agent, operation, work) => {
      if (draining) throw new OperationCacheError('controller_updating', 'Controller is updating. Reconnect before retrying.');
      const binding = bindingFor(agent);
      activeOperations++;
      const release = idle.retain(binding.agentId);
      try {
        return await operationCache.execute({
          operationId: operation.operationId, scope, kind: operation.kind,
          target: JSON.stringify([binding.providerId, binding.nativeSessionId]), parameters: operation.parameters,
        }, { ...work, maximumResultBytes: operation.maximumResultBytes });
      } catch (error) {
        if (error instanceof OperationCacheError && ['operation_outcome_unknown', 'native_file_limit'].includes(error.code)) uncertainAgents.add(binding.agentId);
        throw error;
      } finally { activeOperations--; release(); }
    };
  }
  function lifecycle(event: 'session_idle_released' | 'session_idle_restored' | 'session_idle_reconciled', binding: Binding) {
    try { options.onSessionLifecycleDiagnostic?.({ event, agentId: binding.agentId, providerId: binding.providerId }); }
    catch { /* Diagnostics cannot change session lifetime. */ }
  }
  function watch(binding: Binding) {
    idle.watch(binding.agentId, () => {
      if (closed || uncertainAgents.has(binding.agentId) || projections.has(JSON.stringify([binding.providerId, binding.nativeSessionId]))) return false;
      const source = registration(binding.providerId).directory;
      if (!source.canReleaseSession?.(binding.nativeSessionId) || !liveAgent(binding.agentId)?.canReleaseIdle()) return false;
      // A native child projection shares its ancestor's connection, even with no browser currently attached.
      for (const child of bindingsByAgent.values()) {
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
      for (const child of bindingsByAgent.values()) {
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
    const binding = bindingsByAgent.get(agentId);
    if (closed || !binding) return undefined;
    const release = idle.retain(agentId);
    let parent: RemoteHostSessionLease | undefined;
    try {
      if (binding.parentNativeSessionId) {
        const parentBinding = bindingsByNative.get(JSON.stringify([binding.providerId, binding.parentNativeSessionId]));
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
  async function project(providerId: string, proposedAgentId: string, nativeSessionId: string, parentNativeSessionId?: string): Promise<Binding> {
    const key = JSON.stringify([providerId, nativeSessionId]);
    const existing = bindingsByNative.get(key);
    if (existing) {
      if (existing.parentNativeSessionId !== parentNativeSessionId) throw new HostRequestError(409, 'session_binding_conflict', 'The native session already has different ownership.');
      proposedAgentId = existing.agentId;
      await idle.wait(proposedAgentId);
      if (liveAgent(proposedAgentId)) { idle.touch(proposedAgentId); return existing; }
    }
    const inFlight = projections.get(key);
    if (inFlight) {
      if (inFlight.parentNativeSessionId !== parentNativeSessionId) throw new HostRequestError(409, 'session_binding_conflict', 'The native session already has different ownership.');
      return inFlight.operation;
    }
    const agentKey = projectionAgents.get(proposedAgentId);
    if ((agentKey && agentKey !== key) || !existing && bindingsByAgent.has(proposedAgentId)) {
      throw new HostRequestError(409, 'session_binding_conflict', 'The proposed Agent identity is already bound.');
    }
    projectionAgents.set(proposedAgentId, key);
    const source = registration(providerId).directory;
    const operation = (async () => {
      let parent: RemoteHostSessionLease | undefined;
      try {
        if (parentNativeSessionId) {
          const parentBinding = bindingsByNative.get(JSON.stringify([providerId, parentNativeSessionId]));
          if (parentBinding?.agentId === proposedAgentId) throw new Error('Native parent binding is invalid.');
          if (parentBinding) {
            parent = await acquireSession(parentBinding.agentId);
            if (!parent) throw new Error('Native parent session is unavailable.');
          }
        }
        const session = parentNativeSessionId === undefined ? await source.open(nativeSessionId)
          : source.openChild ? await source.openChild(parentNativeSessionId, nativeSessionId)
          : (() => { throw new HostRequestError(400, 'child_attachment_unavailable', 'This provider does not support native child attachment.'); })();
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
        if (response.payload.sessionId !== nativeSessionId) throw new Error('Provider returned a different native session identity.');
        const binding = { agentId: proposedAgentId, providerId, nativeSessionId, ...(parentNativeSessionId ? { parentNativeSessionId } : {}) };
        bindingsByNative.set(key, binding); bindingsByAgent.set(proposedAgentId, binding);
        watch(binding);
        if (existing) lifecycle('session_idle_restored', binding);
        return binding;
      } finally { parent?.release(); }
    })();
    projections.set(key, { agentId: proposedAgentId, ...(parentNativeSessionId ? { parentNativeSessionId } : {}), operation });
    try { return await operation; } catch (error) {
      prepared.delete(proposedAgentId); throw error;
    } finally { projections.delete(key); projectionAgents.delete(proposedAgentId); }
  }
  async function create(request: RemoteHostControlRequest, payload: Record<string, unknown>): Promise<AgentRemoteHttpResult> {
    const providerId = string(payload.providerId, 'providerId');
    const operationId = string(payload.operationId, 'operationId');
    const proposedAgentId = request.sessionId;
    if (!proposedAgentId) throw new HostRequestError(400, 'invalid_request', 'A proposed Agent identity is required.');
    if (payload.sourceNativeSessionId !== undefined && (typeof payload.sourceNativeSessionId !== 'string' || !payload.sourceNativeSessionId || payload.sourceNativeSessionId.length > 256)) throw new HostRequestError(400, 'invalid_request', 'Source session identity is invalid.');
    const editKeys = ['editNativeSessionId', 'editTurnId', 'editMessageId'] as const;
    const editing = editKeys.some(key => payload[key] !== undefined);
    if (editing && (editKeys.some(key => typeof payload[key] !== 'string' || !(payload[key] as string).trim() || (payload[key] as string).length > 256) || payload.sourceNativeSessionId !== undefined)) throw new HostRequestError(400, 'invalid_request', 'A complete native prompt identity is required.');
    const settings = {
      ...(editing ? { editNativeSessionId: payload.editNativeSessionId as string, editTurnId: payload.editTurnId as string, editMessageId: payload.editMessageId as string } : {}),
      ...(typeof payload.sourceNativeSessionId === 'string' ? { sourceNativeSessionId: payload.sourceNativeSessionId } : {}),
      ...(typeof payload.cwd === 'string' ? { cwd: payload.cwd } : {}),
      ...(typeof payload.workspaceId === 'string' ? { workspaceId: payload.workspaceId } : {}),
      ...(typeof payload.model === 'string' ? { model: payload.model } : {}),
      ...(typeof payload.reasoningEffort === 'string' ? { reasoningEffort: payload.reasoningEffort } : {}),
      ...(typeof payload.planning === 'boolean' ? { planning: payload.planning } : {}),
    };
    const nativeSessionId = await operationCache.execute({
      operationId,
      scope: operationScope(request),
      kind: 'create_agent',
      target: providerId,
      parameters: settings,
    }, {
      validate: async () => {
        const directory = registration(providerId).directory;
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
            throw new HostRequestError(400, 'operation_rejected', error instanceof Error ? error.message : 'The selected prompt could not be verified.');
          }
        }
        if (projectionAgents.has(proposedAgentId) || bindingsByAgent.has(proposedAgentId)) {
          throw new HostRequestError(409, 'session_binding_conflict', 'The proposed Agent identity is already reserved.');
        }
      },
      dispatch: () => registration(providerId).directory.create(settings),
      maximumResultBytes: 1024,
    });
    return json(200, publicBinding(await tracked(project(providerId, proposedAgentId, nativeSessionId))));
  }
  async function control(request: RemoteHostControlRequest): Promise<AgentRemoteHttpResult> {
    const requestId = request.requestId && /^[a-zA-Z0-9-]{1,80}$/.test(request.requestId) ? request.requestId : randomUUID();
    const operation = request.path === '/remote/attach' || request.path === '/remote/child/attach' ? 'session_attach'
      : request.path === '/remote/create' ? 'session_create' : request.method === 'GET' ? 'catalog_read' : 'host_control';
    const started = Date.now();
    const diagnostic = (event: AgentHostRequestDiagnostic['event'], status?: number, code?: string) => {
      try { options.onRequestDiagnostic?.({ event, requestId, operation, elapsedMs: Date.now() - started,
        ...(status === undefined ? {} : { status }), ...(code ? { code } : {}) }); } catch { /* Diagnostics cannot change request outcomes. */ }
    };
    diagnostic('host_request_started');
    const result = await controlRequest(request);
    const data = result.status >= 400 ? JSON.parse(result.body) : {};
    if (request.method === 'POST' && ['operation_outcome_unknown', 'native_file_limit'].includes(data.code)) uncertainHostMutation = true;
    diagnostic('host_request_completed', result.status, typeof data.code === 'string' ? data.code : undefined);
    return result.status >= 400 ? { ...result, body: JSON.stringify({ ...data, requestId }) } : result;
  }
  async function controlRequest(request: RemoteHostControlRequest): Promise<AgentRemoteHttpResult> {
    try {
      if (closed) throw new HostRequestError(503, 'host_closed', 'Agent Host is closed.');
      if (draining && request.method === 'POST') throw new HostRequestError(503, 'controller_updating', 'Controller is updating. Reconnect before retrying.');
      const url = new URL(request.path, 'http://agent-host.local');
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
          const targets = [...bindingsByAgent.keys()].filter(id => liveAgent(id));
          const results = await operationCache.execute({
            operationId,
            scope: operationScope(request),
            kind: 'stop_host_sessions',
            target: 'host',
            parameters: null,
          }, {
            dispatch: () => Promise.all(targets.map(cancelAgent)),
            maximumResultBytes: 256 * 1024,
          });
          return json(200, { results });
        }
        if (url.pathname === '/remote/create') return await create(request, payload);
        if (url.pathname === '/remote/attach' || url.pathname === '/remote/child/attach') {
          if (!request.sessionId) throw new HostRequestError(400, 'invalid_request', 'A proposed Agent identity is required.');
          const providerId = string(payload.providerId, 'providerId');
          const nativeSessionId = string(payload.nativeSessionId, 'nativeSessionId');
          const parent = url.pathname === '/remote/child/attach' ? string(payload.parentNativeSessionId, 'parentNativeSessionId') : undefined;
          return json(200, publicBinding(await tracked(project(providerId, request.sessionId, nativeSessionId, parent))));
        }
      }
      throw new HostRequestError(400, 'invalid_request', 'Remote Host request is invalid.');
    } catch (error) {
      if (error instanceof AgentRuntimeError) return json(503, { error: error.message, code: error.code });
      if (error instanceof AgentSessionInUseError) return json(409, { error: error.message, code: 'session_in_use' });
      if (error instanceof HostExecutionPolicyError) return json(403, { error: error.message, code: 'local_execution_policy' });
      if (error instanceof WorkspaceFolderError) return json(error.status, { error: error.message, code: error.code });
      if (error instanceof OperationCacheError) return json(operationErrorStatus(error.code), { error: error.message, code: error.code });
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
  return { relay, async control(request) {
      if (request.method !== 'POST') return control(request);
      activeOperations++;
      try { return await control(request); } finally { activeOperations--; }
    }, executeOperation, acquireSession, setRelayConnected: idle.setConnected,
    beginControllerRestart() {
      if (closed || draining || uncertainHostMutation || pending.size || activeOperations || uncertainAgents.size || projections.size) return false;
      for (const binding of bindingsByAgent.values()) {
        const agent = liveAgent(binding.agentId);
        if (agent && !agent.canRestartController(registration(binding.providerId).preservesWorkOnDisconnect === true && !registration(binding.providerId).directory.requiresController?.(binding.nativeSessionId))) return false;
      }
      draining = true; return true;
    },
    cancelControllerRestart() { if (!closed) draining = false; },
    resolveSession(agentId) { idle.touch(agentId); return liveAgent(agentId); },
    close(): Promise<void> { return closePromise ??= (async () => {
      closed = true;
      const releasing = idle.close();
      for (const catalog of catalogs.values()) catalog.dispose();
      const cleanup = Promise.allSettled([releasing, relay.close(), operationCache.close(), ...options.registrations.map(({ directory }) => Promise.resolve(directory.close())), ...pending]);
      await bounded(cleanup, shutdownTimeoutMs);
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
function body(value: string | undefined): Record<string, unknown> { try { const parsed: unknown = JSON.parse(value ?? ''); if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) return parsed as Record<string, unknown>; } catch {} throw new HostRequestError(400, 'invalid_request', 'Remote Host body is invalid.'); }
function json(status: number, value: unknown): AgentRemoteHttpResult { return { status, body: JSON.stringify(value) }; }
function positiveTimeout(value: number): number { if (!Number.isSafeInteger(value) || value < 1) throw new RangeError('Agent Host shutdown timeout must be a positive integer.'); return value; }
async function bounded(operation: Promise<unknown>, timeoutMs: number): Promise<void> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try { await Promise.race([operation, new Promise<void>((resolve) => { timer = setTimeout(resolve, timeoutMs); timer.unref?.(); })]); }
  finally { clearTimeout(timer); }
}
