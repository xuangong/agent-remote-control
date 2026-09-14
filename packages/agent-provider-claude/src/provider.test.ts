import { describe, expect, it } from 'vitest';
import { ClaudeAgentProvider } from './provider.js';
import { Channel } from './channel.js';

describe('Claude provider catalog', () => {
  it('maps native catalog identity, title, workspace and timestamps', async () => {
    const provider = new ClaudeAgentProvider({ catalog: {
      async list() { return [{ sessionId: 'native', summary: 'First prompt', customTitle: 'Project notes', cwd: '/work', lastModified: 2000, createdAt: 1000 }]; },
      async info() { return undefined; }, async messages() { return []; },
    } });
    expect(await provider.listSessions()).toEqual([{ nativeSessionId: 'native', providerId: 'claude', title: 'Project notes', workspace: '/work',
      createdAt: '1970-01-01T00:00:01.000Z', updatedAt: '1970-01-01T00:00:02.000Z', state: 'unknown' }]);
  });

  it('refuses foreign, malformed and nonexistent native persistence handles before spawning', async () => {
    const provider = new ClaudeAgentProvider({ catalog: { async list() { return []; }, async info() { return undefined; }, async messages() { return []; } },
      query() { throw new Error('Must not spawn'); } });
    await expect(provider.resumeSession({ providerId: 'codex', sessionId: 'x', opaque: '{}' })).rejects.toThrow(/provider/);
    await expect(provider.resumeSession({ providerId: 'claude', sessionId: '../session', opaque: '{}' })).rejects.toThrow(/identity/);
    await expect(provider.resumeSession({ providerId: 'claude', sessionId: '00000000-0000-4000-8000-000000000000', opaque: '{}' })).rejects.toThrow(/unavailable/);
  });
});


it('reserves a native parent during resume, releases failed loads, and keeps the owner until disposal', async () => {
  let queries = 0;
  let fail = true;
  const provider = new ClaudeAgentProvider({ catalog: { list: async () => [], info: async () => ({ cwd: process.cwd() }) as any,
    messages: async () => [], children: async () => [] }, query: () => {
    queries++;
    const events = new Channel<any>();
    return { [Symbol.asyncIterator]: () => events[Symbol.asyncIterator](), initializationResult: async () => {
      if (fail) throw new Error('fixture initialization failed'); return {};
    }, close: () => events.close(), interrupt: async () => {}, setPermissionMode: async () => {} } as any;
  } });
  const id = '11111111-1111-1111-1111-111111111111';
  const handle = { providerId: 'claude', sessionId: id, opaque: '{}' };
  await expect(provider.resumeSession(handle)).rejects.toThrow('fixture initialization failed');
  fail = false;
  const results = await Promise.allSettled([provider.resumeSession(handle), provider.resumeSession(handle)]);
  const owners = results.flatMap((result) => result.status === 'fulfilled' ? [result.value] : []);
  try {
    expect(owners).toHaveLength(1);
    expect(queries).toBe(2);
    expect(results.find((result) => result.status === 'rejected')).toMatchObject({ reason: expect.objectContaining({ message: 'Claude session is already loaded.' }) });
    await expect(provider.openChildSession(id, 'child')).rejects.toThrow('not a direct child');
    await expect(provider.resumeSession(handle)).rejects.toThrow('already loaded');
  } finally { await Promise.all(owners.map((owner) => owner.dispose())); }
  const reopened = await provider.resumeSession(handle);
  try { expect(queries).toBe(3); } finally { await reopened.dispose(); }
}, 10000);

it('resumes the selected native permission mode and retains it across a saved planning session', async () => {
  const launched: any[] = [];
  const modes: string[] = [];
  const provider = new ClaudeAgentProvider({ catalog: { list: async () => [], info: async () => ({ cwd: process.cwd() }) as any,
    messages: async () => [], children: async () => [] }, query: ({ options }) => {
    launched.push(options);
    const events = new Channel<any>();
    return { [Symbol.asyncIterator]: () => events[Symbol.asyncIterator](), initializationResult: async () => ({ models: [] }),
      setPermissionMode: async (mode: string) => { modes.push(mode); }, close: () => events.close() } as any;
  } });
  const first = await provider.createSession({ sessionId: 'proposed' });
  await first.setSessionSetting!('permissions', 'acceptEdits');
  await first.setPlanning!(true);
  const handle = (await first.runtimeInfo()).persistence!;
  await first.dispose();
  const resumed = await provider.resumeSession(handle);
  try {
    expect(launched[1].permissionMode).toBe('plan');
    await resumed.setPlanning!(false);
    expect(modes).toEqual(['acceptEdits', 'plan', 'acceptEdits']);
  } finally { await resumed.dispose(); }
});
