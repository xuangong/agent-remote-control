import { describe, expect, it } from 'vitest';
import { ClaudeAgentSession } from './session.js';
import { Channel } from './channel.js';
import { ClaudeChildSession } from './child-session.js';
import { ClaudeChildren } from './children.js';

async function harness(parent = 'root', saved: any[] = []) {
  const events = new Channel<any>();
  let closed = false;
  const session = await ClaudeAgentSession.open({ sessionId: parent, cwd: '/work' }, { query: () => ({
    [Symbol.asyncIterator]: () => events[Symbol.asyncIterator](), initializationResult: async () => ({}),
    close() { closed = true; events.close(); }, interrupt: async () => {}, setPermissionMode: async () => {},
  }) as any, catalog: { list: async () => [], info: async () => undefined, messages: async () => [], children: async () => saved,
    childMessages: async () => [] } }, [], saved.length > 0);
  const push = (frame: any) => events.push({ ...frame, session_id: parent });
  const start = (id = 'task', extras = {}) => push({ type: 'system', subtype: 'task_started', task_type: 'local_agent', task_id: id,
    tool_use_id: `tool-${id}`, description: 'Review implementation', subagent_type: 'Explore', spawn_depth: 1, ...extras });
  const child = async () => { await expect.poll(async () => (await session.runtimeInfo()).childSessions?.length).toBe(1);
    const descriptor = (await session.runtimeInfo()).childSessions![0]!; return { descriptor, view: await session.openChildSession(descriptor.nativeSessionId) }; };
  return { session, push, start, child, closed: () => closed };
}

