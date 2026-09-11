import { describe, expect, it } from 'vitest';
import type { Options } from '@anthropic-ai/claude-agent-sdk';
import type { ProviderStreamItem } from '@borgee/agent-provider-sdk';
import { ClaudeAgentSession } from './session.js';

function runtime() {
  const pending: any[] = [];
  let release: (() => void) | undefined;
  let closed = false;
  let input!: AsyncIterator<any>;
  let options!: Options;
  const push = (frame: any) => { pending.push(frame); release?.(); };
  const query = {
    async *[Symbol.asyncIterator]() { while (!closed) { if (pending.length) { const value = pending.shift(); if (value instanceof Error) throw value; yield value; }
      else await new Promise<void>((resolve) => { release = resolve; }); } },
    async initializationResult() { return {}; },
    async interrupt() { push({ type: 'result', subtype: 'success', is_error: false, session_id: 'native', uuid: 'cancel-result', usage: {} }); },
    async setPermissionMode() {},
    close() { closed = true; release?.(); },
  };
  return { push, get options() { return options; }, get closed() { return closed; },
    nextInput: () => input.next(),
    factory(args: any) { input = args.prompt[Symbol.asyncIterator](); options = args.options; return query as any; } };
}

async function nextEvent(iterator: AsyncIterator<ProviderStreamItem>, type: string) {
  for (;;) { const next = await iterator.next(); if (next.done) throw new Error('Observation ended');
    if (next.value.type === 'observation' && next.value.event.type === type) return next.value.event; }
}

describe('Claude persistent session', () => {
  it('tracks native plan-mode transitions in runtime information and persistence', async () => {
    const native = runtime();
    const session = await ClaudeAgentSession.open({ sessionId: 'native' }, { query: native.factory });
    native.push({ type: 'system', subtype: 'init', session_id: 'native', model: 'native-model', permissionMode: 'plan' });
    await expect.poll(async () => (await session.runtimeInfo()).planning?.active).toBe(true);
    native.push({ type: 'system', subtype: 'status', session_id: 'native', status: null, permissionMode: 'default' });
    await expect.poll(async () => (await session.runtimeInfo()).planning?.active).toBe(false);
    expect(JSON.parse((await session.runtimeInfo()).persistence!.opaque).planning).toBe(false);
    await session.dispose();
  });

  it('drains accepted observations then fails the iterator when the native stream fails', async () => {
    const native = runtime();
    const session = await ClaudeAgentSession.open({ sessionId: 'native' }, { query: native.factory });
    await session.sendMessage('Hello');
    native.push(new Error('native transport disconnected'));
    const output = session.observe()[Symbol.asyncIterator]();
    await nextEvent(output, 'turn_failed');
    await expect.poll(() => native.closed).toBe(true);
    expect((await session.runtimeInfo()).status).toBe('failed');
    const drain = async () => { for (;;) { const next = await output.next(); if (next.done) return; } };
    await expect(drain()).rejects.toThrow('native transport disconnected');
    await session.dispose();
  });

  it('uses native streaming input across turns and rejects concurrent message submission', async () => {
    const native = runtime();
    const session = await ClaudeAgentSession.open({ sessionId: 'native', cwd: '/workspace' }, { query: native.factory });
    const output = session.observe()[Symbol.asyncIterator]();
    expect((await output.next()).value).toEqual({ type: 'history_boundary' });
    await session.sendMessage('First');
    expect((await native.nextInput()).value).toMatchObject({ type: 'user', session_id: 'native', message: { content: 'First' } });
    await expect(session.sendMessage('racing')).rejects.toThrow(/active/);
    native.push({ type: 'result', subtype: 'success', is_error: false, session_id: 'native', uuid: 'done', usage: { input_tokens: 7, output_tokens: 3 } });
    await nextEvent(output, 'turn_completed');
    await session.sendMessage('Second');
    expect((await native.nextInput()).value).toMatchObject({ message: { content: 'Second' } });
    expect((await session.runtimeInfo()).status).toBe('running');
    await session.dispose();
    expect(native.closed).toBe(true);
  });

  it('interrupts the active native turn without closing the persistent query', async () => {
    const native = runtime();
    const session = await ClaudeAgentSession.open({ sessionId: 'native' }, { query: native.factory });
    const output = session.observe()[Symbol.asyncIterator]();
    await session.sendMessage('Wait');
    await session.cancel();
    await nextEvent(output, 'turn_canceled');
    expect((await session.runtimeInfo()).status).toBe('idle');
    expect(native.closed).toBe(false);
    await session.dispose();
  });

  it('emits saved history before the boundary and preserves resume identity', async () => {
    const native = runtime();
    const session = await ClaudeAgentSession.open({ sessionId: 'native', cwd: '/workspace' }, { query: native.factory,
      catalog: { list: async () => [], info: async () => undefined, messages: async () => [], children: async () => [] } }, [
      { type: 'assistant', uuid: 'old', session_id: 'native', parent_tool_use_id: null, parent_agent_id: null,
        message: { id: 'old-msg', content: [{ type: 'text', text: 'Saved text' }] } },
    ], true);
    const output = session.observe()[Symbol.asyncIterator]();
    expect((await output.next()).value).toMatchObject({ delivery: 'history', event: { item: { text: 'Saved text' } } });
    expect((await output.next()).value).toEqual({ type: 'history_boundary' });
    expect(native.options).toMatchObject({ resume: 'native', cwd: '/workspace' });
    expect(native.options.sessionId).toBeUndefined();
    expect((await session.runtimeInfo()).persistence).toMatchObject({ providerId: 'claude', sessionId: 'native' });
    await session.dispose();
  });

  it('fails and cleans up a query that never finishes initialization', async () => {
    const native = runtime();
    const factory = (args: any) => ({ ...native.factory(args), initializationResult: () => new Promise(() => undefined) });
    await expect(ClaudeAgentSession.open({ sessionId: 'native' }, { query: factory, requestTimeoutMs: 20 })).rejects.toThrow(/timed out/);
    expect(native.closed).toBe(true);
  });
});
