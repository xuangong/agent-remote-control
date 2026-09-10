import { afterEach, expect, it, vi } from 'vitest';
import { PROTOCOL_VERSION, type HistoryPage, type ProjectedTimelineEntry } from '@borgee/agent-remote-protocol';
import { captureForkContext, ForkStore, contextPrefix } from './session-forks.js';

const source = { agentId: 'parent', nativeSessionId: 'native-parent', providerId: 'codex', title: 'Parent', hostId: 'local' };
const entry = (seq: number, text: string): ProjectedTimelineEntry => ({ providerId: 'codex', item: { type: 'user_message', text }, timestamp: '2026-09-11T00:00:00Z', seqStart: seq, seqEnd: seq, sourceSeqRanges: [{ startSeq: seq, endSeq: seq }], resources: [], collapsed: [] });
function page(entries: ProjectedTimelineEntry[], hasOlder = false, epoch = 'one'): HistoryPage {
  return { protocolVersion: PROTOCOL_VERSION, type: 'timeline_page', payload: { requestId: 'r', agentId: 'parent', direction: 'tail', epoch, entries, hasOlder, hasNewer: false, reset: false, staleCursor: false, gap: false, error: null, window: { minSeq: 1, maxSeq: 9, nextSeq: 10 }, startCursor: entries[0] ? { epoch, seq: entries[0].seqStart } : null, endCursor: entries.at(-1) ? { epoch, seq: entries.at(-1)!.seqEnd } : null } };
}
afterEach(() => localStorage.clear());
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
