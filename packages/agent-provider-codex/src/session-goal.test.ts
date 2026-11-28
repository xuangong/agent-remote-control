import { describe, expect, it } from 'vitest';
import type { AgentSession, ProviderStreamItem } from '@orchardworks/agent-provider-sdk';
import { CodexAppServerProvider } from './provider.js';
import { createScriptedAppServer } from './test-utils/scripted-app-server.js';

const THREAD = 'thread-goal';
const nativeGoal = (patch: Record<string, unknown> = {}) => ({ threadId: THREAD, objective: 'make tests pass', status: 'active', tokenBudget: null, tokensUsed: 500, timeUsedSeconds: 3, createdAt: 1_795_893_366, updatedAt: 1_795_893_370, ...patch });
const note = (server: ReturnType<typeof createScriptedAppServer>, method: string, params: unknown) => server.child.stdout.write(`${JSON.stringify({ method, params })}\n`);

/** A session over a scripted app-server that answers the goal requests the way Codex does, and keeps the goal it was set to. */
async function open(options: { stored?: Record<string, unknown> | null; resume?: boolean } = {}) {
  let goal: Record<string, unknown> | null = options.stored ?? null;
  const server = createScriptedAppServer({
    'thread/start': () => ({ thread: { id: THREAD }, model: 'gpt-5.4' }),
    'thread/resume': () => ({ thread: { id: THREAD }, model: 'gpt-5.4' }),
    'thread/read': () => ({ thread: { id: THREAD, turns: [] } }),
    'turn/start': () => ({ turn: { id: 'turn-1' } }),
    'skills/list': () => ({ data: [] }),
    'thread/goal/get': () => ({ goal }),
    'thread/goal/set': (params: any) => {
      if (params.objective === 'refuse') throw new Error('goals are disabled');
      goal = nativeGoal({ ...goal, ...(params.objective ? { objective: params.objective } : {}), ...(params.status ? { status: params.status } : {}) });
      note(server, 'thread/goal/updated', { threadId: THREAD, turnId: null, goal });
      return { goal };
    },
    'thread/goal/clear': () => { goal = null; note(server, 'thread/goal/cleared', { threadId: THREAD }); return { cleared: true }; },
  });
  const provider = new CodexAppServerProvider({ spawn: () => server.child });
  const session: AgentSession = options.resume
    ? await provider.resumeSession({ providerId: 'codex', sessionId: THREAD, opaque: '{}' })
    : await provider.createSession({ sessionId: 'local', planning: false });
  const goals: unknown[] = [];
  void (async () => { for await (const item of session.observe() as AsyncIterable<ProviderStreamItem>) if (item.type === 'observation' && item.event.type === 'runtime_updated') goals.push(item.event.runtimeInfo.goal); })().catch(() => {});
  const sent = (method: string) => server.requests.filter(request => request.method === method).map(request => request.params);
  return { session, server, goals, sent, settle: () => new Promise<void>(resolve => setImmediate(resolve)) };
}

describe('the goal of a Codex session', () => {
  it('is read from the thread when the session opens again, and offers pause and clear', async () => {
    const { session, sent, settle } = await open({ resume: true, stored: nativeGoal() });
    try {
      await settle();
      expect(sent('thread/goal/get')).toEqual([{ threadId: THREAD }]);
      expect((await session.runtimeInfo()).goal).toMatchObject({ objective: 'make tests pass', status: 'active', tokensUsed: 500, startedAt: 1_795_893_366_000,
        actions: [{ kind: 'pause', commandId: 'goal', args: 'pause' }, { kind: 'clear', commandId: 'goal', args: 'clear' }] });
    } finally { await session.dispose(); }
  });

  it('is none for a thread that has no goal', async () => {
    const { session, settle } = await open({ resume: true });
    try { await settle(); expect((await session.runtimeInfo()).goal).toBeUndefined(); } finally { await session.dispose(); }
  });

  it('follows the notifications of its own thread, and ignores those of another', async () => {
    const { session, server, goals, settle } = await open();
    try {
      note(server, 'thread/goal/updated', { threadId: 'other-thread', turnId: null, goal: nativeGoal({ threadId: 'other-thread', objective: 'not mine' }) });
      note(server, 'thread/goal/updated', { threadId: THREAD, turnId: 'turn-9', goal: nativeGoal({ tokensUsed: 900, status: 'usageLimited' }) });
      await settle();
      expect(goals).toHaveLength(1);
      expect(goals[0]).toMatchObject({ objective: 'make tests pass', status: 'usage_limited', tokensUsed: 900 });
      note(server, 'thread/goal/cleared', { threadId: THREAD });
      await settle();
      expect(goals.at(-1)).toBeUndefined();
      expect((await session.runtimeInfo()).goal).toBeUndefined();
    } finally { await session.dispose(); }
  });

  it('keeps a notification that arrived while the stored goal was still being read', async () => {
    const { session, server, settle } = await open({ resume: true, stored: nativeGoal({ objective: 'stale' }) });
    try {
      note(server, 'thread/goal/updated', { threadId: THREAD, turnId: null, goal: nativeGoal({ objective: 'fresh' }) });
      await settle();
      expect((await session.runtimeInfo()).goal?.objective).toBe('fresh');
    } finally { await session.dispose(); }
  });
});

