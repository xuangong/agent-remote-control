import { describe, expect, it } from 'vitest';

import { projectTimelinePage, projectTimelineRows } from './timeline-projector.js';
import { TimelineStore } from './timeline-store.js';

describe('projectTimelineRows', () => {
  it('coalesces streamed text, tool lifecycle, and todo snapshots at fetch time', () => {
    const store = new TimelineStore('epoch-1');
    const append = (sourceKey: string, item: Parameters<TimelineStore['append']>[0]['item']) => store.append({
      providerId: 'codex', sourceKey, occurredAt: 1_725_000_000_000, turnId: 'turn-1', item,
    });

    append('assistant-1', { type: 'assistant_message', messageId: 'message-1', text: 'Hello ' });
    append('assistant-2', { type: 'assistant_message', messageId: 'message-1', text: 'world' });
    append('reasoning-1', { type: 'reasoning', text: 'Check ' });
    append('reasoning-2', { type: 'reasoning', text: 'the result.' });
    append('tool-1', {
      type: 'tool_call', callId: 'call-1', name: 'shell', status: 'running', error: null,
      detail: { type: 'shell', command: 'pnpm test' },
    });
    append('tool-2', {
      type: 'tool_call', callId: 'call-1', name: 'shell', status: 'completed', error: null,
      detail: { type: 'shell', command: 'pnpm test' },
    });
    append('todo-1', { type: 'todo', items: [{ id: 'item-1', text: 'Run tests', completed: false }] });
    append('todo-2', { type: 'todo', items: [{ id: 'item-1', text: 'Run tests', completed: true }] });

    expect(projectTimelineRows(store.rows())).toEqual([
      expect.objectContaining({
        item: { type: 'assistant_message', messageId: 'message-1', text: 'Hello world' },
        seqStart: 1, seqEnd: 2, sourceSeqRanges: [{ startSeq: 1, endSeq: 2 }],
        collapsed: ['assistant_merge'], resources: [],
      }),
      expect.objectContaining({
        item: { type: 'reasoning', text: 'Check the result.' },
        seqStart: 3, seqEnd: 4, sourceSeqRanges: [{ startSeq: 3, endSeq: 4 }],
        collapsed: ['reasoning_merge'], resources: [],
      }),
      expect.objectContaining({
        item: expect.objectContaining({ type: 'tool_call', callId: 'call-1', status: 'completed' }),
        seqStart: 5, seqEnd: 6, sourceSeqRanges: [{ startSeq: 5, endSeq: 6 }],
        collapsed: ['tool_lifecycle'], resources: [],
      }),
      expect.objectContaining({
        item: { type: 'todo', items: [{ id: 'item-1', text: 'Run tests', completed: true }] },
        seqStart: 7, seqEnd: 8, sourceSeqRanges: [{ startSeq: 7, endSeq: 8 }],
        collapsed: [], resources: [],
      }),
    ]);
  });

  it('keeps every resource record bound to coalesced rows', () => {
    const store = new TimelineStore('epoch-1');
    const first = store.append({
      providerId: 'codex', sourceKey: 'assistant-1', occurredAt: 1, turnId: 'turn-1',
      item: { type: 'assistant_message', messageId: 'message-1', text: '[one](one.png)' },
      resources: [{ locator: 'one.png', resourceId: 'resource-1', status: 'available' }],
    });
    const second = store.append({
      providerId: 'codex', sourceKey: 'assistant-2', occurredAt: 2, turnId: 'turn-1',
      item: { type: 'assistant_message', messageId: 'message-1', text: '[two](two.png)' },
      resources: [{ locator: 'two.png', resourceId: 'resource-2', status: 'failed' }],
    });
    expect(first.status).toBe('appended');
    expect(second.status).toBe('appended');

    expect(projectTimelineRows(store.rows())[0]?.resources).toEqual([
      { locator: 'one.png', resourceId: 'resource-1', status: 'available' },
      { locator: 'two.png', resourceId: 'resource-2', status: 'failed' },
    ]);
  });
});

