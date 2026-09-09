import type {
  AgentCapabilities,
  AgentInteractionResponse,
  AgentProviderAdapter,
  AgentResourceReadResult,
  AgentRuntimeInfo,
  AgentSession,
  ProviderStreamItem,
} from '@borgee/agent-provider-sdk';
import { describe, expect, it } from 'vitest';

import type { AgentManagerEvent } from './agent-manager-events.js';
import { AgentManager, InteractionResponseError } from './agent-manager.js';
import { createSessionWire } from './session-wire.js';

const capabilities: AgentCapabilities = {
  history: true,
  sendMessage: true,
  steer: false,
  cancel: false,
  readResource: false,
  interactions: { question: true, planApproval: true, toolApproval: true },
};

describe('AgentManager Timeline and Snapshot', () => {
  it('serializes planning selection with message submission and publishes authoritative state before acknowledgement', async () => {
    const stream = new ManualProviderStream();
    stream.push({ type: 'history_boundary' });
    const gate = deferred();
    const calls: string[] = [];
    let active = false;
    const session = sessionFor(stream, {
      capabilities: { ...capabilities, planning: true },
      async setPlanning(value) { calls.push('select'); await gate.promise; active = value; },
      async sendMessage() { calls.push(active ? 'send-in-plan' : 'send-in-default'); },
      async runtimeInfo() { return { providerId: 'codex', sessionId: 'session-1', status: 'idle', planning: { active } }; },
    });
    const manager = await AgentManager.attach({ agentId: 'agent-1', provider: { providerId: 'codex', displayName: 'Codex' }, session, epoch: 'epoch-1' });
    await manager.ready;
    const selected = manager.setPlanning(true);
    await nextEventLoopTurn();
    const sent = manager.sendMessage('Inspect this.');
    await nextEventLoopTurn();
    expect(calls).toEqual(['select']);
    expect(manager.snapshot().payload.runtimeInfo.planning).toEqual({ active: false });
    gate.resolve();
    await selected;
    expect(manager.snapshot().payload.runtimeInfo.planning).toEqual({ active: true });
    await sent;
    expect(calls).toEqual(['select', 'send-in-plan']);
    await manager.close();
  });

  it.each(['unsupported', 'running', 'waiting'] as const)('rejects a planning change while %s', async (state) => {
    const stream = new ManualProviderStream();
    stream.push({ type: 'history_boundary' });
    let changed = false;
    const session = sessionFor(stream, {
      capabilities: { ...capabilities, ...(state === 'unsupported' ? {} : { planning: true }) },
      async setPlanning() { changed = true; },
      async runtimeInfo() { return { providerId: 'codex', sessionId: 'session-1', status: state === 'unsupported' ? 'idle' : state }; },
    });
    const manager = await AgentManager.attach({ agentId: 'agent-1', provider: { providerId: 'codex', displayName: 'Codex' }, session, epoch: 'epoch-1' });
    await manager.ready;
    await expect(manager.setPlanning(true)).rejects.toThrow();
    expect(changed).toBe(false);
    await manager.close();
  });

  it('creates and resumes Provider sessions through the same manager contract', async () => {
    const calls: unknown[] = [];
    const createStream = new ManualProviderStream();
    const resumeStream = new ManualProviderStream();
    createStream.push({ type: 'history_boundary' });
    resumeStream.push({ type: 'history_boundary' });
    const adapter: AgentProviderAdapter = {
      descriptor: { providerId: 'codex', displayName: 'Codex' },
      async createSession(config) { calls.push(['create', config]); return sessionFor(createStream); },
      async resumeSession(handle) { calls.push(['resume', handle]); return sessionFor(resumeStream); },
    };

    const created = await AgentManager.create({
      agentId: 'agent-created', adapter, config: { sessionId: 'session-1', cwd: '/workspace' }, epoch: 'epoch-created',
    });
    const resumed = await AgentManager.resume({
      agentId: 'agent-resumed', adapter,
      handle: { providerId: 'codex', sessionId: 'session-1', opaque: 'resume-1' }, epoch: 'epoch-resumed',
    });
    await Promise.all([created.ready, resumed.ready]);

    expect(calls).toEqual([
      ['create', { sessionId: 'session-1', cwd: '/workspace' }],
      ['resume', { providerId: 'codex', sessionId: 'session-1', opaque: 'resume-1' }],
    ]);
    expect(created.snapshot().payload.id).toBe('agent-created');
    expect(resumed.snapshot().payload.id).toBe('agent-resumed');
    await Promise.all([created.close(), resumed.close()]);
  });

  it('disposes a created session that cannot honor explicit planning', async () => {
    const stream = new ManualProviderStream();
    stream.push({ type: 'history_boundary' });
    let disposed = false;
    const adapter: AgentProviderAdapter = {
      descriptor: { providerId: 'codex', displayName: 'Codex' },
      async createSession() { return sessionFor(stream, { async dispose() { disposed = true; } }); },
      async resumeSession() { throw new Error('Unexpected resume.'); },
    };
    await expect(AgentManager.create({
      agentId: 'agent-created', adapter, config: { sessionId: 'session-1', planning: true }, epoch: 'epoch-created',
    })).rejects.toThrow('set_planning');
    expect(disposed).toBe(true);
  });

  it('delegates supported message, steering, and cancellation commands', async () => {
    const providerStream = new ManualProviderStream();
    providerStream.push({ type: 'history_boundary' });
    const calls: unknown[] = [];
    const session = sessionFor(providerStream, {
      capabilities: { ...capabilities, steer: true, cancel: true },
      async sendMessage(text) { calls.push(['message', text]); },
      async steer(text) { calls.push(['steer', text]); },
      async cancel() { calls.push(['cancel']); },
    });
    const manager = await AgentManager.attach({
      agentId: 'agent-1', provider: { providerId: 'codex', displayName: 'Codex' }, session, epoch: 'epoch-1',
    });
    await manager.ready;

    await manager.sendMessage('Continue.');
    await manager.steer('Use the new target.');
    await manager.cancel();

    expect(calls).toEqual([
      ['message', 'Continue.'], ['steer', 'Use the new target.'], ['cancel'],
    ]);
    await manager.close();
  });

  it('records a canonical row before broadcast and keeps Timeline state out of Snapshot', async () => {
    const providerStream = new ManualProviderStream();
    const manager = await AgentManager.attach({
      agentId: 'agent-1',
      provider: { providerId: 'codex', displayName: 'Codex' },
      session: sessionFor(providerStream),
      epoch: 'epoch-1',
      clock: () => new Date('2026-09-02T00:00:00.000Z'),
    });
    let visibleDuringBroadcast: unknown;
    manager.subscribe((event) => {
      if (event.type !== 'agent_stream' || event.event.type !== 'timeline') return;
      visibleDuringBroadcast = manager.fetchTimeline({
        requestId: 'tail-during-broadcast', agentId: 'agent-1', direction: 'tail', limit: 10,
      }).payload.entries;
    });

    providerStream.push({
      type: 'observation', sourceKey: 'native-1', occurredAt: 1_725_000_000_000, delivery: 'history',
      event: {
        type: 'timeline', provider: 'codex', turnId: 'turn-1',
        item: { type: 'assistant_message', messageId: 'message-1', text: 'Hello' },
      },
    });
    providerStream.push({ type: 'history_boundary' });
    await manager.ready;

    expect(visibleDuringBroadcast).toEqual([
      expect.objectContaining({ seqStart: 1, seqEnd: 1, item: expect.objectContaining({ text: 'Hello' }) }),
    ]);
    const snapshot = manager.snapshot();
    expect(snapshot).toMatchObject({
      protocolVersion: '1.2.0', type: 'agent_snapshot',
      payload: { id: 'agent-1', providerId: 'codex', pendingInteractions: [] },
    });
    expect(snapshot.payload).not.toHaveProperty('timeline');
    expect(snapshot.payload).not.toHaveProperty('epoch');
    expect(snapshot.payload).not.toHaveProperty('cursor');
    await manager.close();
  });

  it('retires a throwing listener without failing the Agent or later delivery', async () => {
    const providerStream = new ManualProviderStream();
    const manager = await AgentManager.attach({
      agentId: 'agent-1', provider: { providerId: 'codex', displayName: 'Codex' },
      session: sessionFor(providerStream), epoch: 'epoch-1',
    });
    providerStream.push({ type: 'history_boundary' });
    await manager.ready;
    const received: string[] = [];
    manager.subscribe(() => { throw new Error('listener failed'); });
    manager.subscribe((event) => {
      if (event.type === 'agent_stream' && event.event.type === 'timeline'
        && event.event.item.type === 'assistant_message') received.push(event.event.item.text);
    });

    providerStream.push(timelineObservation('listener-row-1', 'First.', 1));
    await nextEventLoopTurn();
    providerStream.push(timelineObservation('listener-row-2', 'Second.', 2));
    await nextEventLoopTurn();

    expect(received).toEqual(['First.', 'Second.']);
    expect(manager.snapshot().payload).toMatchObject({ status: 'idle', runtimeInfo: { status: 'idle' } });
    await manager.close();
  });

  it('deduplicates history/live overlap and converges projected history with accepted live meaning', async () => {
    const providerStream = new ManualProviderStream();
    const manager = await AgentManager.attach({
      agentId: 'agent-1', provider: { providerId: 'codex', displayName: 'Codex' },
      session: sessionFor(providerStream), epoch: 'epoch-1',
    });
    const liveText: string[] = [];
    manager.subscribe((event) => {
      if (event.type === 'agent_stream' && event.event.type === 'timeline'
        && event.event.item.type === 'assistant_message') liveText.push(event.event.item.text);
    });
    const first = timelineObservation('shared-row', 'Hello ', 1);
    if (first.type !== 'observation') throw new Error('Expected an observation fixture.');
    providerStream.push({ ...first, delivery: 'history' });
    providerStream.push(first);
    providerStream.push(timelineObservation('live-row', 'world', 2));
    providerStream.push({ type: 'history_boundary' });
    await manager.ready;

    const history = manager.fetchTimeline({
      requestId: 'tail', agentId: 'agent-1', direction: 'tail', limit: 10,
    }).payload.entries;
    expect(liveText.join('')).toBe('Hello world');
    expect(history).toEqual([
      expect.objectContaining({
        seqStart: 1, seqEnd: 2,
        item: { type: 'assistant_message', messageId: 'message-1', text: 'Hello world' },
      }),
    ]);
    await manager.close();
  });

  it('replaces the Timeline epoch before recording rehydrated Provider rows', async () => {
    const providerStream = new ManualProviderStream();
    const manager = await AgentManager.attach({
      agentId: 'agent-1', provider: { providerId: 'codex', displayName: 'Codex' },
      session: sessionFor(providerStream), epoch: 'epoch-1',
    });
    providerStream.push({ type: 'history_boundary' });
    await manager.ready;
    providerStream.push(timelineObservation('old-row', 'Old output.', 1));
    await nextEventLoopTurn();

    const events: string[] = [];
    manager.subscribe((event) => events.push(event.type));
    manager.replaceTimeline('epoch-2');
    providerStream.push(timelineObservation('new-row', 'Rehydrated output.', 2));
    await nextEventLoopTurn();

    expect(events).toEqual(['timeline_replacement', 'agent_stream']);
    expect(manager.fetchTimeline({
      requestId: 'tail', agentId: 'agent-1', direction: 'tail', limit: 10,
    }).payload).toMatchObject({
      epoch: 'epoch-2',
      entries: [expect.objectContaining({ seqStart: 1, item: expect.objectContaining({ text: 'Rehydrated output.' }) })],
    });
    expect(manager.fetchTimeline({
      requestId: 'old-after', agentId: 'agent-1', direction: 'after',
      cursor: { epoch: 'epoch-1', seq: 1 }, limit: 10,
    }).payload).toMatchObject({ reset: true, staleCursor: true, entries: [] });
    await manager.close();
  });

  it('eagerly ingests a recorded resource and serves it after the Provider reader is disposed', async () => {
    const providerStream = new ManualProviderStream();
    let manager!: AgentManager;
    let recordedBeforeRead = false;
    let disposed = false;
    const session = sessionFor(providerStream, {
      capabilities: { ...capabilities, readResource: true },
      async readResource(locator) {
        expect(locator).toBe('artifacts/chart.png');
        recordedBeforeRead = manager.fetchTimeline({
          requestId: 'during-ingestion', agentId: 'agent-1', direction: 'tail', limit: 10,
        }).payload.entries.some(({ item }) => item.type === 'assistant_message' && item.text.includes(locator));
        return {
          status: 'available', mediaType: 'image/png',
          bytes: new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10, 1]),
        };
      },
      async dispose() {
        disposed = true;
        providerStream.finish();
      },
    });
    manager = await AgentManager.attach({
      agentId: 'agent-1', provider: { providerId: 'codex', displayName: 'Codex' }, session, epoch: 'epoch-1',
    });
    const liveResources: unknown[] = [];
    manager.subscribe((event) => {
      if (event.type === 'agent_stream' && event.event.type === 'timeline') {
        liveResources.push(event.row?.resources);
      }
    });

    providerStream.push({
      type: 'observation', sourceKey: 'resource-message', occurredAt: 1, delivery: 'history',
      event: {
        type: 'timeline', provider: 'codex',
        item: { type: 'assistant_message', text: 'Generated ![chart](artifacts/chart.png).' },
      },
    });
    providerStream.push({ type: 'history_boundary' });
    await manager.ready;
    await nextEventLoopTurn();

    const historyResources = manager.fetchTimeline({
      requestId: 'tail', agentId: 'agent-1', direction: 'tail', limit: 10,
    }).payload.entries[0]?.resources;
    expect(recordedBeforeRead).toBe(true);
    expect(liveResources).toEqual([[
      expect.objectContaining({ locator: 'artifacts/chart.png', status: 'pending' }),
    ]]);
    expect(historyResources).toEqual([
      expect.objectContaining({ locator: 'artifacts/chart.png', status: 'available' }),
    ]);
    expect((liveResources[0] as Array<{ resourceId: string }>)[0]?.resourceId).toBe(historyResources?.[0]?.resourceId);

    const resourceId = historyResources?.[0]?.resourceId;
    if (!resourceId) throw new Error('Expected an ingested resource.');
    await manager.close();
    expect(disposed).toBe(true);

    const output: Array<Record<string, unknown>> = [];
    const freshClient = createSessionWire(manager, (json) => output.push(JSON.parse(json) as Record<string, unknown>));
    await freshClient.receive(JSON.stringify({ protocolVersion: '1.2.0', type: 'negotiate' }));
    output.length = 0;
    await freshClient.receive(JSON.stringify({
      protocolVersion: '1.2.0', type: 'resource_request',
      payload: { requestId: 'resource-read', agentId: 'agent-1', resourceId },
    }));

    expect(output).toEqual([expect.objectContaining({
      type: 'resource_response',
      payload: expect.objectContaining({
        requestId: 'resource-read', agentId: 'agent-1', resourceId,
        state: expect.objectContaining({
          status: 'available', mediaType: 'image/png', byteLength: 9, contentBase64: 'iVBORw0KGgoB',
        }),
      }),
    })]);
    freshClient.close();
  });

  it('uses an observation-scoped read locator without exposing it in Timeline bindings', async () => {
    const providerStream = new ManualProviderStream();
    const reads: string[] = [];
    const manager = await AgentManager.attach({
      agentId: 'agent-1',
      provider: { providerId: 'codex', displayName: 'Codex' },
      epoch: 'epoch-1',
      session: sessionFor(providerStream, {
        capabilities: { ...capabilities, readResource: true },
        async readResource(locator) {
          reads.push(locator);
          return {
            status: 'available',
            mediaType: 'image/png',
            bytes: new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10, 1]),
          };
        },
      }),
    });
    providerStream.push({
      type: 'observation',
      sourceKey: 'generated-resource-row',
      occurredAt: 1,
      delivery: 'history',
      resourceReferences: [{ locator: 'artifacts/chart.png', readLocator: 'provider-resource:revision-one' }],
      event: {
        type: 'timeline',
        provider: 'codex',
        item: {
          type: 'tool_call',
          callId: 'write-one',
          name: 'write',
          detail: { type: 'write', filePath: 'artifacts/chart.png' },
          status: 'completed',
          error: null,
        },
      },
    });
    providerStream.push({ type: 'history_boundary' });
    await manager.ready;
    await nextEventLoopTurn();

    const binding = manager.fetchTimeline({
      requestId: 'tail-read-locator', agentId: 'agent-1', direction: 'tail', limit: 10,
    }).payload.entries[0]?.resources[0];
    expect(reads).toEqual(['provider-resource:revision-one']);
    expect(binding).toMatchObject({ locator: 'artifacts/chart.png', status: 'available' });
    expect(binding).not.toHaveProperty('readLocator');
    await manager.close();
  });

  it('delivers a pending resource binding without waiting for Provider bytes', async () => {
    const providerStream = new ManualProviderStream();
    const pendingRead = deferred<{ status: 'unavailable'; reason: string }>();
    const manager = await AgentManager.attach({
      agentId: 'agent-1', provider: { providerId: 'codex', displayName: 'Codex' }, epoch: 'epoch-1',
      session: sessionFor(providerStream, {
        capabilities: { ...capabilities, readResource: true },
        readResource: () => pendingRead.promise,
      }),
    });
    providerStream.push({ type: 'history_boundary' });
    await manager.ready;
    const liveResources: unknown[] = [];
    const terminalUpdates: unknown[] = [];
    manager.subscribe((event) => {
      if (event.type === 'agent_stream' && event.event.type === 'timeline') liveResources.push(event.row?.resources);
      if (event.type === 'resource_update') terminalUpdates.push(event);
    });
    const wireOutput: Array<Record<string, unknown>> = [];
    const wire = createSessionWire(manager, (json) => wireOutput.push(JSON.parse(json) as Record<string, unknown>));
    await wire.receive(JSON.stringify({ protocolVersion: '1.2.0', type: 'negotiate' }));
    await wire.receive(JSON.stringify({
      protocolVersion: '1.2.0', type: 'timeline_subscription',
      payload: { requestId: 'subscribe-resource', agentIds: ['agent-1'] },
    }));
    wireOutput.length = 0;

    providerStream.push({
      type: 'observation', sourceKey: 'slow-resource', occurredAt: 2, delivery: 'live',
      event: {
        type: 'timeline', provider: 'codex',
        item: { type: 'assistant_message', text: 'Generated [output](output.png).' },
      },
    });
    await nextEventLoopTurn();

    const pendingBinding = manager.fetchTimeline({
      requestId: 'pending-tail', agentId: 'agent-1', direction: 'tail', limit: 10,
    }).payload.entries[0]?.resources[0];
    expect(liveResources).toEqual([[pendingBinding]]);
    expect(pendingBinding).toMatchObject({ locator: 'output.png', status: 'pending' });
    expect(wireOutput).toEqual([expect.objectContaining({
      type: 'agent_stream',
      payload: expect.objectContaining({
        event: expect.objectContaining({ resources: [pendingBinding] }),
      }),
    })]);
    expect((await manager.readResource('pending-read', pendingBinding!.resourceId)).payload.state)
      .toEqual({ status: 'pending', retryAfterMs: 250 });

    pendingRead.resolve({ status: 'unavailable', reason: 'The generated file expired.' });
    await nextEventLoopTurn();

    expect(terminalUpdates).toEqual([expect.objectContaining({
      type: 'resource_update', agentId: 'agent-1', resourceId: pendingBinding!.resourceId,
      state: { status: 'unavailable', reason: 'The generated file expired.' },
    })]);
    expect(wireOutput.slice(1)).toEqual([expect.objectContaining({
      protocolVersion: '1.2.0',
      type: 'resource_update',
      payload: expect.objectContaining({
        agentId: 'agent-1', resourceId: pendingBinding!.resourceId,
        state: { status: 'unavailable', reason: 'The generated file expired.' },
      }),
    })]);
    expect((wireOutput[1]?.payload as Record<string, unknown>)).not.toHaveProperty('requestId');
    expect((await manager.readResource('unavailable-read', pendingBinding!.resourceId)).payload.state)
      .toEqual({ status: 'unavailable', reason: 'The generated file expired.' });
    expect(manager.fetchTimeline({
      requestId: 'available-tail', agentId: 'agent-1', direction: 'tail', limit: 10,
    }).payload.entries[0]?.resources[0]).toEqual({ ...pendingBinding, status: 'unavailable' });
    wire.close();
    await manager.close();
  });

  it('replaces a provisional same-content binding so live reduction converges with history', async () => {
    const providerStream = new ManualProviderStream();
    const secondRead = deferred<AgentResourceReadResult>();
    const pngBytes = new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10, 1]);
    let readCount = 0;
    const manager = await AgentManager.attach({
      agentId: 'agent-1', provider: { providerId: 'codex', displayName: 'Codex' }, epoch: 'epoch-1',
      session: sessionFor(providerStream, {
        capabilities: { ...capabilities, readResource: true },
        async readResource() {
          readCount += 1;
          if (readCount === 1) return { status: 'available', mediaType: 'image/png', bytes: pngBytes };
          return secondRead.promise;
        },
      }),
    });
    providerStream.push({ type: 'history_boundary' });
    await manager.ready;

    const wireOutput: Array<Record<string, unknown>> = [];
    const wire = createSessionWire(manager, (json) => wireOutput.push(JSON.parse(json) as Record<string, unknown>));
    await wire.receive(JSON.stringify({ protocolVersion: '1.2.0', type: 'negotiate' }));
    await wire.receive(JSON.stringify({
      protocolVersion: '1.2.0', type: 'timeline_subscription',
      payload: { requestId: 'subscribe-resources', agentIds: ['agent-1'] },
    }));
    wireOutput.length = 0;

    providerStream.push({
      type: 'observation', sourceKey: 'first-resource-row', occurredAt: 1, delivery: 'live',
      event: {
        type: 'timeline', provider: 'codex',
        item: { type: 'assistant_message', messageId: 'message-1', text: 'First [output](output.png).' },
      },
    });
    await nextEventLoopTurn();
    providerStream.push({
      type: 'observation', sourceKey: 'second-resource-row', occurredAt: 2, delivery: 'live',
      event: {
        type: 'timeline', provider: 'codex',
        item: {
          type: 'tool_call', callId: 'write-1', name: 'write', status: 'completed', error: null,
          detail: { type: 'other', description: 'Reuse [output](output.png).' },
        },
      },
    });
    await nextEventLoopTurn();

    const streamMessages = wireOutput.filter(({ type }) => type === 'agent_stream');
    const firstBinding = ((((streamMessages[0]?.payload as Record<string, unknown>).event as Record<string, unknown>)
      .resources as Array<Record<string, unknown>>)[0]);
    const provisionalBinding = ((((streamMessages[1]?.payload as Record<string, unknown>).event as Record<string, unknown>)
      .resources as Array<Record<string, unknown>>)[0]);
    expect(firstBinding.status).toBe('pending');
    expect(provisionalBinding).toMatchObject({ locator: 'output.png', status: 'pending' });
    expect(provisionalBinding.resourceId).not.toBe(firstBinding.resourceId);

    secondRead.resolve({ status: 'available', mediaType: 'image/png', bytes: pngBytes });
    await nextEventLoopTurn();
    await wire.receive(JSON.stringify({
      protocolVersion: '1.2.0', type: 'timeline_request',
      payload: { requestId: 'tail-after-settlement', agentId: 'agent-1', direction: 'tail', limit: 10 },
    }));

    const secondStreamIndex = wireOutput.findIndex((message) => message === streamMessages[1]);
    const replacementIndex = wireOutput.findIndex(({ type }) => type === 'timeline_resource_binding_replaced');
    const terminalUpdateIndex = wireOutput.findIndex(
      ({ type }, index) => type === 'resource_update' && index > secondStreamIndex,
    );
    expect(replacementIndex).toBeGreaterThan(secondStreamIndex);
    expect(terminalUpdateIndex).toBeGreaterThan(replacementIndex);

    type ReducedRow = {
      seqStart: number;
      seqEnd: number;
      resources: Array<{ locator: string; resourceId: string; status: string }>;
    };
    const liveRows = new Map<number, ReducedRow>();
    for (const message of wireOutput) {
      const payload = message.payload as Record<string, unknown> | undefined;
      if (message.type === 'agent_stream') {
        const event = payload?.event as Record<string, unknown> | undefined;
        if (event?.type !== 'timeline') continue;
        const seq = payload?.seq as number;
        liveRows.set(seq, {
          seqStart: seq,
          seqEnd: seq,
          resources: structuredClone(event.resources) as ReducedRow['resources'],
        });
      } else if (message.type === 'timeline_resource_binding_replaced') {
        const seq = payload?.seq as number;
        const row = liveRows.get(seq);
        const previous = payload?.previous as ReducedRow['resources'][number];
        const replacement = payload?.replacement as ReducedRow['resources'][number];
        if (row) {
          row.resources = row.resources.map((resource) => (
            resource.locator === previous.locator && resource.resourceId === previous.resourceId
              ? structuredClone(replacement)
              : resource
          ));
        }
      } else if (message.type === 'resource_update') {
        const resourceId = payload?.resourceId;
        const state = payload?.state as { status: string };
        for (const row of liveRows.values()) {
          row.resources = row.resources.map((resource) => (
            resource.resourceId === resourceId ? { ...resource, status: state.status } : resource
          ));
        }
      }
    }
    const historyPage = wireOutput.find(({ type }) => type === 'timeline_page');
    const historyEntries = ((historyPage?.payload as Record<string, unknown>).entries as Array<ReducedRow>)
      .map(({ seqStart, seqEnd, resources }) => ({ seqStart, seqEnd, resources }));

    expect([...liveRows.values()]).toEqual(historyEntries);
    expect(historyEntries[1]?.resources[0]?.resourceId).toBe(firstBinding.resourceId);
    wire.close();
    await manager.close();
  });
});

