import { afterEach, expect, it, vi } from 'vitest';
import { PROTOCOL_VERSION, type HistoryPage, type ProjectedTimelineEntry } from '@orchardworks/agent-remote-protocol';
import { captureForkContext, ForkStore, contextPrefix, referenceForkContext } from './session-forks.js';
import { RemoteOperationError } from '@orchardworks/agent-remote-web';

const source = { agentId: 'parent', nativeSessionId: 'native-parent', providerId: 'codex', title: 'Parent', hostId: 'local' };
const entry = (seq: number, text: string): ProjectedTimelineEntry => ({ providerId: 'codex', item: { type: 'user_message', text }, timestamp: '2026-09-11T00:00:00Z', seqStart: seq, seqEnd: seq, sourceSeqRanges: [{ startSeq: seq, endSeq: seq }], resources: [], collapsed: [] });
function page(entries: ProjectedTimelineEntry[], hasOlder = false, epoch = 'one'): HistoryPage {
  return { protocolVersion: PROTOCOL_VERSION, type: 'timeline_page', payload: { requestId: 'r', agentId: 'parent', direction: 'tail', epoch, entries, hasOlder, hasNewer: false, reset: false, staleCursor: false, gap: false, error: null, window: { minSeq: 1, maxSeq: 9, nextSeq: 10 }, startCursor: entries[0] ? { epoch, seq: entries[0].seqStart } : null, endCursor: entries.at(-1) ? { epoch, seq: entries.at(-1)!.seqEnd } : null } };
}
afterEach(() => localStorage.clear());
it('allows replacement after the first image input is rejected before native dispatch', async () => {
  const store = new ForkStore('rejected-image');
  const record = store.prepare(await captureForkContext({ fetchTimeline: async () => page([]) }, source));
  await expect(store.send(record.id, '[image #1]', async () => {
    throw new RemoteOperationError('invalid_image_input', 'Image attachment expired.', true);
  }, async () => false, 'expired-attachment')).rejects.toThrow(/expired/);
  const send = vi.fn(async () => {});
  await new ForkStore('rejected-image').send(record.id, '[image #2]', send, async () => false, 'replacement-attachment');
  expect(send).toHaveBeenCalledWith(contextPrefix(record) + '[image #2]');
  expect(store.get(record.id).delivery).toBe('sent');
});
it('captures spanning tool results and the canonical boundary in one response', async () => {
  const tool: ProjectedTimelineEntry = { ...entry(1, ''), seqEnd: 9, item: { type: 'tool_call', callId: 'long-running', name: 'shell', detail: { type: 'shell', command: 'pwd' }, status: 'completed', error: null, result: { content: [{ type: 'text', text: 'late result' }] } } };
  const fetchTimeline = vi.fn().mockResolvedValueOnce(page([tool, entry(3, 'captured')])).mockResolvedValueOnce(page([entry(10, 'later mutation')]));
  const context = await captureForkContext({ fetchTimeline }, source);
  expect(context.text).toContain('late result');
  expect(context.text).toContain('captured');
  expect(context.text).not.toContain('later mutation');
  expect(context.boundary.seq).toBe(9);
  expect(fetchTimeline).toHaveBeenCalledTimes(1);
  expect(fetchTimeline.mock.calls[0]?.slice(1, 4)).toEqual(['tail', undefined, 20_000]);
});
it('rejects incomplete capture without combining independently changing pages', async () => {
  const fetchTimeline = vi.fn().mockResolvedValueOnce(page([entry(3, 'tail')], true)).mockResolvedValueOnce(page([entry(1, 'old')]));
  await expect(captureForkContext({ fetchTimeline }, source)).rejects.toThrow(/fully captured/);
  expect(fetchTimeline).toHaveBeenCalledTimes(1);
});
it('rejects a history gap instead of creating a partial context', async () => {
  const response = page([entry(3, 'tail')]);
  response.payload.gap = true;
  await expect(captureForkContext({ fetchTimeline: async () => response }, source)).rejects.toThrow(/changed/);
});
it('persists the reference and sends the context once across restoration', async () => {
  const context = await captureForkContext({ fetchTimeline: async () => page([entry(1, 'secret context')]) }, source);
  const store = new ForkStore('test');
  const record = store.prepare(context);
  store.bind(record.id, { ...source, agentId: 'child', nativeSessionId: 'native-child', title: 'Fork' });
  const send = vi.fn(async (_text: string) => {});
  await store.send(record.id, 'new question', send, async () => false);
  expect(send.mock.calls[0]?.[0]).toBe(contextPrefix(record) + 'new question');
  const restored = new ForkStore('test');
  expect(restored.find({ ...source, nativeSessionId: 'native-child' })?.source.nativeSessionId).toBe('native-parent');
  await restored.send(record.id, 'next question', send, async () => false);
  expect(send.mock.calls[1]?.[0]).toBe('next question');
});
it('does not replay uncertain first input until native history confirms delivery', async () => {
  const context = await captureForkContext({ fetchTimeline: async () => page([]) }, source);
  const store = new ForkStore('test'); const record = store.prepare(context);
  await expect(store.send(record.id, 'first', async () => { throw new Error('connection lost'); }, async () => false)).rejects.toThrow('connection lost');
  const send = vi.fn(async () => {});
  await expect(new ForkStore('test').send(record.id, 'retry', send, async () => false)).rejects.toThrow(/unknown/);
  expect(send).not.toHaveBeenCalled();
  await store.send(record.id, 'follow up', send, async () => true);
  expect(send).toHaveBeenCalledWith('follow up');
});

