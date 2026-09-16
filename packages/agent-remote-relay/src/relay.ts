import { randomUUID } from 'node:crypto';

import type { AgentPersistenceHandle, AgentProviderAdapter, AgentProviderDescriptor } from '@agent-remote-controller/agent-provider-sdk';
import {
  PROTOCOL_VERSION,
  type AgentSessionResponse,
  type CreateAgentRequest,
  type ResumeAgentRequest,
} from '@agent-remote-controller/agent-remote-protocol';

import { AgentManager } from './agent-manager.js';
import { ProviderRegistry } from './provider-registry.js';
import { InMemoryResourceStore, type ResourceStore } from './resources/resource-store.js';

export interface AgentRemoteRelay {
  listProviders(): readonly AgentProviderDescriptor[];
  createAgent(request: CreateAgentRequest): Promise<AgentSessionResponse>;
  resumeAgent(request: ResumeAgentRequest): Promise<AgentSessionResponse>;
  requireAgent(agentId: string): AgentManager;
  closeAgent(agentId: string): Promise<void>;
  close(): Promise<void>;
}

export interface AgentRemoteRelayOptions {
  providers: readonly AgentProviderAdapter[];
  epoch?: () => string;
  resourceStore?: ResourceStore;
}

export class AgentAlreadyExistsError extends Error {
  constructor(readonly agentId: string) {
    super(`Agent already exists: ${agentId}`);
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
  constructor() {
    super('Agent Remote relay is closed.');
    this.name = 'RelayClosedError';
  }
}

class AgentRemoteRelayImplementation implements AgentRemoteRelay {
  private readonly providers: ProviderRegistry;
  private readonly agents = new Map<string, AgentManager>();
  private readonly reservations = new Set<string>();
  private readonly restorations = new Map<string, Promise<AgentManager>>();
  private closed = false;

  constructor(
    providers: readonly AgentProviderAdapter[],
    private readonly createEpoch: () => string,
    private readonly resourceStore: ResourceStore,
  ) {
    this.providers = new ProviderRegistry(providers);
  }

  listProviders(): readonly AgentProviderDescriptor[] {
    return this.providers.list();
  }

  async createAgent(request: CreateAgentRequest): Promise<AgentSessionResponse> {
    const release = this.reserve(request.payload.agentId);
    let manager: AgentManager | undefined;
    try {
      const adapter = this.providers.require(request.payload.providerId);
      manager = await AgentManager.create({
        agentId: request.payload.agentId,
        adapter,
        config: request.payload.config,
        epoch: this.createEpoch(),
        resourceStore: this.resourceStore,
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
        adapter,
        handle: request.payload.persistence,
        epoch: this.createEpoch(),
        resourceStore: this.resourceStore,
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

  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    const managers = [...this.agents.values()];
    this.agents.clear();
    await Promise.all(managers.map((manager) => manager.close()));
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
