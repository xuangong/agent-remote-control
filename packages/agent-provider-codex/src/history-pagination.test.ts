import { expect, it } from 'vitest';
import { AgentManager } from '../../agent-remote-relay/src/agent-manager.js';
import { CodexAppServerProvider } from './provider.js';
import { createScriptedAppServer } from './test-utils/scripted-app-server.js';

function fixture() {
  let failOlder = false;
  const turns = Array.from({ length: 23 }, (_, index) => ({ id: `t${index + 1}`, status: 'completed',
    items: [{ id: `a${index + 1}`, type: 'agentMessage', text: `Answer ${index + 1}` }] }));
  const native = createScriptedAppServer({
    'thread/resume': () => ({ thread: { id: 'root', status: { type: 'idle' }, turns: [] } }),
    'thread/read': () => { throw new Error('Full history must not be needed to open a paginated session'); },
    'thread/turns/list': value => {
      const params = value as { limit: number; cursor?: string; sortDirection: string; itemsView: string };
      expect(params).toMatchObject({ limit: 10, sortDirection: 'desc', itemsView: 'full' });
      if (params.cursor && failOlder) throw new Error('Older page temporarily unavailable');
      const offset = Number(params.cursor ?? 0);
      return { data: [...turns].reverse().slice(offset, offset + 10), nextCursor: offset + 10 < turns.length ? String(offset + 10) : null };
    },
    'turn/start': () => {
      native.child.stdout.write(JSON.stringify({ method: 'turn/started', params: { threadId: 'root', turn: { id: 'new' } } }) + '\n');
      return { turn: { id: 'new' } };
    },
  });
  return { native, failOlder: () => { failOlder = true; }, allowOlder: () => { failOlder = false; },
    provider: new CodexAppServerProvider({ spawn: () => native.child }) };
}

it('opens only the newest ten turns, then prepends older pages without changing live positions or runtime state', async () => {
  const f = fixture();
  const manager = await AgentManager.resume({ agentId: 'agent', adapter: f.provider, epoch: 'epoch',
    handle: { providerId: 'codex', sessionId: 'root', opaque: '{}' } });
  try {
    const tail = manager.fetchTimeline({ agentId: 'agent', requestId: 'tail', direction: 'tail', limit: 100 });
    expect(tail.payload.entries.map(entry => entry.turnId)).toEqual(['t14','t15','t16','t17','t18','t19','t20','t21','t22','t23']);
    expect(tail.payload.hasOlder).toBe(true);
    expect(f.native.requests.filter(request => request.method === 'thread/turns/list')).toHaveLength(1);
    expect(f.native.requests.find(request => request.method === 'thread/resume')?.params).toMatchObject({ excludeTurns: true });
    const liveCursor = manager.timelineCursor();
    const before = await manager.loadTimeline({ agentId: 'agent', requestId: 'before', direction: 'before', limit: 100, cursor: tail.payload.startCursor! });
    expect(before.payload.entries.map(entry => entry.turnId)).toEqual(['t4','t5','t6','t7','t8','t9','t10','t11','t12','t13']);
    expect(before.payload.hasOlder).toBe(true);
    expect(manager.timelineCursor()).toEqual(liveCursor);
    const oldest = await manager.loadTimeline({ agentId: 'agent', requestId: 'oldest', direction: 'before', limit: 100, cursor: before.payload.startCursor! });
    expect(oldest.payload.entries.map(entry => entry.turnId)).toEqual(['t1','t2','t3']);
    expect(oldest.payload.hasOlder).toBe(false);
    const all = manager.fetchTimeline({ agentId: 'agent', requestId: 'all', direction: 'tail', limit: 100 });
    expect(new Set(all.payload.entries.map(entry => entry.seqStart)).size).toBe(23);
    expect(all.payload.entries.slice(-10)).toEqual(tail.payload.entries);
    await manager.sendMessage('Continue');
    await expect.poll(() => manager.snapshot().payload.status).toBe('running');
  } finally { await manager.close(); }
});

it('keeps a failed older page retryable and coalesces concurrent requests for the same page', async () => {
  const f = fixture();
  const manager = await AgentManager.resume({ agentId: 'agent', adapter: f.provider, epoch: 'epoch',
    handle: { providerId: 'codex', sessionId: 'root', opaque: '{}' } });
  try {
    const request = { agentId: 'agent', requestId: 'before', direction: 'before' as const, limit: 100, cursor: { epoch: 'epoch', seq: 1 } };
    f.failOlder();
    await expect(manager.loadTimeline(request)).rejects.toThrow('Older page temporarily unavailable');
    expect(manager.snapshot().payload.runtimeInfo.status).toBe('idle');
    f.allowOlder();
    const pages = await Promise.all([manager.loadTimeline(request), manager.loadTimeline(request)]);
    expect(pages[0]).toEqual(pages[1]);
    expect(pages[0]!.payload.entries).toHaveLength(10);
    expect(f.native.requests.filter(request => request.method === 'thread/turns/list')).toHaveLength(3);
  } finally { await manager.close(); }
});