it('fails before creation when durable storage is unavailable', async () => {
  const context = await captureForkContext({ fetchTimeline: async () => page([]) }, source);
  const storage = { getItem: () => null, setItem: () => { throw new Error('quota'); } } as unknown as Storage;
  expect(() => new ForkStore('full', storage).prepare(context)).toThrow(/could not be saved/);
});
it('includes tool results but excludes private reasoning and interaction responses', async () => {
  const rows = [entry(1, 'question'), { ...entry(2, ''), item: { type: 'reasoning' as const, text: 'private thinking' } },
    { ...entry(3, ''), item: { type: 'tool_call' as const, callId: 'call-1', name: 'shell', detail: { type: 'shell' as const, command: 'pwd' }, status: 'completed' as const, error: null, result: { content: [{ type: 'text' as const, text: '/workspace' }], exitCode: 0 } } }];
  const context = await captureForkContext({ fetchTimeline: async () => page(rows) }, source);
  expect(context.text).toContain('call-1');
  expect(context.text).toContain('/workspace');
  expect(context.text).not.toContain('private thinking');
});
it('preserves long dialogue without imposing a console character limit', async () => {
  const text = 'Original requirement\n' + 'x'.repeat(500_001) + '\nLatest decision';
  const context = await captureForkContext({ fetchTimeline: async () => page([entry(1, text)]) }, source);
  expect(JSON.parse(context.text)).toEqual([{ role: 'user', text }]);
});
it('bounds verbose tool records while preserving dialogue and tool outcome', async () => {
  const tool: ProjectedTimelineEntry = { ...entry(2, ''), item: { type: 'tool_call', callId: 'large-call', name: 'shell', detail: { type: 'shell', command: 'echo ' + 'x'.repeat(600_000) }, status: 'completed', error: null,
    result: { content: [{ type: 'text', text: 'Start of output\n' + 'x'.repeat(600_000) + '\nFinal error' }], exitCode: 1 } } };
  const context = await captureForkContext({ fetchTimeline: async () => page([entry(1, 'Keep the original requirement'), tool, entry(3, 'Keep the latest decision')]) }, source);
  const rows = JSON.parse(context.text);
  expect(rows[0].text).toBe('Keep the original requirement');
  expect(rows[2].text).toBe('Keep the latest decision');
  expect(context.text.length).toBeLessThan(5_000);
  expect(rows[1].text).toContain('large-call');
  expect(rows[1].text).toContain('Final error');
  expect(rows[1].text).toContain('Start of output');
  expect(rows[1].text).toContain('"exitCode":1');
  expect(rows[1].text).toContain('omitted');
  expect(context.shortenedToolCount).toBe(1);
  const record = new ForkStore('long-tools').prepare(context);
  expect(contextPrefix(record)).toContain('shortenedToolCount');
});
it('acknowledges a confirmed uncertain retry without resending the same question', async () => {
  const store = new ForkStore('retry');
  const record = store.prepare(await captureForkContext({ fetchTimeline: async () => page([]) }, source));
  await expect(store.send(record.id, 'first question', async () => { throw new Error('lost acknowledgement'); }, async () => false)).rejects.toThrow();
  const send = vi.fn(async () => {});
  await new ForkStore('retry').send(record.id, 'first question', send, async () => true);
  expect(send).not.toHaveBeenCalled();
  expect(new ForkStore('retry').get(record.id).delivery).toBe('sent');
});
it('keeps separate forks and fresh delivery state across browser instances', async () => {
  const a = new ForkStore('tabs'); const b = new ForkStore('tabs');
  const context = await captureForkContext({ fetchTimeline: async () => page([]) }, source);
  const first = a.prepare(context); const second = b.prepare(context);
  a.bind(first.id, { ...source, nativeSessionId: 'first' });
  b.bind(second.id, { ...source, nativeSessionId: 'second' });
  expect(new ForkStore('tabs').all()).toHaveLength(2);
  await a.send(first.id, 'sent once', async () => {}, async () => false);
  b.bind(first.id, { ...source, agentId: 'reattached', nativeSessionId: 'first' });
  expect(a.get(first.id).delivery).toBe('sent');
  expect(a.get(first.id).target?.agentId).toBe('reattached');
});

