import type { AgentPersistenceHandle, AgentProviderAdapter, AgentSession } from '@borgee/agent-provider-sdk';
import { describe, expect, it } from 'vitest';

import { AgentAlreadyExistsError, AgentNotFoundError, RelayClosedError, createAgentRemoteRelay } from './relay.js';
import { InMemoryResourceStore } from './resources/resource-store.js';

describe('AgentRemoteRelay manager ownership', () => {
  it('creates and resumes Agents through registered Providers', async () => {
    const calls: unknown[] = [];
    const provider: AgentProviderAdapter = {
      descriptor: { providerId: 'codex', displayName: 'Codex' },
      async createSession(config) { calls.push(['create', config]); return completeSession(); },
      async resumeSession(handle) { calls.push(['resume', handle]); return completeSession(); },
    };
    const relay = createAgentRemoteRelay({ providers: [provider], epoch: () => `epoch-${calls.length}` });

    const created = await relay.createAgent({
      protocolVersion: '1.4.0', type: 'create_agent',
      payload: {
        requestId: 'create-1', agentId: 'agent-created', providerId: 'codex',
        config: { sessionId: 'session-1', cwd: '/workspace' },
      },
    });
    expect(created).toMatchObject({
      protocolVersion: '1.4.0', type: 'agent_session',
      payload: { requestId: 'create-1', agentId: 'agent-created', providerId: 'codex', sessionId: 'session-1' },
    });
    expect(relay.requireAgent('agent-created').snapshot().payload.id).toBe('agent-created');
    await relay.close();
    const restoredRelay = createAgentRemoteRelay({ providers: [provider] });
    const resumed = await restoredRelay.resumeAgent({
      protocolVersion: '1.4.0', type: 'resume_agent',
      payload: {
        requestId: 'resume-1', agentId: 'agent-resumed',
        persistence: { providerId: 'codex', sessionId: 'session-1', opaque: 'resume-1' },
      },
    });

    expect(calls).toEqual([
      ['create', { sessionId: 'session-1', cwd: '/workspace' }],
      ['resume', { providerId: 'codex', sessionId: 'session-1', opaque: 'resume-1' }],
    ]);
    expect(resumed.payload.requestId).toBe('resume-1');
    expect(resumed.payload.agentId).toBe('agent-resumed');
    await restoredRelay.close();
  });

  it('reattaches an owned persistence handle without replacing its manager or disposing its session', async () => {
    const persistence = { providerId: 'codex', sessionId: 'session-owned', opaque: 'owned-handle' };
    let resumeCalls = 0;
    let disposals = 0;
    const messages: string[] = [];
    const relay = createAgentRemoteRelay({ providers: [{
      descriptor: { providerId: 'codex', displayName: 'Codex' },
      async createSession() { return heldSession(persistence, () => { disposals += 1; }, text => messages.push(text)); },
      async resumeSession() { resumeCalls += 1; throw new Error('The native session is already live.'); },
    }], epoch: () => 'owned-epoch' });
    try {
      await relay.createAgent(createRequest('agent-owned', persistence.sessionId));
      const manager = relay.requireAgent('agent-owned');
      const before = manager.snapshot();
      const history = manager.fetchTimeline({ requestId: 'history', agentId: 'agent-owned', direction: 'tail', limit: 10 });
      const replies = await Promise.all([
        relay.resumeAgent(resumeRequest('candidate-a', persistence)),
        relay.resumeAgent(resumeRequest('candidate-b', persistence)),
        relay.resumeAgent(resumeRequest('agent-owned', persistence)),
      ]);
      expect(replies.map(reply => reply.payload.agentId)).toEqual(['agent-owned', 'agent-owned', 'agent-owned']);
      expect(replies.map(reply => reply.payload.requestId)).toEqual(['resume-candidate-a', 'resume-candidate-b', 'resume-agent-owned']);
      expect(resumeCalls).toBe(0);
      expect(disposals).toBe(0);
      expect(relay.requireAgent('agent-owned')).toBe(manager);
      expect(manager.snapshot()).toEqual(before);
      expect(manager.fetchTimeline({ requestId: 'history', agentId: 'agent-owned', direction: 'tail', limit: 10 })).toEqual(history);
      expect(() => relay.requireAgent('candidate-a')).toThrow(AgentNotFoundError);
      await manager.sendMessage('Continue from the same owner.');
      expect(messages).toEqual(['Continue from the same owner.']);
    } finally {
      await relay.close();
    }
    expect(disposals).toBe(1);
  });

  it('rejects a candidate identity owned by another Agent before reattaching', async () => {
    const persistence = { providerId: 'codex', sessionId: 'session-owned', opaque: 'owned-handle' };
    const relay = createAgentRemoteRelay({ providers: [{
      descriptor: { providerId: 'codex', displayName: 'Codex' },
      async createSession(config) { return heldSession({ ...persistence, sessionId: config.sessionId }); },
      async resumeSession() { throw new Error('Unexpected native resume.'); },
    }] });
    try {
      await relay.createAgent(createRequest('agent-owned', persistence.sessionId));
      await relay.createAgent(createRequest('agent-other', 'session-other'));
      await expect(relay.resumeAgent(resumeRequest('agent-other', persistence))).rejects.toBeInstanceOf(AgentAlreadyExistsError);
      expect(relay.requireAgent('agent-other').snapshot().payload.runtimeInfo.sessionId).toBe('session-other');
    } finally {
      await relay.close();
    }
  });

  it.each(['providerId', 'sessionId', 'opaque'] as const)('does not reattach when persistence %s differs', async field => {
    const persistence = { providerId: 'codex', sessionId: 'session-owned', opaque: 'owned-handle' };
    const different = { ...persistence, [field]: 'different-value' };
    const requested: AgentPersistenceHandle[] = [];
    const provider: AgentProviderAdapter = {
      descriptor: { providerId: 'codex', displayName: 'Codex' },
      async createSession() { return heldSession(persistence); },
      async resumeSession(handle) { requested.push(handle); throw new Error('Cold persistence unavailable.'); },
    };
    const relay = createAgentRemoteRelay({ providers: [provider, { ...provider, descriptor: { providerId: 'different-value', displayName: 'Other' } }] });
    try {
      await relay.createAgent(createRequest('agent-owned', persistence.sessionId));
      await expect(relay.resumeAgent(resumeRequest('candidate', different))).rejects.toThrow('Cold persistence unavailable.');
      expect(requested).toEqual([different]);
    } finally {
      await relay.close();
    }
  });

  it('shares one cold restore for concurrent requests with the same persistence handle', async () => {
    const persistence = { providerId: 'codex', sessionId: 'session-cold', opaque: 'cold-handle' };
    let completeRestore!: () => void;
    const waiting = new Promise<void>(resolve => { completeRestore = resolve; });
    let resumeCalls = 0;
    const relay = createAgentRemoteRelay({ providers: [{
      descriptor: { providerId: 'codex', displayName: 'Codex' },
      async createSession(config) { return heldSession({ ...persistence, sessionId: config.sessionId }); },
      async resumeSession() { resumeCalls += 1; await waiting; return heldSession(persistence); },
    }] });
    try {
      const first = relay.resumeAgent(resumeRequest('candidate-first', persistence));
      const second = relay.resumeAgent(resumeRequest('candidate-second', persistence));
      completeRestore();
      const replies = await Promise.all([first, second]);
      expect(resumeCalls).toBe(1);
      expect(replies.map(reply => reply.payload.agentId)).toEqual(['candidate-first', 'candidate-first']);
      expect(replies.map(reply => reply.payload.requestId)).toEqual(['resume-candidate-first', 'resume-candidate-second']);
      await expect(relay.createAgent(createRequest('candidate-second', 'other-session'))).resolves.toMatchObject({
        payload: { agentId: 'candidate-second' },
      });
    } finally {
      await relay.close();
    }
  });

  it('releases a failed cold restore so the persistence handle can be retried', async () => {
    const persistence = { providerId: 'codex', sessionId: 'session-retry', opaque: 'retry-handle' };
    let resumeCalls = 0;
    const relay = createAgentRemoteRelay({ providers: [{
      descriptor: { providerId: 'codex', displayName: 'Codex' },
      async createSession() { return heldSession(persistence); },
      async resumeSession() {
        resumeCalls += 1;
        if (resumeCalls === 1) throw new Error('Persistence is temporarily unavailable.');
        return heldSession(persistence);
      },
    }] });
    try {
      await expect(relay.resumeAgent(resumeRequest('candidate', persistence))).rejects.toThrow('Persistence is temporarily unavailable.');
      await expect(relay.resumeAgent(resumeRequest('candidate', persistence))).resolves.toMatchObject({ payload: { agentId: 'candidate' } });
      expect(resumeCalls).toBe(2);
    } finally {
      await relay.close();
    }
  });

  it('rejects Resume after Relay closure without reviving an owned session', async () => {
    const persistence = { providerId: 'codex', sessionId: 'session-closed', opaque: 'closed-handle' };
    const relay = createAgentRemoteRelay({ providers: [{
      descriptor: { providerId: 'codex', displayName: 'Codex' },
      async createSession() { return heldSession(persistence); },
      async resumeSession() { throw new Error('Unexpected native resume.'); },
    }] });
    await relay.createAgent(createRequest('agent-owned', persistence.sessionId));
    await relay.close();
    await expect(relay.resumeAgent(resumeRequest('agent-owned', persistence))).rejects.toBeInstanceOf(RelayClosedError);
  });

  it('disposes a cold restore that finishes after Relay closure', async () => {
    const persistence = { providerId: 'codex', sessionId: 'session-closing', opaque: 'closing-handle' };
    let completeRestore!: () => void;
    const waiting = new Promise<void>(resolve => { completeRestore = resolve; });
    let disposals = 0;
    const relay = createAgentRemoteRelay({ providers: [{
      descriptor: { providerId: 'codex', displayName: 'Codex' },
      async createSession() { return heldSession(persistence); },
      async resumeSession() { await waiting; return heldSession(persistence, () => { disposals += 1; }); },
    }] });
    const restoring = relay.resumeAgent(resumeRequest('candidate', persistence));
    const rejected = expect(restoring).rejects.toBeInstanceOf(RelayClosedError);
    await relay.close();
    completeRestore();
    await rejected;
    expect(disposals).toBe(1);
    expect(() => relay.requireAgent('candidate')).toThrow(AgentNotFoundError);
  });

  it('rejects a second Agent reservation before invoking the Provider again', async () => {
    let createCount = 0;
    const provider: AgentProviderAdapter = {
      descriptor: { providerId: 'codex', displayName: 'Codex' },
      async createSession() { createCount += 1; return completeSession(); },
      async resumeSession() { return completeSession(); },
    };
    const relay = createAgentRemoteRelay({ providers: [provider] });
    const request = {
      protocolVersion: '1.4.0' as const, type: 'create_agent' as const,
      payload: {
        requestId: 'create-1', agentId: 'agent-1', providerId: 'codex', config: { sessionId: 'session-1' },
      },
    };
    await relay.createAgent(request);

    await expect(relay.createAgent({ ...request, payload: { ...request.payload, requestId: 'create-2' } }))
      .rejects.toBeInstanceOf(AgentAlreadyExistsError);
    expect(createCount).toBe(1);
    await relay.close();
  });

  it('uses the injected resource store for Agent managers', async () => {
    const resourceStore = new InMemoryResourceStore();
    const provider: AgentProviderAdapter = {
      descriptor: { providerId: 'codex', displayName: 'Codex' },
      async createSession() { return resourceSession(); },
      async resumeSession() { return resourceSession(); },
    };
    const relay = createAgentRemoteRelay({ providers: [provider], resourceStore, epoch: () => 'epoch-1' });

    await relay.createAgent({
      protocolVersion: '1.4.0', type: 'create_agent',
      payload: {
        requestId: 'create-resource', agentId: 'agent-resource', providerId: 'codex',
        config: { sessionId: 'session-resource' },
      },
    });
    const resourceId = relay.requireAgent('agent-resource').fetchTimeline({
      requestId: 'tail', agentId: 'agent-resource', direction: 'tail', limit: 10,
    }).payload.entries[0]?.resources[0]?.resourceId;

    expect(resourceId).toBeDefined();
    expect(resourceStore.getRecord('agent-resource', resourceId!)).toMatchObject({
      locator: 'output.png', state: { status: 'available' },
    });
    await relay.close();
  });

  it.each(['create', 'resume'] as const)(
    'rejects %s when observation fails before the history boundary and disposes the session',
    async (operation) => {
      let disposeCount = 0;
      const provider: AgentProviderAdapter = {
        descriptor: { providerId: 'codex', displayName: 'Codex' },
        async createSession() { return failingSession(() => { disposeCount += 1; }); },
        async resumeSession() { return failingSession(() => { disposeCount += 1; }); },
      };
      const relay = createAgentRemoteRelay({ providers: [provider] });
      const agentId = `agent-${operation}`;

      try {
        const request = operation === 'create'
          ? relay.createAgent({
              protocolVersion: '1.4.0', type: 'create_agent',
              payload: {
                requestId: 'create-failed', agentId, providerId: 'codex',
                config: { sessionId: 'session-failed' },
              },
            })
          : relay.resumeAgent({
              protocolVersion: '1.4.0', type: 'resume_agent',
              payload: {
                requestId: 'resume-failed', agentId,
                persistence: { providerId: 'codex', sessionId: 'session-failed', opaque: 'resume-failed' },
              },
            });
        await expect(request).rejects.toThrow('Provider observation failed before history readiness.');
        expect(() => relay.requireAgent(agentId)).toThrow(AgentNotFoundError);
        expect(disposeCount).toBe(1);
      } finally {
        await relay.close().catch(() => undefined);
      }
    },
  );
});

