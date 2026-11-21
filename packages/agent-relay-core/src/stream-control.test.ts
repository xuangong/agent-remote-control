import { PROTOCOL_VERSION, type NativeSessionOwner, type ServerMessage } from '@orchardworks/agent-remote-protocol';
import { describe, expect, it } from 'vitest';

import { createStreamControl } from './stream-control.js';

const owner: NativeSessionOwner = { kind: 'native_cli', generation: 'native-1' };

function stream(holder: () => Promise<NativeSessionOwner | undefined> = async () => undefined) {
  const sent: ServerMessage[] = [];
  const control = createStreamControl({ agentId: 'agent-1', send: message => { sent.push(message); }, readNativeOwner: holder });
  const state = () => sent.filter(message => message.type === 'session_control').at(-1) as Extract<ServerMessage, { type: 'session_control' }>;
  const acquire = (requestId = 'q1') => control.admitRaw(JSON.stringify({ protocolVersion: PROTOCOL_VERSION, type: 'session_control_request', payload: { requestId, agentId: 'agent-1', action: 'acquire', revision: state().payload.revision } }));
  return { control, sent, state, acquire };
}
const send = (controlToken?: string) => JSON.stringify({ protocolVersion: PROTOCOL_VERSION, type: 'send_message', payload: { requestId: 'm1', operationId: '00000000-0000-4000-8000-000000000001', agentId: 'agent-1', text: 'hi' }, ...(controlToken === undefined ? {} : { controlToken }) });
const settle = () => new Promise<void>(resolve => setTimeout(resolve, 0));

describe('a browser stream through the lease table', () => {
  it('announces a read-only state once, after the first Snapshot', () => {
    const { control, sent, state } = stream();
    const forwarded: string[] = [];
    control.controllerFrame('{"type":"agent_snapshot"}', raw => forwarded.push(raw));
    control.controllerFrame('{"type":"agent_snapshot"}', raw => forwarded.push(raw));
    expect(forwarded).toHaveLength(2);
    expect(sent).toHaveLength(1);
    expect(state().payload).toMatchObject({ agentId: 'agent-1', access: 'read_only', available: true });
  });

  it('answers an acquire with the request id and the token, and lets a mutation with that token go on', () => {
    const { control, state, acquire } = stream();
    control.announce();
    expect(acquire('q1')).toBe(true);
    expect(state().payload).toMatchObject({ requestId: 'q1', access: 'control' });
    expect(control.admitRaw(send(state().payload.token))).toBe(false);
  });

  it('refuses a mutation without the token and keeps the stream open', () => {
    const { control, sent } = stream();
    control.announce();
    expect(control.admitRaw(send())).toBe(true);
    expect(sent.at(-1)).toMatchObject({ type: 'protocol_error', payload: { requestId: 'm1', code: 'session_read_only', recoverable: true } });
  });

  it('refuses an acquire for a revision that is not current', () => {
    const { control, sent } = stream();
    control.announce();
    control.admitRaw(JSON.stringify({ protocolVersion: PROTOCOL_VERSION, type: 'session_control_request', payload: { requestId: 'q1', agentId: 'agent-1', action: 'acquire', revision: 'stale' } }));
    expect(sent.at(-1)).toMatchObject({ type: 'protocol_error', payload: { requestId: 'q1', code: 'session_control_changed' } });
  });

  it('refuses a control frame that does not decode and never forwards it', () => {
    const { control, sent } = stream();
    expect(control.admitRaw('{"type":"session_control_request","payload":{"requestId":"q9"}}')).toBe(true);
    expect(sent.at(-1)).toMatchObject({ type: 'protocol_error', payload: { requestId: 'q9', code: 'invalid_shape' } });
  });

  it('leaves frames that are neither control nor a mutation to go on', () => {
    const { control } = stream();
    expect(control.admitRaw('{"type":"timeline_request","payload":{}}')).toBe(false);
    expect(control.admitRaw('not json')).toBe(false);
  });

  it('shows the owner a refusal names, takes the token away and tells the browser', () => {
    const { control, state, acquire } = stream();
    control.announce();
    acquire();
    control.controllerRefused('native_session_owned', owner);
    expect(state().payload).toMatchObject({ access: 'read_only', available: false, nativeOwner: owner });
    expect(state().payload.token).toBeUndefined();
  });

  it('asks the Controller who holds the session when a refusal names no owner, and shows the answer', async () => {
    const { control, state, acquire } = stream(async () => owner);
    control.announce();
    acquire();
    control.controllerFrame('{"type":"protocol_error","payload":{"code":"native_session_owned"}}', () => {});
    await settle();
    expect(state().payload).toMatchObject({ available: false, nativeOwner: owner });
  });

  it('shows the session available when the Controller cannot say who holds it', async () => {
    const { control, state, acquire } = stream(async () => { throw new Error('offline'); });
    control.announce();
    acquire();
    control.controllerRefused('native_session_owned');
    await settle();
    expect(state().payload).toMatchObject({ access: 'read_only', available: true });
  });

  it('drops the answer to a question asked under a revision that has moved on', async () => {
    let answer!: (found: NativeSessionOwner | undefined) => void;
    const { control, sent, state } = stream(() => new Promise(resolve => { answer = resolve; }));
    control.announce();
    control.controllerRefused('native_session_owned');
    control.controllerRefused('native_session_owned', { kind: 'controller', generation: 'c-1' });
    const count = sent.length;
    answer(owner);
    await settle();
    expect(sent).toHaveLength(count);
    expect(state().payload.nativeOwner).toEqual({ kind: 'controller', generation: 'c-1' });
  });

  it('refuses an interaction answer without the token with its submission id as the request id', () => {
    const { control, sent } = stream();
    control.announce();
    const answer = JSON.stringify({ protocolVersion: PROTOCOL_VERSION, type: 'interaction_response', payload: { agentId: 'agent-1', requestId: 'r1', submissionId: 'sub-1', operationId: '00000000-0000-4000-8000-000000000002', response: { kind: 'permission_approval', decision: 'deny' } } });
    expect(control.admitRaw(answer)).toBe(true);
    expect(sent.at(-1)).toMatchObject({ type: 'protocol_error', payload: { requestId: 'sub-1', code: 'session_read_only', recoverable: true } });
  });

  it('never gives two streams, or two acquires and refusals of one stream, the same revision or token', () => {
    const streams = Array.from({ length: 3 }, () => stream());
    const revisions = new Set<string>(), tokens = new Set<string>();
    for (const { control, state, acquire } of streams) {
      control.announce();
      revisions.add(state().payload.revision);
      acquire();
      tokens.add(state().payload.token!);
      control.controllerRefused('native_session_owned', owner);
      revisions.add(state().payload.revision);
      acquire();
      tokens.add(state().payload.token!);
    }
    expect(revisions.size).toBe(3 * 2);
    expect(tokens.size).toBe(3 * 2);
  });
});