describe('AgentManager interactions', () => {
  it('stores a completed interaction once across history and live overlap', async () => {
    const stream = new ManualProviderStream();
    const requested: ProviderStreamItem = {
      type: 'observation', sourceKey: 'question-request', occurredAt: 1, delivery: 'history',
      event: { type: 'interaction_requested', provider: 'codex', turnId: 'turn-1', request: questionRequest },
    };
    const response: AgentInteractionResponse = { kind: 'question', answers: [{ questionId: 'channel', selectedValues: ['beta'] }] };
    const resolved: ProviderStreamItem = {
      type: 'observation', sourceKey: 'question-resolution', occurredAt: 2, delivery: 'history',
      event: { type: 'interaction_resolved', provider: 'codex', turnId: 'turn-1', requestId: 'question-1', response },
    };
    stream.push(requested);
    stream.push(resolved);
    stream.push({ ...requested, delivery: 'live' });
    stream.push({ ...resolved, delivery: 'live' });
    stream.push({ type: 'history_boundary' });
    const manager = await AgentManager.attach({ agentId: 'agent-1', provider: { providerId: 'codex', displayName: 'Codex' }, session: sessionFor(stream), epoch: 'epoch-1' });
    await manager.ready;
    await nextEventLoopTurn();
    stream.push({ ...resolved, delivery: 'live', sourceKey: 'duplicate-resolution' });
    await nextEventLoopTurn();
    expect(manager.snapshot().payload.pendingInteractions).toEqual([]);
    const entries = manager.fetchTimeline({ requestId: 'reload', agentId: 'agent-1', direction: 'tail', limit: 10 }).payload.entries;
    expect(entries).toHaveLength(1);
    expect(entries[0]).toMatchObject({ seqStart: 1, seqEnd: 1, turnId: 'turn-1', item: { type: 'interaction', request: questionRequest, response } });
    await manager.close();
  });

  it('does not fabricate history for an unmatched resolution or incompatible response kind', async () => {
    const stream = new ManualProviderStream();
    stream.push({ type: 'observation', sourceKey: 'request', occurredAt: 1, delivery: 'history', event: { type: 'interaction_requested', provider: 'codex', request: questionRequest } });
    stream.push({ type: 'observation', sourceKey: 'wrong-kind', occurredAt: 2, delivery: 'history', event: { type: 'interaction_resolved', provider: 'codex', requestId: questionRequest.requestId, response: { kind: 'plan_approval', action: 'reject' } } });
    stream.push({ type: 'observation', sourceKey: 'missing-request', occurredAt: 3, delivery: 'history', event: { type: 'interaction_resolved', provider: 'codex', requestId: 'missing', response: { kind: 'question', answers: [], dismissed: true } } });
    stream.push({ type: 'history_boundary' });
    const manager = await AgentManager.attach({ agentId: 'agent-1', provider: { providerId: 'codex', displayName: 'Codex' }, session: sessionFor(stream), epoch: 'epoch-1' });
    await manager.ready;
    expect(manager.fetchTimeline({ requestId: 'reload', agentId: 'agent-1', direction: 'tail', limit: 10 }).payload.entries).toEqual([]);
    await manager.close();
  });

  it('preserves revision feedback in completed plan history', async () => {
    const stream = new ManualProviderStream();
    const request = { kind: 'plan_approval' as const, requestId: 'plan-1', plan: '# Plan\n\n1. Read files.', allowedActions: ['reject' as const, 'approve_and_resume' as const] };
    const response: AgentInteractionResponse = { kind: 'plan_approval', action: 'reject', feedback: 'Read only the named file.' };
    stream.push({ type: 'observation', sourceKey: 'plan-request', occurredAt: 1, delivery: 'history', event: { type: 'interaction_requested', provider: 'codex', request } });
    stream.push({ type: 'history_boundary' });
    const session = sessionFor(stream);
    const manager = await AgentManager.attach({ agentId: 'agent-1', provider: { providerId: 'codex', displayName: 'Codex' }, session, epoch: 'epoch-1' });
    await manager.ready;
    await manager.respondToInteraction('plan-1', response);
    expect(manager.snapshot().payload.pendingInteractions).toEqual([request]);
    expect(session.interactionResponses).toEqual([{ requestId: 'plan-1', response }]);
    stream.push({ type: 'observation', sourceKey: 'plan-resolved', occurredAt: 2, delivery: 'live', event: { type: 'interaction_resolved', provider: 'codex', requestId: 'plan-1', response } });
    await nextEventLoopTurn();
    expect(manager.fetchTimeline({ requestId: 'reload', agentId: 'agent-1', direction: 'tail', limit: 10 }).payload.entries[0]?.item).toEqual({ type: 'interaction', request, response });
    await manager.close();
  });

  it('buffers a request during attach and reconciles a later resolution into Snapshot state', async () => {
    const providerStream = new ManualProviderStream();
    const manager = await AgentManager.attach({
      agentId: 'agent-1', provider: { providerId: 'codex', displayName: 'Codex' },
      session: sessionFor(providerStream), epoch: 'epoch-1',
    });
    const events: string[] = [];
    manager.subscribe((event) => events.push(event.type));

    providerStream.push({
      type: 'observation', sourceKey: 'request-1', occurredAt: 1, delivery: 'live',
      event: { type: 'interaction_requested', provider: 'codex', request: questionRequest },
    });
    providerStream.push({ type: 'history_boundary' });
    await manager.ready;

    expect(manager.snapshot().payload.pendingInteractions).toEqual([questionRequest]);
    expect(manager.snapshot().payload.status).toBe('waiting');
    expect(events).toEqual(['agent_state', 'agent_stream', 'interaction_requested']);

    providerStream.push({
      type: 'observation', sourceKey: 'resolution-1', occurredAt: 2, delivery: 'live',
      event: {
        type: 'interaction_resolved', provider: 'codex', requestId: 'question-1',
        response: { kind: 'question', answers: [{ questionId: 'channel', selectedValues: ['beta'] }] },
      },
    });
    await nextEventLoopTurn();

    expect(manager.snapshot().payload.pendingInteractions).toEqual([]);
    expect(manager.snapshot().payload.status).toBe('idle');
    expect(events.slice(-3)).toEqual(['agent_state', 'agent_stream', 'interaction_resolved']);
    await manager.close();
  });

  it('applies a resolution buffered during attach after its history request', async () => {
    const providerStream = new ManualProviderStream();
    const manager = await AgentManager.attach({
      agentId: 'agent-1', provider: { providerId: 'codex', displayName: 'Codex' },
      session: sessionFor(providerStream), epoch: 'epoch-1',
    });
    providerStream.push({
      type: 'observation', sourceKey: 'request-1', occurredAt: 1, delivery: 'history',
      event: { type: 'interaction_requested', provider: 'codex', request: questionRequest },
    });
    providerStream.push({
      type: 'observation', sourceKey: 'resolution-1', occurredAt: 2, delivery: 'live',
      event: {
        type: 'interaction_resolved', provider: 'codex', requestId: 'question-1',
        response: { kind: 'question', answers: [{ questionId: 'channel', selectedValues: ['beta'] }] },
      },
    });
    providerStream.push({ type: 'history_boundary' });
    await manager.ready;

    expect(manager.snapshot().payload.pendingInteractions).toEqual([]);
    await manager.close();
  });

  it('rejects mismatched and stale interaction responses before invoking the Provider', async () => {
    const providerStream = new ManualProviderStream();
    const session = sessionFor(providerStream);
    const manager = await AgentManager.attach({
      agentId: 'agent-1', provider: { providerId: 'codex', displayName: 'Codex' }, session, epoch: 'epoch-1',
    });
    providerStream.push({
      type: 'observation', sourceKey: 'request-1', occurredAt: 1, delivery: 'history',
      event: { type: 'interaction_requested', provider: 'codex', request: questionRequest },
    });
    providerStream.push({ type: 'history_boundary' });
    await manager.ready;

    await expect(manager.respondToInteraction('question-1', {
      kind: 'plan_approval', action: 'approve',
    })).rejects.toMatchObject<Partial<InteractionResponseError>>({ code: 'invalid_interaction_response' });
    expect(session.interactionResponses).toEqual([]);

    await manager.respondToInteraction('question-1', {
      kind: 'question', answers: [{ questionId: 'channel', selectedValues: ['beta'] }],
    });
    providerStream.push({
      type: 'observation', sourceKey: 'resolution-1', occurredAt: 2, delivery: 'live',
      event: {
        type: 'interaction_resolved', provider: 'codex', requestId: 'question-1',
        response: { kind: 'question', answers: [{ questionId: 'channel', selectedValues: ['beta'] }] },
      },
    });
    await nextEventLoopTurn();
    await expect(manager.respondToInteraction('question-1', {
      kind: 'question', answers: [{ questionId: 'channel', selectedValues: ['beta'] }],
    })).rejects.toMatchObject<Partial<InteractionResponseError>>({ code: 'stale_interaction' });
    expect(session.interactionResponses).toHaveLength(1);
    await manager.close();
  });

  it('claims a pending interaction before awaiting the Provider and retains the claim until resolution', async () => {
    const providerStream = new ManualProviderStream();
    providerStream.push({
      type: 'observation', sourceKey: 'request-1', occurredAt: 1, delivery: 'history',
      event: { type: 'interaction_requested', provider: 'codex', request: questionRequest },
    });
    providerStream.push({ type: 'history_boundary' });
    const submitted = deferred();
    let providerCalls = 0;
    const manager = await AgentManager.attach({
      agentId: 'agent-1', provider: { providerId: 'codex', displayName: 'Codex' }, epoch: 'epoch-1',
      session: sessionFor(providerStream, {
        async respondToInteraction() {
          providerCalls += 1;
          await submitted.promise;
        },
      }),
    });
    await manager.ready;
    const response = {
      kind: 'question' as const,
      answers: [{ questionId: 'channel', selectedValues: ['beta'] }],
    };

    const first = manager.respondToInteraction('question-1', response);
    await expect(manager.respondToInteraction('question-1', response))
      .rejects.toMatchObject<Partial<InteractionResponseError>>({ code: 'stale_interaction' });
    expect(providerCalls).toBe(1);

    submitted.resolve();
    await first;
    expect(manager.snapshot().payload.pendingInteractions).toEqual([questionRequest]);
    await expect(manager.respondToInteraction('question-1', response))
      .rejects.toMatchObject<Partial<InteractionResponseError>>({ code: 'stale_interaction' });

    providerStream.push({
      type: 'observation', sourceKey: 'resolution-1', occurredAt: 2, delivery: 'live',
      event: { type: 'interaction_resolved', provider: 'codex', requestId: 'question-1', response },
    });
    await nextEventLoopTurn();
    expect(manager.snapshot().payload.pendingInteractions).toEqual([]);
    await manager.close();
  });

  it('releases an interaction claim when Provider submission fails', async () => {
    const providerStream = new ManualProviderStream();
    providerStream.push({
      type: 'observation', sourceKey: 'request-1', occurredAt: 1, delivery: 'history',
      event: { type: 'interaction_requested', provider: 'codex', request: questionRequest },
    });
    providerStream.push({ type: 'history_boundary' });
    let providerCalls = 0;
    const manager = await AgentManager.attach({
      agentId: 'agent-1', provider: { providerId: 'codex', displayName: 'Codex' }, epoch: 'epoch-1',
      session: sessionFor(providerStream, {
        async respondToInteraction() {
          providerCalls += 1;
          if (providerCalls === 1) throw new Error('Provider submission failed.');
        },
      }),
    });
    await manager.ready;
    const response = {
      kind: 'question' as const,
      answers: [{ questionId: 'channel', selectedValues: ['beta'] }],
    };

    await expect(manager.respondToInteraction('question-1', response))
      .rejects.toThrow('Provider submission failed.');
    expect(manager.snapshot().payload.pendingInteractions).toEqual([questionRequest]);
    await expect(manager.respondToInteraction('question-1', response)).resolves.toBeUndefined();
    expect(providerCalls).toBe(2);
    await manager.close();
  });
});

