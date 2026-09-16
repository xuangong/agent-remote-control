import { describe, expect, it } from 'vitest';
import type { ProviderStreamItem } from '@agent-remote-controller/agent-provider-sdk';
import { CodexAppServerProvider } from './provider.js';
import { createScriptedAppServer } from './test-utils/scripted-app-server.js';

const modes = { data: [
  { name: 'Default', mode: 'default', model: 'test-model', reasoning_effort: null, developer_instructions: null },
  { name: 'Plan', mode: 'plan', model: 'test-model', reasoning_effort: 'medium', developer_instructions: 'Plan carefully.' },
] };

async function openPlanning(available = true, planning = false, startTurn = (_params: unknown): unknown => ({ turn: { id: 'turn-1' } })) {
  const server = createScriptedAppServer({
    'collaborationMode/list': () => available ? modes : { data: [] },
    'thread/start': () => ({ thread: { id: 'thread-plan' }, model: 'test-model', cwd: '/workspace' }),
    'turn/start': startTurn,
  });
  const provider = new CodexAppServerProvider({ spawn: () => server.child });
  const session = await provider.createSession({ sessionId: 'local', planning });
  const iterator = session.observe()[Symbol.asyncIterator]();
  await iterator.next();
  const notify = (method: string, params: object) => server.child.stdout.write(`${JSON.stringify({
    method, params: { threadId: 'thread-plan', turnId: 'turn-1', ...params },
  })}\n`);
  return { server, session, iterator, notify };
}

async function nextEvent(iterator: AsyncIterator<ProviderStreamItem>, type: string) {
  for (let count = 0; count < 20; count += 1) {
    const item = await iterator.next();
    if (item.done) throw new Error('Observation ended');
    if (item.value.type === 'observation' && item.value.event.type === type) return item.value.event;
  }
  throw new Error(`No ${type} event`);
}

