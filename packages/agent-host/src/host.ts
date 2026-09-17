import { browseWorkspaceFolders, createWorkspaceFolder, WorkspaceFolderError } from './workspace-folders.js';
import { allowedWorkspace, HostExecutionPolicyError, protectHostDirectory, type HostExecutionPolicy } from './execution-policy.js';
import { createControllerPreviews } from './previews.js';
import { createOperationCache, OperationCacheError, type OperationCacheOptions } from './operation-cache.js';
import { randomUUID } from 'node:crypto';
import type { AgentProviderAdapter, AgentSession, AgentSessionConfig } from '@agent-remote-controller/agent-provider-sdk';
import { AgentSessionInUseError } from '@agent-remote-controller/agent-provider-sdk';
import { PROTOCOL_VERSION } from '@agent-remote-controller/agent-remote-protocol';
import { createAgentRemoteRelay, createRemoteHostUplinkClient, type AgentRemoteHttpResult, type AgentRemoteRelay,
  RemoteHostCatalog, RemoteHostCatalogError, UnsupportedAgentCapabilityError, type RemoteHostControlRequest, type RemoteHostUplinkClient, type RemoteHostUplinkDiagnostic, type RemoteSessionSummary,
  type SessionWireAgent, type SessionWireOperationExecutor } from '@agent-remote-controller/agent-remote-relay';

export interface AgentHostWorkspace { id: string; name: string; path: string }
export interface AgentHostDirectory {
  readonly providerId: string;
  list(): Promise<readonly RemoteSessionSummary[]> | readonly RemoteSessionSummary[];
  workspaces(): Promise<readonly AgentHostWorkspace[]> | readonly AgentHostWorkspace[];
  models?(): Promise<unknown> | unknown;
  create(input: Omit<AgentSessionConfig, 'sessionId'> & { workspaceId?: string }): Promise<string>;
  open(nativeSessionId: string): Promise<AgentSession>;
  openChild?(parentNativeSessionId: string, nativeSessionId: string): Promise<AgentSession>;
  close(): Promise<void> | void;
}
export interface AgentHostProviderRegistration { adapter: AgentProviderAdapter; directory: AgentHostDirectory }
export interface AgentHostRuntimeOptions {
  registrations: readonly AgentHostProviderRegistration[];
  shutdownTimeoutMs?: number;
  cancelTimeoutMs?: number;
  executionPolicy?: HostExecutionPolicy;
  operationCache?: OperationCacheOptions;
}
export interface AgentHostRuntime {
  readonly relay: AgentRemoteRelay;
  control(request: RemoteHostControlRequest): Promise<AgentRemoteHttpResult>;
  executeOperation(scope: string): SessionWireOperationExecutor;
  resolveSession(agentId: string): ReturnType<AgentRemoteRelay['requireAgent']> | undefined;
  close(): Promise<void>;
}
export interface AgentHostOptions extends AgentHostRuntimeOptions {
  preview?: { stateDirectory: string; ttlMs?: number; protectedPorts?: number[]; diagnostic?(event: string): void };
  installationId: string;
  name: string;
  onDiagnostic?: (diagnostic: AgentHostUplinkDiagnostic) => void | Promise<void>;
  uplink: { url: string; remoteKey: string; onCredential?: (credential: string) => Promise<void> };
}
export interface AgentHostUplinkDiagnostic extends RemoteHostUplinkDiagnostic { uplinkGeneration: number }
export interface AgentHost {
  readonly ready: Promise<{ hostId: string }>;
  readonly state: 'connecting' | 'registered' | 'disconnected' | 'rejected' | 'closed';
  replaceUplink(uplink: AgentHostOptions['uplink']): Promise<{ hostId: string }>;
  close(): Promise<void>;
}

