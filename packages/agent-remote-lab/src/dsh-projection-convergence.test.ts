import { describe, expect, it } from 'vitest';

import {
  DshProjector,
  LiveDshSession,
  type DshNativeObservation,
  type DshOwnedAgent,
} from '@borgee/agent-provider-dsh';
import type { AgentProviderAdapter, AgentSession, ProviderObservation, ProviderStreamItem } from '@borgee/agent-provider-sdk';
import {
  createAgentRemoteRelay,
  InMemoryResourceStore,
  type AgentManager,
  type AgentManagerEvent,
  type ResourceStore,
} from '@borgee/agent-remote-relay';
import { AgentReplica } from '@borgee/agent-remote-web';

import { createAgentRemoteRelay as createSourceAgentRemoteRelay } from '../../agent-remote-relay/src/relay.js';

function chunk(recordId: string, value: Record<string, unknown>): DshNativeObservation {
  return {
    recordId,
    occurredAt: 1_800_000_000_000,
    kind: 'session_event',
    payload: { type: 'assistant/chunk', turn: 'turn-one', step: 'step-one', chunk: value },
  };
}

function projectedHistory(): ProviderObservation[] {
  const projector = new DshProjector({ sessionId: 'delta-session', tools: { get: () => undefined } });
  return [
    ...projector.project(chunk('text-one', { type: 'text-delta', index: 0, text: 'Hel' })),
    ...projector.project(chunk('text-two', { type: 'text-delta', index: 0, text: 'lo' })),
    ...projector.project(chunk('text-end', { type: 'block-end', index: 0, block: { type: 'text', text: 'Hello' } })),
    ...projector.close('completed', 1_800_000_000_001),
  ].map((observation) => ({ ...observation, delivery: 'history' as const }));
}

function timelineHistoryObservation(
  sourceKey: string,
  sequence: number,
  item: Extract<ProviderObservation['event'], { type: 'timeline' }>['item'],
): ProviderObservation {
  return {
    type: 'observation',
    sourceKey,
    occurredAt: 1_800_000_000_000 + sequence,
    delivery: 'history',
    event: { type: 'timeline', provider: 'delta-provider', turnId: 'turn-one', item },
  };
}

function writeRecords(seqStart: number, callId: string, content: string, failed = false): DshNativeObservation[] {
  return [
    {
      recordId: `${callId}-call`,
      occurredAt: 1_800_000_000_000 + seqStart,
      kind: 'session_event',
      payload: {
        type: 'tool/call', seq: seqStart,
        data: {
          turn: 'turn-one', callId, name: 'write',
          arguments: JSON.stringify({ file_path: 'output.txt', content }),
        },
      },
    },
    {
      recordId: `${callId}-result`,
      occurredAt: 1_800_000_000_001 + seqStart,
      kind: 'session_event',
      payload: {
        type: 'tool/result', seq: seqStart + 1,
        data: {
          turn: 'turn-one', callId,
          message: {
            content: [{
              type: 'text',
              text: failed ? 'Write failed.' : 'Wrote file.',
              ...(failed ? { isError: true } : {}),
            }],
          },
        },
      },
    },
  ];
}

function provider(history: readonly ProviderObservation[] = projectedHistory()): AgentProviderAdapter {
  const session: AgentSession = {
    capabilities: {
      history: true, sendMessage: false, steer: false, cancel: false, readResource: false,
      interactions: { question: false, planApproval: false, toolApproval: false },
    },
    async *observe(): AsyncIterableIterator<ProviderStreamItem> {
      yield* history;
      yield { type: 'history_boundary' };
    },
    async sendMessage() { throw new Error('read only'); },
    async respondToInteraction() { throw new Error('read only'); },
    async runtimeInfo() {
      return {
        providerId: 'delta-provider', sessionId: 'delta-session', status: 'idle' as const,
        persistence: { providerId: 'delta-provider', sessionId: 'delta-session', opaque: 'delta-session' },
      };
    },
    async dispose() {},
  };
  return {
    descriptor: { providerId: 'delta-provider', displayName: 'Delta Provider' },
    async createSession() { return session; },
    async resumeSession() { return session; },
  };
}

