import { describe, expect, it, vi } from 'vitest';
import type {
  AgentSnapshot,
  AgentStreamMessage,
  ClientMessage,
  HistoryPage,
  ProjectedTimelineEntry,
  ResourceBinding,
  ServerMessage,
  TimelineCursor,
  TimelineDirection,
} from '@borgee/agent-remote-protocol';

import { AgentReplica } from '../replica/store.js';
import { RemoteSessionClient } from './remote-session-client.js';
import type {
  RemoteAgentTransport,
  RemoteConnection,
  RemoteOperationError,
  RemoteTransportListener,
} from './transport.js';

const capabilities = {
  history: true,
  sendMessage: true,
  steer: true,
  cancel: true,
  readResource: true,
  interactions: { question: true, planApproval: true, toolApproval: true },
};

function snapshot(): AgentSnapshot {
  return {
    protocolVersion: '1.4.0',
    type: 'agent_snapshot',
    payload: {
      id: 'agent-one', providerId: 'provider-neutral',
      createdAt: '2026-09-02T00:00:00.000Z', updatedAt: '2026-09-02T00:00:01.000Z',
      status: 'idle', activeTurn: null, capabilities, pendingInteractions: [],
      runtimeInfo: { providerId: 'provider-neutral', sessionId: 'session-one', status: 'idle' },
    },
  };
}

function entry(start: number, end: number, text: string): ProjectedTimelineEntry {
  return {
    providerId: 'provider-neutral',
    item: { type: 'assistant_message', text, messageId: 'answer' },
    timestamp: '2026-09-02T00:00:00.000Z',
    seqStart: start, seqEnd: end,
    sourceSeqRanges: [{ startSeq: start, endSeq: end }],
    collapsed: end > start ? ['assistant_merge'] : [],
    resources: [],
  };
}

function page(
  direction: TimelineDirection,
  entries: ProjectedTimelineEntry[],
  options: Partial<HistoryPage['payload']> = {},
): HistoryPage {
  const start = entries[0]?.seqStart ?? 0;
  const end = entries.at(-1)?.seqEnd ?? 0;
  return {
    protocolVersion: '1.4.0', type: 'timeline_page',
    payload: {
      requestId: 'timeline-page', agentId: 'agent-one', direction, epoch: 'epoch-one',
      reset: false, staleCursor: false, gap: false,
      window: { minSeq: start, maxSeq: end, nextSeq: end + 1 },
      startCursor: entries.length ? { epoch: 'epoch-one', seq: start } : null,
      endCursor: entries.length ? { epoch: 'epoch-one', seq: end } : null,
      hasOlder: false, hasNewer: false, entries, error: null,
      ...options,
    },
  };
}

function live(
  seq: number,
  text: string,
  epoch = 'epoch-one',
  resources: ResourceBinding[] = [],
): AgentStreamMessage {
  return {
    protocolVersion: '1.4.0', type: 'agent_stream',
    payload: {
      agentId: 'agent-one', epoch, seq,
      timestamp: `2026-09-02T00:00:0${seq}.000Z`,
      event: {
        type: 'timeline', providerId: 'provider-neutral',
        item: { type: 'assistant_message', text, messageId: 'answer' }, resources,
      },
    },
  };
}