describe('Claude native child projections', () => {
  it('reports unavailable saved transcripts instead of opening an empty historical child', async () => {
    const h = await harness();
    try {
      h.start(); const { descriptor } = await h.child();
      h.push({ type: 'system', subtype: 'task_notification', task_id: 'task', status: 'completed' });
      await expect.poll(async () => (await h.session.runtimeInfo()).childSessions![0]!.status).toBe('closed');
      await expect(h.session.openChildSession(descriptor.nativeSessionId)).rejects.toThrow(/history is unavailable/);
    } finally { await h.session.dispose(); }
  });
  it('routes live child text independently, retains identity across aliases and releases views without stopping the root', async () => {
    const h = await harness();
    try {
      h.start(); const { descriptor, view } = await h.child();
      expect(descriptor).toMatchObject({ title: 'Review implementation', role: 'Explore', status: 'running', observation: 'live', parentCallId: 'tool-task' });
      expect(view.capabilities).toMatchObject({ sendMessage: false, cancel: false });
      await expect(view.sendMessage('forged')).rejects.toThrow(/read-only/);
      const output = view.observe()[Symbol.asyncIterator]();
      expect((await output.next()).value).toEqual({ type: 'history_boundary' });
      h.push({ type: 'assistant', parent_tool_use_id: 'tool-task', uuid: 'child-message', message: { id: 'answer', content: [{ type: 'text', text: 'CHILD_ONLY' }] } });
      for (;;) { const item = (await output.next()).value; if (item?.type === 'observation' && item.event.type === 'timeline') { expect(item.event.item.text).toBe('CHILD_ONLY'); break; } }
      h.start('task', { tool_use_id: 'new-tool' });
      await expect.poll(async () => (await h.session.runtimeInfo()).childSessions?.length).toBe(1);
      await view.dispose(); expect(h.closed()).toBe(false);
      expect((await h.session.runtimeInfo()).childSessions![0]!.nativeSessionId).toBe(descriptor.nativeSessionId);
      const reopened = await h.session.openChildSession(descriptor.nativeSessionId);
      const history = reopened.observe()[Symbol.asyncIterator]();
      expect((await history.next()).value).toMatchObject({ delivery: 'history', event: { type: 'timeline', item: { text: 'CHILD_ONLY' } } });
      await expect(h.session.openChildSession('foreign')).rejects.toThrow(/direct child/);
    } finally { await h.session.dispose(); }
  });

  it('filters nonchildren and housekeeping, keeps background tasks live after parent completion, and freezes on native exit', async () => {
    const h = await harness();
    try {
      h.start('shell', { task_type: 'local_bash' }); h.start('nested', { spawn_depth: 2 }); h.start('ambient', { ambient: true });
      h.start('background', { is_backgrounded: true });
      await h.child();
      await h.session.sendMessage('work');
      h.push({ type: 'result', subtype: 'success', is_error: false, usage: {} });
      await expect.poll(async () => (await h.session.runtimeInfo()).status).toBe('idle');
      expect((await h.session.runtimeInfo()).childSessions![0]!.status).toBe('running');
      h.push({ type: 'system', subtype: 'task_notification', task_id: 'background', status: 'completed' });
      await expect.poll(async () => (await h.session.runtimeInfo()).childSessions![0]!.status).toBe('closed');
      expect((await h.session.runtimeInfo()).childSessions![0]!.observation).toBe('saved_history');
    } finally { await h.session.dispose(); }
    expect((await h.session.runtimeInfo()).childSessions![0]!.observation).toBe('saved_history');
  });

  it('ends foreground observation at a parent turn boundary without ending background tasks', async () => {
    const h = await harness();
    try {
      await h.session.sendMessage('work');
      h.start(); await h.child();
      h.push({ type: 'result', subtype: 'success', is_error: false, usage: {} });
      await expect.poll(async () => (await h.session.runtimeInfo()).status).toBe('idle');
      expect((await h.session.runtimeInfo()).childSessions![0]).toMatchObject({ status: 'closed', observation: 'saved_history' });
    } finally { await h.session.dispose(); }
  });

  it('restores direct saved children without native child queries and scopes identities by parent', async () => {
    const saved = [{ id: 'same', messages: [{ type: 'user', uuid: 'u', message: { content: 'Saved task' }, parent_agent_id: null },
      { type: 'assistant', uuid: 'a', message: { id: 'saved-answer', content: [{ type: 'text', text: 'Saved answer' }] }, parent_agent_id: null }] },
      { id: 'nested', messages: [{ type: 'user', parent_agent_id: 'same', message: { content: 'Nested task' } }] }];
    const a = await harness('parent-a', saved); const b = await harness('parent-b', saved);
    try {
      const first = await a.child(); const second = await b.child();
      expect(first.descriptor.nativeSessionId).not.toBe(second.descriptor.nativeSessionId);
      expect(first.descriptor).toMatchObject({ status: 'closed', observation: 'saved_history' });
      const history = first.view.observe()[Symbol.asyncIterator]();
      expect((await history.next()).value).toMatchObject({ delivery: 'history', event: { item: { text: 'Saved task' } } });
    } finally { await a.session.dispose(); await b.session.dispose(); }
  });
});


it('replays completed children in native transcript order, including prompts and tool activity', async () => {
  const answer = { type: 'assistant', uuid: 'answer', message: { id: 'm', content: [{ type: 'text', text: 'ANSWER' }] }, parent_agent_id: null };
  const transcript = [
    { type: 'user', uuid: 'prompt', message: { content: 'PROMPT' }, parent_agent_id: null },
    { type: 'assistant', uuid: 'tool', message: { id: 't', content: [{ type: 'tool_use', id: 'call', name: 'Read', input: { file_path: '/work/file' } }] }, parent_agent_id: null },
    { type: 'user', uuid: 'result', message: { content: [{ type: 'tool_result', tool_use_id: 'call', content: 'contents' }] }, parent_agent_id: null }, answer,
  ];
  const catalog = { list: async () => [], info: async () => undefined, messages: async () => [],
    children: async () => [{ id: 'task', messages: transcript }], childMessages: async () => transcript } as any;
  const live = new ClaudeChildren('root', process.cwd(), catalog, () => {});
  const cold = new ClaudeChildren('root', process.cwd(), catalog, () => {});
  try {
    live.consume({ type: 'system', subtype: 'task_started', task_id: 'task', task_type: 'local_agent', tool_use_id: 'tool', spawn_depth: 1 });
    live.consume({ ...answer, parent_tool_use_id: 'tool' });
    live.consume({ type: 'system', subtype: 'task_notification', task_id: 'task', status: 'completed' });
    await cold.restore();
    const completed = await live.open(live.descriptors()[0]!.nativeSessionId);
    const restored = await cold.open(cold.descriptors()[0]!.nativeSessionId);
    const expected = await childHistory(restored);
    expect(expected.map((event) => event.item.type)).toEqual(['user_message', 'tool_call', 'tool_call', 'assistant_message']);
    expect(await childHistory(completed)).toEqual(expected);
  } finally { await live.close(); await cold.close(); }
}, 10000);

