import type { AgentManagerEvent } from './agent-manager-events.js';
import { UnsupportedAgentCapabilityError } from './agent-manager.js';
import { createSessionWire, type SessionWireAgent } from './session-wire.js';
import { describe, expect, it, vi } from 'vitest';

const OPERATION_ID = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';

describe('session wire negotiation', () => {
  it('requires explicit resolve authorization before creating a local resource binding', async () => {
    const { agent } = fakeAgent();
    const resolveResource = vi.fn(async (requestId: string, locator: string, sourceLocator?: string) => ({
      protocolVersion: '1.4.0' as const,
      type: 'resource_resolve_response' as const,
      payload: {
        requestId, agentId: 'agent-1',
        binding: { locator, resourceId: 'resource-one', status: 'available' as const },
      },
    }));
    (agent as SessionWireAgent & { resolveResource: typeof resolveResource }).resolveResource = resolveResource;
    let permitted = false;
    const actions: string[] = [];
    const output: Array<Record<string, unknown>> = [];
    const wire = createSessionWire(agent, (json) => output.push(JSON.parse(json)), {
      authorize: (action) => { actions.push(action); return permitted; },
    });
    await wire.receive(JSON.stringify({ protocolVersion: '1.4.0', type: 'negotiate' }));
    output.length = 0;
    const request = {
      protocolVersion: '1.4.0', type: 'resource_resolve_request',
      payload: { requestId: 'resolve-one', agentId: 'agent-1', locator: './result.png', sourceLocator: '/workspace/report.md' },
    };

    await wire.receive(JSON.stringify(request));
    expect(resolveResource).not.toHaveBeenCalled();
    expect(output).toEqual([expect.objectContaining({ type: 'protocol_error', payload: expect.objectContaining({ code: 'forbidden' }) })]);
    permitted = true;
    output.length = 0;
    await wire.receive(JSON.stringify(request));
    expect(resolveResource).toHaveBeenCalledWith('resolve-one', './result.png', '/workspace/report.md');
    expect(output).toEqual([expect.objectContaining({ type: 'resource_resolve_response' })]);
    expect(actions).toEqual(['resolve_resource', 'resolve_resource']);
    wire.close();
  });
  it('routes the native directory and returns native command output with the caller request ID', async () => {
    const { agent } = fakeAgent();
    const commands = [{ id: 'native:custom', name: 'custom', description: 'Native command', kind: 'command' as const }];
    agent.listCommands = async () => commands;
    agent.executeCommand = vi.fn(async () => ({ text: 'Native result' }));
    const output: Array<Record<string, unknown>> = [];
    const wire = createSessionWire(agent, (json) => output.push(JSON.parse(json)));
    await wire.receive(JSON.stringify({ protocolVersion: '1.4.0', type: 'negotiate' }));
    output.length = 0;
    await wire.receive(JSON.stringify({ protocolVersion: '1.4.0', type: 'list_commands', payload: { agentId: 'agent-1', requestId: 'list' } }));
    expect(output).toEqual([{ protocolVersion: '1.4.0', type: 'command_list', payload: { agentId: 'agent-1', requestId: 'list', commands } }]);
    output.length = 0;
    await wire.receive(JSON.stringify({ protocolVersion: '1.4.0', type: 'execute_command', payload: { agentId: 'agent-1', requestId: 'run', operationId: OPERATION_ID, commandId: 'native:custom', args: ' a  b\n' } }));
    expect(agent.executeCommand).toHaveBeenCalledWith('native:custom', ' a  b\n');
    expect(output).toEqual([{ protocolVersion: '1.4.0', type: 'command_result', payload: { agentId: 'agent-1', requestId: 'run', result: { text: 'Native result' } } }]);
    wire.close();
  });
  it('acknowledges the exact planning command after provider completion', async () => {
    const { agent } = fakeAgent();
    let finish!: () => void;
    const selected: boolean[] = [];
    agent.setPlanning = async (active) => { selected.push(active); await new Promise<void>((resolve) => { finish = resolve; }); };
    const output: Array<Record<string, unknown>> = [];
    const wire = createSessionWire(agent, (json) => output.push(JSON.parse(json) as Record<string, unknown>));
    await wire.receive(JSON.stringify({ protocolVersion: '1.4.0', type: 'negotiate' }));
    output.length = 0;
    const submitted = wire.receive(JSON.stringify({ protocolVersion: '1.4.0', type: 'set_planning', payload: { requestId: 'planning-1', operationId: OPERATION_ID, agentId: 'agent-1', active: true } }));
    await Promise.resolve();
    expect(selected).toEqual([true]);
    expect(output).toEqual([]);
    finish();
    await submitted;
    expect(output).toEqual([{ protocolVersion: '1.4.0', type: 'command_acknowledged', payload: { requestId: 'planning-1', agentId: 'agent-1', command: 'set_planning' } }]);
    wire.close();
  });

  it('rewraps a retained business result with each transport request identity', async () => {
    const { agent } = fakeAgent();
    agent.executeCommand = vi.fn(async () => ({ text: 'retained' }));
    const retained = new Map<string, unknown>();
    const output: Array<Record<string, unknown>> = [];
    const wire = createSessionWire(agent, (json) => output.push(JSON.parse(json)), {
      executeOperation: async (_agent, operation, work) => {
        if (retained.has(operation.operationId)) return retained.get(operation.operationId) as never;
        const result = await work.dispatch();
        retained.set(operation.operationId, result);
        return result;
      },
    });
    await wire.receive(JSON.stringify({ protocolVersion: '1.4.0', type: 'negotiate' }));
    output.length = 0;

    for (const requestId of ['first-request', 'retry-request']) {
      await wire.receive(JSON.stringify({ protocolVersion: '1.4.0', type: 'execute_command', payload: {
        requestId, operationId: OPERATION_ID, agentId: 'agent-1', commandId: 'review', args: '--short',
      } }));
    }

    expect(agent.executeCommand).toHaveBeenCalledOnce();
    expect(output.map((message) => message.payload)).toEqual([
      { requestId: 'first-request', agentId: 'agent-1', result: { text: 'retained' } },
      { requestId: 'retry-request', agentId: 'agent-1', result: { text: 'retained' } },
    ]);
  });

  it('acknowledges an interaction submission independently of the runtime resolved event', async () => {
    const { agent } = fakeAgent();
    const validateInteractionResponse = vi.fn();
    agent.validateInteractionResponse = validateInteractionResponse;
    agent.respondToInteraction = vi.fn(async () => undefined);
    const output: Array<Record<string, unknown>> = [];
    const wire = createSessionWire(agent, (json) => output.push(JSON.parse(json)));
    await wire.receive(JSON.stringify({ protocolVersion: '1.4.0', type: 'negotiate' }));
    output.length = 0;

    await wire.receive(JSON.stringify({ protocolVersion: '1.4.0', type: 'interaction_response', payload: {
      agentId: 'agent-1', requestId: 'native-approval', submissionId: 'submission-one', operationId: OPERATION_ID,
      response: { kind: 'plan_approval', action: 'approve' },
    } }));

    expect(validateInteractionResponse).toHaveBeenCalledOnce();
    expect(output).toEqual([{ protocolVersion: '1.4.0', type: 'command_acknowledged', payload: {
      requestId: 'submission-one', agentId: 'agent-1', command: 'interaction_response',
    } }]);
  });

  it('does not resolve or subscribe to the Agent until exact negotiation succeeds', async () => {
    const { agent, emit } = fakeAgent();
    const subscribe = vi.spyOn(agent, 'subscribe');
    const resolveAgent = vi.fn(() => agent);
    const output: Array<Record<string, unknown>> = [];
    const wire = createSessionWire(resolveAgent, (json) => output.push(JSON.parse(json) as Record<string, unknown>));

    for (let index = 0; index < 10_000; index += 1) {
      emit({ type: 'agent_state', agentId: 'agent-1', snapshot: agent.snapshot() });
    }
    await wire.receive(JSON.stringify({ protocolVersion: '1.0.1', type: 'negotiate' }));

    expect(resolveAgent).not.toHaveBeenCalled();
    expect(subscribe).not.toHaveBeenCalled();
    expect(output.map(({ type }) => type)).toEqual(['protocol_error']);

    output.length = 0;
    await wire.receive(JSON.stringify({ protocolVersion: '1.4.0', type: 'negotiate' }));

    expect(resolveAgent).toHaveBeenCalledOnce();
    expect(subscribe).toHaveBeenCalledOnce();
    expect(output.map(({ type }) => type)).toEqual(['negotiated', 'agent_snapshot']);
  });

  it('does not unsubscribe when the session closes before negotiation', () => {
    const { agent } = fakeAgent();
    const unsubscribe = vi.fn();
    const subscribe = vi.spyOn(agent, 'subscribe').mockReturnValue(unsubscribe);
    const wire = createSessionWire(() => agent, () => undefined);

    wire.close();

    expect(subscribe).not.toHaveBeenCalled();
    expect(unsubscribe).not.toHaveBeenCalled();
  });

  it('fails the session when the Snapshot handoff buffer reaches its bound', async () => {
    const { agent, emit } = fakeAgent();
    const failures: unknown[] = [];
    const output: Array<Record<string, unknown>> = [];
    const wire = createSessionWire(() => agent, (json) => {
      const message = JSON.parse(json) as Record<string, unknown>;
      output.push(message);
      if (message.type !== 'negotiated') return;
      for (let index = 0; index < 3; index += 1) {
        emit({ type: 'agent_state', agentId: 'agent-1', snapshot: agent.snapshot() });
      }
    }, {
      maxBufferedManagerEvents: 2,
      onFailure: (error) => failures.push(error),
    });

    await wire.receive(JSON.stringify({ protocolVersion: '1.4.0', type: 'negotiate' }));

    expect(failures).toEqual([{
      kind: 'manager_event_buffer_overflow',
      error: expect.objectContaining({ message: 'Agent manager event buffer overflowed.' }),
    }]);
    expect(output.map(({ type }) => type)).toEqual(['negotiated']);
  });

  it('fails the session when live Timeline delivery outruns subscription acknowledgement', async () => {
    const { agent, emit } = fakeAgent();
    const failures: unknown[] = [];
    const output: Array<Record<string, unknown>> = [];
    const wire = createSessionWire(() => agent, (json) => {
      const message = JSON.parse(json) as Record<string, unknown>;
      output.push(message);
      if (message.type !== 'timeline_subscribed') return;
      for (let sequence = 1; sequence <= 3; sequence += 1) emit(timelineManagerEvent(sequence, `live-${sequence}`));
    }, {
      maxBufferedManagerEvents: 2,
      onFailure: (error) => failures.push(error),
    });
    await wire.receive(JSON.stringify({ protocolVersion: '1.4.0', type: 'negotiate' }));
    output.length = 0;

    await wire.receive(JSON.stringify({
      protocolVersion: '1.4.0', type: 'timeline_subscription',
      payload: { requestId: 'subscribe-overflow', agentIds: ['agent-1'] },
    }));

    expect(failures).toEqual([{
      kind: 'manager_event_buffer_overflow',
      error: expect.objectContaining({ message: 'Agent manager event buffer overflowed.' }),
    }]);
    expect(output.map(({ type }) => type)).toEqual(['timeline_subscribed']);
  });

  it('rejects a non-exact protocol version before sending Agent state', async () => {
    const { agent } = fakeAgent();
    const output: unknown[] = [];
    const wire = createSessionWire(agent, (json) => output.push(JSON.parse(json)));

    await wire.receive(JSON.stringify({ protocolVersion: '1.0.1', type: 'negotiate' }));

    expect(output).toEqual([
      expect.objectContaining({
        protocolVersion: '1.4.0', type: 'protocol_error',
        payload: expect.objectContaining({ code: 'incompatible_protocol_version', recoverable: false }),
      }),
    ]);
  });

  it('sends negotiation acknowledgement before the independent Snapshot baseline', async () => {
    const { agent } = fakeAgent();
    const output: unknown[] = [];
    const wire = createSessionWire(agent, (json) => output.push(JSON.parse(json)));

    await wire.receive(JSON.stringify({ protocolVersion: '1.4.0', type: 'negotiate' }));

    expect(output.map((message) => (message as { type: string }).type)).toEqual(['negotiated', 'agent_snapshot']);
    expect(output[1]).toMatchObject({ payload: { id: 'agent-1', pendingInteractions: [] } });
  });
});

