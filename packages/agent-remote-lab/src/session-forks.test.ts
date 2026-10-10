import { afterEach, expect, it, vi } from 'vitest';
import { PROTOCOL_VERSION, type HistoryPage, type ProjectedTimelineEntry } from '@orchardworks/agent-remote-protocol';
import { captureForkContext, ForkStore, contextPrefix, referenceForkContext } from './session-forks.js';
import type { SessionRelation } from '@orchardworks/agent-remote-hosted/session-relations';
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
  const target = { ...source, hostId: 'host', agentId: 'child', nativeSessionId: 'child' };
  store.setSharedRelations([{ id: 'shared', kind: 'side', createdAt: '2026-09-29T00:00:00.000Z', source: { ...source, hostId: 'host' }, target,
    hostLocator: { hostId: 'host', controllerId: 'installation' }, nativeSourceRef: { controllerId: 'installation', providerId: source.providerId, nativeSessionId: source.nativeSessionId } }]);
  const observed = store.all()[0]!;
  store.bind(observed.id, { ...target, agentId: 'attached' });
  expect(store.get(observed.id).target?.agentId).toBe('attached');
  expect(() => store.bind('shared', { ...target, agentId: 'alias' })).toThrow('unavailable');
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


it('retains immutable reference delivery while projecting a different current source', async () => {
  const original = { ...source, hostId: 'host-P' };
  const current = { ...source, hostId: 'host-Q', providerId: 'claude', nativeSessionId: 'B', agentId: 'B-agent', title: 'Current B' };
  const target = { ...original, nativeSessionId: 'X', agentId: 'X-agent' };
  const store = new ForkStore('immutable-reference');
  const options = { sourceNativeSessionId: original.nativeSessionId, creationSource: { providerId: original.providerId, nativeSessionId: original.nativeSessionId }, cwd: '/original', model: 'original-model' };
  const record = store.prepare(referenceForkContext(original), options, [], 'creation-operation');
  store.bind(record.id, target);
  store.setSharedRelations([{ id: record.id, kind: 'side', createdAt: record.capturedAt, source: current, target,
    nativeSourceRef: { controllerId: 'installation-P', providerId: original.providerId, nativeSessionId: original.nativeSessionId },
    hostLocator: { hostId: 'host-P', controllerId: 'installation-P' }, revision: 2, roleRevision: 3 }]);
  expect(store.get(record.id).source).toEqual(original);
  const { sideNavigationSource } = await import('./session-forks.js');
  expect(sideNavigationSource(store.get(record.id))).toEqual(current);
  store.bind(record.id, { ...target, agentId: 'X-reattached' });
  store.markConfigured(record.id);
  store.finishCreation(record.id);
  const restored = new ForkStore('immutable-reference').get(record.id);
  expect(restored).toMatchObject({ source: original, options, target: { ...target, agentId: 'X-reattached' }, configured: true });
  expect(restored.creationKey).toBeUndefined();
  expect(restored.revision).toBe(2);
  const sent: string[] = [];
  await store.send(record.id, 'first', async input => { sent.push(input); }, async () => false);
  expect(sent).toEqual([`<source-session-reference>${JSON.stringify({ id: record.id, sourceSession: 'native-parent' })}</source-session-reference>\n\nfirst`]);
  expect(new ForkStore('immutable-reference').get(record.id)).toMatchObject({ source: original, options, delivery: 'sent', target: { nativeSessionId: 'X' } });
});

it('does not configure or complete a shared-only delivery ledger', () => {
  const store = new ForkStore('remote-delivery');
  const target = { ...source, nativeSessionId: 'X', agentId: 'X-agent' };
  store.setSharedRelations([{ id: 'remote', kind: 'side', createdAt: '2026-10-10T00:00:00.000Z', source, target }]);
  store.markConfigured('remote');
  store.finishCreation('remote');
  expect(store.get('remote').configured).toBeUndefined();
  expect(localStorage.getItem('agent-remote-forks:remote-delivery:record:remote')).toBeNull();
});

