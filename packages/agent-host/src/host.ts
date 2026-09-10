import type { AgentProviderAdapter, AgentSession, AgentSessionConfig } from '@borgee/agent-provider-sdk';
import { PROTOCOL_VERSION } from '@borgee/agent-remote-protocol';
import { createAgentRemoteRelay, createRemoteHostUplinkClient, type AgentRemoteHttpResult, type AgentRemoteRelay,
  RemoteHostCatalog, RemoteHostCatalogError, type RemoteHostControlRequest, type RemoteHostUplinkClient, type RemoteSessionSummary } from '@borgee/agent-remote-relay';

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
export interface AgentHostRuntimeOptions { registrations: readonly AgentHostProviderRegistration[]; shutdownTimeoutMs?: number }
export interface AgentHostRuntime {
  readonly relay: AgentRemoteRelay;
  control(request: RemoteHostControlRequest): Promise<AgentRemoteHttpResult>;
  resolveSession(agentId: string): ReturnType<AgentRemoteRelay['requireAgent']> | undefined;
  close(): Promise<void>;
}
export interface AgentHostOptions extends AgentHostRuntimeOptions {
  installationId: string;
  name: string;
  uplink: { url: string; remoteKey: string };
}
export interface AgentHost {
  readonly ready: Promise<{ hostId: string }>;
  readonly state: 'connecting' | 'registered' | 'disconnected' | 'rejected' | 'closed';
  replaceUplink(uplink: AgentHostOptions['uplink']): Promise<{ hostId: string }>;
  close(): Promise<void>;
}

export function createAgentHost(options: AgentHostOptions): AgentHost {
  const runtime = createAgentHostRuntime(options);
  let state: AgentHost['state'] = 'connecting';
  let generation = 0;
  let closed = false;
  interface Connection { client: RemoteHostUplinkClient; superseded: boolean }
  let connection: Connection;
  const connect = (config: AgentHostOptions['uplink']): Connection => {
    const current = ++generation;
    return { superseded: false, client: createRemoteHostUplinkClient({ relay: runtime.relay, installationId: options.installationId, name: options.name,
      providers: options.registrations.map(({ adapter }) => adapter.descriptor), url: config.url, remoteKey: config.remoteKey,
      resolveSession: runtime.resolveSession, control: runtime.control,
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
      try { await connection.client.close(); } finally { await runtime.close(); }
    })(); },
  };
}

interface Binding { agentId: string; nativeSessionId: string; parentNativeSessionId?: string }
interface Creation { fingerprint: string; operation: Promise<AgentRemoteHttpResult> }
interface Projection { agentId: string; parentNativeSessionId?: string; operation: Promise<Binding> }