describe('session wire Timeline and manager-event projection', () => {
  it('fails closed when a manager event cannot be encoded', async () => {
    const { agent, emit } = fakeAgent();
    const failures: unknown[] = [];
    const output: Array<Record<string, unknown>> = [];
    const wire = createSessionWire(agent, (json) => output.push(JSON.parse(json) as Record<string, unknown>), {
      onFailure: (error) => failures.push(error),
    });
    await wire.receive(JSON.stringify({ protocolVersion: '1.4.0', type: 'negotiate' }));
    output.length = 0;

    emit({
      type: 'interaction_requested', agentId: 'agent-1',
      request: { kind: 'question', requestId: 'question-1' },
    } as AgentManagerEvent);
    emit({ type: 'agent_state', agentId: 'agent-1', snapshot: agent.snapshot() });
    await wire.receive(JSON.stringify({
      protocolVersion: '1.4.0', type: 'send_message',
      payload: { requestId: 'message-after-failure', operationId: OPERATION_ID, agentId: 'agent-1', text: 'Continue.' },
    }));

    expect(failures).toEqual([{
      kind: 'manager_event_delivery',
      error: expect.objectContaining({ message: expect.stringContaining('Relay produced an invalid server message') }),
    }]);
    expect(output).toEqual([]);
  });

  it('pushes resource terminal state after negotiation without requiring a Timeline subscription', async () => {
    const { agent, emit } = fakeAgent();
    const output: Array<Record<string, unknown>> = [];
    const wire = createSessionWire(agent, (json) => output.push(JSON.parse(json) as Record<string, unknown>));
    await wire.receive(JSON.stringify({ protocolVersion: '1.4.0', type: 'negotiate' }));
    output.length = 0;

    emit({
      type: 'resource_update',
      agentId: 'agent-1',
      resourceId: 'resource-1',
      state: { status: 'unavailable', reason: 'The generated file expired.' },
    });

    expect(output).toEqual([{
      protocolVersion: '1.4.0',
      type: 'resource_update',
      payload: {
        agentId: 'agent-1',
        resourceId: 'resource-1',
        state: { status: 'unavailable', reason: 'The generated file expired.' },
      },
    }]);
    wire.close();
  });

  it('projects a row-scoped resource binding replacement only to Timeline subscribers', async () => {
    const { agent, emit } = fakeAgent();
    const output: Array<Record<string, unknown>> = [];
    const wire = createSessionWire(agent, (json) => output.push(JSON.parse(json) as Record<string, unknown>));
    await wire.receive(JSON.stringify({ protocolVersion: '1.4.0', type: 'negotiate' }));
    output.length = 0;
    const replacement: AgentManagerEvent = {
      type: 'timeline_resource_binding_replaced',
      agentId: 'agent-1',
      epoch: 'epoch-1',
      seq: 2,
      previous: { locator: 'output.png', resourceId: 'resource-2', status: 'pending' },
      replacement: { locator: 'output.png', resourceId: 'resource-1', status: 'available' },
    };

    emit(replacement);
    expect(output).toEqual([]);

    await wire.receive(JSON.stringify({
      protocolVersion: '1.4.0', type: 'timeline_subscription',
      payload: { requestId: 'subscribe-resource-replacement', agentIds: ['agent-1'] },
    }));
    output.length = 0;
    emit(replacement);

    expect(output).toEqual([{
      protocolVersion: '1.4.0',
      type: 'timeline_resource_binding_replaced',
      payload: {
        agentId: 'agent-1',
        epoch: 'epoch-1',
        seq: 2,
        previous: { locator: 'output.png', resourceId: 'resource-2', status: 'pending' },
        replacement: { locator: 'output.png', resourceId: 'resource-1', status: 'available' },
      },
    }]);
    wire.close();
  });

  it('acknowledges selective subscription before emitting public live and catch-up messages', async () => {
    const { agent, emit } = fakeAgent();
    const output: Array<Record<string, unknown>> = [];
    const wire = createSessionWire(agent, (json) => output.push(JSON.parse(json) as Record<string, unknown>));
    await wire.receive(JSON.stringify({ protocolVersion: '1.4.0', type: 'negotiate' }));
    output.length = 0;

    emit(timelineManagerEvent(1, 'before subscription'));
    expect(output).toEqual([]);

    await wire.receive(JSON.stringify({
      protocolVersion: '1.4.0', type: 'timeline_subscription',
      payload: { requestId: 'subscribe-1', agentIds: ['agent-1'] },
    }));
    emit(timelineManagerEvent(2, 'live after acknowledgement'));
    await wire.receive(JSON.stringify({
      protocolVersion: '1.4.0', type: 'timeline_request',
      payload: { requestId: 'tail-1', agentId: 'agent-1', direction: 'tail', limit: 10 },
    }));

    expect(output.map(({ type }) => type)).toEqual(['timeline_subscribed', 'agent_stream', 'timeline_page']);
    expect(output[1]).toEqual({
      protocolVersion: '1.4.0', type: 'agent_stream',
      payload: {
        agentId: 'agent-1', epoch: 'epoch-1', seq: 2, timestamp: '2026-09-02T00:00:02.000Z',
        event: {
          type: 'timeline', providerId: 'codex', turnId: 'turn-1',
          item: { type: 'assistant_message', messageId: 'message-1', text: 'live after acknowledgement' },
          resources: [{ locator: 'output.png', resourceId: 'resource-2', status: 'available' }],
        },
      },
    });
    expect(JSON.stringify(output[1])).not.toContain('source-key-private');
  });

  it('acknowledges an accepted session command with its request correlation', async () => {
    const { agent } = fakeAgent();
    const output: Array<Record<string, unknown>> = [];
    const wire = createSessionWire(agent, (json) => output.push(JSON.parse(json) as Record<string, unknown>));
    await wire.receive(JSON.stringify({ protocolVersion: '1.4.0', type: 'negotiate' }));
    output.length = 0;

    await wire.receive(JSON.stringify({
      protocolVersion: '1.4.0', type: 'send_message',
      payload: { requestId: 'message-1', operationId: OPERATION_ID, agentId: 'agent-1', text: 'Continue.' },
    }));

    expect(output).toEqual([{
      protocolVersion: '1.4.0', type: 'command_acknowledged',
      payload: { requestId: 'message-1', agentId: 'agent-1', command: 'send_message' },
    }]);
  });

  it.each([undefined, 'immediate', 'next_turn'] as const)('forwards %s delivery without changing native arguments or acknowledgement', async (delivery) => {
    const { agent } = fakeAgent();
    const calls: unknown[][] = [];
    agent.sendMessage = async (...args) => { calls.push(args); };
    const output: Array<Record<string, unknown>> = [];
    const wire = createSessionWire(agent, (json) => output.push(JSON.parse(json) as Record<string, unknown>));
    try {
      await wire.receive(JSON.stringify({ protocolVersion: '1.4.0', type: 'negotiate' }));
      output.length = 0;
      const text = '  Keep this\nexact text  ';
      await wire.receive(JSON.stringify({ protocolVersion: '1.4.0', type: 'send_message', payload: {
        requestId: 'message-delivery', operationId: OPERATION_ID, agentId: 'agent-1', text, ...(delivery === undefined ? {} : { delivery }),
      } }));
      expect(calls).toEqual([delivery === undefined ? [text] : [text, { delivery }]]);
      expect(output).toEqual([{ protocolVersion: '1.4.0', type: 'command_acknowledged', payload: { requestId: 'message-delivery', agentId: 'agent-1', command: 'send_message' } }]);
    } finally { wire.close(); }
  });

  it('reports unsupported manager capabilities as a recoverable command error', async () => {
    const { agent } = fakeAgent();
    agent.sendMessage = async () => {
      throw new UnsupportedAgentCapabilityError('send_message');
    };
    const output: Array<Record<string, unknown>> = [];
    const wire = createSessionWire(agent, (json) => output.push(JSON.parse(json) as Record<string, unknown>));
    await wire.receive(JSON.stringify({ protocolVersion: '1.4.0', type: 'negotiate' }));
    output.length = 0;

    await wire.receive(JSON.stringify({
      protocolVersion: '1.4.0', type: 'send_message',
      payload: { requestId: 'message-unsupported', operationId: OPERATION_ID, agentId: 'agent-1', text: 'Continue.' },
    }));

    expect(output).toEqual([{
      protocolVersion: '1.4.0', type: 'protocol_error',
      payload: {
        requestId: 'message-unsupported', code: 'unsupported_command',
        message: 'send_message is not supported by this Agent.', recoverable: true,
      },
    }]);
  });

  it('maps state and interactions to dedicated public messages without exposing internal manager events', async () => {
    const { agent, emit } = fakeAgent();
    const output: Array<Record<string, unknown>> = [];
    const wire = createSessionWire(agent, (json) => output.push(JSON.parse(json) as Record<string, unknown>));
    await wire.receive(JSON.stringify({ protocolVersion: '1.4.0', type: 'negotiate' }));
    output.length = 0;

    const request = {
      kind: 'plan_approval' as const, requestId: 'plan-1', plan: '## Plan',
      allowedActions: ['approve' as const, 'reject' as const],
    };
    const reconnecting = agent.snapshot();
    reconnecting.payload.runtimeInfo.connection = {
      state: 'reconnecting', reason: 'transport_closed', attempt: 2, nextRetryAt: 1_797_530_400_000,
    };
    emit({ type: 'agent_state', agentId: 'agent-1', snapshot: reconnecting });
    emit({
      type: 'agent_stream', agentId: 'agent-1', timestamp: '2026-09-02T00:00:03.000Z',
      event: { type: 'interaction_requested', provider: 'codex', request },
    });
    emit({ type: 'interaction_requested', agentId: 'agent-1', request });
    emit({
      type: 'interaction_resolved', agentId: 'agent-1', requestId: 'plan-1',
      response: { kind: 'plan_approval', action: 'approve' },
    });
    emit({
      type: 'interaction_invalidated', agentId: 'agent-1', requestId: 'plan-2',
      reason: 'connection_replaced', turnId: 'turn-1',
    });

    expect(output.map(({ type }) => type)).toEqual([
      'agent_update', 'interaction_requested', 'interaction_resolved', 'interaction_invalidated',
    ]);
    expect(output[0]).toMatchObject({ payload: { runtimeInfo: { connection: { state: 'reconnecting', attempt: 2 } } } });
    expect(output.at(-1)).toEqual({
      protocolVersion: '1.4.0', type: 'interaction_invalidated',
      payload: { agentId: 'agent-1', requestId: 'plan-2', reason: 'connection_replaced', turnId: 'turn-1' },
    });
    expect(output.every((message) => !('snapshot' in message) && !('event' in message))).toBe(true);
  });
});

