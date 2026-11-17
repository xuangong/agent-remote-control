import { expect, it } from 'vitest';
import type { AgentCapabilities, AgentSession, ProviderStreamItem } from '@orchardworks/agent-provider-sdk';
import { AgentManager } from './agent-manager.js';

it.each([undefined, 'exclusive', 'shared'] as const)('publishes shared remote access independently of the legacy adapter policy %s', async legacyPolicy => {
  const capabilities: AgentCapabilities = {
    ...(legacyPolicy ? { sessionControl: legacyPolicy } : {}),
    history: true, sendMessage: true, steer: false, cancel: false, readResource: false,
    interactions: { question: false, planApproval: false, toolApproval: false },
  };
  let update!: () => void;
  let finish!: () => void;
  const updated = new Promise<void>(resolve => { update = resolve; });
  const finished = new Promise<void>(resolve => { finish = resolve; });
  const session: AgentSession = {
    capabilities,
    async *observe(): AsyncGenerator<ProviderStreamItem> {
      yield { type: 'history_boundary' };
      await updated;
      yield { type: 'observation', sourceKey: 'runtime-update', occurredAt: 1, delivery: 'live', event: {
        type: 'runtime_updated', provider: 'fixture', runtimeInfo: { providerId: 'fixture', sessionId: 'native', status: 'running' },
      } };
      await finished;
    },
    async runtimeInfo() { return { providerId: 'fixture', sessionId: 'native', status: 'idle' }; },
    async sendMessage() {},
    async respondToInteraction() {},
    async dispose() { update(); finish(); },
  };
  const manager = await AgentManager.attach({ agentId: 'agent', provider: { providerId: 'fixture', displayName: 'Fixture' }, session, epoch: 'epoch' });
  try {
    await manager.ready;
    expect(manager.snapshot().payload.capabilities.sessionControl).toBe('shared');
    expect(capabilities.sessionControl).toBe(legacyPolicy);
    capabilities.sessionControl = 'exclusive';
    update();
    await expect.poll(() => manager.snapshot().payload.status).toBe('running');
    expect(manager.snapshot().payload.capabilities.sessionControl).toBe('shared');
    expect(capabilities.sessionControl).toBe('exclusive');
  } finally { await manager.close(); }
}, 2_000);