it('captures normalized session references as bounded context without treating them as text fields', async () => {
  const reference = { nativeSessionId: 'child', title: '/root/review' };
  const tool: ProjectedTimelineEntry = { ...entry(1, ''), item: { type: 'tool_call', callId: 'activity', name: 'agent.activity', status: 'completed', error: null,
    detail: { type: 'other', description: 'Agent /root/review: interacted', sessionReference: reference } } };
  const context = await captureForkContext({ fetchTimeline: async () => page([tool]) }, source);
  expect(JSON.parse(JSON.parse(context.text)[0].text).detail.sessionReference).toBe(JSON.stringify(reference));
});

it('stores lightweight source references and sends only reference metadata with the first question', async () => {
  const { referenceForkContext } = await import('./session-forks.js');
  const store = new ForkStore('reference');
  const record = store.prepare(referenceForkContext(source), { sourceNativeSessionId: source.nativeSessionId });
  store.bind(record.id, { ...source, nativeSessionId: 'side', agentId: 'side-agent' });
  const restored = new ForkStore('reference').get(record.id);
  expect(restored.mode).toBe('reference');
  expect('text' in restored).toBe(false);
  const send = vi.fn(async (_text: string) => {});
  await store.send(record.id, 'What changed?', send, async () => false);
  expect(send.mock.calls[0]![0]).toBe(contextPrefix(record) + 'What changed?');
  expect(contextPrefix(record)).toContain('native-parent');
  expect(contextPrefix(record)).not.toContain('history');
  expect(JSON.stringify(restored).length).toBeLessThan(1000);
});


it('restores shared navigation without replaying input or replacing the local delivery ledger', async () => {
  const store = new ForkStore('shared');
  const record = store.prepare(referenceForkContext(source), { sourceNativeSessionId: source.nativeSessionId });
  const target = { ...source, nativeSessionId: 'child', agentId: 'child' };
  store.bind(record.id, target);
  await expect(store.send(record.id, 'uncertain question', async () => { throw new Error('lost'); }, async () => false)).rejects.toThrow();
  const relation = { kind: 'side' as const, id: record.id, createdAt: record.capturedAt, source, target };
  store.setSharedRelations([relation]);
  expect(store.all()).toHaveLength(1);
  expect(store.get(record.id).delivery).toBe('uncertain');
  const mobile = new ForkStore('mobile');
  mobile.setSharedRelations([relation]);
  const restored = mobile.find(target)!;
  expect(restored.remote).toBe(true);
  const send = vi.fn(async () => {});
  await mobile.send(restored.id, 'follow up', send, async () => false);
  expect(send).toHaveBeenCalledExactlyOnceWith('follow up');
  expect(localStorage.getItem('agent-remote-forks:mobile:record:' + record.id)).toBeNull();
  mobile.bind(record.id, { ...target, agentId: 'reattached' });
  expect(mobile.find(target)?.target?.agentId).toBe('reattached');
  mobile.setSharedRelations([]);
  expect(mobile.all()).toEqual([]);
});


it('opens shared navigation when browser storage is unavailable', () => {
  const storage = { getItem() { throw new Error('Storage denied'); } } as unknown as Storage;
  const store = new ForkStore('denied', storage);
  store.setSharedRelations([{ id: 'shared', kind: 'side', createdAt: '2026-09-29T00:00:00.000Z', source,
    target: { ...source, agentId: 'child', nativeSessionId: 'child' } }]);
  store.bind('shared', { ...source, agentId: 'attached', nativeSessionId: 'child' });
  expect(store.get('shared').target?.agentId).toBe('attached');
});

