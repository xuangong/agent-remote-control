import { describe, expect, it } from 'vitest';

import type {
  AgentCapabilities,
  AgentProviderAdapter,
  AgentSession,
  ProviderStreamItem,
} from './index.js';
import {
  collectProviderStream,
  runAgentProviderContractTests,
  validateAgentSessionCapabilities,
} from './testing.js';

const capabilities: AgentCapabilities = {
  history: true,
  sendMessage: true,
  steer: false,
  cancel: false,
  readResource: false,
  interactions: { question: true, planApproval: true, toolApproval: true },
};

function sessionFor(items: ProviderStreamItem[], overrides: Partial<AgentSession> = {}): AgentSession {
  return {
    capabilities,
    async *observe() { yield* items; },
    async sendMessage() {},
    async respondToInteraction() {},
    async runtimeInfo() {
      return {
        providerId: 'codex',
        sessionId: 'session-1',
        status: 'waiting',
        persistence: { providerId: 'codex', sessionId: 'session-1', opaque: 'resume-session-1' },
      };
    },
    async dispose() {},
    ...overrides,
  };
}

describe('provider history boundary', () => {
  it('requires setPlanning when the session advertises planning control', () => {
    const session = sessionFor([], { capabilities: { ...capabilities, planning: true } });
    expect(() => validateAgentSessionCapabilities(session)).toThrow('setPlanning');
    expect(() => validateAgentSessionCapabilities(sessionFor([]))).not.toThrow();
  });

  it('rejects a second history boundary before the requested live suffix is complete', async () => {
    const session = sessionFor([
      { type: 'history_boundary' },
      { type: 'history_boundary' },
    ]);

    await expect(collectProviderStream(session, 1)).rejects.toThrow(
      'Provider emitted more than one history boundary.',
    );
  });

  it('rejects history delivery after the history boundary', async () => {
    const session = sessionFor([
      { type: 'history_boundary' },
      {
        type: 'observation', sourceKey: 'late-history', occurredAt: 2, delivery: 'history',
        event: { type: 'turn_started', provider: 'codex', turnId: 'turn-1' },
      },
    ]);

    await expect(collectProviderStream(session, 1)).rejects.toThrow(
      'Provider emitted history data after the history boundary.',
    );
  });

  it('rejects a stream that ends before the requested live observations arrive', async () => {
    const session = sessionFor([{ type: 'history_boundary' }]);

    await expect(collectProviderStream(session, 1)).rejects.toThrow(
      'Provider stream ended before 1 live observation was collected.',
    );
  });

  it('requires every enabled optional capability to have a matching session method', () => {
    const session = sessionFor([], {
      capabilities: { ...capabilities, steer: true },
      steer: undefined,
    });

    expect(() => validateAgentSessionCapabilities(session)).toThrow(
      'Provider declares steer support but does not implement steer().',
    );
  });

  it('keeps resource read identity attached to its Provider observation', async () => {
    const session = sessionFor([
      {
        type: 'observation',
        sourceKey: 'write-result',
        occurredAt: 1,
        delivery: 'history',
        resourceReferences: [{ locator: 'reports/result.txt', readLocator: 'provider-resource:revision-one' }],
        event: {
          type: 'timeline',
          provider: 'codex',
          item: {
            type: 'tool_call',
            callId: 'write-one',
            name: 'write',
            detail: { type: 'write', filePath: 'reports/result.txt' },
            status: 'completed',
            error: null,
          },
        },
      },
      { type: 'history_boundary' },
    ]);

    const collected = await collectProviderStream(session, 0);

    expect(collected.history[0]?.resourceReferences).toEqual([
      { locator: 'reports/result.txt', readLocator: 'provider-resource:revision-one' },
    ]);
    expect(collected.history[0]?.event).not.toHaveProperty('resourceReferences');
  });
});

runAgentProviderContractTests('reusable provider contract runner', async () => {
  const items: ProviderStreamItem[] = [
    {
      type: 'observation', sourceKey: 'history-1', occurredAt: 1, delivery: 'history',
      event: { type: 'thread_started', provider: 'codex', sessionId: 'session-1' },
    },
    { type: 'history_boundary' },
    {
      type: 'observation', sourceKey: 'live-1', occurredAt: 2, delivery: 'live',
      event: { type: 'turn_started', provider: 'codex', turnId: 'turn-1' },
    },
  ];
  const adapter: AgentProviderAdapter = {
    descriptor: { providerId: 'codex', displayName: 'Codex' },
    async createSession() { return sessionFor(items); },
    async resumeSession(handle) {
      expect(handle).toEqual({ providerId: 'codex', sessionId: 'session-1', opaque: 'resume-session-1' });
      return sessionFor(items);
    },
  };
  return {
    adapter,
    createConfig: { sessionId: 'session-1', cwd: '/workspace' },
    expected: { providerId: 'codex', historyCount: 1, liveCount: 1 },
  };
});