function resourceRevisionProvider(
  records: readonly DshNativeObservation[],
  sessionId: string,
  onHistoryRead?: () => void,
): {
  provider: AgentProviderAdapter;
  session: LiveDshSession;
  emit(record: DshNativeObservation): void;
} {
  const listeners = new Set<(record: DshNativeObservation) => void>();
  const agent: DshOwnedAgent = {
    sessionId,
    borrowed: false,
    get events() {
      onHistoryRead?.();
      return records;
    },
    runtimeInfo: { status: 'idle', cwd: '/workspace', model: 'deepseek-chat' },
    features: {
      steer: false,
      cancel: false,
      readResource: true,
      interactions: { question: false, planApproval: false, toolApproval: false },
    },
    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    followup() {},
    steer() {},
    cancel() { return false; },
    respondToInteraction() { return false; },
    async readImage() { throw new Error('No image attachments are present.'); },
    async flush() {},
    async dispose() {},
  };
  const session = new LiveDshSession(
    agent,
    { providerId: 'dsh', sessionId, opaque: `dsh:${sessionId}` },
    { get: () => undefined },
  );
  const provider: AgentProviderAdapter = {
    descriptor: { providerId: 'dsh', displayName: 'DeepSeek Harness' },
    async createSession() { return session; },
    async resumeSession() { return session; },
  };
  return {
    provider,
    session,
    emit(record: DshNativeObservation) {
      for (const listener of listeners) listener(record);
    },
  };
}

async function settledCompletedWrites(manager: AgentManager, expectedCount: number) {
  for (let attempt = 0; attempt < 50; attempt += 1) {
    const page = manager.fetchTimeline({
      requestId: `tail-resource-${attempt}`,
      agentId: manager.agentId,
      direction: 'tail',
      limit: 100,
    });
    const completed = page.payload.entries.filter((entry) => (
      entry.item.type === 'tool_call' && entry.item.status === 'completed'
    ));
    if (
      completed.length === expectedCount
      && completed.every((entry) => entry.resources.every((resource) => resource.status !== 'pending'))
    ) return completed;
    await new Promise<void>((resolve) => setImmediate(resolve));
  }
  throw new Error(`Expected ${expectedCount} completed writes with settled resource bindings.`);
}

async function createResourceManager(
  sessionId: string,
  records: readonly DshNativeObservation[],
  options: { onHistoryRead?: () => void; resourceStore?: ResourceStore } = {},
) {
  const harness = resourceRevisionProvider(records, sessionId, options.onHistoryRead);
  const relay = createAgentRemoteRelay({
    providers: [harness.provider],
    epoch: () => `epoch-${sessionId}`,
    ...(options.resourceStore ? { resourceStore: options.resourceStore } : {}),
  });
  await relay.createAgent({
    protocolVersion: '1.3.0',
    type: 'create_agent',
    payload: {
      requestId: `create-${sessionId}`,
      agentId: `agent-${sessionId}`,
      providerId: 'dsh',
      config: { sessionId },
    },
  });
  return {
    relay,
    manager: relay.requireAgent(`agent-${sessionId}`),
    session: harness.session,
    emit: harness.emit,
  };
}

class RetryOnceResourceStore extends InMemoryResourceStore {
  putAttempts = 0;

  override putBlob(blob: Parameters<InMemoryResourceStore['putBlob']>[0]): void {
    this.putAttempts += 1;
    if (this.putAttempts === 1) throw new Error('Durable blob write failed.');
    super.putBlob(blob);
  }
}