async function childHistory(view: ClaudeChildSession): Promise<any[]> {
  const events: any[] = [];
  for await (const item of view.observe()) { if (item.type === 'history_boundary') break; if (item.type === 'observation') events.push(item.event); }
  return events;
}

it('backfills repeated native inputs in order without dropping a forwarded prompt omitted by the SDK', async () => {
  const view = new ClaudeChildSession({ nativeSessionId: 'child', title: 'Task', createdAt: '', status: 'running', observation: 'live' });
  const first = { type: 'user', uuid: 'first-input', message: { content: 'AGAIN' } };
  const answer = { type: 'assistant', uuid: 'first-answer', message: { id: 'answer-1', content: [{ type: 'text', text: 'ONE' }] } };
  const second = { type: 'user', uuid: 'second-input', message: { content: 'AGAIN' } };
  const reply = { type: 'assistant', uuid: 'second-answer', message: { id: 'answer-2', content: [{ type: 'text', text: 'TWO' }] } };
  view.accept(first); view.accept(answer);
  const output = view.observe()[Symbol.asyncIterator]();
  try {
    while ((await output.next()).value?.type !== 'history_boundary') {}
    view.accept(reply);
    expect((await output.next()).value).toMatchObject({ event: { item: { text: 'TWO' } } });
    view.reconcileHistory([answer, second, reply]);
    expect((await output.next()).value).toMatchObject({ type: 'timeline_replacement', observations: [
      { event: { item: { type: 'user_message', text: 'AGAIN', messageId: 'first-input' } } },
      { event: { item: { text: 'ONE' } } },
      { event: { item: { type: 'user_message', text: 'AGAIN', messageId: 'second-input' } } },
      { event: { item: { text: 'TWO' } } },
    ] });
    view.reconcileHistory([answer, second, reply]);
    view.changed();
    expect((await output.next()).value).toMatchObject({ event: { type: 'runtime_updated' } });
    await view.dispose(); await output.return!();
    expect((await childHistory(view)).map((event) => event.item.text)).toEqual(['AGAIN', 'ONE', 'AGAIN', 'TWO']);
  } finally { await view.dispose(); }
}, 10000);

it('corrects late input history while retaining a partially streamed answer', async () => {
  const view = new ClaudeChildSession({ nativeSessionId: 'child', title: 'Task', createdAt: new Date().toISOString(), status: 'running', observation: 'live' });
  const stream = (event: any) => view.accept({ type: 'stream_event', event });
  const prompt = { type: 'user', uuid: 'prompt', message: { content: 'PROMPT' } };
  const answer = { type: 'assistant', uuid: 'answer', message: { id: 'm', content: [{ type: 'text', text: 'ANSWER' }] } };
  const observer = view.observe()[Symbol.asyncIterator]();
  try {
    expect((await observer.next()).value).toEqual({ type: 'history_boundary' });
    stream({ type: 'message_start', message: { id: 'm' } });
    stream({ type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } });
    stream({ type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'ANS' } });
    expect((await observer.next()).value).toMatchObject({ event: { item: { text: 'ANS' } } });
    view.reconcileHistory([prompt]);
    expect((await observer.next()).value).toMatchObject({ type: 'timeline_replacement', observations: [
      { event: { item: { type: 'user_message', text: 'PROMPT' } } },
      { event: { item: { type: 'assistant_message', text: 'ANS' } } },
    ] });
    // A later snapshot may already contain the full assistant message before its final stream delta arrives.
    view.reconcileHistory([prompt, answer]);
    expect((await observer.next()).value).toMatchObject({ event: { item: { text: 'WER' } } });
    stream({ type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'WER' } });
    view.accept(answer);
    view.reconcileHistory([prompt, answer]);
    view.changed();
    expect((await observer.next()).value).toMatchObject({ event: { type: 'runtime_updated' } });
    await view.dispose();
    expect(await observer.next()).toMatchObject({ done: true });
    expect((await childHistory(view)).map((event) => event.item.text)).toEqual(['PROMPT', 'ANSWER']);
  } finally { await view.dispose(); }
}, 10000);