describe('AgentManager observation lifecycle', () => {
  it('turns a post-boundary observation failure into visible failed state without rejecting settlement', async () => {
    const providerStream = new ManualProviderStream();
    const manager = await AgentManager.attach({
      agentId: 'agent-1', provider: { providerId: 'codex', displayName: 'Codex' },
      session: sessionFor(providerStream), epoch: 'epoch-1',
      clock: () => new Date('2026-09-02T00:00:00.000Z'),
    });
    providerStream.push({ type: 'history_boundary' });
    await manager.ready;
    const events: AgentManagerEvent[] = [];
    manager.subscribe((event) => events.push(event));

    providerStream.fail(new Error('native stream disconnected'));
    await expect(manager.settled).resolves.toBeUndefined();

    expect(manager.snapshot()).toMatchObject({
      payload: { status: 'failed', lastError: 'Provider observation stream failed.' },
    });
    expect(events).toMatchObject([
      { type: 'agent_state', snapshot: { payload: { status: 'failed' } } },
      {
        type: 'agent_stream',
        event: {
          type: 'turn_failed', code: 'provider_observation_failed',
          error: 'Provider observation stream failed.', diagnostic: 'native stream disconnected',
        },
      },
    ]);
    await manager.close();
  });

  it('treats post-boundary stream completion while the manager is open as an observation failure', async () => {
    const providerStream = new ManualProviderStream();
    const manager = await AgentManager.attach({
      agentId: 'agent-1', provider: { providerId: 'codex', displayName: 'Codex' },
      session: sessionFor(providerStream), epoch: 'epoch-1',
      clock: () => new Date('2026-09-02T00:00:00.000Z'),
    });
    providerStream.push({ type: 'history_boundary' });
    await manager.ready;
    const events: AgentManagerEvent[] = [];
    manager.subscribe((event) => events.push(event));

    providerStream.finish();
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
        diagnostic: 'Provider observation stream ended unexpectedly.',
      }),
    }));
    await manager.close();
  });

  it('does not report an explicit manager close as an observation failure', async () => {
    const providerStream = new ManualProviderStream();
    const manager = await AgentManager.attach({
      agentId: 'agent-1', provider: { providerId: 'codex', displayName: 'Codex' },
      session: sessionFor(providerStream), epoch: 'epoch-1',
    });
    providerStream.push({ type: 'history_boundary' });
    await manager.ready;
    const events: AgentManagerEvent[] = [];
    manager.subscribe((event) => events.push(event));

    await manager.close();

    expect(manager.snapshot().payload).toMatchObject({ status: 'idle', runtimeInfo: { status: 'idle' } });
    expect(events.some((event) => (
      event.type === 'agent_stream'
      && event.event.type === 'turn_failed'
      && event.event.code === 'provider_observation_failed'
    ))).toBe(false);
  });
});

