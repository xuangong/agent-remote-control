import { describe, expect, it } from 'vitest';
import { CodexAppServerSession } from './session.js';
import { CodexAppServerProvider } from './provider.js';
import { createFakeChildProcess } from './test-utils/fake-child.js';

async function harness(sharedProvider?: CodexAppServerProvider, process = createFakeChildProcess(), savedThreads: Record<string, unknown>[] = []) {
  const requests: Array<{ id: number; method: string; params: Record<string, unknown> }> = [];
  const replies: Array<Record<string, unknown>> = [];
  const readReply: { beforeReply?: () => void } = {};
  const threads = new Map(savedThreads.map(thread => [String(thread.id), thread]));
  const provider = sharedProvider ?? new CodexAppServerProvider({ spawn: () => process });
  let input = '';
  const write = (value: unknown) => process.stdout.write(`${JSON.stringify(value)}\n`);
  process.stdin.on('data', (chunk) => {
    input += String(chunk);
    const lines = input.split('\n'); input = lines.pop()!;
    for (const line of lines.filter(Boolean)) {
      const message = JSON.parse(line);
      if (!message.method) { replies.push(message); continue; }
      if (message.id === undefined) continue;
      requests.push(message);
      if (message.method === 'thread/turns/list') { write({ id: message.id, error: { code: -32601, message: 'Method not found' } }); continue; }
      let result: unknown = { data: [] };
      if (message.method === 'model/list') result = { data: [{ model: 'codex', displayName: 'Codex' }, { model: 'alternative', displayName: 'Alternative' }] };
      if (message.method === 'configRequirements/read') result = { requirements: null };
      if (message.method === 'thread/start') result = { thread: { id: 'parent' }, cwd: '/workspace', model: 'codex' };
      if (message.method === 'thread/resume') result = { thread: threads.get(message.params.threadId), cwd: '/workspace', model: 'codex' };
      if (message.method === 'thread/read') result = { thread: threads.get(message.params.threadId) };
      if (message.method === 'turn/start') result = { turn: { id: 'direct-turn' } };
      const snapshot = structuredClone(result);
      queueMicrotask(() => {
        if (message.method === 'thread/read' && message.params.includeTurns) readReply.beforeReply?.();
        write({ id: message.id, result: snapshot });
      });
    }
  });
  const parent = savedThreads.length ? await provider.resumeSession({ providerId: 'codex', sessionId: 'parent', opaque: JSON.stringify({ cwd: '/workspace' }) })
    : await provider.createSession({ sessionId: 'local', cwd: '/workspace' });
  const notify = (method: string, params: unknown) => write({ method, params });
  const addChild = (id = 'child', parentId = 'parent', direct = true) => threads.set(id, {
    id, parentThreadId: parentId, name: null, agentNickname: `Name ${id}`, agentRole: 'explorer',
    createdAt: 100, cwd: '/workspace', status: { type: 'active', activeFlags: [] }, canAcceptDirectInput: direct,
    turns: [{ id: `${id}-turn`, status: 'inProgress', items: [{ id: `${id}-message`, type: 'agentMessage', text: 'Early reply' }] }],
  });
  const spawn = (id = 'child', parentId = 'parent', turnId = 'origin', callId = 'spawn-call', tool = 'spawnAgent') => notify('item/completed', {
    threadId: parentId, turnId, item: { type: 'collabAgentToolCall', id: callId, tool, status: 'completed', senderThreadId: parentId,
      receiverThreadIds: [id], prompt: 'Inspect code', agentsStates: { [id]: { status: 'running', message: null } } },
  });
  return { process, provider, parent, notify, addChild, spawn, write, requests, replies, threads, readReply };
}

async function observations(session: { observe(): AsyncIterable<unknown> }, count: number) {
  const iterator = session.observe()[Symbol.asyncIterator]();
  const values = [];
  for (let index = 0; index < count; index++) values.push((await iterator.next()).value);
  return values;
}