it('preserves a forwarded tail absent from persistence and keeps equal prompts with distinct identities', async () => {
  const view = new ClaudeChildSession({ nativeSessionId: 'child', title: 'Task', createdAt: new Date().toISOString(), status: 'running', observation: 'live' });
  const first = { type: 'user', uuid: 'first', message: { content: 'PROMPT' } };
  const second = { type: 'user', uuid: 'second', message: { content: 'PROMPT' } };
  try {
    view.accept({ type: 'stream_event', event: { type: 'message_start', message: { id: 'answer' } } });
    view.accept({ type: 'stream_event', event: { type: 'content_block_start', index: 0, content_block: { type: 'text', text: 'PARTIAL' } } });
    view.reconcileHistory([first, second]);
    expect((await childHistory(view)).map((event) => event.item.text)).toEqual(['PROMPT', 'PROMPT', 'PARTIAL']);
  } finally { await view.dispose(); }
}, 10000);

it('preserves unfinished blocks when another block of the same native message is saved', async () => {
  const view = new ClaudeChildSession({ nativeSessionId: 'child', title: 'Task', createdAt: new Date().toISOString(), status: 'running', observation: 'live' });
  const stream = (event: any) => view.accept({ type: 'stream_event', event });
  try {
    stream({ type: 'message_start', message: { id: 'm' } });
    stream({ type: 'content_block_start', index: 0, content_block: { type: 'thinking', thinking: 'THINK' } });
    const first = { type: 'assistant', uuid: 'thinking-block', message: { id: 'm', content: [{ type: 'thinking', thinking: 'THINK' }] } };
    view.accept(first);
    stream({ type: 'content_block_start', index: 1, content_block: { type: 'text', text: 'ANS' } });
    view.reconcileHistory([first]);
    stream({ type: 'content_block_delta', index: 1, delta: { type: 'text_delta', text: 'WER' } });
    const items: any[] = [];
    for await (const item of view.observe()) { if (item.type === 'history_boundary') break; if (item.type === 'observation') items.push(item.event); }
    expect(items.map((event) => event.item.text)).toEqual(['THINK', 'ANS', 'WER']);
  } finally { await view.dispose(); }
}, 10000);

it('delivers the text suffix before subsequent saved blocks sharing the native message identity', async () => {
  const view = new ClaudeChildSession({ nativeSessionId: 'child', title: 'Task', createdAt: new Date().toISOString(), status: 'running', observation: 'live' });
  const stream = (event: any) => view.accept({ type: 'stream_event', event });
  const output = view.observe()[Symbol.asyncIterator]();
  try {
    await output.next();
    stream({ type: 'message_start', message: { id: 'm' } });
    stream({ type: 'content_block_start', index: 0, content_block: { type: 'text', text: 'ANS' } });
    expect((await output.next()).value).toMatchObject({ event: { item: { text: 'ANS' } } });
    const text = { type: 'assistant', uuid: 'text-block', message: { id: 'm', content: [{ type: 'text', text: 'ANSWER' }] } };
    const tool = { type: 'assistant', uuid: 'tool-block', message: { id: 'm', content: [{ type: 'tool_use', id: 'call', name: 'Read', input: { file_path: '/work/file' } }] } };
    view.reconcileHistory([text, tool]);
    stream({ type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'WER' } });
    view.accept(text);
    view.changed();
    expect((await output.next()).value).toMatchObject({ event: { item: { text: 'WER' } } });
    expect((await output.next()).value).toMatchObject({ event: { item: { type: 'tool_call' } } });
    expect((await output.next()).value).toMatchObject({ event: { type: 'runtime_updated' } });
  } finally { await view.dispose(); }
}, 10000);
