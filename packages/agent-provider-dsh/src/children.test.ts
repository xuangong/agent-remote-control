import { expect, it } from 'vitest';
import type { AgentSession, ProviderStreamItem } from '@orchardworks/agent-provider-sdk';
import { DshChildSessions } from './children.js';

function fixture(options: { interrupt?: boolean; mode?: 'continuable' | 'one-shot' } = {}) {
  const listeners = new Map<string, Set<(...args: any[]) => void>>();
  const history = [
    { type: 'subagent/descriptor', seq: 0, time: 10, data: {} },
    { type: 'user/message', seq: 1, time: 11, data: { id: 'prompt', source: { kind: 'user' }, content: [{ type: 'text', text: 'Child prompt' }] } },
  ];
  const child = { id: 'child', header: { id: 'child', parentSession: 'parent', origin: 'subagent', createdAt: 10, cwd: '/workspace' }, snapshotEvents: () => [...history] };
  let released = 0;
  let resident = true;
  let parent = 'parent';
  let interrupted = false;
  const mode = options.mode ?? 'continuable';
  const context = {
    get(name: string) { return (this as any)[name]; },
    on(name: string, listener: (...args: any[]) => void) { const set = listeners.get(name) ?? new Set(); set.add(listener); listeners.set(name, set); return () => set.delete(listener); },
    agents: { get: (id: string) => resident && id === 'child' ? { status: 'running', session: child } : undefined },
    subagents: { listChildren: async (id: string) => id === parent ? [{ kind: 'child', id: 'child', mode, label: 'Research', activity: resident ? 'running' : 'inactive' }] : [] },
    sessionQuery: { observeSession: async () => ({ header: { ...child.header, parentSession: parent }, inheritedEventCount: 0,
      source: resident ? 'live' : 'prepared', events: [...history], projections: { values: { subagent: { mode, label: 'Research', seq: 0 } } },
      [Symbol.dispose]() { released++; } }) },
  };
  if (options.interrupt) Object.assign(context.subagents, {
    interruptByParent(childId: string, parentId: string, requestedMode: string) {
      if (childId !== 'child' || parentId !== 'parent' || requestedMode !== 'continuable') throw new Error('Invalid native child address.');
      interrupted = true;
      return { accepted: true };
    },
  });
  const append = (text: string) => {
    const event = { type: 'user/message', seq: history.length, time: 20 + history.length,
      data: { id: `msg-${history.length}`, source: { kind: 'user' }, content: [{ type: 'text', text }] } };
    history.push(event);
    for (const listener of listeners.get('session/event') ?? []) listener(child, event);
  };
  return { children: new DshChildSessions(context), append, context, history, child, released: () => released, interrupted: () => interrupted,
    save: () => { resident = false; }, move: () => { parent = 'other'; } };
}

it('discovers direct native children and opens a read-only independent history without activation', async () => {
  const f = fixture();
  expect(await f.children.list('parent')).toMatchObject([{ nativeSessionId: 'child', title: 'Research', status: 'running', observation: 'live', createdAt: new Date(10).toISOString() }]);
  const view = await f.children.open('parent', 'child');
  expect(view.capabilities).toMatchObject({ sendMessage: false, steer: false, cancel: false, sessionSettings: false, commands: false });
  const stream = view.observe()[Symbol.asyncIterator]();
  const seen: ProviderStreamItem[] = [];
  while (true) { const item = await stream.next(); seen.push(item.value!); if (item.value?.type === 'history_boundary') break; }
  expect(seen).toContainEqual(expect.objectContaining({ event: expect.objectContaining({ item: expect.objectContaining({ type: 'user_message', text: 'Child prompt' }) }) }));
  expect(seen.some((item) => item.type === 'observation' && item.event.type === 'timeline' && item.event.item.type === 'error')).toBe(false);
  await expect(view.sendMessage('unowned input')).rejects.toThrow('read-only');
  f.append('Live child input');
  const next = await stream.next();
  expect(next.value).toMatchObject({ event: { type: 'timeline', item: { type: 'user_message', text: 'Live child input' } } });
  await view.dispose();
  expect(f.released()).toBeGreaterThan(0);
  expect(f.context.agents.get('child')?.status).toBe('running');
});

it('observes saved child history without loading an agent and rejects a foreign parent', async () => {
  const f = fixture(); f.save();
  expect(await f.children.list('parent')).toMatchObject([{ observation: 'saved_history', status: 'closed' }]);
  await expect(f.children.open('other', 'child')).rejects.toThrow('direct child');
  const view = await f.children.open('parent', 'child');
  expect(await view.runtimeInfo()).toMatchObject({ sessionId: 'child', status: 'closed' });
  await view.dispose();
});

