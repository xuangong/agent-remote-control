import { expect, it } from 'vitest';
import { CodexAppServerProvider } from './provider.js';
import { createScriptedAppServer } from './test-utils/scripted-app-server.js';

function fixture(branchEnd = 't2', sourceStatus = 'completed', branchStatus = 'completed') {
  const turn = (id: string, status = sourceStatus) => ({ id, status, items: [{ id: `message-${id}`, type: 'userMessage', content: [{ type: 'text', text: id }] }] });
  const app = createScriptedAppServer({
    'thread/read': () => ({ thread: { id: 'A', cwd: '/workspace', source: 'appServer' } }),
    'thread/turns/list': params => {
      const request = params as { threadId: string; limit: number };
      return { data: (request.threadId === 'A' ? [turn('t2'), turn('t1')] : [turn(branchEnd, branchStatus), turn('t1')]).slice(0, request.limit), nextCursor: null };
    },
    'thread/fork': () => ({ thread: { id: 'B', cwd: '/workspace' }, model: 'model' }),
  });
  return { app, provider: new CodexAppServerProvider({ spawn: () => app.child }) };
}

it('forks all settled native history without sending a model turn or mutating the source', async () => {
  const { app, provider } = fixture();
  const session = await provider.forkSession('A');
  try {
    expect(await session.runtimeInfo()).toMatchObject({ sessionId: 'B', cwd: '/workspace' });
    const prompts: string[] = [];
    for await (const row of session.observe()) {
      if (row.type === 'history_boundary') break;
      if (row.event.type === 'timeline' && row.event.item.type === 'user_message') prompts.push(row.event.item.text);
    }
    expect(prompts).toEqual(['t1', 't2']);
    expect(app.requests.filter(row => row.method === 'thread/fork').map(row => row.params)).toEqual([
      expect.objectContaining({ threadId: 'A', cwd: '/workspace', excludeTurns: true }),
    ]);
    expect(app.requests.some(row => ['turn/start', 'thread/rollback', 'thread/revert'].includes(row.method))).toBe(false);
  } finally { await session.dispose(); }
});

it('rejects a running source before creating a candidate', async () => {
  const { app, provider } = fixture('t2', 'inProgress');
  await expect(provider.forkSession('A')).rejects.toThrow(/finish|settled/i);
  expect(app.requests.some(row => row.method === 'thread/fork')).toBe(false);
});

it('does not publish a candidate whose inherited history ends at another boundary', async () => {
  const { provider } = fixture('unexpected');
  await expect(provider.forkSession('A')).rejects.toThrow(/boundary/i);
});

it('rejects a candidate inheriting an unsettled turn even when its turn identity matches', async () => {
  const { provider } = fixture('t2', 'completed', 'inProgress');
  await expect(provider.forkSession('A').then(async session => {
    await session.dispose(); return 'unexpectedly accepted';
  })).rejects.toThrow(/boundary|settled/i);
});