it('does not combine a local delivery with a different Host or provider through a bare relation ID', async () => {
  const original = { ...source, hostId: 'host-P' };
  const target = { ...original, nativeSessionId: 'X', agentId: 'X-agent' };
  const current = { ...original, providerId: 'claude', nativeSessionId: 'B' };
  const store = new ForkStore('identity-collision');
  const record = store.prepare(referenceForkContext(original), { sourceNativeSessionId: original.nativeSessionId });
  store.bind(record.id, target);
  store.setSharedRelations([{ id: record.id, kind: 'side', createdAt: record.capturedAt, source: current, target,
    nativeSourceRef: { controllerId: 'installation', providerId: 'other-provider', nativeSessionId: original.nativeSessionId }, hostLocator: { hostId: 'host-P', controllerId: 'installation' } }]);
  const { sideNavigationSource } = await import('./session-forks.js');
  expect(sideNavigationSource(store.get(record.id))).toEqual(original);
  expect(store.all()).toHaveLength(2);
  store.setSharedRelations([{ id: record.id, kind: 'side', createdAt: record.capturedAt, source: { ...current, hostId: 'other-host' }, target,
    nativeSourceRef: { controllerId: 'installation', providerId: original.providerId, nativeSessionId: original.nativeSessionId }, hostLocator: { hostId: 'other-host', controllerId: 'installation' } }]);
  expect(sideNavigationSource(store.get(record.id))).toEqual(original);
  expect(store.all()).toHaveLength(2);
});

it('keeps ambiguous missing-controller navigation separate from the local delivery', async () => {
  const original = { ...source, hostId: 'host-P' };
  const target = { ...original, nativeSessionId: 'X' };
  const store = new ForkStore('ambiguous-controller');
  const record = store.prepare(referenceForkContext(original), { sourceNativeSessionId: original.nativeSessionId });
  store.bind(record.id, target);
  store.setSharedRelations(['one', 'two'].map(controllerId => ({ id: record.id, kind: 'side' as const, createdAt: record.capturedAt,
    source: { ...original, nativeSessionId: 'B', providerId: 'claude' }, target,
    nativeSourceRef: { controllerId, providerId: original.providerId, nativeSessionId: original.nativeSessionId }, hostLocator: { hostId: 'host-P', controllerId } })));
  const { sideNavigationSource } = await import('./session-forks.js');
  expect(sideNavigationSource(store.get(record.id))).toEqual(original);
  expect(store.all()).toHaveLength(3);
});


it('retains snapshot provenance through uncertain settlement and newer navigation revisions', async () => {
  const original = { ...source, hostId: 'host' };
  const target = { ...original, nativeSessionId: 'X', agentId: 'X-agent' };
  const current = { ...original, providerId: 'claude', nativeSessionId: 'B', agentId: 'B-agent' };
  const store = new ForkStore('snapshot-settlement');
  const context = { source: original, capturedAt: '2026-10-10T00:00:00.000Z', boundary: { epoch: 'one', seq: 1 }, itemCount: 1, text: '[{"role":"user","text":"captured A"}]' };
  const record = store.prepare(context, { cwd: '/A' });
  store.bind(record.id, target);
  const relation = { id: 'shared', kind: 'side' as const, createdAt: record.capturedAt, source: current, target,
    nativeSourceRef: { controllerId: 'installation', providerId: original.providerId, nativeSessionId: original.nativeSessionId }, hostLocator: { hostId: 'host', controllerId: 'installation' }, revision: 3, roleRevision: 2 };
  store.setSharedRelations([relation]);
  const prefix = contextPrefix(record);
  const sent: string[] = [];
  await expect(store.send(record.id, 'question', async input => { sent.push(input); throw new Error('lost'); }, async () => false)).rejects.toThrow('lost');
  expect(sent).toEqual([prefix + 'question']);
  expect(prefix).toContain('native-parent');
  expect(prefix).toContain('captured A');
  store.setSharedRelations([{ ...relation, source: original, roleRevision: 1 }]);
  const { currentForkSource } = await import('./session-forks.js');
  expect(currentForkSource(store.get(record.id))).toEqual(current);
  store.setSharedRelations([{ ...relation, linked: false, revision: 4 }]);
  await expect(store.send(record.id, 'question', async input => { sent.push(input); }, async () => false)).rejects.toThrow('unknown delivery status');
  await store.send(record.id, 'question', async input => { sent.push(input); }, async () => true);
  expect(sent).toHaveLength(1);
  expect(store.getLocal(record.id)).toMatchObject({ ...context, target, options: { cwd: '/A' }, delivery: 'sent', firstInput: 'question' });
  expect(store.getLocal(record.id)?.revision).toBeUndefined();
  expect(new ForkStore('snapshot-settlement').get(record.id)).toMatchObject({ linked: false, revision: 4, source: original });
  store.setSharedRelations([{ ...relation, linked: true, revision: 5 }]);
  expect(store.linked()).toHaveLength(1);
  expect(new ForkStore('snapshot-settlement').get(record.id)).toMatchObject({ linked: true, revision: 5, delivery: 'sent', source: original });
  expect(() => store.bind(record.id, { ...target, hostId: 'other-host' })).toThrow('target changed');
});