describe('RemoteSessionClient', () => {
  it.each([undefined, 'immediate', 'next_turn'] as const)('sends %s delivery with the existing message acknowledgement', async (delivery) => {
    const transport = new FakeTransport();
    const client = connectedClient(transport, { requestId: () => 'message-delivery' });
    const text = '  Keep this\nexact text  ';
    try {
      const pending = delivery === undefined ? client.sendMessage(text) : client.sendMessage(text, { delivery });
      expect(transport.sent.at(-1)).toEqual({ protocolVersion: '1.4.0', type: 'send_message', payload: {
        requestId: 'message-delivery', agentId: 'agent-one', text, ...(delivery === undefined ? {} : { delivery }),
      } });
      const response = { protocolVersion: '1.4.0', type: 'command_acknowledged', payload: { requestId: 'message-delivery', agentId: 'agent-one', command: 'send_message' } } as const;
      transport.emit(response);
      await expect(pending).resolves.toEqual(response);
    } finally { client.stop(); }
  });

  it('keeps native command execution pending beyond the acknowledgement timeout', async () => {
    vi.useFakeTimers();
    const transport = new FakeTransport();
    const client = connectedClient(transport, { requestId: () => 'long-command', operationTimeoutMs: 10 });
    try {
      const pending = client.executeCommand('native:compact', '');
      let settled = false;
      void pending.then(() => { settled = true; }, () => { settled = true; });
      await vi.advanceTimersByTimeAsync(60_000);
      expect(settled).toBe(false);
      transport.emit({ protocolVersion: '1.4.0', type: 'command_result', payload: { requestId: 'long-command', agentId: 'agent-one', result: { text: 'Native finished' } } });
      await expect(pending).resolves.toEqual({ text: 'Native finished' });
    } finally { client.stop(); vi.useRealTimers(); }
  });

  it.each(['disconnect', 'stop'] as const)('cleans up long command execution on %s', async (ending) => {
    const transport = new FakeTransport();
    const client = connectedClient(transport, { requestId: () => 'native-execution' });
    const pending = client.executeCommand('native:ask', '');
    if (ending === 'disconnect') transport.disconnect();
    else client.stop();
    await expect(pending).rejects.toMatchObject({ code: ending === 'disconnect' ? 'connection_disconnected' : 'operation_stopped', requestId: 'native-execution' });
    client.start();
    transport.open();
    const retry = client.executeCommand('native:ask', '');
    transport.emit({ protocolVersion: '1.4.0', type: 'command_result', payload: { requestId: 'native-execution', agentId: 'agent-one', result: { text: 'New execution' } } });
    await expect(retry).resolves.toEqual({ text: 'New execution' });
    client.stop();
  });

  it('correlates native command discovery and execution results', async () => {
    const transport = new FakeTransport();
    const client = new RemoteSessionClient('agent-one', transport, new AgentReplica());
    client.start();
    transport.open();
    const listed = client.listCommands();
    const request = transport.sent.at(-1)!;
    expect(request.type).toBe('list_commands');
    if (request.type !== 'list_commands') throw new Error('Expected list');
    const commands = [{ id: 'native:go', name: 'go', description: 'Native', kind: 'command' as const }];
    transport.emit({ protocolVersion: '1.4.0', type: 'command_list', payload: { ...request.payload, commands } });
    await expect(listed).resolves.toEqual(commands);
    const executed = client.executeCommand('native:go', 'args');
    const run = transport.sent.at(-1)!;
    if (run.type !== 'execute_command') throw new Error('Expected execute');
    transport.emit({ protocolVersion: '1.4.0', type: 'command_result', payload: { requestId: run.payload.requestId, agentId: 'agent-one', result: { text: 'Done' } } });
    await expect(executed).resolves.toEqual({ text: 'Done' });
    client.stop();
  });
  it('correlates planning acknowledgement without optimistically changing authoritative state', async () => {
    const transport = new FakeTransport();
    const replica = new AgentReplica();
    replica.applySnapshot({ ...snapshot(), payload: { ...snapshot().payload, runtimeInfo: { ...snapshot().payload.runtimeInfo, planning: { active: false } } } });
    const client = new RemoteSessionClient('agent-one', transport, replica, { requestId: () => 'planning-one' });
    client.start();
    transport.open();
    const pending = client.setPlanning(true);
    expect(transport.sent.at(-1)).toEqual({ protocolVersion: '1.4.0', type: 'set_planning', payload: { requestId: 'planning-one', agentId: 'agent-one', active: true } });
    const acknowledgement = { protocolVersion: '1.4.0', type: 'command_acknowledged', payload: { requestId: 'planning-one', agentId: 'agent-one', command: 'set_planning' } } as const;
    transport.emit(acknowledgement);
    await expect(pending).resolves.toEqual(acknowledgement);
    expect(replica.getState().agent?.runtimeInfo.planning).toEqual({ active: false });
    client.stop();
  });

  it('uses capped exponential reconnect delays through an injectable scheduler', () => {
    const transport = new FakeTransport();
    const scheduled: Array<{ delayMs: number; run: () => void; cancel: () => void }> = [];
    const client = new RemoteSessionClient('agent-one', transport, new AgentReplica(), {
      reconnectInitialDelayMs: 10,
      reconnectMaxDelayMs: 25,
      scheduleReconnect(delayMs, reconnect) {
        let cancelled = false;
        const task = {
          delayMs,
          run: () => { if (!cancelled) reconnect(); },
          cancel: () => { cancelled = true; },
        };
        scheduled.push(task);
        return task.cancel;
      },
    });

    client.start();
    for (let attempt = 0; attempt < 4; attempt += 1) {
      transport.disconnect();
      expect(transport.connections).toBe(attempt + 1);
      scheduled[attempt]?.run();
    }

    expect(scheduled.map(({ delayMs }) => delayMs)).toEqual([10, 20, 25, 25]);
    expect(transport.connections).toBe(5);
    client.stop();
  });

  it('uses subscription acknowledgement as the barrier before tail catch-up and live convergence', async () => {
    const transport = new FakeTransport();
    const replica = new AgentReplica();
    const client = new RemoteSessionClient('agent-one', transport, replica);
    const ready: string[] = [];
    client.subscribeStatus((status) => ready.push(status));

    client.start();
    transport.open();
    expect(transport.sent.map(({ type }) => type)).toEqual(['negotiate']);
    transport.emit({ protocolVersion: '1.4.0', type: 'negotiated' });
    transport.emit(snapshot());
    expect(transport.sent.map(({ type }) => type)).toEqual(['negotiate', 'timeline_subscription']);
    expect(transport.timelineRequests).toEqual([]);

    transport.emit({
      protocolVersion: '1.4.0', type: 'timeline_subscribed',
      payload: { requestId: transport.sent[1]?.payload.requestId as string, agentIds: ['agent-one'] },
    });
    expect(transport.timelineRequests).toMatchObject([{ direction: 'tail', cursor: undefined }]);
    transport.emit(live(2, 'B'));
    expect(replica.getState().timeline.entries).toEqual([]);

    transport.resolveTimeline(page('tail', [entry(1, 2, 'AB')], {
      window: { minSeq: 1, maxSeq: 2, nextSeq: 3 },
    }));
    await transport.settle();

    expect(replica.getState().timeline.entries[0]?.item).toMatchObject({ text: 'AB' });
    expect(replica.getState().timeline.pendingLive).toEqual([]);
    expect(ready.at(-1)).toBe('ready');
  });

  it('reconnects automatically when the initial Timeline catch-up fails', async () => {
    const transport = new FakeTransport();
    const replica = new AgentReplica();
    const client = new RemoteSessionClient('agent-one', transport, replica, {
      scheduleReconnect: scheduleReconnectImmediately,
    });
    const statuses: string[] = [];
    client.subscribeStatus((status) => statuses.push(status));

    client.start();
    transport.open();
    transport.emit({ protocolVersion: '1.4.0', type: 'negotiated' });
    transport.emit(snapshot());
    transport.emit({
      protocolVersion: '1.4.0', type: 'timeline_subscribed',
      payload: { requestId: transport.sent.at(-1)?.payload.requestId as string, agentIds: ['agent-one'] },
    });
    transport.emit(live(2, 'B'));
    expect(replica.getState().timeline.pendingLive).toHaveLength(1);

    transport.rejectTimeline(new Error('transient Timeline failure'));
    await transport.settle();

    expect(transport.connections).toBe(2);
    expect(transport.closedConnections).toBe(1);
    transport.open();
    transport.emit({ protocolVersion: '1.4.0', type: 'negotiated' });
    transport.emit(snapshot());
    transport.emit({
      protocolVersion: '1.4.0', type: 'timeline_subscribed',
      payload: { requestId: transport.sent.at(-1)?.payload.requestId as string, agentIds: ['agent-one'] },
    });
    expect(transport.timelineRequests).toHaveLength(2);

    transport.resolveTimeline(page('tail', [entry(1, 1, 'A')]));
    await transport.settle();

    expect(replica.getState().timeline).toMatchObject({ initialized: true, pendingLive: [] });
    expect(replica.getState().timeline.entries[0]?.item).toMatchObject({ text: 'AB' });
    expect(statuses.at(-1)).toBe('ready');
  });

  it('rejects in-flight operations before recovery replaces the active connection', async () => {
    const transport = new FakeTransport();
    const client = new RemoteSessionClient('agent-one', transport, new AgentReplica(), {
      requestId: () => 'recovery-operation',
      operationTimeoutMs: 1_000,
      scheduleReconnect: scheduleReconnectImmediately,
    });
    client.start();
    transport.open();
    transport.emit({ protocolVersion: '1.4.0', type: 'negotiated' });
    transport.emit(snapshot());
    transport.emit({
      protocolVersion: '1.4.0', type: 'timeline_subscribed',
      payload: { requestId: transport.sent.at(-1)?.payload.requestId as string, agentIds: ['agent-one'] },
    });
    const pending = client.sendMessage('Reject this when recovery restarts.');

    transport.rejectTimeline(new Error('transient Timeline failure'));
    await transport.settle();

    await expect(pending).rejects.toMatchObject<Partial<RemoteOperationError>>({
      code: 'connection_disconnected', recoverable: true, requestId: 'recovery-operation',
    });
    expect(transport.connections).toBe(2);
  });

  it('cancels a catch-up restart when the client is stopped from the failure notification', async () => {
    const transport = new FakeTransport();
    const replica = new AgentReplica();
    const client = new RemoteSessionClient('agent-one', transport, replica, {
      scheduleReconnect: scheduleReconnectImmediately,
    });
    const statuses: string[] = [];
    client.subscribeStatus((status) => {
      statuses.push(status);
      if (status === 'disconnected') client.stop();
    });
    client.start();
    transport.open();
    transport.emit({ protocolVersion: '1.4.0', type: 'negotiated' });
    transport.emit(snapshot());
    transport.emit({
      protocolVersion: '1.4.0', type: 'timeline_subscribed',
      payload: { requestId: transport.sent.at(-1)?.payload.requestId as string, agentIds: ['agent-one'] },
    });

    transport.rejectTimeline(new Error('transient Timeline failure'));
    await transport.settle();

    expect(transport.connections).toBe(1);
    expect(transport.closedConnections).toBe(1);
    expect(statuses.at(-1)).toBe('idle');
  });

  it('requests missing history after a forward gap and drains the held live head', async () => {
    const transport = new FakeTransport();
    const replica = new AgentReplica();
    const client = new RemoteSessionClient('agent-one', transport, replica);
    client.start();
    transport.open();
    transport.emit({ protocolVersion: '1.4.0', type: 'negotiated' });
    transport.emit(snapshot());
    transport.emit({
      protocolVersion: '1.4.0', type: 'timeline_subscribed',
      payload: { requestId: transport.sent[1]?.payload.requestId as string, agentIds: ['agent-one'] },
    });
    transport.resolveTimeline(page('tail', [entry(1, 2, 'AB')], {
      window: { minSeq: 1, maxSeq: 2, nextSeq: 3 },
    }));
    await transport.settle();

    transport.emit(live(4, 'D'));
    expect(transport.timelineRequests.at(-1)).toMatchObject({
      direction: 'after', cursor: { epoch: 'epoch-one', seq: 2 },
    });
    transport.resolveTimeline(page('after', [entry(1, 3, 'ABC')], {
      window: { minSeq: 1, maxSeq: 4, nextSeq: 5 },
      endCursor: { epoch: 'epoch-one', seq: 3 }, hasNewer: true,
    }));
    await transport.settle();

    expect(replica.getState().timeline.entries[0]?.item).toMatchObject({ text: 'ABCD' });
    expect(replica.getState().timeline.nextSeq).toBe(5);
  });

  it('reconnects from the retained cursor and keeps the existing Timeline during Snapshot refresh', async () => {
    const transport = new FakeTransport();
    const replica = new AgentReplica();
    const client = new RemoteSessionClient('agent-one', transport, replica, {
      scheduleReconnect: scheduleReconnectImmediately,
    });
    client.start();
    transport.open();
    transport.emit({ protocolVersion: '1.4.0', type: 'negotiated' });
    transport.emit(snapshot());
    transport.emit({
      protocolVersion: '1.4.0', type: 'timeline_subscribed',
      payload: { requestId: transport.sent[1]?.payload.requestId as string, agentIds: ['agent-one'] },
    });
    transport.resolveTimeline(page('tail', [entry(1, 2, 'AB')], {
      window: { minSeq: 1, maxSeq: 2, nextSeq: 3 },
    }));
    await transport.settle();

    transport.disconnect();
    await transport.settle();
    expect(transport.connections).toBe(2);
    transport.open();
    transport.emit({ protocolVersion: '1.4.0', type: 'negotiated' });
    transport.emit(snapshot());
    expect(replica.getState().timeline.entries[0]?.item).toMatchObject({ text: 'AB' });
    const subscribe = transport.sent.at(-1);
    transport.emit({
      protocolVersion: '1.4.0', type: 'timeline_subscribed',
      payload: { requestId: subscribe?.payload.requestId as string, agentIds: ['agent-one'] },
    });

    expect(transport.timelineRequests.at(-1)).toEqual({
      direction: 'after', cursor: { epoch: 'epoch-one', seq: 2 },
    });
  });

  it('follows every after page before declaring reconnect catch-up ready', async () => {
    const transport = new FakeTransport();
    const replica = new AgentReplica();
    const client = new RemoteSessionClient('agent-one', transport, replica, {
      historyPageSize: 1,
      scheduleReconnect: scheduleReconnectImmediately,
    });
    const statuses: string[] = [];
    client.subscribeStatus((status) => statuses.push(status));
    client.start();
    transport.open();
    transport.emit({ protocolVersion: '1.4.0', type: 'negotiated' });
    transport.emit(snapshot());
    transport.emit({
      protocolVersion: '1.4.0', type: 'timeline_subscribed',
      payload: { requestId: transport.sent.at(-1)?.payload.requestId as string, agentIds: ['agent-one'] },
    });
    transport.resolveTimeline(page('tail', [entry(1, 1, 'A')]));
    await transport.settle();

    transport.disconnect();
    await transport.settle();
    transport.open();
    transport.emit({ protocolVersion: '1.4.0', type: 'negotiated' });
    transport.emit(snapshot());
    transport.emit({
      protocolVersion: '1.4.0', type: 'timeline_subscribed',
      payload: { requestId: transport.sent.at(-1)?.payload.requestId as string, agentIds: ['agent-one'] },
    });
    expect(transport.timelineRequests.at(-1)).toEqual({
      direction: 'after', cursor: { epoch: 'epoch-one', seq: 1 },
    });

    transport.resolveTimeline(page('after', [entry(2, 2, 'B')], {
      window: { minSeq: 1, maxSeq: 3, nextSeq: 4 },
      hasNewer: true,
    }));
    await transport.settle();

    expect(transport.timelineRequests.at(-1)).toEqual({
      direction: 'after', cursor: { epoch: 'epoch-one', seq: 2 },
    });
    expect(statuses.at(-1)).toBe('catching_up');

    transport.resolveTimeline(page('after', [entry(3, 3, 'C')], {
      window: { minSeq: 1, maxSeq: 3, nextSeq: 4 },
    }));
    await transport.settle();

    expect(replica.getState().timeline.entries.map(({ seqStart, seqEnd }) => [seqStart, seqEnd])).toEqual([
      [1, 1], [2, 2], [3, 3],
    ]);
    expect(replica.getState().timeline.nextSeq).toBe(4);
    expect(statuses.at(-1)).toBe('ready');
  });

  it.each([
    ['missing', null],
    ['unchanged', { epoch: 'epoch-one', seq: 1 }],
    ['backward', { epoch: 'epoch-one', seq: 0 }],
    ['wrong-epoch', { epoch: 'epoch-two', seq: 2 }],
  ] as const)('rejects a %s after-page cursor instead of looping', async (_case, endCursor) => {
    const transport = new FakeTransport();
    const replica = new AgentReplica();
    const client = new RemoteSessionClient('agent-one', transport, replica, {
      historyPageSize: 1,
      scheduleReconnect: scheduleReconnectImmediately,
    });
    client.start();
    transport.open();
    transport.emit({ protocolVersion: '1.4.0', type: 'negotiated' });
    transport.emit(snapshot());
    transport.emit({
      protocolVersion: '1.4.0', type: 'timeline_subscribed',
      payload: { requestId: transport.sent.at(-1)?.payload.requestId as string, agentIds: ['agent-one'] },
    });
    transport.resolveTimeline(page('tail', [entry(1, 1, 'A')]));
    await transport.settle();

    transport.emit(live(3, 'C'));
    transport.resolveTimeline(page('after', [entry(2, 2, 'B')], {
      window: { minSeq: 1, maxSeq: 3, nextSeq: 4 },
      endCursor,
      hasNewer: true,
    }));
    await transport.settle();

    expect(replica.getState().diagnostics.at(-1)).toEqual({
      code: 'timeline_recovery_failed', message: 'Timeline recovery failed.', recoverable: true,
    });
    expect(transport.connections).toBe(2);
    expect(transport.timelineRequests).toHaveLength(2);
  });

  it('reconnects when a later after page fails', async () => {
    const transport = new FakeTransport();
    const replica = new AgentReplica();
    const client = new RemoteSessionClient('agent-one', transport, replica, {
      historyPageSize: 1,
      scheduleReconnect: scheduleReconnectImmediately,
    });
    client.start();
    transport.open();
    transport.emit({ protocolVersion: '1.4.0', type: 'negotiated' });
    transport.emit(snapshot());
    transport.emit({
      protocolVersion: '1.4.0', type: 'timeline_subscribed',
      payload: { requestId: transport.sent.at(-1)?.payload.requestId as string, agentIds: ['agent-one'] },
    });
    transport.resolveTimeline(page('tail', [entry(1, 1, 'A')]));
    await transport.settle();

    transport.emit(live(3, 'C'));
    transport.resolveTimeline(page('after', [entry(2, 2, 'B')], {
      window: { minSeq: 1, maxSeq: 3, nextSeq: 4 },
      hasNewer: true,
    }));
    await transport.settle();
    expect(transport.timelineRequests.at(-1)).toEqual({
      direction: 'after', cursor: { epoch: 'epoch-one', seq: 2 },
    });

    transport.rejectTimeline(new Error('later Timeline failure'));
    await transport.settle();

    expect(replica.getState().diagnostics.at(-1)?.code).toBe('timeline_recovery_failed');
    expect(transport.connections).toBe(2);
  });

  it('ignores a later after page when stop supersedes the catch-up chain', async () => {
    const transport = new FakeTransport();
    const replica = new AgentReplica();
    const client = new RemoteSessionClient('agent-one', transport, replica, {
      historyPageSize: 1,
      scheduleReconnect: scheduleReconnectImmediately,
    });
    const statuses: string[] = [];
    client.subscribeStatus((status) => statuses.push(status));
    client.start();
    transport.open();
    transport.emit({ protocolVersion: '1.4.0', type: 'negotiated' });
    transport.emit(snapshot());
    transport.emit({
      protocolVersion: '1.4.0', type: 'timeline_subscribed',
      payload: { requestId: transport.sent.at(-1)?.payload.requestId as string, agentIds: ['agent-one'] },
    });
    transport.resolveTimeline(page('tail', [entry(1, 1, 'A')]));
    await transport.settle();

    transport.disconnect();
    await transport.settle();
    transport.open();
    transport.emit({ protocolVersion: '1.4.0', type: 'negotiated' });
    transport.emit(snapshot());
    transport.emit({
      protocolVersion: '1.4.0', type: 'timeline_subscribed',
      payload: { requestId: transport.sent.at(-1)?.payload.requestId as string, agentIds: ['agent-one'] },
    });
    transport.resolveTimeline(page('after', [entry(2, 2, 'B')], {
      window: { minSeq: 1, maxSeq: 3, nextSeq: 4 },
      hasNewer: true,
    }));
    await transport.settle();
    expect(transport.timelineRequests.at(-1)?.cursor).toEqual({ epoch: 'epoch-one', seq: 2 });

    client.stop();
    transport.resolveTimeline(page('after', [entry(3, 3, 'C')], {
      window: { minSeq: 1, maxSeq: 3, nextSeq: 4 },
    }));
    await transport.settle();

    expect(replica.getState().timeline.entries.map(({ seqStart }) => seqStart)).toEqual([1, 2]);
    expect(replica.getState().diagnostics).toEqual([]);
    expect(transport.connections).toBe(2);
    expect(statuses.at(-1)).toBe('idle');
  });

  it('supersedes a multi-page after fetch when the relay replaces the Timeline epoch', async () => {
    const transport = new FakeTransport();
    const replica = new AgentReplica();
    const client = new RemoteSessionClient('agent-one', transport, replica, {
      historyPageSize: 1,
      scheduleReconnect: scheduleReconnectImmediately,
    });
    client.start();
    transport.open();
    transport.emit({ protocolVersion: '1.4.0', type: 'negotiated' });
    transport.emit(snapshot());
    transport.emit({
      protocolVersion: '1.4.0', type: 'timeline_subscribed',
      payload: { requestId: transport.sent[1]?.payload.requestId as string, agentIds: ['agent-one'] },
    });
    transport.resolveTimeline(page('tail', [entry(1, 1, 'A')]));
    await transport.settle();

    transport.disconnect();
    await transport.settle();
    transport.open();
    transport.emit({ protocolVersion: '1.4.0', type: 'negotiated' });
    transport.emit(snapshot());
    transport.emit({
      protocolVersion: '1.4.0', type: 'timeline_subscribed',
      payload: { requestId: transport.sent.at(-1)?.payload.requestId as string, agentIds: ['agent-one'] },
    });
    transport.resolveTimeline(page('after', [entry(2, 2, 'B')], {
      window: { minSeq: 1, maxSeq: 3, nextSeq: 4 },
      hasNewer: true,
    }));
    await transport.settle();
    expect(transport.timelineRequests.at(-1)?.cursor).toEqual({ epoch: 'epoch-one', seq: 2 });

    transport.emit({
      protocolVersion: '1.4.0', type: 'timeline_replacement',
      payload: { agentId: 'agent-one', epoch: 'epoch-two' },
    });

    expect(transport.timelineRequests.at(-1)).toEqual({ direction: 'tail', cursor: undefined });
    expect(replica.getState().timeline).toMatchObject({ epoch: 'epoch-two', entries: [] });

    transport.resolveTimeline(page('after', [entry(3, 3, 'C')], {
      window: { minSeq: 1, maxSeq: 3, nextSeq: 4 },
    }));
    await transport.settle();
    expect(replica.getState().timeline).toMatchObject({ epoch: 'epoch-two', entries: [] });
    expect(transport.connections).toBe(2);

    transport.resolveTimeline(page('tail', [], { epoch: 'epoch-two' }));
    await transport.settle();
    expect(replica.getState().timeline).toMatchObject({ epoch: 'epoch-two', initialized: true, entries: [] });
  });

  it('applies pushed resource replacement and terminal metadata without polling', async () => {
    const transport = new FakeTransport();
    const replica = new AgentReplica();
    const client = new RemoteSessionClient('agent-one', transport, replica);
    client.start();
    transport.open();
    transport.emit({ protocolVersion: '1.4.0', type: 'negotiated' });
    transport.emit(snapshot());
    transport.emit({
      protocolVersion: '1.4.0', type: 'timeline_subscribed',
      payload: { requestId: transport.sent[1]?.payload.requestId as string, agentIds: ['agent-one'] },
    });
    transport.resolveTimeline(page('tail', []));
    await transport.settle();

    const provisional = { locator: 'output.png', resourceId: 'resource-provisional', status: 'pending' as const };
    const replacement = { locator: 'output.png', resourceId: 'resource-canonical', status: 'pending' as const };
    const sentBeforePush = transport.sent.length;
    transport.emit(live(1, 'Generated output', 'epoch-one', [provisional]));
    transport.emit({
      protocolVersion: '1.4.0', type: 'timeline_resource_binding_replaced',
      payload: {
        agentId: 'agent-one', epoch: 'epoch-one', seq: 1,
        previous: provisional, replacement,
      },
    });
    transport.emit({
      protocolVersion: '1.4.0', type: 'resource_update',
      payload: {
        agentId: 'agent-one', resourceId: replacement.resourceId,
        state: { status: 'available', mediaType: 'image/png', byteLength: 42, sha256: 'canonical-digest' },
      },
    });

    expect(replica.getState().timeline.entries[0]?.resources).toEqual([{
      ...replacement, status: 'available',
    }]);
    expect(replica.getState().resources[replacement.resourceId]).toEqual({
      status: 'available', mediaType: 'image/png', byteLength: 42, sha256: 'canonical-digest',
    });
    expect(transport.sent).toHaveLength(sentBeforePush);
  });

  it('requests authorized bytes on demand and stores the correlated resource response', () => {
    const transport = new FakeTransport();
    const replica = new AgentReplica();
    const client = new RemoteSessionClient('agent-one', transport, replica, {
      requestId: () => 'resource-read',
    });
    client.start();
    transport.open();

    client.requestResource('resource-one');
    expect(transport.sent.at(-1)).toEqual({
      protocolVersion: '1.4.0', type: 'resource_request',
      payload: { requestId: 'resource-read', agentId: 'agent-one', resourceId: 'resource-one' },
    });

    transport.emit({
      protocolVersion: '1.4.0', type: 'resource_response',
      payload: {
        requestId: 'resource-read', agentId: 'agent-one', resourceId: 'resource-one',
        state: {
          status: 'available', mediaType: 'image/png', byteLength: 4,
          sha256: 'canonical-digest', contentBase64: 'AAAA',
        },
      },
    });
    expect(replica.getState().resources['resource-one']).toMatchObject({
      status: 'available', contentBase64: 'AAAA',
    });
  });

  it('resolves a command only after its matching acknowledgement', async () => {
    const transport = new FakeTransport();
    const client = connectedClient(transport, { requestId: () => 'send-one' });
    const acknowledgement = {
      protocolVersion: '1.4.0' as const,
      type: 'command_acknowledged' as const,
      payload: { requestId: 'send-one', agentId: 'agent-one', command: 'send_message' as const },
    };
    const pending = client.sendMessage('Continue.');
    let settled = false;
    void pending.then(() => { settled = true; });

    transport.emit({
      ...acknowledgement,
      payload: { ...acknowledgement.payload, requestId: 'another-command' },
    });
    await transport.settle();
    expect(settled).toBe(false);

    transport.emit(acknowledgement);
    await expect(pending).resolves.toEqual(acknowledgement);
  });

  it('rejects the matching operation when the relay reports a protocol error', async () => {
    const transport = new FakeTransport();
    const client = connectedClient(transport, { requestId: () => 'steer-one' });
    const pending = client.steer('Use the new target.');

    transport.emit({
      protocolVersion: '1.4.0',
      type: 'protocol_error',
      payload: {
        requestId: 'steer-one', code: 'unsupported_command',
        message: 'Steering is unavailable.', recoverable: true,
      },
    });

    await expect(pending).rejects.toMatchObject<Partial<RemoteOperationError>>({
      name: 'RemoteOperationError', code: 'unsupported_command',
      message: 'Steering is unavailable.', recoverable: true, requestId: 'steer-one',
    });
  });

  it('applies the interaction resolution before resolving its operation', async () => {
    const transport = new FakeTransport();
    const replica = new AgentReplica();
    const client = new RemoteSessionClient('agent-one', transport, replica);
    client.start();
    transport.open();
    transport.emit({
      protocolVersion: '1.4.0', type: 'interaction_requested',
      payload: {
        agentId: 'agent-one',
        request: { kind: 'plan_approval', requestId: 'interaction-one', plan: 'Check the evidence.', allowedActions: ['approve'] },
      },
    });
    const pending = client.respondToInteraction('interaction-one', { kind: 'plan_approval', action: 'approve' });
    const resolution = {
      protocolVersion: '1.4.0' as const,
      type: 'interaction_resolved' as const,
      payload: {
        agentId: 'agent-one', requestId: 'interaction-one',
        response: { kind: 'plan_approval' as const, action: 'approve' as const },
      },
    };

    transport.emit(resolution);

    await expect(pending).resolves.toEqual(resolution);
    expect(replica.getState().pendingInteractions).toEqual([]);
  });

  it('rejects stale interaction submissions before a delayed resolution can acknowledge them', async () => {
    const transport = new FakeTransport();
    const client = connectedClient(transport);
    const result = client.respondToInteraction('already-resolved', { kind: 'plan_approval', action: 'approve' });
    transport.emit({
      protocolVersion: '1.4.0', type: 'interaction_resolved',
      payload: { agentId: 'agent-one', requestId: 'already-resolved', response: { kind: 'plan_approval', action: 'approve' } },
    });
    await expect(result).rejects.toMatchObject({ code: 'stale_interaction', requestId: 'already-resolved' });
  });

  it('applies the resource response before resolving its operation', async () => {
    const transport = new FakeTransport();
    const replica = new AgentReplica();
    const client = new RemoteSessionClient('agent-one', transport, replica, { requestId: () => 'resource-one' });
    client.start();
    transport.open();
    const pending = client.requestResource('resource-one');
    const response = {
      protocolVersion: '1.4.0' as const,
      type: 'resource_response' as const,
      payload: {
        requestId: 'resource-one', agentId: 'agent-one', resourceId: 'resource-one',
        state: {
          status: 'available' as const, mediaType: 'image/png', byteLength: 4,
          sha256: 'canonical-digest', contentBase64: 'AAAA',
        },
      },
    };

    transport.emit(response);

    await expect(pending).resolves.toEqual(response);
    expect(replica.getState().resources['resource-one']).toMatchObject({
      status: 'available', contentBase64: 'AAAA',
    });
  });

  it('rejects an operation when its configured acknowledgement timeout elapses', async () => {
    const transport = new FakeTransport();
    const client = connectedClient(transport, {
      requestId: () => 'timeout-one', operationTimeoutMs: 1,
    });

    await expect(client.cancel()).rejects.toMatchObject<Partial<RemoteOperationError>>({
      name: 'RemoteOperationError', code: 'operation_timeout', recoverable: true, requestId: 'timeout-one',
    });
  });

  it('rejects pending operations when the client stops', async () => {
    const transport = new FakeTransport();
    const client = connectedClient(transport, { requestId: () => 'stop-one' });
    const pending = client.sendMessage('Stop this operation.');

    client.stop();

    await expect(pending).rejects.toMatchObject<Partial<RemoteOperationError>>({
      name: 'RemoteOperationError', code: 'operation_stopped', recoverable: false, requestId: 'stop-one',
    });
  });

  it('rejects pending operations when the active connection disconnects', async () => {
    const transport = new FakeTransport();
    const client = connectedClient(transport, { requestId: () => 'disconnect-one' });
    const pending = client.sendMessage('Reconnect this operation.');

    transport.disconnect();

    await expect(pending).rejects.toMatchObject<Partial<RemoteOperationError>>({
      name: 'RemoteOperationError', code: 'connection_disconnected', recoverable: true, requestId: 'disconnect-one',
    });
  });

  it('keeps operations with the same request ID isolated by their expected response', async () => {
    const transport = new FakeTransport();
    const client = connectedClient(transport, { requestId: () => 'shared-id' });
    const command = client.sendMessage('Continue.');
    transport.emit({
      protocolVersion: '1.4.0', type: 'interaction_requested',
      payload: { agentId: 'agent-one', request: { kind: 'plan_approval', requestId: 'shared-id', plan: 'Check.', allowedActions: ['approve'] } },
    });
    const interaction = client.respondToInteraction('shared-id', { kind: 'plan_approval', action: 'approve' });
    let commandSettled = false;
    void command.then(() => { commandSettled = true; }, () => undefined);

    transport.emit({
      protocolVersion: '1.4.0', type: 'interaction_resolved',
      payload: {
        agentId: 'agent-one', requestId: 'shared-id',
        response: { kind: 'plan_approval', action: 'approve' },
      },
    });
    await interaction;
    expect(commandSettled).toBe(false);

    transport.emit({
      protocolVersion: '1.4.0', type: 'protocol_error',
      payload: { requestId: 'shared-id', code: 'command_failed', message: 'Command failed.', recoverable: true },
    });
    await expect(command).rejects.toMatchObject<Partial<RemoteOperationError>>({
      code: 'command_failed', requestId: 'shared-id',
    });
  });

  it('rejects every active operation kind sharing a request ID after one protocol error', async () => {
    const transport = new FakeTransport();
    const client = connectedClient(transport, { requestId: () => 'shared-id' });
    const command = client.sendMessage('Continue.');
    transport.emit({
      protocolVersion: '1.4.0', type: 'interaction_requested',
      payload: { agentId: 'agent-one', request: { kind: 'plan_approval', requestId: 'shared-id', plan: 'Check.', allowedActions: ['approve'] } },
    });
    const interaction = client.respondToInteraction('shared-id', { kind: 'plan_approval', action: 'approve' });
    const resource = client.requestResource('resource-one');

    transport.emit({
      protocolVersion: '1.4.0', type: 'protocol_error',
      payload: { requestId: 'shared-id', code: 'command_failed', message: 'Command failed.', recoverable: true },
    });

    await expect(command).rejects.toMatchObject<Partial<RemoteOperationError>>({ code: 'command_failed' });
    await expect(interaction).rejects.toMatchObject<Partial<RemoteOperationError>>({ code: 'command_failed' });
    await expect(resource).rejects.toMatchObject<Partial<RemoteOperationError>>({ code: 'command_failed' });
  });

  it('keeps rejected operations awaitable when another caller ignores one', async () => {
    const transport = new FakeTransport();
    const requestIds = ['ignored-operation', 'kept-operation'];
    const client = connectedClient(transport, { requestId: () => requestIds.shift() ?? 'unexpected-request-id' });
    const unhandled: unknown[] = [];
    const onUnhandledRejection = (reason: unknown) => unhandled.push(reason);
    process.on('unhandledRejection', onUnhandledRejection);
    try {
      void client.cancel();
      const kept = client.steer('Keep this rejection.');
      client.stop();

      await expect(kept).rejects.toMatchObject<Partial<RemoteOperationError>>({
        code: 'operation_stopped', requestId: 'kept-operation',
      });
      await transport.settle();
      expect(unhandled).toEqual([]);
    } finally {
      process.off('unhandledRejection', onUnhandledRejection);
    }
  });
});

