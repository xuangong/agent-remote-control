import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import type { Options } from '@anthropic-ai/claude-agent-sdk';
import type { ProviderStreamItem } from '@orchardworks/agent-provider-sdk';
import { ClaudeAgentSession } from './session.js';

function runtime() {
  const pending: any[] = [];
  let release: (() => void) | undefined;
  let closed = false;
  let input!: AsyncIterator<any>;
  let options!: Options;
  const push = (frame: any) => { pending.push(frame); release?.(); };
  const interrupts: unknown[] = [];
  let cancelled: string[] = [];
  const query = {
    async *[Symbol.asyncIterator]() { while (!closed) { if (pending.length) { const value = pending.shift(); if (value instanceof Error) throw value; yield value; }
      else await new Promise<void>((resolve) => { release = resolve; }); } },
    async initializationResult() { return {}; },
    async interrupt(options?: unknown) {
      interrupts.push(options);
      push({ type: 'result', subtype: 'success', is_error: false, session_id: 'native', uuid: `cancel-result-${interrupts.length}`, usage: {} });
      return { still_queued: [], cancelled };
    },
    async setPermissionMode() {},
    close() { closed = true; release?.(); },
  };
  return { push, interrupts, cancelOnInterrupt(ids: string[]) { cancelled = ids; }, get options() { return options; }, get closed() { return closed; },
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

  it('uses native streaming input across turns', async () => {
    const native = runtime();
    const session = await ClaudeAgentSession.open({ sessionId: 'native', cwd: '/workspace' }, { query: native.factory });
    const output = session.observe()[Symbol.asyncIterator]();
    expect((await output.next()).value).toEqual({ type: 'history_boundary' });
    await session.sendMessage('First');
    expect((await native.nextInput()).value).toMatchObject({ type: 'user', session_id: 'native', message: { content: 'First' } });
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

  it('reports how full a reopened conversation is before its next turn', async () => {
    for (const resume of [true, false]) {
      const native = runtime();
      let asked = 0;
      const factory = (args: any) => Object.assign(native.factory(args), { getContextUsage: async () => { asked++; return { totalTokens: 824_541, rawMaxTokens: 1_000_000 }; } });
      const session = await ClaudeAgentSession.open({ sessionId: 'native', cwd: '/workspace' }, { query: factory,
        catalog: { list: async () => [], info: async () => undefined, messages: async () => [], children: async () => [] } }, [], resume);
      const output = session.observe()[Symbol.asyncIterator]();
      if (resume) expect(await nextEvent(output, 'usage_updated')).toMatchObject({ usage: { contextScope: 'current', contextWindowUsedTokens: 824_541, contextWindowMaxTokens: 1_000_000 } });
      else { await new Promise(resolve => setTimeout(resolve, 20)); expect(asked).toBe(0); }
      await session.dispose();
    }
  });

  it('replays saved history with the turn each entry belongs to, so reopened prompts stay editable', async () => {
    const native = runtime();
    const row = (uuid: string, type: 'user' | 'assistant', content: unknown, turnId?: string) => ({ type, uuid, session_id: 'native', parent_tool_use_id: null,
      parent_agent_id: null, message: { role: type, id: `${uuid}-msg`, content }, ...(turnId ? { turnId } : {}) });
    const session = await ClaudeAgentSession.open({ sessionId: 'native', cwd: '/workspace' }, { query: native.factory,
      catalog: { list: async () => [], info: async () => undefined, messages: async () => [], children: async () => [] } }, [
      row('summary', 'user', 'Compaction summary'),
      row('prompt', 'user', 'Saved prompt', 'prompt'),
      row('reply', 'assistant', [{ type: 'text', text: 'Saved reply' }], 'prompt'),
    ] as never, true);
    const items: Array<{ text?: string; turnId?: string }> = [];
    for await (const item of session.observe()) {
      if (item.type === 'history_boundary') break;
      if (item.type === 'observation' && item.event.type === 'timeline') items.push({ text: (item.event.item as { text?: string }).text, turnId: item.event.turnId });
    }
    expect(items).toEqual([{ text: 'Compaction summary', turnId: undefined }, { text: 'Saved prompt', turnId: 'prompt' }, { text: 'Saved reply', turnId: 'prompt' }]);
    await session.dispose();
  });

  it('fails and cleans up a query that never finishes initialization', async () => {
    const native = runtime();
    const factory = (args: any) => ({ ...native.factory(args), initializationResult: () => new Promise(() => undefined) });
    await expect(ClaudeAgentSession.open({ sessionId: 'native' }, { query: factory, requestTimeoutMs: 20 })).rejects.toThrow(/timed out/);
    expect(native.closed).toBe(true);
  });
});

describe('Claude input during an active turn', () => {
  const lifecycle = (command_uuid: string, state: string) => ({ type: 'command_lifecycle', session_id: 'native', uuid: `${command_uuid}-${state}`, command_uuid, state });
  const result = (user_message_uuid: string) => ({ type: 'result', subtype: 'success', is_error: false, session_id: 'native', uuid: `result-${user_message_uuid}`, user_message_uuid, usage: {} });

  it('folds a message into the running turn when the native runtime starts it before the turn ends', async () => {
    const native = runtime();
    const session = await ClaudeAgentSession.open({ sessionId: 'native' }, { query: native.factory });
    const output = session.observe()[Symbol.asyncIterator]();
    try {
      await session.sendMessage('First');
      const first = (await native.nextInput()).value;
      const acceptances: string[] = [];
      await session.sendMessage('Steer', { onAcceptance: ({ disposition }) => acceptances.push(disposition) });
      const steered = (await native.nextInput()).value;
      expect(steered).toMatchObject({ type: 'user', message: { content: 'Steer' } });
      expect(steered.uuid).not.toBe(first.uuid);
      native.push(lifecycle(steered.uuid, 'queued'));
      native.push(lifecycle(steered.uuid, 'started'));
      await expect.poll(() => acceptances).toEqual(['queued', 'handled']);
      native.push(lifecycle(steered.uuid, 'completed'));
      native.push(result(first.uuid));
      const completed = await nextEvent(output, 'turn_completed');
      expect(completed).toMatchObject({ turnId: first.uuid });
      expect((await session.runtimeInfo()).status).toBe('idle');
    } finally { await session.dispose(); }
  });

  it('runs a message as the next turn when the native runtime starts it after the turn ends', async () => {
    const native = runtime();
    const session = await ClaudeAgentSession.open({ sessionId: 'native' }, { query: native.factory });
    const output = session.observe()[Symbol.asyncIterator]();
    try {
      await session.sendMessage('First');
      const first = (await native.nextInput()).value;
      const acceptances: string[] = [];
      await session.steer('Next', { onAcceptance: ({ disposition }) => acceptances.push(disposition) });
      const steered = (await native.nextInput()).value;
      native.push(lifecycle(steered.uuid, 'queued'));
      native.push(result(first.uuid));
      await nextEvent(output, 'turn_completed');
      await session.sendMessage('Behind');
      expect((await native.nextInput()).value).toMatchObject({ message: { content: 'Behind' } });
      native.push(lifecycle(steered.uuid, 'started'));
      expect(await nextEvent(output, 'turn_started')).toMatchObject({ turnId: steered.uuid });
      expect(acceptances).toEqual(['queued', 'started']);
      expect((await session.runtimeInfo()).status).toBe('running');
      native.push(result(steered.uuid));
      expect(await nextEvent(output, 'turn_completed')).toMatchObject({ turnId: steered.uuid });
    } finally { await session.dispose(); }
  });

  function collect(session: ClaudeAgentSession) {
    const events: any[] = [];
    void (async () => { for await (const item of session.observe()) if (item.type === 'observation') events.push(item.event); })().catch(() => {});
    return events;
  }
  const withdrawnItems = (events: any[]) => events.filter(event => event.type === 'timeline' && event.item.type === 'user_message' && event.item.withdrawn);

  it('stops queued input with the running turn and reports it withdrawn once', async () => {
    const native = runtime();
    const session = await ClaudeAgentSession.open({ sessionId: 'native' }, { query: native.factory });
    const events = collect(session);
    try {
      await session.sendMessage('First');
      const first = (await native.nextInput()).value;
      const acceptances: string[] = [], withdrawals: string[] = [];
      await session.sendMessage('Queued', { onAcceptance: ({ disposition }) => acceptances.push(disposition), onWithdrawn: ({ reason }) => withdrawals.push(reason) });
      const steered = (await native.nextInput()).value;
      native.push(lifecycle(steered.uuid, 'queued'));
      await expect.poll(() => acceptances).toEqual(['queued']);
      native.cancelOnInterrupt([steered.uuid]);
      await session.cancel();
      expect(native.interrupts).toEqual([{ cancelQueued: true }]);
      native.push(lifecycle(steered.uuid, 'cancelled'));
      await expect.poll(() => events.some(event => event.type === 'turn_canceled')).toBe(true);
      await expect.poll(() => withdrawnItems(events).length).toBe(1);
      expect(withdrawnItems(events)[0].item).toMatchObject({ text: 'Queued', withdrawn: { reason: 'stopped' } });
      expect(withdrawals).toEqual(['stopped']);
      expect(events.filter(event => event.type === 'turn_started').map(event => event.turnId)).toEqual([first.uuid]);
      expect((await session.runtimeInfo()).status).toBe('idle');
    } finally { await session.dispose(); }
  });

  it('withdraws queued input reported only by its cancelled lifecycle and never input that already ran', async () => {
    const native = runtime();
    const session = await ClaudeAgentSession.open({ sessionId: 'native' }, { query: native.factory });
    const events = collect(session);
    try {
      await session.sendMessage('First');
      await native.nextInput();
      const withdrawals: string[] = [];
      await session.sendMessage('Folded', { onWithdrawn: ({ reason }) => withdrawals.push(reason) });
      const folded = (await native.nextInput()).value;
      await session.sendMessage('Queued', { onWithdrawn: ({ reason }) => withdrawals.push(`queued:${reason}`) });
      const queued = (await native.nextInput()).value;
      native.push(lifecycle(folded.uuid, 'queued'));
      native.push(lifecycle(folded.uuid, 'started'));
      native.push(lifecycle(queued.uuid, 'queued'));
      await session.cancel();
      native.push(lifecycle(folded.uuid, 'cancelled'));
      native.push(lifecycle(queued.uuid, 'cancelled'));
      await expect.poll(() => withdrawals).toEqual(['queued:stopped']);
      expect(withdrawnItems(events).map(event => event.item.text)).toEqual(['Queued']);
    } finally { await session.dispose(); }
  });

  it('stops queued input that waits between turns and keeps planning unchanged until it is resolved', async () => {
    const native = runtime();
    const session = await ClaudeAgentSession.open({ sessionId: 'native' }, { query: native.factory });
    const events = collect(session);
    try {
      await session.sendMessage('First');
      const first = (await native.nextInput()).value;
      const withdrawals: string[] = [];
      await session.sendMessage('Next', { onWithdrawn: ({ reason }) => withdrawals.push(reason) });
      const steered = (await native.nextInput()).value;
      native.push(lifecycle(steered.uuid, 'queued'));
      native.push(result(first.uuid));
      await expect.poll(() => events.some(event => event.type === 'turn_completed')).toBe(true);
      await expect(session.setPlanning(true)).rejects.toThrow(/only change while idle/);
      native.cancelOnInterrupt([steered.uuid]);
      await session.cancel();
      expect(native.interrupts).toEqual([{ cancelQueued: true }]);
      expect(withdrawals).toEqual(['stopped']);
      expect(events.some(event => event.type === 'turn_canceled')).toBe(false);
      await expect(session.cancel()).resolves.toBeUndefined();
      expect(native.interrupts).toHaveLength(1);
    } finally { await session.dispose(); }
  });

  it.each([[['msg_lifecycle_v1', 'interrupt_cancel_queued_v1'], true], [['msg_lifecycle_v1'], false], [[], false]] as const)(
    'accepts input during a turn only when Claude Code reports %j', async (capabilities, accepted) => {
      const native = runtime();
      const session = await ClaudeAgentSession.open({ sessionId: 'native' }, { query: native.factory });
      try {
        await session.sendMessage('First');
        await native.nextInput();
        native.push({ type: 'system', subtype: 'init', session_id: 'native', model: 'native-model', permissionMode: 'default', capabilities });
        await expect.poll(async () => (await session.runtimeInfo()).model).toBe('native-model');
        if (accepted) {
          await session.sendMessage('During');
          expect((await native.nextInput()).value).toMatchObject({ message: { content: 'During' } });
        } else await expect(session.sendMessage('During')).rejects.toThrow(/cannot accept input while a turn is running/);
      } finally { await session.dispose(); }
    });

  it('rejects steering without an active turn and keeps next-turn delivery unsupported', async () => {
    const native = runtime();
    const session = await ClaudeAgentSession.open({ sessionId: 'native' }, { query: native.factory });
    try {
      expect(session.capabilities.steer).toBe(true);
      await expect(session.steer('nothing to steer')).rejects.toThrow(/no active turn/);
      await expect(session.sendMessage('First', { delivery: 'next_turn' })).rejects.toThrow(/queued delivery/);
    } finally { await session.dispose(); }
  });
});

it('does not finish a later turn on duplicate results and reports the latest query accounting', async () => {
  const native = runtime();
  const session = await ClaudeAgentSession.open({ sessionId: 'native', model: 'root' }, { query: native.factory });
  const output = session.observe()[Symbol.asyncIterator]();
  try {
    await session.sendMessage('First');
    const first = (await native.nextInput()).value;
    const completed = { type: 'result', subtype: 'success', is_error: false, session_id: 'native', uuid: 'result-one', user_message_uuid: first.uuid,
      usage: { input_tokens: 10, output_tokens: 2 }, total_cost_usd: 2,
      modelUsage: { root: { inputTokens: 10, outputTokens: 2, cacheReadInputTokens: 0, cacheCreationInputTokens: 0, contextWindow: 200000 } } };
    native.push(completed);
    const firstResult = await nextEvent(output, 'turn_completed');
    expect(firstResult).toMatchObject({ turnId: first.uuid, usage: { tokenScope: 'runtime', inputTokens: 10, totalCostUsd: 2 } });
    expect(firstResult).not.toHaveProperty('usage.contextWindowMaxTokens');
    await session.sendMessage('Second');
    const second = (await native.nextInput()).value;
    native.push(completed);
    native.push({ ...completed, uuid: 'replayed-other-envelope' });
    await new Promise<void>((resolve) => setImmediate(resolve));
    expect((await session.runtimeInfo()).status).toBe('running');
    native.push({ ...completed, uuid: 'result-two', user_message_uuid: second.uuid, total_cost_usd: 3,
      modelUsage: { root: { inputTokens: 20, outputTokens: 5, cacheReadInputTokens: 4, cacheCreationInputTokens: 3 } } });
    expect(await nextEvent(output, 'turn_completed')).toMatchObject({ turnId: second.uuid,
      usage: { tokenScope: 'runtime', inputTokens: 20, outputTokens: 5, cachedInputTokens: 4, cacheCreationInputTokens: 3, totalTokens: 32, totalCostUsd: 3 } });
  } finally { await session.dispose(); }
});

it('keeps native inline context usage and final accounting in the same turn', async () => {
  const native = runtime();
  const session = await ClaudeAgentSession.open({ sessionId: 'native', model: 'root' }, { query: native.factory });
  const output = session.observe()[Symbol.asyncIterator]();
  try {
    await session.sendMessage('/context');
    const input = (await native.nextInput()).value;
    native.push({ type: 'assistant', session_id: 'native', uuid: 'context-result', context_usage: { model: 'root', total_tokens: 123, raw_max_tokens: 200000 },
      message: { id: 'context-message', content: [{ type: 'text', text: 'Context table' }] } });
    native.push({ type: 'result', subtype: 'success', session_id: 'native', uuid: 'context-done', user_message_uuid: input.uuid, usage: {}, total_cost_usd: 0 });
    expect(await nextEvent(output, 'usage_updated')).toMatchObject({ turnId: input.uuid, usage: { contextScope: 'current', contextWindowUsedTokens: 123, contextWindowMaxTokens: 200000 } });
    expect(await nextEvent(output, 'turn_completed')).toMatchObject({ turnId: input.uuid, usage: { contextScope: 'current', contextWindowUsedTokens: 123, contextWindowMaxTokens: 200000 } });
  } finally { await session.dispose(); }
});

it('holds the permission mutation gate until a canceled plan approval settles natively', async () => {
  const native = runtime();
  let confirm!: () => void;
  const session = await ClaudeAgentSession.open({ sessionId: 'native', planning: true }, { query: (args) => ({
    ...native.factory(args), setPermissionMode: () => new Promise<void>((resolve) => { confirm = resolve; }),
  }) });
  const output = session.observe()[Symbol.asyncIterator]();
  try {
    await session.sendMessage('Plan a change');
    const decision = native.options.canUseTool!('ExitPlanMode', { plan: 'Make the change.' }, {
      signal: new AbortController().signal, toolUseID: 'exit-plan',
    });
    const request = await nextEvent(output, 'interaction_requested');
    if (request.type !== 'interaction_requested') throw new Error('Missing plan request');
    const approval = session.respondToInteraction(request.request.requestId, { kind: 'plan_approval', action: 'approve_and_resume' });
    const settled = approval.catch((error: unknown) => error);
    await session.cancel();
    await nextEvent(output, 'turn_canceled');
    expect((await session.runtimeInfo()).status).toBe('idle');
    await expect(session.sendMessage('Racing work')).rejects.toThrow(/setting change/);
    await expect(session.setSessionSetting('permissions', 'dontAsk')).resolves.toEqual({ status: 'deferred' });
    await expect(session.setPlanning(false)).rejects.toThrow(/idle/);
    await expect(decision).resolves.toMatchObject({ behavior: 'deny', interrupt: true });
    confirm(); expect(await settled).toMatchObject({ message: expect.stringMatching(/no longer active/) });
    expect((await session.runtimeInfo()).planning?.active).toBe(false);
    await session.sendMessage('After confirmation');
  } finally { confirm?.(); await session.dispose(); }
});

it('revokes native image reads after transport failure', async () => {
  const native = runtime();
  const session = await ClaudeAgentSession.open({ sessionId: 'native' }, { query: native.factory }, [{
    type: 'user', uuid: 'image-result', session_id: 'native', parent_tool_use_id: null, parent_agent_id: null,
    message: { content: [{ type: 'tool_result', tool_use_id: 'read', content: [{ type: 'image', source: {
      type: 'base64', media_type: 'image/png', data: 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jZ1kAAAAASUVORK5CYII=',
    } }] }] },
  }]);
  try {
    expect(session.capabilities.readResource).toBe(true);
    let locator = '';
    for await (const item of session.observe()) {
      if (item.type === 'history_boundary') break;
      if (item.type === 'observation' && item.resourceReferences?.length) locator = item.resourceReferences[0]!.readLocator;
    }
    expect(await session.readResource(locator)).toMatchObject({ status: 'available' });
    native.push(new Error('Transport ended'));
    await expect.poll(async () => (await session.runtimeInfo()).status).toBe('failed');
    expect(await session.readResource(locator)).toMatchObject({ status: 'unavailable' });
  } finally { await session.dispose(); }
});

it('sends ordered base64 image blocks and forwards rich input during an active turn', async () => {
  const root = await mkdtemp(join(tmpdir(), 'claude-input-'));
  const native = runtime();
  const session = await ClaudeAgentSession.open({ sessionId: 'native' }, { query: native.factory });
  try {
    const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jZ1kAAAAASUVORK5CYII=', 'base64');
    const jpg = Buffer.from([255, 216, 255, 224]);
    const paths = [join(root, 'one.png'), join(root, 'two.jpg')];
    await writeFile(paths[0]!, png); await writeFile(paths[1]!, jpg);
    const parts = [
      { type: 'text', text: 'before ' },
      { type: 'image', path: paths[0]!, mediaType: 'image/png', sha256: createHash('sha256').update(png).digest('hex'), label: 'image #1' },
      { type: 'text', text: ' between ' },
      { type: 'image', path: paths[1]!, mediaType: 'image/jpeg', sha256: createHash('sha256').update(jpg).digest('hex'), label: 'image #2' },
      { type: 'text', text: ' after' },
    ] as const;
    await session.sendMessageContent(parts);
    const sent = (await native.nextInput()).value;
    expect(sent.message.content.map((part: any) => part.type)).toEqual(['text', 'image', 'text', 'image', 'text']);
    expect(sent.message.content[1].source).toEqual({ type: 'base64', media_type: 'image/png', data: png.toString('base64') });
    expect(sent.message.content[3].source.data).toBe(jpg.toString('base64'));
    await session.sendMessageContent([parts[1]]);
    const steered = (await native.nextInput()).value;
    expect(steered.message.content).toHaveLength(1);
    expect(steered.uuid).not.toBe(sent.uuid);
    expect(session.capabilities.imageInput).toMatchObject({ maxImages: 8 });
  } finally { await session.dispose(); await rm(root, { recursive: true, force: true }); }
});

it('reserves submission during image reads and releases it on a failed image preparation', async () => {
  const root = await mkdtemp(join(tmpdir(), 'claude-race-'));
  const native = runtime();
  const session = await ClaudeAgentSession.open({ sessionId: 'native' }, { query: native.factory });
  try {
    const path = join(root, 'missing.png');
    const sending = session.sendMessageContent([{ type: 'image', path, sha256: 'a'.repeat(64), mediaType: 'image/png', label: 'image #1' }]);
    await expect(session.sendMessage('racing')).rejects.toThrow(/submission in progress/);
    await expect(session.setPlanning(true)).rejects.toThrow(/idle/);
    await expect(sending).rejects.toThrow(/ENOENT/);
    expect((await session.runtimeInfo()).status).toBe('idle');
    await session.sendMessage('after failure');
    expect((await native.nextInput()).value.message.content).toBe('after failure');
  } finally { await session.dispose(); await rm(root, { recursive: true, force: true }); }
});


