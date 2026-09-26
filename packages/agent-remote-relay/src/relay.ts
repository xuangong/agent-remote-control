import { createOperationCache, type OperationCache } from './operation-cache.js';
import { createOperationExecutor, type OperationLifecycle } from './operation-settlement.js';
import type { SessionWireAgent, SessionWireOperationExecutor } from './session-wire.js';
import { SessionControlRegistry } from './session-control.js';
import type { InputImageStore } from './resources/input-image-store.js';
import { randomUUID } from 'node:crypto';

import { AgentOperationRejectedError, type AgentSession, type AgentPersistenceHandle, type AgentProviderAdapter, type AgentProviderDescriptor } from '@orchardworks/agent-provider-sdk';
import {
  PROTOCOL_VERSION,
  type AgentSessionResponse,
  type CreateAgentRequest,
  type ResumeAgentRequest,
} from '@orchardworks/agent-remote-protocol';

import { AgentManager } from './agent-manager.js';
import { ProviderRegistry } from './provider-registry.js';
import { InMemoryResourceStore, type ResourceStore } from './resources/resource-store.js';

export interface AgentRemoteRelay {
  readonly sessionControls?: SessionControlRegistry;
  executeOperation(scope: string): SessionWireOperationExecutor;
  registerProvider(adapter: AgentProviderAdapter): void;
  listProviders(): readonly AgentProviderDescriptor[];
  executeSessionOperation(request: CreateAgentRequest | ResumeAgentRequest, scope: string): Promise<AgentSessionResponse>;
  createAgent(request: CreateAgentRequest): Promise<AgentSessionResponse>;
  resumeAgent(request: ResumeAgentRequest): Promise<AgentSessionResponse>;
  requireAgent(agentId: string): AgentManager;
  closeAgent(agentId: string): Promise<void>;
  close(): Promise<void>;
}

export interface AgentRemoteRelayOptions {
  operationCache?: OperationCache;
  operationLifecycle?: OperationLifecycle;
  providers: readonly AgentProviderAdapter[];
  epoch?: () => string;
  resourceStore?: ResourceStore;
  inputImageStore?: InputImageStore;
}

export class AgentAlreadyExistsError extends AgentOperationRejectedError {
  constructor(readonly agentId: string) {
    super('agent_already_exists', `Agent already exists: ${agentId}`);
    this.name = 'AgentAlreadyExistsError';
  }
}

export class AgentNotFoundError extends Error {
  constructor(readonly agentId: string) {
    super(`Agent was not found: ${agentId}`);
    this.name = 'AgentNotFoundError';
  }
}

export class RelayClosedError extends Error {
  readonly code = 'relay_closed';
  constructor() {
    super('Agent Remote relay is closed.');
    this.name = 'RelayClosedError';
  }
}

class AgentRemoteRelayImplementation implements AgentRemoteRelay {
  readonly sessionControls = new SessionControlRegistry();
  private readonly providers: ProviderRegistry;
  private readonly agents = new Map<string, AgentManager>();
  private readonly reservations = new Set<string>();
  private readonly restorations = new Map<string, Promise<AgentManager>>();
  private closed = false;
  private closePromise?: Promise<void>;
  private readonly nativeSessions = new Set<() => Promise<void>>();
  private readonly ephemeralOperationTargets = new WeakMap<SessionWireAgent, string>();

  constructor(
    providers: readonly AgentProviderAdapter[],
    private readonly createEpoch: () => string,
    private readonly resourceStore: ResourceStore,
    private readonly inputImageStore?: InputImageStore,
    private readonly operationCache: OperationCache = createOperationCache(),
    private readonly operationLifecycle?: OperationLifecycle,
  ) {
    this.providers = new ProviderRegistry(providers);
  }

  executeOperation(scope: string): SessionWireOperationExecutor {
    return createOperationExecutor(this.operationCache, scope, this.operationLifecycle, this.ephemeralOperationTargets);
  }