it('uses known installation identity and does not hide target-locator collisions', async () => {
  const original = { ...source, hostId: 'host' };
  const target = { ...original, nativeSessionId: 'X' };
  const store = new ForkStore('known-controller');
  const record = store.prepare(referenceForkContext(original), { sourceNativeSessionId: original.nativeSessionId });
  store.bind(record.id, target);
  const origin = { controllerId: 'known', providerId: original.providerId, nativeSessionId: original.nativeSessionId };
  localStorage.setItem('agent-remote-forks:known-controller:record:' + record.id, JSON.stringify({ ...store.get(record.id), nativeSourceRef: origin, hostLocator: { hostId: 'host', controllerId: 'known' } }));
  const current = { ...original, providerId: 'claude', nativeSessionId: 'B' };
  const relation = { id: record.id, kind: 'side' as const, createdAt: record.capturedAt, source: current, target,
    nativeSourceRef: origin, hostLocator: { hostId: 'host', controllerId: 'known' } };
  store.setSharedRelations([{ ...relation, nativeSourceRef: { ...origin, controllerId: 'other' }, hostLocator: { hostId: 'host', controllerId: 'other' } }]);
  const { currentForkSource } = await import('./session-forks.js');
  expect(currentForkSource(store.get(record.id))).toEqual(original);
  expect(store.all()).toHaveLength(2);
  store.setSharedRelations([relation, { ...relation, id: 'other-target', target: { ...target, hostId: 'other-host' }, hostLocator: { hostId: 'other-host', controllerId: 'other' } }]);
  expect(currentForkSource(store.get(record.id))).toEqual(current);
  expect(store.all()).toHaveLength(2);
  expect(store.all().find(item => item.remote)?.target?.hostId).toBe('other-host');
});


it('retains known controller evidence in independent navigation after delivery writes', async () => {
  const original = { ...source, hostId: 'host' };
  const target = { ...original, nativeSessionId: 'X' };
  const store = new ForkStore('durable-controller');
  const record = store.prepare(referenceForkContext(original), { sourceNativeSessionId: original.nativeSessionId });
  store.bind(record.id, target);
  const relation = { id: 'shared', kind: 'side' as const, createdAt: record.capturedAt, source: { ...original, providerId: 'claude', nativeSessionId: 'B' }, target,
    nativeSourceRef: { controllerId: 'known', providerId: original.providerId, nativeSessionId: original.nativeSessionId }, hostLocator: { hostId: 'host', controllerId: 'known' }, revision: 2 };
  store.setSharedRelations([relation]);
  store.markConfigured(record.id);
  const fresh = new ForkStore('durable-controller');
  fresh.setSharedRelations([{ ...relation, nativeSourceRef: { ...relation.nativeSourceRef, controllerId: 'other' }, hostLocator: { hostId: 'host', controllerId: 'other' }, revision: 3 }]);
  const { currentForkSource } = await import('./session-forks.js');
  expect(currentForkSource(fresh.get(record.id))).toEqual(original);
  expect(fresh.all()).toHaveLength(2);
});


it('recognizes an original source-reference prefix in a shared-only projected conversation', () => {
  const store = new ForkStore('shared-reference-prefix');
  const original = { controllerId: 'installation', providerId: 'codex', nativeSessionId: 'A' };
  store.setSharedRelations([{ id: 'relation', kind: 'side', createdAt: '2026-10-10T00:00:00.000Z',
    source: { ...source, nativeSessionId: 'B', providerId: 'claude', hostId: 'host' }, target: { ...source, hostId: 'host', nativeSessionId: 'X' },
    nativeSourceRef: original, hostLocator: { hostId: 'host', controllerId: 'installation' } }]);
  const record = store.all()[0]!;
  expect(contextPrefix(record)).toBe('<source-session-reference>{"id":"relation","sourceSession":"A"}</source-session-reference>\n\n');
});