export function createAgentHost(options: AgentHostOptions): AgentHost {
  const runtime = createAgentHostRuntime(options);
  const previews = options.preview ? createControllerPreviews(options.preview) : undefined;
  let state: AgentHost['state'] = 'connecting';
  let generation = 0;
  let closed = false;
  interface Connection { client: RemoteHostUplinkClient; superseded: boolean }
  let connection: Connection;
  let credentialPersistence: Promise<void> = Promise.resolve();
  const connect = (config: AgentHostOptions['uplink']): Connection => {
    const current = ++generation;
    return { superseded: false, client: createRemoteHostUplinkClient({ relay: runtime.relay, installationId: options.installationId, name: options.name,
      providers: options.registrations.map(({ adapter }) => adapter.descriptor), url: config.url, remoteKey: config.remoteKey,
      onCredential: config.onCredential ? credential => {
        const pending = credentialPersistence.catch(() => undefined).then(async () => {
          if (generation !== current || closed) throw new Error('Host credential persistence was superseded.');
          await config.onCredential!(credential);
        });
        credentialPersistence = pending;
        return pending;
      } : undefined,
      resolveSession: runtime.resolveSession, control: request => request.path.startsWith('/remote/previews') && previews ? previews.control(request) : runtime.control(request),
      operationExecutor: scope => runtime.executeOperation(scope),
      previews: previews ? { snapshot: previews.snapshot, subscribe: previews.subscribe, disconnected: previews.disconnected,
        registered: info => previews.registered({ ...info, url: config.url }) } : undefined,
      onDiagnostic: options.onDiagnostic ? diagnostic => options.onDiagnostic!({ ...diagnostic, uplinkGeneration: current }) : undefined,
      onStateChange(next) { if (generation === current && !closed) state = next; } }) };
  };
  connection = connect(options.uplink);
  const ready = connection.client.ready;
  let closePromise: Promise<void> | undefined;
  return {
    ready,
    get state() { return state; },
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
      await bounded(Promise.allSettled([connection.client.close(), previews?.close(), runtime.close()]), options.shutdownTimeoutMs ?? 5000);
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
  const relay = createAgentRemoteRelay({ providers: relayAdapters });
  const operationCache = createOperationCache(options.operationCache);
  const catalogs = new Map(options.registrations.map(({ directory }) => [directory.providerId, new RemoteHostCatalog({ roots: directory.list })]));
  const bindingsByNative = new Map<string, Binding>();
  const bindingsByAgent = new Map<string, Binding>();
  const projections = new Map<string, Projection>();
  const projectionAgents = new Map<string, string>();
  const pending = new Set<Promise<unknown>>();
  const cancelTimeoutMs = positiveTimeout(options.cancelTimeoutMs ?? 5000);
  const shutdownTimeoutMs = positiveTimeout(options.shutdownTimeoutMs ?? 5000);
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
      if (relay.requireAgent(agentId) === agent) return binding;
    }
    throw new OperationCacheError('invalid_operation_target', 'The native session binding is unavailable.');
  }
  function executeOperation(scope: string): SessionWireOperationExecutor {
    return (agent, operation, work) => {
      const binding = bindingFor(agent);
      return operationCache.execute({
        operationId: operation.operationId,
        scope,
        kind: operation.kind,
        target: JSON.stringify([binding.providerId, binding.nativeSessionId]),
        parameters: operation.parameters,
      }, { ...work, maximumResultBytes: operation.maximumResultBytes });
    };
  }
  async function project(providerId: string, proposedAgentId: string, nativeSessionId: string, parentNativeSessionId?: string): Promise<Binding> {
    const key = JSON.stringify([providerId, nativeSessionId]);
    const existing = bindingsByNative.get(key);
    if (existing) {
      if (existing.parentNativeSessionId !== parentNativeSessionId) throw new HostRequestError(409, 'session_binding_conflict', 'The native session already has different ownership.');
      return existing;
    }
    const inFlight = projections.get(key);
    if (inFlight) {
      if (inFlight.parentNativeSessionId !== parentNativeSessionId) throw new HostRequestError(409, 'session_binding_conflict', 'The native session already has different ownership.');
      return inFlight.operation;
    }
    const agentKey = projectionAgents.get(proposedAgentId);
    if ((agentKey && agentKey !== key) || bindingsByAgent.has(proposedAgentId)) {
      throw new HostRequestError(409, 'session_binding_conflict', 'The proposed Agent identity is already bound.');
    }
    projectionAgents.set(proposedAgentId, key);
    const source = registration(providerId).directory;
    const operation = (async () => {
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
      return binding;
    })();
    projections.set(key, { agentId: proposedAgentId, ...(parentNativeSessionId ? { parentNativeSessionId } : {}), operation });
    try { return await operation; } catch (error) {
      prepared.delete(proposedAgentId); projections.delete(key); projectionAgents.delete(proposedAgentId); throw error;
    }
  }
  async function create(request: RemoteHostControlRequest, payload: Record<string, unknown>): Promise<AgentRemoteHttpResult> {
    const providerId = string(payload.providerId, 'providerId');
    const operationId = string(payload.operationId, 'operationId');
    const proposedAgentId = request.sessionId;
    if (!proposedAgentId) throw new HostRequestError(400, 'invalid_request', 'A proposed Agent identity is required.');
    const settings = {
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
        if (options.executionPolicy) {
          const selected = payload.workspaceId === undefined ? undefined
            : (await directory.workspaces()).find(workspace => workspace.id === payload.workspaceId);
          if (payload.workspaceId !== undefined && !selected) throw new HostExecutionPolicyError('Unknown local Host workspace.');
          await allowedWorkspace(options.executionPolicy, typeof payload.cwd === 'string' ? payload.cwd : selected?.path ?? options.executionPolicy.defaultWorkspace);
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
    try {
      if (closed) throw new HostRequestError(503, 'host_closed', 'Agent Host is closed.');
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
          const targets = [...bindingsByAgent.keys()];
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
      if (error instanceof AgentSessionInUseError) return json(409, { error: error.message, code: 'session_in_use' });
      if (error instanceof HostExecutionPolicyError) return json(403, { error: error.message, code: 'local_execution_policy' });
      if (error instanceof WorkspaceFolderError) return json(error.status, { error: error.message, code: error.code });
      if (error instanceof OperationCacheError) return json(operationErrorStatus(error.code), { error: error.message, code: error.code });
      if (error instanceof HostRequestError) return json(error.status, { error: error.message, code: error.code });
      if (error instanceof RemoteHostCatalogError) return json(error.status, { error: error.message, code: error.code });
      if (request.method === 'GET') return json(503, { error: 'The Remote Host catalog is unavailable.', code: 'catalog_unavailable' });
      return json(503, { error: 'Remote Host operation outcome is unknown.', code: 'mutation_outcome_unknown' });
    }
  }
  async function cancelAgent(agentId: string) {
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
    } finally { clearTimeout(timer); }
  }
  return { relay, control, executeOperation, resolveSession(agentId) { try { return relay.requireAgent(agentId); } catch { return undefined; } },
    close(): Promise<void> { return closePromise ??= (async () => {
      closed = true;
      for (const catalog of catalogs.values()) catalog.dispose();
      const cleanup = Promise.allSettled([relay.close(), operationCache.close(), ...options.registrations.map(({ directory }) => Promise.resolve(directory.close())), ...pending]);
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
  if (code === 'operation_outcome_unknown' || code === 'operation_cache_closed' || code === 'operation_clock_invalid') return 503;
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
