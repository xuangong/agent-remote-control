import type { AgentCapabilities, AgentRuntimeInfo, AgentSession, ProviderObservation, ProviderStreamItem } from '@orchardworks/agent-provider-sdk';
import { AgentManager } from '@orchardworks/agent-remote-relay';

const capabilities: AgentCapabilities = {
  history: true, sendMessage: true, steer: false, cancel: false, readResource: false, interactions: { question: true, planApproval: true, toolApproval: true },
};

/** A provider session a scenario drives: queued items, then live items pushed later. It is what a provider adapter gives the runtime. */
export class ScriptedSession implements AgentSession {
  readonly capabilities: AgentCapabilities = capabilities;
  private readonly queue: ProviderStreamItem[];
  private waiter: ((item: ProviderStreamItem | undefined) => void) | undefined;
  private disposed = false;

  constructor(readonly providerId: string, readonly nativeSessionId: string, initial: ProviderStreamItem[]) { this.queue = [...initial]; }

  async *observe(): AsyncIterable<ProviderStreamItem> {
    for (;;) {
      const item = this.queue.shift() ?? await new Promise<ProviderStreamItem | undefined>(resolve => { if (this.disposed) resolve(undefined); else this.waiter = resolve; });
      if (!item) return;
      yield item;
    }
  }

  push(item: ProviderStreamItem): void {
    const waiter = this.waiter;
    if (waiter) { this.waiter = undefined; waiter(item); } else this.queue.push(item);
  }

  async runtimeInfo(): Promise<AgentRuntimeInfo> {
    return { providerId: this.providerId, sessionId: this.nativeSessionId, status: 'idle', persistence: { providerId: this.providerId, sessionId: this.nativeSessionId, opaque: '{}' } };
  }
  async sendMessage(): Promise<void> {}
  async respondToInteraction(): Promise<void> {}
  async dispose(): Promise<void> {
    this.disposed = true;
    const waiter = this.waiter;
    this.waiter = undefined;
    waiter?.(undefined);
  }
}

export const historyBoundary = (): ProviderStreamItem => ({ type: 'history_boundary' });

/** An agent manager over a scripted session, ready after its history boundary; it checks the item identity contract as a journal-capable provider's does. */
export async function attachScripted(session: ScriptedSession, agentId = 'agent-1'): Promise<AgentManager> {
  // A Controller keeps its resource id key with its state, so a file a row names keeps its resource id across a reopen; a fixed key does the same here.
  const manager = await AgentManager.attach({ agentId, provider: { providerId: session.providerId, displayName: 'Scripted' }, epoch: `epoch-${agentId}`, session, journalContract: true, resourceIdKey: 'fixtures' });
  await manager.ready;
  return manager;
}

export const observationsOf = (observations: readonly ProviderObservation[], delivery: 'history' | 'live') => observations.filter(observation => observation.delivery === delivery);