function createRequest(agentId: string, sessionId: string) {
  return {
    protocolVersion: '1.4.0' as const, type: 'create_agent' as const,
    payload: { requestId: `create-${agentId}`, agentId, providerId: 'codex', config: { sessionId } },
  };
}

function resumeRequest(agentId: string, persistence: AgentPersistenceHandle) {
  return {
    protocolVersion: '1.4.0' as const, type: 'resume_agent' as const,
    payload: { requestId: `resume-${agentId}`, agentId, persistence },
  };
}

function heldSession(persistence: AgentPersistenceHandle, onDispose = () => {}, onMessage = (_text: string) => {}): AgentSession {
  let release!: () => void;
  const finished = new Promise<void>(resolve => { release = resolve; });
  return {
    ...completeSession(),
    async *observe() {
      yield {
        type: 'observation', sourceKey: 'seed-message', occurredAt: 1, delivery: 'history',
        event: { type: 'timeline', provider: persistence.providerId, item: { type: 'assistant_message', text: 'Remembered conversation.' } },
      };
      yield { type: 'history_boundary' };
      await finished;
    },
    async runtimeInfo() { return { providerId: persistence.providerId, sessionId: persistence.sessionId, status: 'idle', persistence }; },
    async sendMessage(text) { onMessage(text); },
    async dispose() { onDispose(); release(); },
  };
}