function fakeAgent(): { agent: SessionWireAgent; emit: (event: AgentManagerEvent) => void } {
  let listener: ((event: AgentManagerEvent) => void) | undefined;
  const snapshot = {
    protocolVersion: '1.4.0' as const,
    type: 'agent_snapshot' as const,
    payload: {
      id: 'agent-1', providerId: 'codex', createdAt: '2026-09-02T00:00:00.000Z',
      updatedAt: '2026-09-02T00:00:00.000Z', status: 'idle' as const, activeTurn: null,
      capabilities: {
        history: true, sendMessage: true, steer: false, cancel: false, readResource: false,
        interactions: { question: true, planApproval: true, toolApproval: true },
      },
      pendingInteractions: [],
      runtimeInfo: { providerId: 'codex', sessionId: 'session-1', status: 'idle' as const },
    },
  };
  return {
    agent: {
      agentId: 'agent-1',
      snapshot: () => structuredClone(snapshot),
      subscribe(next) { listener = next; return () => { listener = undefined; }; },
      fetchTimeline(request) {
        return {
          protocolVersion: '1.4.0', type: 'timeline_page',
          payload: {
            requestId: request.requestId, agentId: 'agent-1', direction: request.direction,
            epoch: 'epoch-1', reset: false, staleCursor: false, gap: false,
            window: { minSeq: 0, maxSeq: 0, nextSeq: 1 },
            startCursor: null, endCursor: null, hasOlder: false, hasNewer: false, entries: [], error: null,
          },
        };
      },
      async sendMessage() {},
      async respondToInteraction() {},
    },
    emit: (event) => listener?.(event),
  };
}