const questionRequest = {
  kind: 'question' as const,
  requestId: 'question-1',
  questions: [{
    questionId: 'channel', header: 'Channel', prompt: 'Choose a channel.', required: true,
    selection: 'single' as const,
    options: [{ value: 'beta', label: 'Beta' }, { value: 'stable', label: 'Stable' }],
    allowCustomText: false, allowDismiss: false,
  }],
};

async function nextEventLoopTurn(): Promise<void> {
  await new Promise<void>((resolve) => setImmediate(resolve));
}

function deferred<T = void>(): { promise: Promise<T>; resolve: (value: T) => void } {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((next) => { resolve = next; });
  return { promise, resolve };
}

function timelineObservation(sourceKey: string, text: string, occurredAt: number): ProviderStreamItem {
  return {
    type: 'observation', sourceKey, occurredAt, delivery: 'live',
    event: {
      type: 'timeline', provider: 'codex', turnId: 'turn-1',
      item: { type: 'assistant_message', messageId: 'message-1', text },
    },
  };
}

function sessionFor(
  stream: ManualProviderStream,
  overrides: Partial<AgentSession> = {},
): AgentSession & { interactionResponses: unknown[] } {
  const interactionResponses: unknown[] = [];
  const runtime: AgentRuntimeInfo = {
    providerId: 'codex', sessionId: 'session-1', status: 'idle', cwd: '/workspace', model: 'gpt-5.6-codex',
    persistence: { providerId: 'codex', sessionId: 'session-1', opaque: 'resume-1' },
  };
  return {
    capabilities,
    interactionResponses,
    observe: () => stream,
    async sendMessage() {},
    async respondToInteraction(requestId: string, response: AgentInteractionResponse) {
      interactionResponses.push({ requestId, response });
    },
    async runtimeInfo() { return runtime; },
    async dispose() { stream.finish(); },
    ...overrides,
  };
}

