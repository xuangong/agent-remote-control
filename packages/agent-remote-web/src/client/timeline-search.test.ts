import { describe, expect, it, vi } from 'vitest';
import type { HistoryPage, ProjectedTimelineEntry } from '@orchardworks/agent-remote-protocol';
import { findTimelineMatches, scanTimelineHistory } from './timeline-search.js';

const entry = (seq: number, text: string): ProjectedTimelineEntry => ({ providerId: 'recorded', seqStart: seq, seqEnd: seq,
  timestamp: '2026-09-29T00:00:00Z', item: { type: 'assistant_message', text }, resources: [], collapsed: [], sourceSeqRanges: [] });
const page = (entries: ProjectedTimelineEntry[], hasOlder = false): HistoryPage => ({ protocolVersion: '1.6.0', type: 'timeline_page', payload: {
  requestId: 'page', agentId: 'one', direction: 'before', epoch: 'epoch', reset: false, staleCursor: false, gap: false, error: null,
  entries, hasOlder, hasNewer: true, startCursor: entries[0] ? { epoch: 'epoch', seq: entries[0].seqStart } : null, endCursor: null,
  window: { minSeq: 1, maxSeq: 30, nextSeq: 31 },
} });

describe('timeline search', () => {
  it('matches Chinese and case-insensitive text, including folded reasoning and tool output', () => {
    const reasoning = { ...entry(2, ''), item: { type: 'reasoning' as const, text: '找到中文思考' } };
    const tool: ProjectedTimelineEntry = { ...entry(3, ''), item: { type: 'tool_call', callId: 'hidden-id', name: 'shell', status: 'completed', error: null,
      detail: { type: 'shell', command: 'ls' }, result: { content: [{ type: 'text', text: '中文 Output' }] } } };
    expect(findTimelineMatches('epoch', [entry(1, '中文 MESSAGE'), reasoning, tool], '中文', 'all')).toHaveLength(3);
    expect(findTimelineMatches('epoch', [tool], 'output', 'tools')[0]?.snippet).toContain('Output');
    expect(findTimelineMatches('epoch', [tool], 'hidden-id', 'all')).toHaveLength(0);
    expect(findTimelineMatches('epoch', [entry(1, 'anything')], '  ')).toHaveLength(0);
  });

  it('scans unloaded pages without applying them to the replica, with incremental progress', async () => {
    const loaded = [entry(30, 'latest match')];
    const fetchBefore = vi.fn().mockResolvedValueOnce(page([entry(20, 'older match')], true)).mockResolvedValueOnce(page([entry(1, 'first match')]));
    const progress: number[] = [];
    const result = await scanTimelineHistory({ epoch: 'epoch', entries: loaded, hasOlder: true, query: 'match', fetchBefore,
      assertCurrent() {}, onProgress: value => progress.push(value.scanned) });
    expect(fetchBefore.mock.calls.map(args => args[0])).toEqual([30, 20]);
    expect(result.matches.map(match => match.seq)).toEqual([30, 20, 1]);
    expect(progress).toEqual([1, 2, 3]);
    expect(loaded).toHaveLength(1);
  });

  it('limits every historical page to user and assistant messages', async () => {
    const reasoning: ProjectedTimelineEntry = { ...entry(2, ''), item: { type: 'reasoning', text: 'match thought' } };
    const tasks: ProjectedTimelineEntry = { ...entry(3, ''), item: { type: 'todo', items: [{ text: 'match plan', completed: false }] } };
    const entries = [entry(1, 'match message'), reasoning, tasks];
    const result = await scanTimelineHistory({ epoch: 'epoch', entries: [entry(10, 'recent')], hasOlder: true, query: 'match', scope: 'messages',
      fetchBefore: async () => page(entries), assertCurrent() {} });
    expect(result.matches.map(match => match.seq)).toEqual([1]);
    expect(findTimelineMatches('epoch', entries, 'match', 'reasoning').map(match => match.seq)).toEqual([2]);
    expect(findTimelineMatches('epoch', entries, 'match', 'tools')).toEqual([]);
  });

  it.each(['reset', 'staleCursor', 'gap'] as const)('does not claim complete history on %s', async flag => {
    const result = page([entry(1, 'old')]); result.payload[flag] = true;
    await expect(scanTimelineHistory({ epoch: 'epoch', entries: [entry(10, 'recent')], hasOlder: true, query: 'old',
      fetchBefore: async () => result, assertCurrent() {} })).rejects.toThrow('changed');
  });

  it('stops on cancellation, changed identity, or a non-advancing page', async () => {
    const controller = new AbortController();
    const options = { epoch: 'epoch', entries: [entry(10, 'recent')], hasOlder: true, query: 'old', assertCurrent() {} };
    await expect(scanTimelineHistory({ ...options, signal: controller.signal, fetchBefore: async () => {
      controller.abort(); return page([entry(1, 'old')]);
    } })).rejects.toMatchObject({ name: 'AbortError' });
    await expect(scanTimelineHistory({ ...options, fetchBefore: async () => page([entry(10, 'same')], true) })).rejects.toThrow('advance');
    await expect(scanTimelineHistory({ ...options, assertCurrent() { throw new Error('changed session'); }, fetchBefore: vi.fn() })).rejects.toThrow('changed session');
  });
});