it('applies shared unlink state to a matching local target without losing its delivery ledger', async () => {
  const store = new ForkStore('shared-unlink');
  const record = store.prepare(referenceForkContext(source), { sourceNativeSessionId: source.nativeSessionId });
  const target = { ...source, nativeSessionId: 'side', agentId: 'side-agent' };
  store.bind(record.id, target);
  await expect(store.send(record.id, 'question awaiting receipt', async () => { throw new Error('lost receipt'); }, async () => false)).rejects.toThrow('lost receipt');
  store.setSharedRelations([{ id: 'server-relation', kind: 'side', createdAt: record.capturedAt, source, target, linked: false, revision: 2 }]);
  expect(store.linked()).toEqual([]);
  expect(store.all()).toHaveLength(1);
  expect(store.find(target)).toMatchObject({ id: record.id, relationId: 'server-relation', linked: false, revision: 2,
    delivery: 'uncertain', pendingInput: 'question awaiting receipt', firstInput: 'question awaiting receipt' });
  expect(store.get(record.id)).toMatchObject({ linked: false, revision: 2, delivery: 'uncertain' });
});

it('persists local unlink and uses revisions to reject stale undo while preserving context', async () => {
  const store = new ForkStore('local-unlink');
  const record = store.prepare(await captureForkContext({ fetchTimeline: async () => page([entry(1, 'source context')]) }, source));
  store.bind(record.id, { ...source, nativeSessionId: 'side' });
  store.setLinked(record.id, false, 0);
  const restored = new ForkStore('local-unlink');
  expect(restored.linked()).toEqual([]);
  expect(restored.get(record.id)).toMatchObject({ linked: false, revision: 1, delivery: 'pending' });
  expect(contextPrefix(restored.get(record.id))).toContain('source context');
  expect(() => restored.setLinked(record.id, true, 0)).toThrow(/changed/);
  restored.setLinked(record.id, true, 1);
  expect(restored.linked()).toHaveLength(1);
  expect(restored.get(record.id).revision).toBe(2);
});

it('does not resurrect shared navigation when an older revision arrives after unlink', () => {
  const store = new ForkStore('reordered-relations');
  const relation = { id: 'shared', kind: 'side' as const, createdAt: '2026-10-02T00:00:00.000Z', source,
    target: { ...source, nativeSessionId: 'side', agentId: 'side-agent' } };
  store.setSharedRelations([{ ...relation, linked: false, revision: 3 }]);
  store.setSharedRelations([relation]);
  expect(store.linked()).toEqual([]);
  expect(store.get('shared')).toMatchObject({ linked: false, revision: 3 });
  store.setSharedRelations([{ ...relation, linked: true, revision: 4 }]);
  expect(store.linked().map(item => item.id)).toEqual(['shared']);
});

it('keeps an acknowledged unlink across reload before refresh and after an empty directory response', () => {
  const store = new ForkStore('durable-navigation');
  const record = store.prepare(referenceForkContext(source), { sourceNativeSessionId: source.nativeSessionId });
  const target = { ...source, nativeSessionId: 'side', agentId: 'side-agent' };
  store.bind(record.id, target);
  store.setSharedRelations([{ id: 'server-side', kind: 'side', createdAt: record.capturedAt, source, target, linked: false, revision: 1 }]);
  const restored = new ForkStore('durable-navigation');
  expect(restored.linked()).toEqual([]);
  restored.setSharedRelations([]);
  expect(restored.get(record.id)).toMatchObject({ linked: false, revision: 1, delivery: 'pending' });
  expect(restored.linked()).toEqual([]);
});

it('keeps acknowledged navigation separate from an older tab rewriting its delivery record', () => {
  const store = new ForkStore('old-delivery-writer');
  const record = store.prepare(referenceForkContext(source), { sourceNativeSessionId: source.nativeSessionId });
  const target = { ...source, nativeSessionId: 'side', agentId: 'side-agent' };
  store.bind(record.id, target);
  const old = store.get(record.id);
  const relation = { id: 'server-side', kind: 'side' as const, createdAt: record.capturedAt, source, target };
  store.setSharedRelations([{ ...relation, linked: false, revision: 3 }]);
  localStorage.setItem('agent-remote-forks:old-delivery-writer:record:' + record.id, JSON.stringify({ ...old, delivery: 'sent', firstInput: 'received' }));
  const restored = new ForkStore('old-delivery-writer');
  restored.setSharedRelations([relation]);
  expect(restored.get(record.id)).toMatchObject({ linked: false, revision: 3, delivery: 'sent', firstInput: 'received' });
  restored.setSharedRelations([{ ...relation, linked: true, revision: 4 }]);
  expect(new ForkStore('old-delivery-writer').linked()).toHaveLength(1);
});
