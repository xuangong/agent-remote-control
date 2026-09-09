import type { AgentManagerEvent } from './agent-manager-events.js';
import { UnsupportedAgentCapabilityError } from './agent-manager.js';
import { createSessionWire, type SessionWireAgent } from './session-wire.js';
import { describe, expect, it, vi } from 'vitest';

describe('session wire negotiation', () => {
  it('acknowledges the exact planning command after provider completion', async () => {
    const { agent } = fakeAgent();
    let finish!: () => void;
    const selected: boolean[] = [];
    agent.setPlanning = async (active) => { selected.push(active); await new Promise<void>((resolve) => { finish = resolve; }); };
    const output: Array<Record<string, unknown>> = [];
    const wire = createSessionWire(agent, (json) => output.push(JSON.parse(json) as Record<string, unknown>));
    await wire.receive(JSON.stringify({ protocolVersion: '1.2.0', type: 'negotiate' }));
    output.length = 0;
    const submitted = wire.receive(JSON.stringify({ protocolVersion: '1.2.0', type: 'set_planning', payload: { requestId: 'planning-1', agentId: 'agent-1', active: true } }));
    await Promise.resolve();
    expect(selected).toEqual([true]);
    expect(output).toEqual([]);
    finish();
    await submitted;
    expect(output).toEqual([{ protocolVersion: '1.2.0', type: 'command_acknowledged', payload: { requestId: 'planning-1', agentId: 'agent-1', command: 'set_planning' } }]);
    wire.close();
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
    await wire.receive(JSON.stringify({ protocolVersion: '1.2.0', type: 'negotiate' }));

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

    await wire.receive(JSON.stringify({ protocolVersion: '1.2.0', type: 'negotiate' }));

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
    await wire.receive(JSON.stringify({ protocolVersion: '1.2.0', type: 'negotiate' }));
    output.length = 0;

    await wire.receive(JSON.stringify({
      protocolVersion: '1.2.0', type: 'timeline_subscription',
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
        protocolVersion: '1.2.0', type: 'protocol_error',
        payload: expect.objectContaining({ code: 'incompatible_protocol_version', recoverable: false }),
      }),
    ]);
  });

  it('sends negotiation acknowledgement before the independent Snapshot baseline', async () => {
    const { agent } = fakeAgent();
    const output: unknown[] = [];
    const wire = createSessionWire(agent, (json) => output.push(JSON.parse(json)));

    await wire.receive(JSON.stringify({ protocolVersion: '1.2.0', type: 'negotiate' }));

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
    await wire.receive(JSON.stringify({ protocolVersion: '1.2.0', type: 'negotiate' }));
    output.length = 0;

    emit({
      type: 'interaction_requested', agentId: 'agent-1',
      request: { kind: 'question', requestId: 'question-1' },
    } as AgentManagerEvent);
    emit({ type: 'agent_state', agentId: 'agent-1', snapshot: agent.snapshot() });
    await wire.receive(JSON.stringify({
      protocolVersion: '1.2.0', type: 'send_message',
      payload: { requestId: 'message-after-failure', agentId: 'agent-1', text: 'Continue.' },
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
    await wire.receive(JSON.stringify({ protocolVersion: '1.2.0', type: 'negotiate' }));
    output.length = 0;

    emit({
      type: 'resource_update',
      agentId: 'agent-1',
      resourceId: 'resource-1',
      state: { status: 'unavailable', reason: 'The generated file expired.' },
    });

    expect(output).toEqual([{
      protocolVersion: '1.2.0',
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
    await wire.receive(JSON.stringify({ protocolVersion: '1.2.0', type: 'negotiate' }));
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
      protocolVersion: '1.2.0', type: 'timeline_subscription',
      payload: { requestId: 'subscribe-resource-replacement', agentIds: ['agent-1'] },
    }));
    output.length = 0;
    emit(replacement);

    expect(output).toEqual([{
      protocolVersion: '1.2.0',
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
    await wire.receive(JSON.stringify({ protocolVersion: '1.2.0', type: 'negotiate' }));
    output.length = 0;

    emit(timelineManagerEvent(1, 'before subscription'));
    expect(output).toEqual([]);

    await wire.receive(JSON.stringify({
      protocolVersion: '1.2.0', type: 'timeline_subscription',
      payload: { requestId: 'subscribe-1', agentIds: ['agent-1'] },
    }));
    emit(timelineManagerEvent(2, 'live after acknowledgement'));
    await wire.receive(JSON.stringify({
      protocolVersion: '1.2.0', type: 'timeline_request',
      payload: { requestId: 'tail-1', agentId: 'agent-1', direction: 'tail', limit: 10 },
    }));

    expect(output.map(({ type }) => type)).toEqual(['timeline_subscribed', 'agent_stream', 'timeline_page']);
    expect(output[1]).toEqual({
      protocolVersion: '1.2.0', type: 'agent_stream',
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
    await wire.receive(JSON.stringify({ protocolVersion: '1.2.0', type: 'negotiate' }));
    output.length = 0;

    await wire.receive(JSON.stringify({
      protocolVersion: '1.2.0', type: 'send_message',
      payload: { requestId: 'message-1', agentId: 'agent-1', text: 'Continue.' },
    }));

    expect(output).toEqual([{
      protocolVersion: '1.2.0', type: 'command_acknowledged',
      payload: { requestId: 'message-1', agentId: 'agent-1', command: 'send_message' },
    }]);
  });

  it('reports unsupported manager capabilities as a recoverable command error', async () => {
    const { agent } = fakeAgent();
    agent.sendMessage = async () => {
      throw new UnsupportedAgentCapabilityError('send_message');
    };
    const output: Array<Record<string, unknown>> = [];
    const wire = createSessionWire(agent, (json) => output.push(JSON.parse(json) as Record<string, unknown>));
    await wire.receive(JSON.stringify({ protocolVersion: '1.2.0', type: 'negotiate' }));
    output.length = 0;

    await wire.receive(JSON.stringify({
      protocolVersion: '1.2.0', type: 'send_message',
      payload: { requestId: 'message-unsupported', agentId: 'agent-1', text: 'Continue.' },
    }));

    expect(output).toEqual([{
      protocolVersion: '1.2.0', type: 'protocol_error',
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
    await wire.receive(JSON.stringify({ protocolVersion: '1.2.0', type: 'negotiate' }));
    output.length = 0;

    const request = {
      kind: 'plan_approval' as const, requestId: 'plan-1', plan: '## Plan',
      allowedActions: ['approve' as const, 'reject' as const],
    };
    emit({ type: 'agent_state', agentId: 'agent-1', snapshot: agent.snapshot() });
    emit({
      type: 'agent_stream', agentId: 'agent-1', timestamp: '2026-09-02T00:00:03.000Z',
      event: { type: 'interaction_requested', provider: 'codex', request },
    });
    emit({ type: 'interaction_requested', agentId: 'agent-1', request });
    emit({
      type: 'interaction_resolved', agentId: 'agent-1', requestId: 'plan-1',
      response: { kind: 'plan_approval', action: 'approve' },
    });

    expect(output.map(({ type }) => type)).toEqual([
      'agent_update', 'interaction_requested', 'interaction_resolved',
    ]);
    expect(output.every((message) => !('snapshot' in message) && !('event' in message))).toBe(true);
  });
});

function fakeAgent(): { agent: SessionWireAgent; emit: (event: AgentManagerEvent) => void } {
  let listener: ((event: AgentManagerEvent) => void) | undefined;
  const snapshot = {
    protocolVersion: '1.2.0' as const,
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
          protocolVersion: '1.2.0', type: 'timeline_page',
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