describe('projectTimelinePage', () => {
  it('paginates canonical rows with tail, before, and after cursors', () => {
    const store = messageStore(5);

    const tail = projectTimelinePage(store, {
      requestId: 'tail-request', agentId: 'agent-1', direction: 'tail', limit: 2,
    });
    const before = projectTimelinePage(store, {
      requestId: 'before-request', agentId: 'agent-1', direction: 'before',
      cursor: { epoch: 'epoch-1', seq: 4 }, limit: 2,
    });
    const after = projectTimelinePage(store, {
      requestId: 'after-request', agentId: 'agent-1', direction: 'after',
      cursor: { epoch: 'epoch-1', seq: 2 }, limit: 2,
    });

    expect(pageSummary(tail)).toEqual({ sequences: [[4, 4], [5, 5]], hasOlder: true, hasNewer: false });
    expect(pageSummary(before)).toEqual({ sequences: [[2, 2], [3, 3]], hasOlder: true, hasNewer: true });
    expect(pageSummary(after)).toEqual({ sequences: [[3, 3], [4, 4]], hasOlder: true, hasNewer: true });
    expect(tail.payload).toMatchObject({
      epoch: 'epoch-1', reset: false, staleCursor: false, gap: false,
      window: { minSeq: 1, maxSeq: 5, nextSeq: 6 },
      startCursor: { epoch: 'epoch-1', seq: 4 }, endCursor: { epoch: 'epoch-1', seq: 5 }, error: null,
    });
  });

  it('does not split one coalesced projected entry at a page boundary', () => {
    const store = new TimelineStore('epoch-1');
    store.append({
      providerId: 'codex', sourceKey: 'assistant-1', occurredAt: 1,
      item: { type: 'assistant_message', messageId: 'message-1', text: 'Hello ' },
    });
    store.append({
      providerId: 'codex', sourceKey: 'assistant-2', occurredAt: 2,
      item: { type: 'assistant_message', messageId: 'message-1', text: 'world' },
    });
    store.append({
      providerId: 'codex', sourceKey: 'user-1', occurredAt: 3,
      item: { type: 'user_message', messageId: 'message-2', text: 'Continue.' },
    });

    const page = projectTimelinePage(store, {
      requestId: 'tail-request', agentId: 'agent-1', direction: 'tail', limit: 2,
    });

    expect(page.payload.entries).toEqual([
      expect.objectContaining({
        seqStart: 1, seqEnd: 2,
        item: { type: 'assistant_message', messageId: 'message-1', text: 'Hello world' },
      }),
      expect.objectContaining({ seqStart: 3, seqEnd: 3, item: expect.objectContaining({ text: 'Continue.' }) }),
    ]);
  });

  it('uses raw sequence windows before projecting an after page', () => {
    const store = new TimelineStore('epoch-1');
    const append = (sourceKey: string, item: Parameters<TimelineStore['append']>[0]['item']) => store.append({
      providerId: 'codex', sourceKey, occurredAt: 1_725_000_000_000, turnId: 'turn-1', item,
    });
    append('tool-running', {
      type: 'tool_call', callId: 'call-1', name: 'read', status: 'running', error: null,
      detail: { type: 'read', filePath: 'fixture.txt' },
    });
    append('todo-running', { type: 'todo', items: [{ text: 'Read file', completed: false }] });
    append('assistant', { type: 'assistant_message', messageId: 'message-1', text: 'Done' });
    append('todo-completed', { type: 'todo', items: [{ text: 'Read file', completed: true }] });
    append('tool-completed', {
      type: 'tool_call', callId: 'call-1', name: 'read', status: 'completed', error: null,
      detail: { type: 'read', filePath: 'fixture.txt' },
    });

    const page = projectTimelinePage(store, {
      requestId: 'after-request', agentId: 'agent-1', direction: 'after',
      cursor: { epoch: 'epoch-1', seq: 2 }, limit: 1,
    });

    expect(page.payload).toMatchObject({
      startCursor: { epoch: 'epoch-1', seq: 3 },
      endCursor: { epoch: 'epoch-1', seq: 3 },
      hasNewer: true,
      entries: [expect.objectContaining({
        seqStart: 3,
        seqEnd: 3,
        item: expect.objectContaining({ type: 'assistant_message' }),
      })],
    });
  });

  it('returns a coalesced entry that starts before the cursor even when a later update crosses it', () => {
    const store = new TimelineStore('epoch-1');
    const append = (sourceKey: string, item: Parameters<TimelineStore['append']>[0]['item']) => store.append({
      providerId: 'dsh', sourceKey, occurredAt: 1_725_000_000_000, turnId: 'turn-1', item,
    });
    append('user', { type: 'user_message', messageId: 'message-1', text: 'Start' });
    append('todo-running', { type: 'todo', items: [{ text: 'Read file', completed: false }] });
    append('tool', {
      type: 'tool_call', callId: 'call-1', name: 'read', status: 'completed', error: null,
      detail: { type: 'read', filePath: 'fixture.txt' },
    });
    append('todo-completed', { type: 'todo', items: [{ text: 'Read file', completed: true }] });
    append('assistant', { type: 'assistant_message', messageId: 'message-2', text: 'Done' });

    const tail = projectTimelinePage(store, {
      requestId: 'tail-request', agentId: 'agent-1', direction: 'tail', limit: 2,
    });
    const before = projectTimelinePage(store, {
      requestId: 'before-request', agentId: 'agent-1', direction: 'before',
      cursor: tail.payload.startCursor ?? undefined, limit: 2,
    });

    expect(tail.payload.entries.map(({ item }) => item.type)).toEqual(['tool_call', 'assistant_message']);
    expect(before.payload.entries).toEqual([
      expect.objectContaining({ seqStart: 1, seqEnd: 1, item: expect.objectContaining({ type: 'user_message' }) }),
      expect.objectContaining({
        seqStart: 2, seqEnd: 4, sourceSeqRanges: [{ startSeq: 2, endSeq: 2 }, { startSeq: 4, endSeq: 4 }],
        item: { type: 'todo', items: [{ text: 'Read file', completed: true }] },
      }),
    ]);
  });

  it('marks a cursor from a replaced epoch stale without returning old rows', () => {
    const page = projectTimelinePage(messageStore(2), {
      requestId: 'after-request', agentId: 'agent-1', direction: 'after',
      cursor: { epoch: 'old-epoch', seq: 9 }, limit: 2,
    });

    expect(page.payload).toMatchObject({
      epoch: 'epoch-1', reset: true, staleCursor: true, gap: false,
      entries: [], startCursor: null, endCursor: null,
    });
    expect(page.payload.error).toBe('Timeline cursor epoch was replaced.');
  });

  it('marks an after cursor beyond recoverable history as a forward gap', () => {
    const page = projectTimelinePage(messageStore(2), {
      requestId: 'gap-request', agentId: 'agent-1', direction: 'after',
      cursor: { epoch: 'epoch-1', seq: 7 }, limit: 2,
    });

    expect(page.payload).toMatchObject({
      epoch: 'epoch-1', reset: false, staleCursor: false, gap: true,
      entries: [], startCursor: null, endCursor: null,
      error: 'Timeline cursor is ahead of recoverable history.',
    });
  });
});