function timelineManagerEvent(seq: number, text: string): AgentManagerEvent {
  return {
    type: 'agent_stream', agentId: 'agent-1', timestamp: `2026-09-02T00:00:0${seq}.000Z`,
    event: {
      type: 'timeline', provider: 'codex', turnId: 'turn-1',
      item: { type: 'assistant_message', messageId: 'message-1', text },
    },
    row: {
      epoch: 'epoch-1', seq, providerId: 'codex', sourceKey: 'source-key-private',
      occurredAt: 1_725_000_000_000 + seq,
      timestamp: `2026-09-02T00:00:0${seq}.000Z`, turnId: 'turn-1',
      item: { type: 'assistant_message', messageId: 'message-1', text },
      resources: [{ locator: 'output.png', resourceId: `resource-${seq}`, status: 'available' }],
    },
  };
}


it('captures the content cursor with the activity change, without sending content or moving unchanged targets', async () => {
  const { agent, emit } = fakeAgent();
  Object.assign(agent, { timelineCursor: () => ({ epoch: 'epoch-1', seq: 3 }) });
  const output: any[] = [];
  const wire = createSessionWire(agent, json => output.push(JSON.parse(json)));
  await wire.receive(JSON.stringify({ protocolVersion: '1.4.0', type: 'negotiate', observation: 'activity' }));
  expect(output.at(-1)).toMatchObject({ type: 'agent_activity', payload: { status: 'idle', cursor: { epoch: 'epoch-1', seq: 3 } } });
  const snapshot = agent.snapshot(); snapshot.payload.status = 'waiting';
  emit({ type: 'agent_state', agentId: agent.agentId, snapshot, cursor: { epoch: 'epoch-1', seq: 7 } } as AgentManagerEvent);
  expect(output.at(-1).payload).toEqual({ agentId: agent.agentId, status: 'waiting', cursor: { epoch: 'epoch-1', seq: 7 } });
  const count = output.length;
  emit({ type: 'agent_state', agentId: agent.agentId, snapshot, cursor: { epoch: 'epoch-1', seq: 8 } } as AgentManagerEvent);
  expect(output).toHaveLength(count);
  wire.close();
});
