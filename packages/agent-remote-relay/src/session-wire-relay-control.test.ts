import { describe, expect, it, vi } from 'vitest';

import type { SessionWireAgent } from './session-wire.js';
import { createSettledSessionWire as createSessionWire } from './session-wire.test-fixture.js';

const OPERATION_ID = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const frame = (fields: Record<string, unknown>) => JSON.stringify({ protocolVersion: '1.8.0', ...fields });

function agent(): SessionWireAgent {
  return {
    agentId: 'agent-1',
    snapshot: () => ({ protocolVersion: '1.8.0', type: 'agent_snapshot', payload: {
      id: 'agent-1', providerId: 'codex', createdAt: '2026-09-02T00:00:00.000Z', updatedAt: '2026-09-02T00:00:00.000Z', status: 'idle', activeTurn: null,
      capabilities: { history: true, sendMessage: true, steer: false, cancel: false, readResource: false, interactions: { question: true, planApproval: true, toolApproval: true } },
      pendingInteractions: [], runtimeInfo: { providerId: 'codex', sessionId: 'session-1', status: 'idle' } } }),
    subscribe: () => () => undefined,
    fetchTimeline: () => { throw new Error('No timeline.'); },
    sendMessage: vi.fn(async () => ({ disposition: 'started' as const })),
  } as unknown as SessionWireAgent;
}

const send = (requestId: string) => frame({ type: 'send_message', payload: { requestId, operationId: OPERATION_ID, agentId: 'agent-1', text: 'Hi' } });

describe('a session wire of a Host behind a Relay', () => {
  it('sends no control state, holds no lease, and says session control applies', async () => {
    const output: Array<Record<string, any>> = [];
    const wire = createSessionWire(agent(), json => output.push(JSON.parse(json)), { nativeOwner: () => undefined });
    await wire.receive(frame({ type: 'negotiate' }));
    expect(output.map(message => message.type)).toEqual(['negotiated', 'agent_snapshot']);
    expect(output[0]).toMatchObject({ sessionControl: true });
    wire.close();
  });

  it('delivers a mutation with no token, and refuses it while a terminal holds the session, without a native call', async () => {
    const target = agent();
    const output: Array<Record<string, any>> = [];
    let owner: { kind: 'native_cli'; generation: string } | undefined;
    const wire = createSessionWire(target, json => output.push(JSON.parse(json)), { nativeOwner: () => owner });
    await wire.receive(frame({ type: 'negotiate' }));
    await wire.receive(send('free'));
    expect(output.at(-1)).toMatchObject({ type: 'command_acknowledged', payload: { requestId: 'free' } });
    expect(target.sendMessage).toHaveBeenCalledTimes(1);
    owner = { kind: 'native_cli', generation: 'g1' };
    await wire.receive(send('owned'));
    expect(output.at(-1)).toMatchObject({ type: 'protocol_error', payload: { requestId: 'owned', code: 'native_session_owned' } });
    expect(target.sendMessage).toHaveBeenCalledTimes(1);
    wire.close();
  });

  it('does not dispatch a send that was queued before its stream ended', async () => {
    const target = agent();
    const output: Array<Record<string, any>> = [];
    let admit!: () => void;
    const admitted = new Promise<void>(resolve => { admit = resolve; });
    const wire = createSessionWire(target, json => output.push(JSON.parse(json)), {
      // The Host's queue holds the send until the running turn ends; the stream ends meanwhile.
      executeOperation: async (_agent, _operation, work) => { await admitted; work.beforeDispatch?.(); return work.dispatch(); },
    });
    await wire.receive(frame({ type: 'negotiate' }));
    const queued = wire.receive(frame({ type: 'send_message', payload: { requestId: 'queued', operationId: OPERATION_ID, agentId: 'agent-1', text: 'Later', delivery: 'next_turn' } }));
    wire.close();
    admit();
    await queued;
    expect(target.sendMessage).not.toHaveBeenCalled();
    expect(output.some(message => message.type === 'command_acknowledged')).toBe(false);
  });
});