it('rejects stale lineage and ancestor-inherited child descriptors', async () => {
  const f = fixture();
  const original = f.context.sessionQuery.observeSession;
  f.context.sessionQuery.observeSession = async () => ({ ...await original(), inheritedEventCount: 1 });
  await expect(f.children.open('parent', 'child')).rejects.toThrow('descriptor');
  f.context.sessionQuery.observeSession = async () => ({ ...await original(), header: { ...f.child.header, parentSession: 'foreign' } });
  await expect(f.children.open('parent', 'child')).rejects.toThrow('parent');
});

it('buffers native events during the initial snapshot without duplication', async () => {
  const f = fixture();
  const original = f.context.sessionQuery.observeSession;
  let reads = 0;
  f.context.sessionQuery.observeSession = async () => { if (++reads === 1) f.append('Racing input'); return original(); };
  const view = await f.children.open('parent', 'child');
  const texts: string[] = [];
  for await (const item of view.observe()) {
    if (item.type === 'history_boundary') break;
    if (item.event.type === 'timeline' && item.event.item.type === 'user_message') texts.push(item.event.item.text);
  }
  expect(texts).toEqual(['Child prompt', 'Racing input']);
  await view.dispose();
});

it('rejects a new native lifecycle racing an older initial observation', async () => {
  const f = fixture();
  const original = f.context.sessionQuery.observeSession;
  f.context.sessionQuery.observeSession = async () => {
    const old = await original();
    f.child.header.createdAt = 30;
    f.append('Different lifecycle');
    return old;
  };
  await expect(f.children.open('parent', 'child')).rejects.toThrow('lifecycle');
});

it('fails an attached observer on recreated identity and native sequence gaps', async () => {
  for (const mode of ['lifecycle', 'gap']) {
    const f = fixture();
    const view = await f.children.open('parent', 'child');
    const stream = view.observe()[Symbol.asyncIterator]();
    while ((await stream.next()).value?.type !== 'history_boundary') { /* Drain the immutable prefix. */ }
    if (mode === 'lifecycle') f.child.header.createdAt = 30;
    else f.history.push({ ...f.history[0]!, seq: 2 });
    f.append('Invalid suffix');
    expect((await stream.next()).value).toMatchObject({ event: { type: 'runtime_updated', runtimeInfo: { status: 'failed' } } });
    await expect(stream.next()).rejects.toThrow(mode === 'lifecycle' ? 'lifecycle' : 'sequence');
    expect(f.context.agents.get('child')).toBeDefined();
  }
});

it('bounds an entire child catalog read, including late native leases', async () => {
  const f = fixture();
  let reads = 0;
  f.context.subagents.listChildren = async () => Array.from({ length: 5 }, () => ({ kind: 'child', id: 'child', mode: 'continuable', label: 'Child', activity: 'running' }));
  const original = f.context.sessionQuery.observeSession;
  f.context.sessionQuery.observeSession = async () => { reads++; await new Promise((resolve) => setTimeout(resolve, 25)); return original(); };
  const source = new DshChildSessions(f.context, 60);
  await expect(source.list('parent')).rejects.toThrow('timed out');
  await new Promise((resolve) => setTimeout(resolve, 35));
  expect(reads).toBeLessThan(5);
  expect(f.released()).toBe(reads);
});

it('keeps parent history and input available when child discovery fails, with a live diagnostic', async () => {
  const f = fixture();
  f.context.subagents.listChildren = async () => { throw new Error('catalog offline'); };
  const { DshObservationQueue } = await import('./children.js');
  const queue = new DshObservationQueue<ProviderStreamItem>();
  let disposed = false, input = '';
  const base: AgentSession = {
    capabilities: { history: true, sendMessage: true, interactions: {} },
    observe: () => queue,
    async runtimeInfo() { return { providerId: 'dsh', sessionId: 'parent', status: 'idle' }; },
    async sendMessage(text) { input = text; },
    async respondToInteraction() {},
    async dispose() { disposed = true; queue.close(); },
  };
  const view = f.children.decorate('parent', base);
  await view.runtimeInfo();
  const stream = view.observe()[Symbol.asyncIterator]();
  queue.push({ type: 'history_boundary' });
  expect((await stream.next()).value).toEqual({ type: 'history_boundary' });
  expect((await stream.next()).value).toMatchObject({ event: { type: 'timeline', item: { type: 'error', message: expect.stringContaining('catalog offline') } } });
  await view.sendMessage('Still usable');
  expect(input).toBe('Still usable'); expect(disposed).toBe(false);
  await view.dispose();
});