class ManualProviderStream implements AsyncIterable<ProviderStreamItem> {
  private readonly values: ProviderStreamItem[] = [];
  private readonly waiters: Array<{
    resolve: (result: IteratorResult<ProviderStreamItem>) => void;
    reject: (error: unknown) => void;
  }> = [];
  private failure: unknown;
  private finished = false;

  push(value: ProviderStreamItem): void {
    const waiter = this.waiters.shift();
    if (waiter) waiter.resolve({ done: false, value });
    else this.values.push(value);
  }

  fail(error: unknown): void {
    const waiter = this.waiters.shift();
    if (waiter) waiter.reject(error);
    else this.failure = error;
  }

  finish(): void {
    this.finished = true;
    for (const waiter of this.waiters.splice(0)) waiter.resolve({ done: true, value: undefined });
  }

  [Symbol.asyncIterator](): AsyncIterator<ProviderStreamItem> {
    return {
      next: () => {
        const value = this.values.shift();
        if (value) return Promise.resolve({ done: false as const, value });
        if (this.failure !== undefined) {
          const error = this.failure;
          this.failure = undefined;
          return Promise.reject(error);
        }
        if (this.finished) return Promise.resolve({ done: true as const, value: undefined });
        return new Promise((resolve, reject) => this.waiters.push({ resolve, reject }));
      },
    };
  }
}