describe('Codex native children', () => {
  it('restores parent-controlled children from activity history without a live spawn notification', async () => {
    const children = ['review', 'diagnosis', 'acceptance'].map((name, index) => ({ id: name, parentThreadId: 'parent',
      source: { subAgent: { thread_spawn: { parent_thread_id: 'parent', agent_path: `/root/${name}` } } },
      agentNickname: `Nickname ${name}`, canAcceptDirectInput: false, createdAt: index + 1, cwd: '/workspace',
      status: { type: index === 2 ? 'notLoaded' : 'idle' },
      turns: [{ id: `${name}-turn`, status: 'completed', items: [{ type: 'agentMessage', id: `${name}-message`, text: 'Saved child reply' }] }],
    }));
    const h = await harness(undefined, createFakeChildProcess(), [{ id: 'parent', turns: [{ id: 'origin', status: 'completed',
      items: children.flatMap(child => ['started', 'completed'].map(kind => ({ type: 'subAgentActivity', id: `${child.id}-${kind}`, kind,
        agentThreadId: child.id, agentPath: `/root/${child.id}` }))),
    }] }, ...children]);
    try {
      await expect.poll(async () => (await h.parent.runtimeInfo()).childSessions?.length).toBe(3);
      expect((await h.parent.runtimeInfo()).childSessions?.map(child => child.title)).toEqual(['/root/review', '/root/diagnosis', '/root/acceptance']);
      for (const name of ['review', 'diagnosis', 'acceptance']) {
        const child = await h.provider.openChildSession('parent', name);
        expect(child.capabilities.sendMessage).toBe(false);
        expect(await observations(child, 2)).toMatchObject([{ delivery: 'history', event: { item: { text: 'Saved child reply' } } }, { type: 'history_boundary' }]);
      }
      expect(h.requests.filter(({ method }) => method === 'thread/resume').map(({ params }) => params.threadId)).toEqual(['parent']);
    } finally { await h.parent.dispose(); }
  });

  it.each(['started', 'interacted', 'completed'])('discovers parent-controlled children from %s activity and displays their native path', async (kind) => {
    const h = await harness();
    try {
      h.addChild('child', 'parent', false);
      Object.assign(h.threads.get('child')!, { name: 'A friendly name', source: { subAgent: { thread_spawn: {
        parent_thread_id: 'parent', agent_path: '/root/review', agent_nickname: 'Hypatia',
      } } } });
      h.notify('item/completed', { threadId: 'parent', turnId: 'origin', item: {
        type: 'subAgentActivity', id: 'activity', kind, agentThreadId: 'child', agentPath: '/root/review',
      } });
      await expect.poll(async () => (await h.parent.runtimeInfo()).childSessions).toMatchObject([
        { nativeSessionId: 'child', title: '/root/review', status: 'running', observation: 'live' },
      ]);
      const child = await h.provider.openChildSession('parent', 'child');
      expect(child.capabilities).toMatchObject({ sendMessage: false, steer: false, cancel: false, commands: false, sessionSettings: false });
      expect(await observations(child, 2)).toMatchObject([{ delivery: 'history', event: { item: { text: 'Early reply' } } }, { type: 'history_boundary' }]);
      await expect(child.sendMessage('Direct input')).rejects.toThrow(/direct input/);
      await expect(child.cancel()).rejects.toThrow(/direct input/);
      expect(h.requests.some(({ method }) => ['thread/resume', 'turn/start', 'turn/interrupt'].includes(method))).toBe(false);
    } finally { await h.parent.dispose(); }
  });

  it('records delayed activity provenance after discovering a child from its own notification', async () => {
    const h = await harness();
    try {
      h.addChild('child', 'parent', false);
      h.notify('thread/started', { thread: h.threads.get('child') });
      await expect.poll(async () => (await h.parent.runtimeInfo()).childSessions?.length).toBe(1);
      h.notify('item/completed', { threadId: 'parent', turnId: 'origin', item: {
        type: 'subAgentActivity', id: 'spawn-activity', kind: 'started', agentThreadId: 'child',
      } });
      expect((await h.parent.runtimeInfo()).childSessions).toMatchObject([
        { nativeSessionId: 'child', parentTurnId: 'origin', parentCallId: 'spawn-activity' },
      ]);
    } finally { await h.parent.dispose(); }
  });

  it('checks native parentage before reading history for an activity reference', async () => {
    const h = await harness();
    try {
      h.addChild('foreign', 'other-parent', false);
      h.notify('item/completed', { threadId: 'parent', turnId: 'origin', item: {
        type: 'subAgentActivity', id: 'foreign-reference', kind: 'interacted', agentThreadId: 'foreign', agentPath: '/root/foreign',
      } });
      await expect.poll(() => h.requests.filter(({ method }) => method === 'thread/read').length).toBeGreaterThan(0);
      await new Promise(resolve => setImmediate(resolve));
      expect((await h.parent.runtimeInfo()).childSessions).toEqual([]);
      expect(h.requests.filter(({ method, params }) => method === 'thread/read' && params.includeTurns === true)).toEqual([]);
    } finally { await h.parent.dispose(); }
  });

  it('opens the existing child with history and retains its creation origin after send calls', async () => {
    const h = await harness();
    try {
      h.addChild(); h.spawn();
      await expect.poll(async () => (await h.parent.runtimeInfo()).childSessions?.length).toBe(1);
      h.spawn('child', 'parent', 'later-turn', 'send-call', 'sendInput');
      const child = await h.provider.openChildSession('parent', 'child');
      expect(await h.provider.openChildSession('parent', 'child')).toBe(child);
      expect((await h.parent.runtimeInfo()).childSessions).toMatchObject([{ nativeSessionId: 'child', title: 'Name child',
        role: 'explorer', parentTurnId: 'origin', parentCallId: 'spawn-call', status: 'running', observation: 'live' }]);
      expect(await observations(child, 2)).toMatchObject([{ type: 'observation', delivery: 'history', event: { item: { text: 'Early reply' } } }, { type: 'history_boundary' }]);
      expect(h.requests.filter(({ method }) => method === 'thread/resume')).toHaveLength(0);
      await child.cancel();
      expect(h.requests.at(-1)).toMatchObject({ method: 'turn/interrupt', params: { threadId: 'child', turnId: 'child-turn' } });
      await child.dispose();
      expect(h.process.killed).toBe(false);
      await h.parent.sendMessage('Parent still works');
    } finally { await h.parent.dispose(); }
  });

  it('routes approvals arriving before child discovery and reports waiting to its parent', async () => {
    const h = await harness();
    try {
      h.addChild();
      h.write({ id: 'approval', method: 'item/commandExecution/requestApproval', params: { threadId: 'child', turnId: 'child-turn', itemId: 'command', command: 'echo test', cwd: '/workspace' } });
      await expect.poll(async () => (await h.parent.runtimeInfo()).childSessions?.[0]?.status).toBe('waiting');
      const child = await h.provider.openChildSession('parent', 'child');
      const events = await observations(child, 3);
      expect(events[2]).toMatchObject({ event: { type: 'interaction_requested', request: { requestId: 'tool:approval' } } });
      await child.respondToInteraction('tool:approval', { kind: 'tool_approval', decision: 'allow', scope: 'once' });
      await expect.poll(() => h.replies.find(({ id }) => id === 'approval')).toMatchObject({ result: { decision: 'accept' } });
      expect(h.replies.some((reply) => reply.error)).toBe(false);
    } finally { await h.parent.dispose(); }
  });

  it('keeps nested children direct and denies input for restricted or unloaded native children', async () => {
    const h = await harness();
    try {
      h.addChild('child', 'parent', false); h.spawn();
      await expect.poll(async () => (await h.parent.runtimeInfo()).childSessions?.length).toBe(1);
      const child = await h.provider.openChildSession('parent', 'child');
      expect(child.capabilities).toMatchObject({ sendMessage: false, steer: false, cancel: false, sessionSettings: false, commands: false, planning: false });
      expect(child.capabilities.imageInput).toBeUndefined();
      await expect(child.sendMessageContent!([{ type: 'image', path: '/managed/image.png', mediaType: 'image/png', sha256: 'a'.repeat(64), label: 'image #1' }])).rejects.toThrow(/direct input/);
      await expect(child.sendMessage('hello')).rejects.toThrow(/direct input/);
      await expect(child.cancel()).rejects.toThrow(/direct input/);
      h.addChild('grandchild', 'child'); h.spawn('grandchild', 'child');
      await expect.poll(async () => (await child.runtimeInfo()).childSessions?.length).toBe(1);
      await expect(h.provider.openChildSession('parent', 'grandchild')).rejects.toThrow(/direct child/);
      expect((await h.provider.openChildSession('child', 'grandchild')).capabilities.sendMessage).toBe(true);
      h.addChild('cold'); h.threads.get('cold')!.status = { type: 'notLoaded' }; h.threads.get('cold')!.canAcceptDirectInput = null; h.spawn('cold');
      await expect.poll(async () => (await h.parent.runtimeInfo()).childSessions?.length).toBe(2);
      const cold = await h.provider.openChildSession('parent', 'cold');
      expect(cold.capabilities.sendMessage).toBe(false);
      await expect(cold.sendMessage('cannot resume')).rejects.toThrow(/direct input/);
      expect(await observations(cold, 2)).toMatchObject([{ delivery: 'history' }, { type: 'history_boundary' }]);
      expect((await h.parent.runtimeInfo()).childSessions?.[1]).toMatchObject({ status: 'closed', observation: 'saved_history' });
      await expect(h.provider.openChildSession('parent', 'foreign')).rejects.toThrow(/direct child/);
      expect(h.requests.some(({ method }) => method === 'thread/resume')).toBe(false);
    } finally { await h.parent.dispose(); }
  });
  it('applies buffered native turn state and capability changes without mixing parent output', async () => {
    const h = await harness();
    try {
      h.addChild();
      h.threads.get('child')!.turns = [];
      h.threads.get('child')!.status = { type: 'idle' };
      h.notify('turn/started', { threadId: 'child', turn: { id: 'early-turn', status: 'inProgress' } });
      h.notify('item/agentMessage/delta', { threadId: 'child', turnId: 'early-turn', itemId: 'early', delta: 'Child only' });
      await expect.poll(async () => (await h.parent.runtimeInfo()).childSessions?.[0]?.status).toBe('running');
      const child = await h.provider.openChildSession('parent', 'child');
      await child.cancel();
      expect(h.requests.at(-1)).toMatchObject({ method: 'turn/interrupt', params: { threadId: 'child', turnId: 'early-turn' } });
      h.notify('thread/started', { thread: { ...h.threads.get('child'), canAcceptDirectInput: false } });
      expect(child.capabilities.sendMessage).toBe(false);
      h.notify('thread/status/changed', { threadId: 'child', status: { type: 'notLoaded' } });
      expect(await h.provider.openChildSession('parent', 'child')).toBe(child);
      expect((await h.parent.runtimeInfo()).childSessions?.[0]).toMatchObject({ status: 'closed', observation: 'saved_history' });
      expect((await h.parent.runtimeInfo()).status).toBe('idle');
    } finally { await h.parent.dispose(); }
  });

  it('rebuilds an unopened child from native history after a long live stream', async () => {
    const h = await harness();
    try {
      h.addChild(); h.spawn();
      await expect.poll(async () => (await h.parent.runtimeInfo()).childSessions?.length).toBe(1);
      for (let index = 0; index < 700; index++) h.notify('item/agentMessage/delta', { threadId: 'child', turnId: 'child-turn', itemId: 'stream', delta: 'x' });
      h.threads.get('child')!.turns = [{ id: 'child-turn', status: 'inProgress', items: [{ id: 'stream', type: 'agentMessage', text: 'x'.repeat(700) }] }];
      const child = await h.provider.openChildSession('parent', 'child');
      const events = await observations(child, 2);
      expect(events).toMatchObject([{ delivery: 'history', event: { item: { text: 'x'.repeat(700) } } }, { type: 'history_boundary' }]);
      expect(h.requests.filter(({ method, params }) => method === 'thread/read' && params.threadId === 'child' && params.includeTurns)).toHaveLength(2);
    } finally { await h.parent.dispose(); }
  });

  it('does not expose a request already resolved while its unknown child was being read', async () => {
    const h = await harness();
    try {
      h.addChild();
      h.write({ id: 'resolved', method: 'item/commandExecution/requestApproval', params: { threadId: 'child', turnId: 'child-turn', itemId: 'command', command: 'echo test' } });
      h.notify('serverRequest/resolved', { threadId: 'child', requestId: 'resolved' });
      await expect.poll(async () => (await h.parent.runtimeInfo()).childSessions?.length).toBe(1);
      const child = await h.provider.openChildSession('parent', 'child');
      await expect(child.respondToInteraction('tool:resolved', { kind: 'tool_approval', decision: 'deny' })).rejects.toThrow(/No pending/);
      expect((await h.parent.runtimeInfo()).childSessions?.[0]?.status).toBe('running');
    } finally { await h.parent.dispose(); }
  });

  it('shares the native model catalog while keeping child settings independent', async () => {
    const h = await harness();
    try {
      h.addChild(); h.threads.get('child')!.status = { type: 'idle' }; h.threads.get('child')!.turns = []; h.spawn();
      await expect.poll(async () => (await h.parent.runtimeInfo()).childSessions?.length).toBe(1);
      const child = await h.provider.openChildSession('parent', 'child');
      expect((await child.runtimeInfo()).settings?.find(({ id }) => id === 'model')).toMatchObject({ mutable: true, options: [{ value: 'codex' }, { value: 'alternative' }] });
      h.notify('thread/settings/updated', { threadId: 'child', threadSettings: { model: 'alternative', approvalPolicy: 'on-request', sandboxPolicy: { type: 'readOnly' } } });
      expect((await child.runtimeInfo()).model).toBe('alternative');
      expect((await h.parent.runtimeInfo()).model).toBe('codex');
      await child.sendMessage('Native child turn');
      expect(h.requests.at(-1)).toMatchObject({ method: 'turn/start', params: { threadId: 'child', model: 'alternative' } });
    } finally { await h.parent.dispose(); }
  });

  it('releases a child view without canceling its native approval and permits reopening', async () => {
    const h = await harness();
    try {
      h.addChild(); h.spawn();
      await expect.poll(async () => (await h.parent.runtimeInfo()).childSessions?.length).toBe(1);
      const child = await h.provider.openChildSession('parent', 'child');
      h.write({ id: 'release-approval', method: 'item/commandExecution/requestApproval', params: { threadId: 'child', turnId: 'child-turn', itemId: 'command', command: 'echo test' } });
      await child.dispose();
      expect(h.process.killed).toBe(false);
      expect((await h.parent.runtimeInfo()).childSessions?.[0]?.status).toBe('waiting');
      const reopened = await h.provider.openChildSession('parent', 'child');
      expect(await observations(reopened, 3)).toMatchObject([{ delivery: 'history' }, { type: 'history_boundary' }, { event: { type: 'interaction_requested' } }]);
      await reopened.respondToInteraction('tool:release-approval', { kind: 'tool_approval', decision: 'deny' });
      await expect.poll(() => h.replies.find(({ id }) => id === 'release-approval')).toMatchObject({ result: { decision: 'decline' } });
    } finally { await h.parent.dispose(); }
  });

  it('restores live interactions after the native parent resumes a saved child', async () => {
    const h = await harness();
    try {
      h.addChild(); h.threads.get('child')!.status = { type: 'notLoaded' }; h.threads.get('child')!.canAcceptDirectInput = null; h.spawn();
      await expect.poll(async () => (await h.parent.runtimeInfo()).childSessions?.length).toBe(1);
      const child = await h.provider.openChildSession('parent', 'child');
      expect(child.capabilities.interactions.toolApproval).toBe(false);
      h.notify('thread/started', { thread: { ...h.threads.get('child'), status: { type: 'idle' }, canAcceptDirectInput: true } });
      h.notify('thread/status/changed', { threadId: 'child', status: { type: 'active', activeFlags: ['waitingOnApproval'] } });
      expect(child.capabilities.interactions.toolApproval).toBe(true);
      expect((await h.parent.runtimeInfo()).childSessions?.[0]).toMatchObject({ status: 'waiting', observation: 'live' });
    } finally { await h.parent.dispose(); }
  });

  it.each([true, false])('refreshes saved child native input eligibility %s without a thread start notification', async (direct) => {
    const h = await harness();
    try {
      h.addChild();
      Object.assign(h.threads.get('child')!, { status: { type: 'notLoaded' }, canAcceptDirectInput: null, turns: [] });
      h.spawn();
      await expect.poll(async () => (await h.parent.runtimeInfo()).childSessions?.length).toBe(1);
      const child = await h.provider.openChildSession('parent', 'child');
      expect(child.capabilities.sendMessage).toBe(false);
      expect(child.capabilities.interactions.toolApproval).toBe(false);
      Object.assign(h.threads.get('child')!, { status: { type: 'idle' }, canAcceptDirectInput: direct });
      h.notify('thread/status/changed', { threadId: 'child', status: { type: 'idle' } });
      h.spawn('child', 'parent', 'resume-turn', 'resume-call', 'resumeAgent');
      await expect.poll(() => child.capabilities.interactions.toolApproval).toBe(true);
      expect(child.capabilities.sendMessage).toBe(direct);
      expect((await h.parent.runtimeInfo()).childSessions?.[0]).toMatchObject({ status: 'idle', observation: 'live' });
      if (direct) {
        await child.sendMessage('Direct input after native resume');
        expect(h.requests.find(({ method }) => method === 'turn/start')?.params.threadId).toBe('child');
      } else {
        await expect(child.sendMessage('Restricted child')).rejects.toThrow('does not accept direct input');
      }
      h.write({ id: 'reactivated-approval', method: 'item/commandExecution/requestApproval', params: { threadId: 'child', turnId: 'direct-turn', itemId: 'command', command: 'echo test' } });
      await child.respondToInteraction('tool:reactivated-approval', { kind: 'tool_approval', decision: 'deny' });
      await expect.poll(() => h.replies.find(({ id }) => id === 'reactivated-approval')).toMatchObject({ result: { decision: 'decline' } });
      expect(h.requests.filter(({ method }) => method === 'thread/resume')).toHaveLength(0);
    } finally { await h.parent.dispose(); }
  });

  it('selects the owning runtime and rejects ambiguous native parent-child identities', async () => {
    const processes = [createFakeChildProcess(), createFakeChildProcess()];
    let index = 0;
    const provider = new CodexAppServerProvider({ spawn: () => processes[index++]! });
    const first = await harness(provider, processes[0]);
    const second = await harness(provider, processes[1]);
    try {
      first.addChild('first'); first.spawn('first');
      second.addChild('second'); second.spawn('second');
      await expect.poll(async () => (await second.parent.runtimeInfo()).childSessions?.length).toBe(1);
      expect((await provider.openChildSession('parent', 'second')).capabilities.sendMessage).toBe(true);
      second.addChild('first'); second.spawn('first');
      await expect.poll(async () => (await second.parent.runtimeInfo()).childSessions?.length).toBe(2);
      await expect(provider.openChildSession('parent', 'first')).rejects.toThrow(/ambiguous/);
    } finally { await first.parent.dispose(); await second.parent.dispose(); }
  });

  it('preserves a live delta arriving after the refreshed native history snapshot', async () => {
    const h = await harness();
    try {
      h.addChild(); h.spawn();
      await expect.poll(async () => (await h.parent.runtimeInfo()).childSessions?.length).toBe(1);
      const child = await h.provider.openChildSession('parent', 'child');
      await child.dispose();
      h.readReply.beforeReply = () => h.notify('item/agentMessage/delta', { threadId: 'child', turnId: 'child-turn', itemId: 'child-message', delta: ' after snapshot' });
      const reopened = await h.provider.openChildSession('parent', 'child');
      expect(await observations(reopened, 3)).toMatchObject([
        { delivery: 'history', event: { item: { text: 'Early reply' } } },
        { type: 'history_boundary' },
        { delivery: 'live', event: { item: { text: ' after snapshot' } } },
      ]);
    } finally { await h.parent.dispose(); }
  });

  it('trims history coverage once and retains repeated fragments beyond a partial snapshot', async () => {
    const h = await harness();
    try {
      h.addChild();
      const history = (text: string) => [{ id: 'child-turn', status: 'inProgress', items: [{ id: 'child-message', type: 'agentMessage', text }] }];
      h.threads.get('child')!.turns = history('e');
      h.spawn();
      await expect.poll(async () => (await h.parent.runtimeInfo()).childSessions?.length).toBe(1);
      const child = await h.provider.openChildSession('parent', 'child');
      await child.dispose();
      h.threads.get('child')!.turns = history('ee');
      h.readReply.beforeReply = () => {
        h.readReply.beforeReply = undefined;
        for (const delta of ['ee', 'e']) h.notify('item/agentMessage/delta', {
          threadId: 'child', turnId: 'child-turn', itemId: 'child-message', delta,
        });
        for (let replay = 0; replay < 2; replay++) h.notify('item/completed', {
          threadId: 'child', turnId: 'child-turn', item: { type: 'agentMessage', id: 'child-message', text: 'eeee' },
        });
        h.notify('turn/completed', { threadId: 'child', turn: { id: 'child-turn', status: 'completed' } });
      };
      const reopened = await h.provider.openChildSession('parent', 'child');
      expect(await observations(reopened, 5)).toMatchObject([
        { delivery: 'history', event: { item: { text: 'ee' } } },
        { type: 'history_boundary' },
        { delivery: 'live', event: { item: { text: 'e' } } },
        { delivery: 'live', event: { item: { text: 'e' } } },
        { event: { type: 'turn_completed' } },
      ]);
    } finally { await h.parent.dispose(); }
  });

  it('preserves root thread startup observations through the shared router', async () => {
    const h = await harness();
    try {
      h.notify('thread/started', { thread: { id: 'parent', status: { type: 'idle' } } });
      expect(await observations(h.parent, 2)).toMatchObject([{ type: 'history_boundary' }, { event: { type: 'thread_started', sessionId: 'parent' } }]);
    } finally { await h.parent.dispose(); }
  });

  it.each(['dispose', 'exit'] as const)('releases provider ownership when its root closes by %s', async (reason) => {
    const h = await harness();
    let released = 0;
    (h.parent as CodexAppServerSession).onRuntimeClosed(() => released++);
    if (reason === 'exit') h.process.emitExit(1);
    else await h.parent.dispose();
    expect(released).toBe(1);
    await h.parent.dispose();
    expect(released).toBe(1);
  });

  it('refreshes initial child discovery when a delta races its first history snapshot', async () => {
    const h = await harness();
    try {
      h.addChild();
      h.readReply.beforeReply = () => {
        h.readReply.beforeReply = undefined;
        h.notify('item/agentMessage/delta', { threadId: 'child', turnId: 'child-turn', itemId: 'child-message', delta: ' after snapshot' });
        h.threads.get('child')!.turns = [{ id: 'child-turn', status: 'inProgress', items: [{ id: 'child-message', type: 'agentMessage', text: 'Early reply after snapshot' }] }];
      };
      h.spawn();
      await expect.poll(async () => (await h.parent.runtimeInfo()).childSessions?.length).toBe(1);
      const child = await h.provider.openChildSession('parent', 'child');
      expect(await observations(child, 2)).toMatchObject([{ delivery: 'history', event: { item: { text: 'Early reply after snapshot' } } }, { type: 'history_boundary' }]);
      expect(h.requests.filter(({ method, params }) => method === 'thread/read' && params.includeTurns)).toHaveLength(2);
    } finally { await h.parent.dispose(); }
  });

  it('keeps native approvals pending when repeated snapshot races require reopening', async () => {
    const h = await harness();
    try {
      h.addChild();
      let text = 'Early reply';
      h.readReply.beforeReply = () => {
        h.notify('item/agentMessage/delta', { threadId: 'child', turnId: 'child-turn', itemId: 'child-message', delta: ' more' });
        text += ' more';
        h.threads.get('child')!.turns = [{ id: 'child-turn', status: 'inProgress', items: [{ id: 'child-message', type: 'agentMessage', text }] }];
      };
      h.write({ id: 'snapshot-approval', method: 'item/commandExecution/requestApproval', params: { threadId: 'child', turnId: 'child-turn', itemId: 'command', command: 'echo test' } });
      await expect.poll(async () => (await h.parent.runtimeInfo()).childSessions?.[0]?.status).toBe('waiting');
      await expect(h.provider.openChildSession('parent', 'child')).rejects.toThrow(/Reopen/);
      expect(h.replies.some((reply) => reply.error)).toBe(false);
      expect((await h.parent.runtimeInfo()).childSessions?.[0]).toMatchObject({ status: 'waiting', observation: 'live' });
      h.readReply.beforeReply = undefined;
      const child = await h.provider.openChildSession('parent', 'child');
      await child.respondToInteraction('tool:snapshot-approval', { kind: 'tool_approval', decision: 'deny' });
      await expect.poll(() => h.replies.find(({ id }) => id === 'snapshot-approval')).toMatchObject({ result: { decision: 'decline' } });
    } finally { await h.parent.dispose(); }
  });

});