it('cancels a live continuable child synchronously through its native parent address without completing its turn', async () => {
  const f = fixture({ interrupt: true });
  const view = await f.children.open('parent', 'child');
  expect(view.capabilities).toMatchObject({ cancel: true, sendMessage: false, queueMessage: false, steer: false });
  const stream = view.observe()[Symbol.asyncIterator]();
  while ((await stream.next()).value?.type !== 'history_boundary') { /* Drain history before admission. */ }
  f.context.subagents.listChildren = async () => { throw new Error('Cancel must not await catalog reads.'); };
  f.context.sessionQuery.observeSession = async () => { throw new Error('Cancel must not await history reads.'); };
  const get = f.context.agents.get;
  f.context.agents.get = (id) => { if (id === 'parent') throw new Error('The parent may be offline.'); return get(id); };
  const cancellation = view.cancel!();
  expect(f.interrupted()).toBe(true);
  await cancellation;
  expect(await view.runtimeInfo()).toMatchObject({ status: 'running' });
  f.append('Still waiting for native termination');
  expect((await stream.next()).value).toMatchObject({ event: { type: 'timeline', item: { type: 'user_message', text: 'Still waiting for native termination' } } });
  await expect(view.sendMessage('not supported')).rejects.toThrow('read-only');
  await view.dispose();
  expect(view.capabilities.cancel).toBe(false);
  await expect(view.cancel!()).rejects.toThrow();
});

it('never grants child cancellation to saved histories, one-shot children, or incomplete native services', async () => {
  for (const kind of ['saved', 'prepared-live', 'one-shot', 'missing-service', 'missing-registry', 'missing-header']) {
    const f = fixture({ interrupt: kind !== 'missing-service', mode: kind === 'one-shot' ? 'one-shot' : 'continuable' });
    if (kind === 'saved') f.save();
    if (kind === 'prepared-live') {
      const read = f.context.sessionQuery.observeSession;
      f.context.sessionQuery.observeSession = async () => ({ ...await read(), source: 'prepared' });
    }
    if (kind === 'missing-registry') Object.assign(f.context, { agents: {} });
    if (kind === 'missing-header') Object.assign(f.context.agents, { get: () => ({ status: 'running' }) });
    const view = await f.children.open('parent', 'child');
    expect(view.capabilities.cancel, kind).toBe(false);
    await expect(view.cancel!(), kind).rejects.toThrow();
    expect(f.interrupted(), kind).toBe(false);
    await view.dispose();
  }
});

it('rejects cancellation after native lifecycle replacement, changed parent, disposal, or service removal', async () => {
  for (const kind of ['lifecycle', 'parent', 'origin', 'disposal', 'service']) {
    const f = fixture({ interrupt: true });
    const view = await f.children.open('parent', 'child');
    expect(view.capabilities.cancel).toBe(true);
    if (kind === 'lifecycle') f.child.header.createdAt = 30;
    if (kind === 'parent') f.child.header.parentSession = 'other';
    if (kind === 'origin') f.child.header.origin = 'root';
    if (kind === 'disposal') f.save();
    if (kind === 'service') Object.assign(f.context.subagents, { interruptByParent: undefined });
    expect(view.capabilities.cancel, kind).toBe(false);
    await expect(view.cancel!(), kind).rejects.toThrow();
    expect(f.interrupted(), kind).toBe(false);
    await view.dispose();
  }
});

it('propagates native cancellation rejection without synthesizing child termination', async () => {
  const f = fixture({ interrupt: true });
  Object.assign(f.context.subagents, { interruptByParent() { throw new Error('Native authority rejected.'); } });
  const view = await f.children.open('parent', 'child');
  await expect(view.cancel!()).rejects.toThrow('Native authority rejected.');
  expect(await view.runtimeInfo()).toMatchObject({ status: 'running' });
  expect(f.interrupted()).toBe(false);
  await view.dispose();
});


it('bounds canonical child validation across catalog and history with one deadline', async () => {
  const f = fixture();
  const source = new DshChildSessions(f.context, 60);
  const view = await source.open('parent', 'child');
  const list = f.context.subagents.listChildren;
  const read = f.context.sessionQuery.observeSession;
  f.context.subagents.listChildren = async (id) => { await new Promise(resolve => setTimeout(resolve, 35)); return list(id); };
  f.context.sessionQuery.observeSession = async () => { await new Promise(resolve => setTimeout(resolve, 35)); return read(); };
  await expect(source.validate(view)).rejects.toThrow('timed out');
  await new Promise(resolve => setTimeout(resolve, 30));
  expect(f.released()).toBe(2);
  await view.dispose();
});


it('requires a synchronous native cancellation receipt without inferring turn completion', async () => {
  const f = fixture({ interrupt: true });
  Object.assign(f.context.subagents, { interruptByParent() { return { accepted: false }; } });
  const view = await f.children.open('parent', 'child');
  await expect(view.cancel!()).rejects.toThrow('not acknowledged');
  expect(await view.runtimeInfo()).toMatchObject({ status: 'running' });
  await view.dispose();
});