  registerProvider(adapter: AgentProviderAdapter): void { this.ensureOpen(); this.providers.register(adapter); }

  listProviders(): readonly AgentProviderDescriptor[] {
    return this.providers.list();
  }

  async executeSessionOperation(request: CreateAgentRequest | ResumeAgentRequest, scope: string): Promise<AgentSessionResponse> {
    this.ensureOpen();
    const { requestId, operationId, ...parameters } = request.payload;
    if (!operationId && request.type === 'resume_agent') return this.resumeAgent(request);
    const payload = await this.operationCache.execute({
      operationId: operationId!, scope, kind: request.type,
      target: request.type === 'create_agent' ? request.payload.providerId
        : JSON.stringify([request.payload.persistence.providerId, request.payload.persistence.sessionId]),
      parameters,
    }, {
      validate: () => {
        this.ensureOpen();
        this.providers.require(request.type === 'create_agent' ? request.payload.providerId : request.payload.persistence.providerId);
      },
      beforeDispatch: () => this.ensureOpen(),
      dispatch: async () => {
        const response = request.type === 'create_agent' ? await this.createAgent(request) : await this.resumeAgent(request);
        const { requestId: _correlation, ...result } = response.payload;
        return result;
      },
      maximumResultBytes: 256 * 1024,
    });
    return { protocolVersion: PROTOCOL_VERSION, type: 'agent_session', payload: { ...payload, requestId } };
  }

  async createAgent(request: CreateAgentRequest): Promise<AgentSessionResponse> {
    const release = this.reserve(request.payload.agentId);
    let manager: AgentManager | undefined;
    try {
      const adapter = this.providers.require(request.payload.providerId);
      manager = await AgentManager.create({
        agentId: request.payload.agentId,
        adapter: this.ownAdapter(adapter),
        config: request.payload.config,
        epoch: this.createEpoch(),
        resourceStore: this.resourceStore,
        ...(this.inputImageStore ? { inputImageStore: this.inputImageStore } : {}),
      });
      await manager.ready;
      this.ensureOpen();
      this.agents.set(request.payload.agentId, manager);
      return sessionResponse(request.payload.requestId, manager);
    } catch (error) {
      if (manager) await manager.close();
      throw error;
    } finally {
      release();
    }
  }

  async resumeAgent(request: ResumeAgentRequest): Promise<AgentSessionResponse> {
    this.ensureOpen();
    const attached = this.findOwnedSession(request.payload.persistence);
    if (attached?.agentId === request.payload.agentId) return sessionResponse(request.payload.requestId, attached);
    const release = this.reserve(request.payload.agentId);
    try {
      if (attached) return sessionResponse(request.payload.requestId, attached);
      const handle = request.payload.persistence;
      const key = JSON.stringify([handle.providerId, handle.sessionId, handle.opaque]);
      let restoration = this.restorations.get(key);
      if (!restoration) {
        restoration = this.restoreAgent(request).finally(() => this.restorations.delete(key));
        this.restorations.set(key, restoration);
      }
      const manager = await restoration;
      this.ensureOpen();
      return sessionResponse(request.payload.requestId, manager);
    } finally {
      release();
    }
  }

  private ownAdapter(adapter: AgentProviderAdapter): AgentProviderAdapter {
    const own = async (opening: Promise<AgentSession>): Promise<AgentSession> => {
      const session = await opening;
      let disposed: Promise<void> | undefined;
      const dispose = (): Promise<void> => {
        disposed ??= Promise.resolve().then(() => session.dispose()).finally(() => this.nativeSessions.delete(dispose));
        return disposed;
      };
      this.nativeSessions.add(dispose);
      if (this.closed) {
        await dispose();
        // Native opening already occurred, so closing cannot prove this operation was rejected.
        throw new RelayClosedError();
      }
      return new Proxy(session, {
        get(target, property) {
          if (property === 'dispose') return dispose;
          const value = Reflect.get(target, property, target);
          return typeof value === 'function' ? value.bind(target) : value;
        },
      });
    };
    return {
      descriptor: adapter.descriptor,
      createSession: config => own(adapter.createSession(config)),
      resumeSession: handle => own(adapter.resumeSession(handle)),
    };
  }