function messageStore(count: number): TimelineStore {
  const store = new TimelineStore('epoch-1');
  for (let index = 1; index <= count; index += 1) {
    store.append({
      providerId: 'codex', sourceKey: `message-${index}`, occurredAt: 1_725_000_000_000 + index,
      item: { type: 'user_message', messageId: `message-${index}`, text: `Message ${index}` },
    });
  }
  return store;
}

function pageSummary(page: ReturnType<typeof projectTimelinePage>) {
  return {
    sequences: page.payload.entries.map(({ seqStart, seqEnd }) => [seqStart, seqEnd]),
    hasOlder: page.payload.hasOlder,
    hasNewer: page.payload.hasNewer,
  };
}

describe('compaction lifecycle projection', () => {
  it('completes the nearest active compaction and preserves separate cycles and contexts', () => {
    const store = new TimelineStore('compaction-epoch');
    const append = (sourceKey: string, item: Parameters<TimelineStore['append']>[0]['item'], turnId = 'turn-1', providerId = 'opencode') => store.append({ providerId, sourceKey, occurredAt: 1000, turnId, item });
    append('first-loading', { type: 'compaction', status: 'loading', trigger: 'auto', preTokens: 100 });
    append('interleaved', { type: 'assistant_message', text: 'Summarizing' });
    append('other-turn', { type: 'compaction', status: 'loading' }, 'turn-2');
    append('other-provider', { type: 'compaction', status: 'completed' }, 'turn-1', 'claude');
    append('first-completed', { type: 'compaction', status: 'completed' });
    append('second-loading', { type: 'compaction', status: 'loading', trigger: 'manual' });
    append('second-completed', { type: 'compaction', status: 'completed' });
    const entries = projectTimelineRows(store.rows());
    expect(entries).toHaveLength(5);
    expect(entries[0]).toMatchObject({ seqStart: 1, seqEnd: 5, item: { type: 'compaction', status: 'completed', trigger: 'auto', preTokens: 100 }, sourceSeqRanges: [{ startSeq: 1, endSeq: 1 }, { startSeq: 5, endSeq: 5 }] });
    expect(entries[2]?.item).toMatchObject({ type: 'compaction', status: 'loading' });
    expect(entries[4]).toMatchObject({ seqStart: 6, seqEnd: 7, item: { type: 'compaction', status: 'completed', trigger: 'manual' } });
    const after = projectTimelinePage(store, { requestId: 'after', agentId: 'agent', direction: 'after', cursor: { epoch: store.epoch, seq: 4 }, limit: 1 });
    expect(after.payload.entries).toEqual([entries[0]]);
  });

  it('does not merge new loading cycles or consume older cycles for repeated terminal events', () => {
    const store = new TimelineStore('compaction-epoch');
    for (const [index, status] of (['loading', 'loading', 'completed', 'completed'] as const).entries()) store.append({ providerId: 'opencode', sourceKey: `compaction-${index}`, occurredAt: 1000 + index, turnId: 'turn', item: { type: 'compaction', status } });
    expect(projectTimelineRows(store.rows()).map(entry => [entry.seqStart, entry.seqEnd, entry.item])).toEqual([
      [1, 1, { type: 'compaction', status: 'loading' }],
      [2, 3, { type: 'compaction', status: 'completed' }],
      [4, 4, { type: 'compaction', status: 'completed' }],
    ]);
  });
});