it('persists edited Side navigation without moving uncertain input ownership', async () => {
  const { sideNavigationTarget } = await import('./session-forks.js');
  const original = { ...source, hostId: 'host' };
  const target = { ...original, nativeSessionId: 'X', agentId: 'X-agent' };
  const edited = { ...target, nativeSessionId: 'Y', agentId: 'Y-agent' };
  const store = new ForkStore('edited-navigation');
  const record = store.prepare(referenceForkContext(original), { sourceNativeSessionId: original.nativeSessionId });
  store.bind(record.id, target);
  await expect(store.send(record.id, 'unknown X input', async () => { throw new Error('lost'); }, async () => false)).rejects.toThrow('lost');
  const raw = store.getLocal(record.id);
  store.followEditedSide(record.id, target, edited);
  expect(sideNavigationTarget(new ForkStore('edited-navigation').get(record.id))).toEqual(edited);
  expect(store.getLocal(record.id)).toEqual(raw);
  expect(store.find(edited)).toBeUndefined();
  expect(() => store.bind(record.id, edited)).toThrow('target changed');
  expect(() => store.followEditedSide(record.id, target, edited)).toThrow('navigation changed');
  expect(() => store.followEditedSide(record.id, edited, { ...edited, hostId: 'other' })).toThrow('retain its Host');
  const sent: string[] = [];
  await expect(store.send(record.id, 'unknown X input', async input => { sent.push(input); }, async () => false)).rejects.toThrow('unknown delivery status');
  expect(sent).toEqual([]);
  expect(store.getLocal(record.id)).toEqual(raw);
  store.setLinked(record.id, false);
  expect(sideNavigationTarget(new ForkStore('edited-navigation').get(record.id))).toEqual(edited);
});


function sharedEditedSide(): SessionRelation {
  const origin = { controllerId: 'installation', providerId: 'codex', nativeSessionId: 'A' };
  return { id: 'relation', kind: 'side', createdAt: '2026-10-10T00:00:00.000Z',
    source: { ...source, hostId: 'host', nativeSessionId: 'B', agentId: 'B-agent' },
    target: { ...source, hostId: 'host', nativeSessionId: 'X', agentId: 'X-agent' },
    nativeSourceRef: origin, sourceBinding: { kind: 'fixed', source: origin },
    hostLocator: { hostId: 'host', controllerId: 'installation' }, linked: true, revision: 1, roleRevision: 2 };
}

it('retains shared-only edited Side across current-source advancement and reload without delivery effects', async () => {
  const { sideNavigationTarget, currentForkSource } = await import('./session-forks.js');
  const relation = sharedEditedSide();
  const edited = { ...relation.target, nativeSessionId: 'Y', agentId: 'Y-agent' };
  const store = new ForkStore('moving-shared-source');
  store.setSharedRelations([relation]);
  store.followEditedSide('relation', relation.target, edited);
  const advanced = { ...relation, source: { ...relation.source, nativeSessionId: 'C', agentId: 'C-agent' }, roleRevision: 3 };
  store.setSharedRelations([advanced]);
  expect(currentForkSource(store.get('relation')).nativeSessionId).toBe('C');
  expect(sideNavigationTarget(store.get('relation'))).toEqual(edited);
  const reloaded = new ForkStore('moving-shared-source');
  reloaded.setSharedRelations([advanced]);
  expect(sideNavigationTarget(reloaded.get('relation'))).toEqual(edited);
  reloaded.markConfigured('relation'); reloaded.finishCreation('relation');
  expect(reloaded.allLocal()).toEqual([]);
  expect(store.allLocal()).toEqual([]);
});