describe('Codex planning', () => {
  it('discovers planning, switches idle sessions, and returns to native default collaboration', async () => {
    const { session, server } = await openPlanning();
    expect(session.capabilities.planning).toBe(true);
    expect(session.capabilities.interactions.planApproval).toBe(true);
    await session.setPlanning?.(true);
    await session.sendMessage('Plan the change');
    expect(server.requests.filter(({ method }) => method === 'turn/start')[0]?.params).toMatchObject({
      collaborationMode: { mode: 'plan', settings: { model: 'test-model' } },
    });
    await session.dispose();
  });

  it('does not claim or accept planning when discovery has no supported collaboration pair', async () => {
    const { session } = await openPlanning(false);
    expect(session.capabilities.planning).toBe(false);
    await expect(session.setPlanning?.(true)).rejects.toThrow('unsupported');
    await session.dispose();
    await expect(openPlanning(false, true)).rejects.toThrow('unsupported');
  });

  it('propagates discovery failures instead of creating a partially initialized session', async () => {
    const server = createScriptedAppServer({
      'collaborationMode/list': () => { throw new Error('Native discovery failed'); },
      'thread/start': () => ({ thread: { id: 'thread-plan' } }),
    });
    const provider = new CodexAppServerProvider({ spawn: () => server.child });
    await expect(provider.createSession({ sessionId: 'local' })).rejects.toThrow('Native discovery failed');
    expect(server.requests.some(({ method }) => method === 'thread/start')).toBe(false);
  });

  it('preserves a terminal turn notification that precedes the turn start response', async () => {
    const server = createScriptedAppServer({
      'collaborationMode/list': () => modes,
      'thread/start': () => ({ thread: { id: 'thread-plan' } }),
      'turn/start': () => {
        for (const [method, status] of [['turn/started', 'inProgress'], ['turn/completed', 'completed']]) {
          server.child.stdout.write(`${JSON.stringify({ method, params: { threadId: 'thread-plan', turn: { id: 'turn-fast', status } } })}\n`);
        }
        return { turn: { id: 'turn-fast' } };
      },
    });
    const provider = new CodexAppServerProvider({ spawn: () => server.child });
    const session = await provider.createSession({ sessionId: 'local', model: 'test-model' });
    await session.sendMessage('Quick reply');
    expect((await session.runtimeInfo()).status).toBe('idle');
    await expect(session.setPlanning?.(true)).resolves.toBeUndefined();
    await session.dispose();
  });

  it('rejects mode changes while a turn or question is pending', async () => {
    const { session, notify, iterator } = await openPlanning();
    expect(session.capabilities.planning).toBe(true);
    notify('turn/started', { turn: { id: 'turn-1' } });
    await nextEvent(iterator, 'turn_started');
    await expect(session.setPlanning?.(true)).rejects.toThrow('idle');
    await session.dispose();
  });

  it('approves a completed native plan and starts exactly one default-mode implementation turn', async () => {
    const { session, server, iterator, notify } = await openPlanning(true, true);
    expect(session.capabilities.interactions.planApproval).toBe(true);
    notify('turn/started', { turn: { id: 'turn-1' } });
    notify('item/completed', { item: { type: 'plan', id: 'plan-1', text: '# Plan\n\nRead the README.' } });
    notify('turn/completed', { turn: { id: 'turn-1', status: 'completed' } });
    const event = await nextEvent(iterator, 'interaction_requested');
    if (event.type !== 'interaction_requested') throw new Error('Missing plan');
    expect(event.request).toMatchObject({ kind: 'plan_approval', plan: '# Plan\n\nRead the README.' });
    await expect(session.setPlanning?.(false)).rejects.toThrow('pending');
    await session.respondToInteraction(event.request.requestId, { kind: 'plan_approval', action: 'approve_and_resume' });
    expect(server.requests.filter(({ method }) => method === 'turn/start')).toHaveLength(1);
    expect(server.requests.find(({ method }) => method === 'turn/start')?.params).toMatchObject({ collaborationMode: { mode: 'default' } });
    expect((await session.runtimeInfo()).planning).toEqual({ active: false });
    await expect(session.respondToInteraction(event.request.requestId, { kind: 'plan_approval', action: 'approve_and_resume' })).rejects.toThrow('No pending');
    await session.dispose();
  });

  it.each(['Read only the README.', undefined])('rejects a plan with feedback %s and keeps planning active', async (feedback) => {
    const { session, server, iterator, notify } = await openPlanning(true, true);
    notify('turn/started', { turn: { id: 'turn-1' } });
    notify('item/completed', { item: { type: 'plan', id: 'plan-1', text: 'Inspect the repository.' } });
    notify('turn/completed', { turn: { id: 'turn-1', status: 'completed' } });
    const event = await nextEvent(iterator, 'interaction_requested');
    if (event.type !== 'interaction_requested') throw new Error('Missing plan');
    await expect(session.respondToInteraction(event.request.requestId, {
      kind: 'plan_approval', action: 'approve_and_resume', feedback: 'Change it',
    } as never)).rejects.toThrow('feedback');
    await session.respondToInteraction(event.request.requestId, { kind: 'plan_approval', action: 'reject', ...(feedback ? { feedback } : {}) });
    const starts = server.requests.filter(({ method }) => method === 'turn/start');
    expect(starts).toHaveLength(feedback ? 1 : 0);
    if (feedback) expect(starts[0]?.params).toMatchObject({
      collaborationMode: { mode: 'plan' }, input: [{ text: expect.stringContaining(feedback) }],
    });
    expect((await session.runtimeInfo()).planning).toEqual({ active: true });
    await expect(session.respondToInteraction(event.request.requestId, { kind: 'plan_approval', action: 'reject' })).rejects.toThrow('No pending');
    await session.dispose();
  });

  it.each(['approve_and_resume', 'reject'] as const)('keeps plan review retryable when the %s continuation is rejected', async (action) => {
    let starts = 0;
    const { session, server, iterator, notify } = await openPlanning(true, true, () => {
      if (++starts === 1) throw new Error('Native turn start rejected');
      return { turn: { id: 'turn-retry' } };
    });
    notify('turn/started', { turn: { id: 'turn-1' } });
    notify('item/completed', { item: { type: 'plan', id: 'plan-1', text: 'Inspect README.' } });
    notify('turn/completed', { turn: { id: 'turn-1', status: 'completed' } });
    const event = await nextEvent(iterator, 'interaction_requested');
    if (event.type !== 'interaction_requested') throw new Error('Missing plan');
    const response = action === 'reject'
      ? { kind: 'plan_approval' as const, action, feedback: 'Read the whole README.' }
      : { kind: 'plan_approval' as const, action };
    const observed: string[] = [];
    const consume = (async () => {
      for (;;) {
        const next = await iterator.next();
        if (next.done) return;
        if (next.value.type === 'observation') observed.push(next.value.event.type);
      }
    })();
    await expect(session.respondToInteraction(event.request.requestId, response)).rejects.toThrow('Native turn start rejected');
    expect((await session.runtimeInfo()).planning).toEqual({ active: true });
    expect((await session.runtimeInfo()).status).toBe('idle');
    await session.respondToInteraction(event.request.requestId, response);
    expect((await session.runtimeInfo()).planning).toEqual({ active: action === 'reject' });
    expect((await session.runtimeInfo()).status).toBe('running');
    expect(server.requests.filter(({ method }) => method === 'turn/start')).toHaveLength(2);
    await session.dispose();
    await consume;
    expect(observed.filter((type) => type === 'interaction_resolved')).toHaveLength(1);
  });

  it('does not retry a continuation whose native completion precedes an RPC error', async () => {
    const { session, server, iterator, notify } = await openPlanning(true, true, () => {
      notify('turn/started', { turn: { id: 'turn-accepted' } });
      notify('turn/completed', { turn: { id: 'turn-accepted', status: 'completed' } });
      throw new Error('Late acknowledgement failed');
    });
    notify('turn/started', { turn: { id: 'turn-1' } });
    notify('item/completed', { item: { type: 'plan', id: 'plan-1', text: 'Inspect README.' } });
    notify('turn/completed', { turn: { id: 'turn-1', status: 'completed' } });
    const event = await nextEvent(iterator, 'interaction_requested');
    if (event.type !== 'interaction_requested') throw new Error('Missing plan');
    const response = { kind: 'plan_approval' as const, action: 'approve_and_resume' as const };
    await expect(session.respondToInteraction(event.request.requestId, response)).resolves.toBeUndefined();
    expect((await session.runtimeInfo()).planning).toEqual({ active: false });
    expect((await session.runtimeInfo()).status).toBe('idle');
    await expect(session.respondToInteraction(event.request.requestId, response)).rejects.toThrow('No pending');
    expect(server.requests.filter(({ method }) => method === 'turn/start')).toHaveLength(1);
    await session.dispose();
  });
});