export function createAgentHostRuntime(options: AgentHostRuntimeOptions): AgentHostRuntime {
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
  const catalogs = new Map(options.registrations.map(({ directory }) => [directory.providerId, new RemoteHostCatalog({ roots: directory.list })]));
  const bindingsByNative = new Map<string, Binding>();
  const bindingsByAgent = new Map<string, Binding>();
  const creations = new Map<string, Creation>();
  const creationAgents = new Map<string, string>();
  const projections = new Map<string, Projection>();
  const projectionAgents = new Map<string, string>();
  const pending = new Set<Promise<unknown>>();
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
        requestId: `host:${proposedAgentId}`, agentId: proposedAgentId, providerId, config: { sessionId: proposedAgentId },
      } }).catch(async (error: unknown) => {
        if (prepared.get(proposedAgentId) === session) {
          prepared.delete(proposedAgentId);
          await session.dispose().catch(() => undefined);
        }
        throw error;
      });
      if (response.payload.sessionId !== nativeSessionId) throw new Error('Provider returned a different native session identity.');
      const binding = { agentId: proposedAgentId, nativeSessionId, ...(parentNativeSessionId ? { parentNativeSessionId } : {}) };
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
    const requestId = string(payload.requestId, 'requestId');
    const proposedAgentId = request.sessionId;
    if (!proposedAgentId) throw new HostRequestError(400, 'invalid_request', 'A proposed Agent identity is required.');
    const fingerprint = JSON.stringify([payload.cwd ?? null, payload.workspaceId ?? null, payload.model ?? null,
      payload.reasoningEffort ?? null, payload.planning ?? null]);
    const key = JSON.stringify([providerId, requestId]);
    const prior = creations.get(key);
    if (prior) {
      if (prior.fingerprint !== fingerprint) throw new HostRequestError(409, 'request_conflict', 'The creation request identity is reserved for different settings.');
      return prior.operation;
    }
    const priorAgentRequest = creationAgents.get(proposedAgentId);
    if (priorAgentRequest && priorAgentRequest !== key) throw new HostRequestError(409, 'session_binding_conflict', 'The proposed Agent identity is already reserved.');
    creationAgents.set(proposedAgentId, key);
    const operation = tracked((async () => {
      const directory = registration(providerId).directory;
      const nativeSessionId = await directory.create({
        ...(typeof payload.cwd === 'string' ? { cwd: payload.cwd } : {}),
        ...(typeof payload.workspaceId === 'string' ? { workspaceId: payload.workspaceId } : {}),
        ...(typeof payload.model === 'string' ? { model: payload.model } : {}),
        ...(typeof payload.reasoningEffort === 'string' ? { reasoningEffort: payload.reasoningEffort } : {}),
        ...(typeof payload.planning === 'boolean' ? { planning: payload.planning } : {}),
      });
      return json(200, await project(providerId, proposedAgentId, nativeSessionId));
    })());
    creations.set(key, { fingerprint, operation });
    return operation;
  }
  async function control(request: RemoteHostControlRequest): Promise<AgentRemoteHttpResult> {
    try {
      if (closed) throw new HostRequestError(503, 'host_closed', 'Agent Host is closed.');
      const url = new URL(request.path, 'http://agent-host.local');
      if (request.method === 'GET') {
        const providerId = string(url.searchParams.get('providerId'), 'providerId');
        const directory = registration(providerId).directory;
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
        if (url.pathname === '/remote/create') return await create(request, payload);
        if (url.pathname === '/remote/attach' || url.pathname === '/remote/child/attach') {
          if (!request.sessionId) throw new HostRequestError(400, 'invalid_request', 'A proposed Agent identity is required.');
          const providerId = string(payload.providerId, 'providerId');
          const nativeSessionId = string(payload.nativeSessionId, 'nativeSessionId');
          const parent = url.pathname === '/remote/child/attach' ? string(payload.parentNativeSessionId, 'parentNativeSessionId') : undefined;
          return json(200, await tracked(project(providerId, request.sessionId, nativeSessionId, parent)));
        }
      }
      throw new HostRequestError(400, 'invalid_request', 'Remote Host request is invalid.');
    } catch (error) {
      if (error instanceof HostRequestError) return json(error.status, { error: error.message, code: error.code });
      if (error instanceof RemoteHostCatalogError) return json(error.status, { error: error.message, code: error.code });
      if (request.method === 'GET') return json(503, { error: 'The Remote Host catalog is unavailable.', code: 'catalog_unavailable' });
      return json(503, { error: 'Remote Host operation outcome is unknown.', code: 'mutation_outcome_unknown' });
    }
  }
  return { relay, control, resolveSession(agentId) { try { return relay.requireAgent(agentId); } catch { return undefined; } },
    close(): Promise<void> { return closePromise ??= (async () => {
      closed = true;
      for (const catalog of catalogs.values()) catalog.dispose();
      const cleanup = Promise.allSettled([relay.close(), ...options.registrations.map(({ directory }) => Promise.resolve(directory.close())), ...pending]);
      await bounded(cleanup, shutdownTimeoutMs);
    })(); } };
}

class HostRequestError extends Error { constructor(readonly status: number, readonly code: string, message: string) { super(message); } }
function string(value: unknown, field: string): string { if (typeof value !== 'string' || !value) throw new HostRequestError(400, 'invalid_request', `${field} is required.`); return value; }
function body(value: string | undefined): Record<string, unknown> { try { const parsed: unknown = JSON.parse(value ?? ''); if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) return parsed as Record<string, unknown>; } catch {} throw new HostRequestError(400, 'invalid_request', 'Remote Host body is invalid.'); }
function json(status: number, value: unknown): AgentRemoteHttpResult { return { status, body: JSON.stringify(value) }; }
function positiveTimeout(value: number): number { if (!Number.isSafeInteger(value) || value < 1) throw new RangeError('Agent Host shutdown timeout must be a positive integer.'); return value; }
async function bounded(operation: Promise<unknown>, timeoutMs: number): Promise<void> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try { await Promise.race([operation, new Promise<void>((resolve) => { timer = setTimeout(resolve, timeoutMs); timer.unref?.(); })]); }
  finally { clearTimeout(timer); }
}