it.each([
  ['product Host', (r: SessionRelation) => ({ ...r, hostLocator: { ...r.hostLocator!, hostId: 'other-host' } })],
  ['installation Controller', (r: SessionRelation) => ({ ...r, hostLocator: { ...r.hostLocator!, controllerId: 'other' }, nativeSourceRef: { ...r.nativeSourceRef!, controllerId: 'other' }, sourceBinding: undefined })],
  ['raw target native', (r: SessionRelation) => ({ ...r, target: { ...r.target, nativeSessionId: 'other' } })],
  ['raw target provider', (r: SessionRelation) => ({ ...r, target: { ...r.target, providerId: 'other' } })],
  ['raw target Host', (r: SessionRelation) => ({ ...r, target: { ...r.target, hostId: 'other' } })],
  ['relation', (r: SessionRelation) => ({ ...r, id: 'other-relation' })],
  ['original source native', (r: SessionRelation) => ({ ...r, nativeSourceRef: { ...r.nativeSourceRef!, nativeSessionId: 'other' }, sourceBinding: undefined })],
  ['original source provider', (r: SessionRelation) => ({ ...r, nativeSourceRef: { ...r.nativeSourceRef!, providerId: 'other' }, sourceBinding: undefined })],
  ['missing Host evidence', (r: SessionRelation) => ({ ...r, hostLocator: undefined })],
  ['missing original source', (r: SessionRelation) => ({ ...r, nativeSourceRef: undefined, sourceBinding: undefined })],
  ['incompatible origin binding', (r: SessionRelation) => ({ ...r, sourceBinding: { kind: 'fixed' as const, source: { ...r.nativeSourceRef!, nativeSessionId: 'other' } } })],
] as const)('refuses edited shared navigation with unrelated or incomplete %s evidence', async (_, collide) => {
  const { sideNavigationTarget } = await import('./session-forks.js');
  const relation = sharedEditedSide();
  const store = new ForkStore('shared-collision');
  store.setSharedRelations([relation]);
  store.followEditedSide('relation', relation.target, { ...relation.target, nativeSessionId: 'Y', agentId: 'Y-agent' });
  const unrelated = collide(relation);
  const reloaded = new ForkStore('shared-collision');
  reloaded.setSharedRelations([unrelated]);
  expect(sideNavigationTarget(reloaded.get(unrelated.id))).toEqual(unrelated.target);
  expect(reloaded.allLocal()).toEqual([]);
});

it.each(['missing', 'malformed'] as const)('keeps %s legacy navigation evidence conservative when current source moves', async evidence => {
  const { sideNavigationTarget } = await import('./session-forks.js');
  const relation = sharedEditedSide();
  const store = new ForkStore('legacy-shared-edit');
  store.setSharedRelations([relation]);
  const edited = { ...relation.target, nativeSessionId: 'Y', agentId: 'Y-agent' };
  store.followEditedSide('relation', relation.target, edited);
  const key = [...Array(localStorage.length)].map((_, i) => localStorage.key(i)!).find(key => key.includes(':navigation:'))!;
  const navigation = JSON.parse(localStorage.getItem(key)!);
  if (evidence === 'missing') delete navigation.identity;
  else navigation.identity = { relationId: 'relation' };
  localStorage.setItem(key, JSON.stringify(navigation));
  const reloaded = new ForkStore('legacy-shared-edit');
  reloaded.setSharedRelations([{ ...relation, source: { ...relation.source, nativeSessionId: 'C' }, roleRevision: 3 }]);
  expect(sideNavigationTarget(reloaded.get('relation'))).toEqual(relation.target);
  expect(reloaded.allLocal()).toEqual([]);
});


it('does not use a shared fallback to send when a local delivery read is denied', async () => {
  let denied = false;
  const storage = { getItem(key: string) { if (denied) throw new Error('Read denied'); return localStorage.getItem(key); },
    setItem(key: string, value: string) { localStorage.setItem(key, value); } } as unknown as Storage;
  const store = new ForkStore('denied-shared-fallback', storage);
  const record = store.prepare(referenceForkContext(source), { sourceNativeSessionId: source.nativeSessionId });
  const target = { ...source, nativeSessionId: 'X', agentId: 'X-agent' };
  store.bind(record.id, target);
  await expect(store.send(record.id, 'unknown input', async () => { throw new Error('lost'); }, async () => false)).rejects.toThrow('lost');
  const raw = store.getLocal(record.id);
  store.setSharedRelations([{ id: record.id, kind: 'side', createdAt: record.capturedAt, source, target }]);
  denied = true;
  const sent: string[] = [];
  await expect(store.send(record.id, 'unknown input', async input => { sent.push(input); }, async () => false)).rejects.toThrow('unavailable');
  expect(sent).toEqual([]);
  denied = false;
  expect(store.getLocal(record.id)).toEqual(raw);
});


it('rejects a legacy shared alias attachment when storage cannot prove local absence', () => {
  const storage = { getItem() { throw new Error('Read denied'); } } as unknown as Storage;
  const store = new ForkStore('denied-legacy-bind', storage);
  const target = { ...source, agentId: 'X-agent', nativeSessionId: 'X' };
  store.setSharedRelations([{ id: 'same-local-id', kind: 'side', createdAt: '2026-10-10T00:00:00.000Z', source, target }]);
  expect(() => store.bind('same-local-id', { ...target, agentId: 'attached' })).toThrow('unavailable');
  expect(store.get('same-local-id').target).toEqual(target);
});
