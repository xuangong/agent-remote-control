import type {
  AgentPersistenceHandle,
  AgentProviderAdapter,
  AgentSessionConfig,
} from '@borgee/agent-provider-sdk';

import { LiveDshSession } from './live-session.js';
import type { DshRuntime } from './runtime.js';
import type { Agent } from '@deepseek-ai/dsh-agent';
import type { DshToolRegistry } from './tools.js';

const descriptor = { providerId: 'dsh', displayName: 'DeepSeek Harness' } as const;
const emptyTools: DshToolRegistry = { get: () => undefined };

export interface LiveDshProvider extends AgentProviderAdapter {
  createSession(config: AgentSessionConfig): Promise<LiveDshSession>;
  resumeSession(handle: AgentPersistenceHandle): Promise<LiveDshSession>;
  borrowSession(agent: Agent): Promise<LiveDshSession>;
  dispose(): Promise<void>;
}

export function createLiveDshProvider(options: {
  runtime: DshRuntime;
  tools?: DshToolRegistry;
}): LiveDshProvider {
  return new LiveProvider(options.runtime, options.tools ?? emptyTools);
}

class LiveProvider implements LiveDshProvider {
  readonly descriptor = descriptor;

  constructor(
    private readonly runtime: DshRuntime,
    private readonly tools: DshToolRegistry,
  ) {}

  async createSession(config: AgentSessionConfig): Promise<LiveDshSession> {
    const agent = await this.runtime.create(config);
    await requireIdentity(agent, config.sessionId);
    return new LiveDshSession(agent, persistenceHandle(config.sessionId), this.tools);
  }

  async resumeSession(handle: AgentPersistenceHandle): Promise<LiveDshSession> {
    if (handle.providerId !== descriptor.providerId || handle.opaque !== persistenceOpaque(handle.sessionId)) {
      throw new Error('Live DSH persistence handle does not belong to this provider.');
    }
    const agent = await this.runtime.resume(handle);
    await requireIdentity(agent, handle.sessionId);
    return new LiveDshSession(agent, handle, this.tools);
  }

  async borrowSession(agent: Agent): Promise<LiveDshSession> {
    const borrowed = await this.runtime.borrow(agent);
    return new LiveDshSession(borrowed, persistenceHandle(borrowed.sessionId), this.tools);
  }

  async dispose(): Promise<void> {
    await this.runtime.dispose?.();
  }
}

function persistenceHandle(sessionId: string): AgentPersistenceHandle {
  return { providerId: descriptor.providerId, sessionId, opaque: persistenceOpaque(sessionId) };
}

function persistenceOpaque(sessionId: string): string {
  return `dsh:${sessionId}`;
}

async function requireIdentity(agent: Awaited<ReturnType<DshRuntime['create']>>, requestedSessionId: string): Promise<void> {
  if (agent.sessionId === requestedSessionId) return;
  try {
    await agent.flush();
  } finally {
    await agent.dispose();
  }
  throw new Error(`DSH runtime returned session "${agent.sessionId}" for "${requestedSessionId}".`);
}