function completeSession(): AgentSession {
  return {
    capabilities: {
      history: true, sendMessage: true, steer: false, cancel: false, readResource: false,
      interactions: { question: true, planApproval: true, toolApproval: true },
    },
    async *observe() { yield { type: 'history_boundary' as const }; },
    async sendMessage() {},
    async respondToInteraction() {},
    async runtimeInfo() {
      return {
        providerId: 'codex', sessionId: 'session-1', status: 'idle' as const,
        persistence: { providerId: 'codex', sessionId: 'session-1', opaque: 'resume-1' },
      };
    },
    async dispose() {},
  };
}

function failingSession(onDispose: () => void): AgentSession {
  return {
    capabilities: {
      history: true, sendMessage: true, steer: false, cancel: false, readResource: false,
      interactions: { question: true, planApproval: true, toolApproval: true },
    },
    async *observe() {
      throw new Error('Provider observation failed before history readiness.');
    },
    async sendMessage() {},
    async respondToInteraction() {},
    async runtimeInfo() {
      return {
        providerId: 'codex', sessionId: 'session-failed', status: 'starting' as const,
        persistence: { providerId: 'codex', sessionId: 'session-failed', opaque: 'resume-failed' },
      };
    },
    async dispose() { onDispose(); },
  };
}

function resourceSession(): AgentSession {
  return {
    capabilities: {
      history: true, sendMessage: true, steer: false, cancel: false, readResource: true,
      interactions: { question: true, planApproval: true, toolApproval: true },
    },
    async *observe() {
      yield {
        type: 'observation' as const, sourceKey: 'resource-row', occurredAt: 1, delivery: 'history' as const,
        event: {
          type: 'timeline' as const, provider: 'codex',
          item: { type: 'assistant_message' as const, text: '[output](output.png)' },
        },
      };
      yield { type: 'history_boundary' as const };
    },
    async readResource() {
      return {
        status: 'available', mediaType: 'image/png',
        bytes: new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10, 1]),
      };
    },
    async sendMessage() {},
    async respondToInteraction() {},
    async runtimeInfo() { return { providerId: 'codex', sessionId: 'session-resource', status: 'idle' }; },
    async dispose() {},
  };
}