function connectedClient(
  transport: FakeTransport,
  options: ConstructorParameters<typeof RemoteSessionClient>[3] = {},
): RemoteSessionClient {
  const client = new RemoteSessionClient('agent-one', transport, new AgentReplica(), options);
  client.start();
  transport.open();
  return client;
}

function scheduleReconnectImmediately(
  _delayMs: number,
  reconnect: () => void,
): () => void {
  let active = true;
  queueMicrotask(() => {
    if (active) reconnect();
  });
  return () => {
    active = false;
  };
}

class FakeTransport implements RemoteAgentTransport {
  listener: RemoteTransportListener | undefined;
  sent: ClientMessage[] = [];
  timelineRequests: Array<{ direction: TimelineDirection; cursor?: TimelineCursor }> = [];
  connections = 0;
  closedConnections = 0;
  private readonly timelineRequestsPending: Array<ReturnType<typeof deferred<HistoryPage>>> = [];

  connect(_agentId: string, listener: RemoteTransportListener): RemoteConnection {
    this.connections += 1;
    this.listener = listener;
    return {
      send: (message) => this.sent.push(message),
      close: () => { this.closedConnections += 1; },
    };
  }

  fetchSnapshot(): Promise<AgentSnapshot> { return Promise.resolve(snapshot()); }