  private findOwnedSession(handle: AgentPersistenceHandle): AgentManager | undefined {
    for (const manager of this.agents.values()) {
      const persistence = manager.snapshot().payload.persistence;
      if (persistence?.providerId === handle.providerId
        && persistence.sessionId === handle.sessionId
        && persistence.opaque === handle.opaque) return manager;
    }
    return undefined;
  }

  private async restoreAgent(request: ResumeAgentRequest): Promise<AgentManager> {
    let manager: AgentManager | undefined;
    try {
      const adapter = this.providers.require(request.payload.persistence.providerId);
      manager = await AgentManager.resume({
        agentId: request.payload.agentId,
        adapter: this.ownAdapter(adapter),
        handle: request.payload.persistence,
        epoch: this.createEpoch(),
        resourceStore: this.resourceStore,
        ...(this.inputImageStore ? { inputImageStore: this.inputImageStore } : {}),
      });
      await manager.ready;
      this.ensureOpen();
      this.agents.set(request.payload.agentId, manager);
      return manager;
    } catch (error) {
      if (manager) await manager.close();
      throw error;
    }
  }

  requireAgent(agentId: string): AgentManager {
    const manager = this.agents.get(agentId);
    if (!manager) throw new AgentNotFoundError(agentId);
    return manager;
  }

  async closeAgent(agentId: string): Promise<void> {
    const manager = this.agents.get(agentId);
    if (!manager) return;
    this.agents.delete(agentId);
    await manager.close();
  }

  close(): Promise<void> {
    if (this.closePromise) return this.closePromise;
    this.closed = true;
    const draining = this.operationCache.close();
    this.sessionControls.close();
    const managers = [...this.agents.values()];
    this.agents.clear();
    const disposingNative = [...this.nativeSessions].map(dispose => dispose());
    this.closePromise = Promise.allSettled([draining, ...disposingNative, ...managers.map(manager => manager.close())]).then(results => {
      const failure = results.find((result): result is PromiseRejectedResult => result.status === 'rejected');
      if (failure) throw failure.reason;
    });
    return this.closePromise;
  }

  private reserve(agentId: string): () => void {
    this.ensureOpen();
    if (this.agents.has(agentId) || this.reservations.has(agentId)) {
      throw new AgentAlreadyExistsError(agentId);
    }
    this.reservations.add(agentId);
    return () => this.reservations.delete(agentId);
  }

  private ensureOpen(): void {
    if (this.closed) throw new RelayClosedError();
  }
}

export function createAgentRemoteRelay(options: AgentRemoteRelayOptions): AgentRemoteRelay {
  return new AgentRemoteRelayImplementation(
    options.providers,
    options.epoch ?? randomUUID,
    options.resourceStore ?? new InMemoryResourceStore(),
    options.inputImageStore,
    options.operationCache,
    options.operationLifecycle,
  );
}

function sessionResponse(requestId: string, manager: AgentManager): AgentSessionResponse {
  const snapshot = manager.snapshot();
  const sessionId = snapshot.payload.runtimeInfo.sessionId;
  if (!sessionId) throw new Error('Provider did not expose a session identity.');
  return {
    protocolVersion: PROTOCOL_VERSION,
    type: 'agent_session',
    payload: {
      requestId,
      agentId: manager.agentId,
      providerId: manager.provider.providerId,
      sessionId,
      ...(snapshot.payload.persistence === undefined
        ? {}
        : { persistence: structuredClone(snapshot.payload.persistence) }),
    },
  };
}
