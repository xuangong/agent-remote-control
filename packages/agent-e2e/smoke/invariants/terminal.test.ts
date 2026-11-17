import { describe, expect, it } from 'vitest';
import { page, transcript } from './builders.js';
import { leaseFollowsNativeOwner, noLostOrDoubledMessage, takeOverWorks, terminalRowsAppear } from './terminal.js';

const control = (extra: Record<string, unknown>) => ({ agentId: 'a', revision: 'r', available: true, ...extra });

describe('the lease follows the native owner', () => {
  it('passes when a terminal-owned session is read-only', () => {
    const wire = transcript().receive(1, 'session_control', control({ access: 'read_only', nativeOwner: { kind: 'native_cli', generation: 'g' } })).build();
    expect(leaseFollowsNativeOwner(wire).status).toBe('passed');
  });
  it('fails when the page holds control while a terminal owns the session', () => {
    const wire = transcript().receive(1, 'session_control', control({ access: 'control', token: 't', nativeOwner: { kind: 'native_cli', generation: 'g' } })).build();
    expect(leaseFollowsNativeOwner(wire).status).toBe('failed');
  });
});

describe('no message is lost or doubled', () => {
  const user = (text: string, key = text) => ({ key, kind: 'user_message', text });
  it('passes when each prompt is shown once', () => {
    expect(noLostOrDoubledMessage(page({ finalRows: [user('one'), user('two')] }), ['one', 'two']).status).toBe('passed');
  });
  it('fails for a lost prompt and a doubled one', () => {
    expect(noLostOrDoubledMessage(page({ finalRows: [user('one')] }), ['one', 'two']).violations[0]?.message).toMatch(/lost/);
    expect(noLostOrDoubledMessage(page({ finalRows: [user('one', 'a'), user('one', 'b')] }), ['one']).violations[0]?.message).toMatch(/2 times/);
  });
});

describe('take over works', () => {
  const request = () => transcript().send(1, 'session_control_request', { agentId: 'a', requestId: 'q1', revision: 'r', action: 'take_over' });
  it('passes when the answer grants control', () => {
    expect(takeOverWorks(request().receive(2, 'session_control', control({ access: 'control', token: 't', requestId: 'q1' })).build()).status).toBe('passed');
  });
  it('fails for no answer and for an answer that keeps the page read-only', () => {
    expect(takeOverWorks(request().build()).violations[0]?.message).toMatch(/not answered/);
    expect(takeOverWorks(request().receive(2, 'session_control', control({ access: 'read_only', requestId: 'q1' })).build()).status).toBe('failed');
  });
});

describe('terminal rows appear in the timeline', () => {
  const written = () => transcript().marker(100, 'terminal-write', { text: 'from the terminal' });
  const stream = (text: string) => ({ agentId: 'a', epoch: 'e', seq: 1, event: { type: 'timeline', item: { type: 'user_message', text } } });
  it('passes when a live entry carries the text soon after', () => {
    expect(terminalRowsAppear(written().receive(900, 'agent_stream', stream('from the terminal')).build()).status).toBe('passed');
  });
  it('fails when the text never arrives or arrives too late', () => {
    expect(terminalRowsAppear(written().build()).status).toBe('failed');
    expect(terminalRowsAppear(written().receive(30_000, 'agent_stream', stream('from the terminal')).build(), 10_000).violations[0]?.message).toMatch(/took/);
  });
});