  fetchTimeline(
    _agentId: string,
    direction: TimelineDirection,
    cursor?: TimelineCursor,
  ): Promise<HistoryPage> {
    this.timelineRequests.push({ direction, cursor });
    const pending = deferred<HistoryPage>();
    this.timelineRequestsPending.push(pending);
    return pending.promise;
  }

  onDiagnostic(): () => void { return () => undefined; }
  onProtocolMessage(): () => void { return () => undefined; }
  open(): void { this.listener?.onOpen(); }
  disconnect(): void { this.listener?.onDisconnect(); }
  emit(message: ServerMessage): void { this.listener?.onMessage(message); }
  resolveTimeline(value: HistoryPage): void {
    const pending = this.timelineRequestsPending.shift();
    if (!pending) throw new Error('No pending Timeline request to resolve.');
    pending.resolve(value);
  }
  rejectTimeline(error: Error): void {
    const pending = this.timelineRequestsPending.shift();
    if (!pending) throw new Error('No pending Timeline request to reject.');
    pending.reject(error);
  }
  async settle(): Promise<void> { await new Promise((resolve) => setTimeout(resolve, 0)); }
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<T>((done, fail) => {
    resolve = done;
    reject = fail;
  });
  return { promise, resolve, reject };
}

it('loads older pages once without interrupting live readiness and retries history failures locally', async () => {
  const transport = new FakeTransport();
  const replica = new AgentReplica();
  const client = new RemoteSessionClient('agent-one', transport, replica);
  const statuses: string[] = [];
  client.subscribeStatus((status) => statuses.push(status));
  client.start(); transport.open();
  transport.emit({ protocolVersion: '1.4.0', type: 'negotiated' });
  transport.emit(snapshot());
  transport.emit({ protocolVersion: '1.4.0', type: 'timeline_subscribed', payload: { requestId: transport.sent[1]?.payload.requestId as string, agentIds: ['agent-one'] } });
  transport.resolveTimeline(page('tail', [entry(10, 10, 'Current')], { hasOlder: true }));
  await transport.settle();
  statuses.length = 0;
  const first = client.loadOlder();
  expect(client.loadOlder()).toBe(first);
  const failed = expect(first).rejects.toThrow('Offline');
  transport.rejectTimeline(new Error('Offline'));
  await failed;
  expect(statuses).toEqual([]);
  expect(transport.connections).toBe(1);
  const retried = client.loadOlder();
  transport.emit(live(11, 'Live text'));
  transport.resolveTimeline(page('before', [entry(1, 9, 'Earlier')], { window: { minSeq: 1, maxSeq: 11, nextSeq: 12 } }));
  await retried;
  expect(replica.getState().timeline.entries[0]?.seqStart).toBe(1);
  expect(replica.getState().timeline.nextSeq).toBe(12);
  expect(statuses).toEqual([]);
  client.stop();
});

it.each([{ gap: true }, { error: 'History is unavailable' }, { epoch: 'obsolete-epoch' }])('keeps the loaded conversation intact when an older page is unusable: %j', async (response) => {
  const transport = new FakeTransport();
  const replica = new AgentReplica();
  replica.applySnapshot(snapshot());
  replica.applyHistory(page('tail', [entry(10, 10, 'Keep reading')], { hasOlder: true }));
  const client = new RemoteSessionClient('agent-one', transport, replica);
  const pending = client.loadOlder();
  const failure = expect(pending).rejects.toThrow();
  transport.resolveTimeline(page('before', [entry(1, 9, 'Earlier')], response));
  await failure;
  expect(replica.getState().timeline).toMatchObject({ epoch: 'epoch-one', initialized: true, hasOlder: true });
  expect(replica.getState().timeline.entries).toEqual([entry(10, 10, 'Keep reading')]);
});