describe('the /goal command of a Codex session', () => {
  it('is a command with an argument hint', async () => {
    const { session } = await open();
    try { expect((await session.listCommands!()).find(command => command.id === 'goal')).toMatchObject({ name: 'goal', kind: 'command', inputHint: expect.stringContaining('clear') }); }
    finally { await session.dispose(); }
  });

  it('sets the objective as the person\'s own goal, and edits it', async () => {
    const { session, sent, goals } = await open();
    try {
      await session.executeCommand!('goal', ' all tests pass ');
      await session.executeCommand!('goal', 'edit make all tests pass');
      expect(sent('thread/goal/set')).toEqual([{ threadId: THREAD, origin: 'user', objective: 'all tests pass' }, { threadId: THREAD, origin: 'user', objective: 'make all tests pass' }]);
      expect(goals.at(-1)).toMatchObject({ objective: 'make all tests pass', status: 'active' });
    } finally { await session.dispose(); }
  });

  it('pauses, resumes and clears with the person as the origin', async () => {
    const { session, sent, goals, settle } = await open({ stored: nativeGoal() });
    try {
      await session.executeCommand!('goal', 'pause');
      expect(goals.at(-1)).toMatchObject({ status: 'paused', actions: [{ kind: 'resume' }, { kind: 'clear' }] });
      await session.executeCommand!('goal', 'resume');
      expect(goals.at(-1)).toMatchObject({ status: 'active' });
      await session.executeCommand!('goal', 'clear');
      await settle();
      expect(sent('thread/goal/set')).toEqual([{ threadId: THREAD, origin: 'user', status: 'paused' }, { threadId: THREAD, origin: 'user', status: 'active' }]);
      expect(sent('thread/goal/clear')).toEqual([{ threadId: THREAD, origin: 'user' }]);
      expect(goals.at(-1)).toBeUndefined();
    } finally { await session.dispose(); }
  });

  it('acts on a goal while its turn runs, which another command could not', async () => {
    const { session, server, sent, settle } = await open();
    try {
      await session.sendMessage('go');
      note(server, 'turn/started', { threadId: THREAD, turn: { id: 'turn-1', status: 'inProgress' } });
      await settle();
      expect((await session.runtimeInfo()).status).toBe('running');
      await expect(session.executeCommand!('compact', '')).rejects.toThrow('idle');
      await session.executeCommand!('goal', 'pause');
      expect(sent('thread/goal/set')).toHaveLength(1);
    } finally { await session.dispose(); }
  });

  it('answers /goal alone with the goal, or says there is none', async () => {
    const { session } = await open();
    try {
      expect((await session.executeCommand!('goal', '')).text).toContain('No goal');
      await session.executeCommand!('goal', 'ship it');
      expect((await session.executeCommand!('goal', '')).text).toBe('Goal (active): ship it');
    } finally { await session.dispose(); }
  });

  it('refuses an edit without an objective, and passes on what Codex refuses, without changing the goal', async () => {
    const { session, sent } = await open();
    try {
      await expect(session.executeCommand!('goal', 'edit')).rejects.toThrow('/goal edit');
      expect(sent('thread/goal/set')).toEqual([]);
      await expect(session.executeCommand!('goal', 'refuse')).rejects.toThrow('goals are disabled');
      expect((await session.runtimeInfo()).goal).toBeUndefined();
    } finally { await session.dispose(); }
  });
});