describe('DSH projection convergence', () => {
  it('converges through the shared Relay history page and Web replica', async () => {
    const relay = createAgentRemoteRelay({ providers: [provider()], epoch: () => 'epoch-dsh' });
    await relay.createAgent({
      protocolVersion: '1.3.0', type: 'create_agent',
      payload: {
        requestId: 'create-dsh', agentId: 'agent-dsh', providerId: 'delta-provider',
        config: { sessionId: 'delta-session' },
      },
    });
    const page = relay.requireAgent('agent-dsh').fetchTimeline({
      requestId: 'tail-dsh', agentId: 'agent-dsh', direction: 'tail', limit: 100,
    });
    const replica = new AgentReplica();
    replica.applySnapshot(relay.requireAgent('agent-dsh').snapshot());
    replica.applyHistory(page);

    expect(page.payload.entries).toEqual([
      expect.objectContaining({ item: expect.objectContaining({ type: 'assistant_message', text: 'Hello' }) }),
    ]);
    expect(replica.getState().timeline.entries).toEqual(page.payload.entries);
    await relay.close();
  });

  it('catches up through interleaved lifecycle rows without skipping or duplicating Replica entries', async () => {
    const history = [
      timelineHistoryObservation('tool-running', 1, {
        type: 'tool_call', callId: 'call-one', name: 'read', status: 'running', error: null,
        detail: { type: 'read', filePath: '/workspace/input.txt' },
      }),
      timelineHistoryObservation('todo-running', 2, {
        type: 'todo', items: [{ text: 'Inspect input', completed: false, status: 'in_progress' }],
      }),
      timelineHistoryObservation('assistant', 3, {
        type: 'assistant_message', messageId: 'answer-one', text: 'Inspection complete.',
      }),
      timelineHistoryObservation('todo-completed', 4, {
        type: 'todo', items: [{ text: 'Inspect input', completed: true, status: 'completed' }],
      }),
      timelineHistoryObservation('tool-completed', 5, {
        type: 'tool_call', callId: 'call-one', name: 'read', status: 'completed', error: null,
        detail: { type: 'read', filePath: '/workspace/input.txt' },
      }),
    ];
    const relay = createSourceAgentRemoteRelay({ providers: [provider(history)], epoch: () => 'epoch-pagination' });
    await relay.createAgent({
      protocolVersion: '1.3.0', type: 'create_agent',
      payload: {
        requestId: 'create-pagination', agentId: 'agent-pagination', providerId: 'delta-provider',
        config: { sessionId: 'pagination-session' },
      },
    });

    try {
      const manager = relay.requireAgent('agent-pagination');
      const afterTwo = manager.fetchTimeline({
        requestId: 'after-two', agentId: manager.agentId, direction: 'after',
        cursor: { epoch: 'epoch-pagination', seq: 2 }, limit: 1,
      });
      expect(afterTwo.payload.endCursor).toEqual({ epoch: 'epoch-pagination', seq: 3 });

      const replica = new AgentReplica();
      replica.applySnapshot(manager.snapshot());
      let cursor = { epoch: 'epoch-pagination', seq: 0 };
      const endSequences: number[] = [];
      for (let pageIndex = 0; pageIndex < 10; pageIndex += 1) {
        const page = manager.fetchTimeline({
          requestId: `after-page-${pageIndex}`, agentId: manager.agentId, direction: 'after', cursor, limit: 1,
        });
        replica.applyHistory(page);
        if (!page.payload.endCursor) break;
        endSequences.push(page.payload.endCursor.seq);
        cursor = page.payload.endCursor;
        if (!page.payload.hasNewer) break;
      }

      expect(endSequences).toEqual([1, 2, 3, 4, 5]);
      const entries = replica.getState().timeline.entries;
      expect(entries.map(({ item }) => item.type)).toEqual(['tool_call', 'todo', 'assistant_message']);
      expect(entries[0]?.item).toMatchObject({ type: 'tool_call', callId: 'call-one', status: 'completed' });
      expect(entries[1]?.item).toMatchObject({ type: 'todo', items: [{ completed: true }] });
      expect(replica.getState().timeline.nextSeq).toBe(6);
    } finally {
      await relay.close();
    }
  });

  it('keeps future assistant chunks outside each forward page and replaces them authoritatively', async () => {
    const history = [
      timelineHistoryObservation('assistant-a', 1, {
        type: 'assistant_message', messageId: 'answer-one', text: 'A',
      }),
      timelineHistoryObservation('assistant-b', 2, {
        type: 'assistant_message', messageId: 'answer-one', text: 'B',
      }),
      timelineHistoryObservation('assistant-c', 3, {
        type: 'assistant_message', messageId: 'answer-one', text: 'C',
      }),
    ];
    const relay = createSourceAgentRemoteRelay({ providers: [provider(history)], epoch: () => 'epoch-message-pages' });
    await relay.createAgent({
      protocolVersion: '1.3.0', type: 'create_agent',
      payload: {
        requestId: 'create-message-pages', agentId: 'agent-message-pages', providerId: 'delta-provider',
        config: { sessionId: 'message-pages-session' },
      },
    });

    try {
      const manager = relay.requireAgent('agent-message-pages');
      const replica = new AgentReplica();
      replica.applySnapshot(manager.snapshot());
      let cursor = { epoch: 'epoch-message-pages', seq: 0 };
      const endSequences: number[] = [];
      const pageTexts: string[] = [];
      for (let pageIndex = 0; pageIndex < 10; pageIndex += 1) {
        const page = manager.fetchTimeline({
          requestId: `message-page-${pageIndex}`, agentId: manager.agentId, direction: 'after', cursor, limit: 1,
        });
        replica.applyHistory(page);
        const item = page.payload.entries[0]?.item;
        if (item?.type === 'assistant_message') pageTexts.push(item.text);
        if (!page.payload.endCursor) break;
        endSequences.push(page.payload.endCursor.seq);
        cursor = page.payload.endCursor;
        if (!page.payload.hasNewer) break;
      }

      expect(endSequences).toEqual([1, 2, 3]);
      expect(pageTexts).toEqual(['A', 'AB', 'ABC']);
      expect(replica.getState().timeline.entries).toHaveLength(1);
      expect(replica.getState().timeline.entries[0]?.item).toEqual({
        type: 'assistant_message', messageId: 'answer-one', text: 'ABC',
      });
      expect(replica.getState().timeline.nextSeq).toBe(4);
    } finally {
      await relay.close();
    }
  });

  it('preserves non-user DSH message sources as visible diagnostics through Relay and Web', async () => {
    const projector = new DshProjector({ sessionId: 'source-session', tools: { get: () => undefined } });
    const records: DshNativeObservation[] = [
      {
        recordId: 'plan-mode-notice', occurredAt: 1_800_000_000_000, kind: 'session_event',
        payload: {
          type: 'user/message', seq: 0,
          data: {
            id: 'plan-mode-notice', turn: 'turn-one',
            source: { kind: 'plugin', plugin: 'plan-mode', form: 'notice' },
            content: [{ type: 'text', text: 'The user switched this session to plan mode.' }],
          },
        },
      },
      {
        recordId: 'model-context', occurredAt: 1_800_000_000_001, kind: 'session_event',
        payload: {
          type: 'user/message', seq: 1,
          data: {
            id: 'model-context', turn: 'turn-one', source: { kind: 'model', model: 'deepseek-chat' },
            content: [{ type: 'text', text: 'Model-owned context.' }],
          },
        },
      },
      {
        recordId: 'future-context', occurredAt: 1_800_000_000_002, kind: 'session_event',
        payload: {
          type: 'user/message', seq: 2,
          data: {
            id: 'future-context', turn: 'turn-one', source: { kind: 'workflow', workflow: 'future-controller' },
            content: [{ type: 'text', text: 'Future injected context.' }],
          },
        },
      },
    ];
    const history = records.flatMap((record) => projector.project(record))
      .map((observation) => ({ ...observation, delivery: 'history' as const }));
    const relay = createAgentRemoteRelay({ providers: [provider(history)], epoch: () => 'epoch-source' });
    await relay.createAgent({
      protocolVersion: '1.3.0', type: 'create_agent',
      payload: {
        requestId: 'create-source', agentId: 'agent-source', providerId: 'delta-provider',
        config: { sessionId: 'source-session' },
      },
    });
    try {
      const manager = relay.requireAgent('agent-source');
      const page = manager.fetchTimeline({
        requestId: 'tail-source', agentId: 'agent-source', direction: 'tail', limit: 100,
      });
      const replica = new AgentReplica();
      replica.applySnapshot(manager.snapshot());
      replica.applyHistory(page);
      const entries = replica.getState().timeline.entries;

      expect(entries.some(({ item }) => item.type === 'user_message')).toBe(false);
      expect(entries.map(({ item }) => item.type === 'error' ? item.message : '')).toEqual([
        'Unsupported DSH user/message source model.',
        'Unsupported DSH user/message source workflow.',
      ]);
    } finally {
      await relay.close();
    }
  });

  it('propagates a post-boundary native sequence gap into manager failure state', async () => {
    const initial: DshNativeObservation = {
      recordId: 'assistant-initial',
      occurredAt: 1_800_000_000_000,
      kind: 'session_event',
      payload: {
        type: 'assistant/message', seq: 0,
        data: {
          turn: 'turn-one', step: 1,
          message: { content: [{ type: 'text', text: 'Initial output.' }] },
        },
      },
    };
    const { relay, manager, emit } = await createResourceManager('sequence-gap', [initial]);
    const events: AgentManagerEvent[] = [];
    manager.subscribe((event) => events.push(event));

    try {
      emit({
        recordId: 'assistant-before-gap',
        occurredAt: 1_800_000_000_001,
        kind: 'session_event',
        payload: {
          type: 'assistant/message', seq: 1,
          data: {
            turn: 'turn-one', step: 2,
            message: { content: [{ type: 'text', text: 'Output before a gap.' }] },
          },
        },
      });
      emit({
        recordId: 'assistant-queued-before-gap',
        occurredAt: 1_800_000_000_002,
        kind: 'session_event',
        payload: {
          type: 'assistant/message', seq: 2,
          data: {
            turn: 'turn-one', step: 3,
            message: { content: [{ type: 'text', text: 'Queued output before a gap.' }] },
          },
        },
      });
      emit({
        recordId: 'assistant-after-gap',
        occurredAt: 1_800_000_000_004,
        kind: 'session_event',
        payload: {
          type: 'assistant/message', seq: 4,
          data: {
            turn: 'turn-one', step: 4,
            message: { content: [{ type: 'text', text: 'Output after a gap.' }] },
          },
        },
      });
      await manager.settled;

      expect(manager.snapshot()).toMatchObject({
        payload: {
          status: 'failed',
          runtimeInfo: { status: 'failed' },
          lastError: 'Provider observation stream failed.',
        },
      });
      expect(events).toContainEqual(expect.objectContaining({
        type: 'agent_stream',
        event: expect.objectContaining({
          type: 'turn_failed',
          code: 'provider_observation_failed',
          diagnostic: 'Live DSH sequence jumped from 2 to 4.',
        }),
      }));
      const entries = manager.fetchTimeline({
        requestId: 'tail-before-gap', agentId: manager.agentId, direction: 'tail', limit: 100,
      }).payload.entries;
      expect(entries).toContainEqual(expect.objectContaining({
        item: expect.objectContaining({
          type: 'assistant_message', text: 'Output before a gap.',
        }),
      }));
      expect(entries).toContainEqual(expect.objectContaining({
        item: expect.objectContaining({
          type: 'assistant_message', text: 'Queued output before a gap.',
        }),
      }));
    } finally {
      await relay.close();
    }
  });

  it('binds each completed historical write to its own available byte revision', async () => {
    const { relay, manager } = await createResourceManager('resource-valid-valid', [
      ...writeRecords(0, 'write-first', 'first revision\n'),
      ...writeRecords(2, 'write-second', 'second revision\n'),
    ]);
    try {
      const completedWrites = await settledCompletedWrites(manager, 2);
      const firstBinding = completedWrites[0]?.resources[0];
      const secondBinding = completedWrites[1]?.resources[0];

      expect(firstBinding).toMatchObject({ locator: 'output.txt', status: 'available' });
      expect(secondBinding).toMatchObject({ locator: 'output.txt', status: 'available' });
      expect(secondBinding?.resourceId).not.toBe(firstBinding?.resourceId);
      expect((await manager.readResource('read-first', firstBinding!.resourceId)).payload.state).toMatchObject({
        status: 'available',
        contentBase64: 'Zmlyc3QgcmV2aXNpb24K',
      });
      expect((await manager.readResource('read-second', secondBinding!.resourceId)).payload.state).toMatchObject({
        status: 'available',
        contentBase64: 'c2Vjb25kIHJldmlzaW9uCg==',
      });
    } finally {
      await relay.close();
    }
  });

  it('reconstructs the same native revision when Relay durable blob storage retries', async () => {
    const store = new RetryOnceResourceStore();
    let historyReads = 0;
    const { relay, manager } = await createResourceManager(
      'resource-store-retry',
      writeRecords(0, 'write-retry', 'retryable revision\n'),
      { resourceStore: store, onHistoryRead: () => { historyReads += 1; } },
    );
    try {
      const completedWrites = await settledCompletedWrites(manager, 1);
      const binding = completedWrites[0]?.resources[0];

      expect(store.putAttempts).toBe(2);
      expect(historyReads).toBe(3);
      expect((await manager.readResource('read-retried', binding!.resourceId)).payload.state).toMatchObject({
        status: 'available',
        contentBase64: 'cmV0cnlhYmxlIHJldmlzaW9uCg==',
      });
    } finally {
      await relay.close();
    }
  });

  it('serves the durable Relay blob after the Provider generated-resource reader stops', async () => {
    const { relay, manager, session } = await createResourceManager(
      'resource-reader-stopped',
      writeRecords(0, 'write-durable', 'durable revision\n'),
    );
    try {
      const completedWrites = await settledCompletedWrites(manager, 1);
      const binding = completedWrites[0]?.resources[0];
      session.stopGeneratedResourceReader();

      expect((await manager.readResource('read-durable', binding!.resourceId)).payload.state).toMatchObject({
        status: 'available',
        contentBase64: 'ZHVyYWJsZSByZXZpc2lvbgo=',
      });
    } finally {
      await relay.close();
    }
  });

  it.each([
    { name: 'empty', content: '' },
    { name: 'oversized', content: 'x'.repeat((16 * 1024 * 1024) + 1) },
  ])('keeps the first historical revision available when a later successful write is $name', async ({ name, content }) => {
    const { relay, manager } = await createResourceManager(`resource-valid-${name}`, [
      ...writeRecords(0, 'write-first', 'first revision\n'),
      ...writeRecords(2, `write-${name}`, content),
    ]);
    try {
      const completedWrites = await settledCompletedWrites(manager, 2);
      const firstBinding = completedWrites[0]?.resources[0];
      const secondBinding = completedWrites[1]?.resources[0];

      expect(firstBinding).toMatchObject({ locator: 'output.txt', status: 'available' });
      expect(secondBinding).toMatchObject({ locator: 'output.txt', status: 'unavailable' });
      expect(secondBinding?.resourceId).not.toBe(firstBinding?.resourceId);
      expect((await manager.readResource('read-first', firstBinding!.resourceId)).payload.state).toMatchObject({
        status: 'available',
        contentBase64: 'Zmlyc3QgcmV2aXNpb24K',
      });
      expect((await manager.readResource('read-second', secondBinding!.resourceId)).payload.state).toMatchObject({
        status: 'unavailable',
      });
    } finally {
      await relay.close();
    }
  });

  it('does not create a completed replacement binding for a failed historical write', async () => {
    const { relay, manager } = await createResourceManager('resource-valid-failed', [
      ...writeRecords(0, 'write-first', 'first revision\n'),
      ...writeRecords(2, 'write-failed', 'rejected revision\n', true),
    ]);
    try {
      const completedWrites = await settledCompletedWrites(manager, 1);
      const page = manager.fetchTimeline({
        requestId: 'tail-resource-failed',
        agentId: manager.agentId,
        direction: 'tail',
        limit: 100,
      });
      const failedWrites = page.payload.entries.filter((entry) => (
        entry.item.type === 'tool_call' && entry.item.status === 'failed'
      ));
      const firstBinding = completedWrites[0]?.resources[0];

      expect(completedWrites).toHaveLength(1);
      expect(failedWrites).toHaveLength(1);
      expect(failedWrites[0]?.resources).toEqual([]);
      expect(firstBinding).toMatchObject({ locator: 'output.txt', status: 'available' });
      expect((await manager.readResource('read-first', firstBinding!.resourceId)).payload.state).toMatchObject({
        status: 'available',
        contentBase64: 'Zmlyc3QgcmV2aXNpb24K',
      });
    } finally {
      await relay.close();
    }
  });
});
