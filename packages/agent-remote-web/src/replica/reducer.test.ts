import { describe, expect, it } from 'vitest';
import { TimelineStore, projectTimelinePage } from '@orchardworks/agent-timeline';
import type {
  AgentInteractionRequest,
  AgentSnapshot,
  AgentStreamMessage,
  HistoryPage,
  ProjectedTimelineEntry,
  ResourceBinding,
} from '@orchardworks/agent-remote-protocol';

import {
  applyAgentSnapshot,
  applyHistoryPage,
  applyInteractionRequested,
  applyInteractionInvalidated,
  applyInteractionResolved,
  applyResourceUpdate,
  applyTimelineResourceBindingReplacement,
  applyTimelineReplacement,
  createReplicaState,
  reduceTimelineEvent,
  restoreFromDevice,
} from './reducer.js';

const capabilities = {
  history: true,
  sendMessage: true,
  steer: true,
  cancel: true,
  readResource: true,
  interactions: { question: true, planApproval: true, toolApproval: true },
};

it('replays only the latest usage groups and restores them identically from a snapshot', () => {
  const usage = { tokenScope: 'session' as const, inputTokens: 100, cachedInputTokens: 20, outputTokens: 10, totalTokens: 130 };
  const updates = [usage, { contextScope: 'current' as const, contextWindowUsedTokens: 50, contextWindowMaxTokens: 200 },
    usage, { tokenScope: 'call' as const, totalTokens: 8 }, { contextWindowUsedTokens: 10 }];
  let state = applyAgentSnapshot(createReplicaState(), snapshot());
  for (const [index, update] of updates.entries()) {
    const message: AgentStreamMessage = { protocolVersion: '1.8.0', type: 'agent_stream', payload: {
      agentId: 'agent-one', timestamp: `2026-10-09T00:00:0${index}.000Z`,
      event: { type: 'usage_updated', providerId: 'provider-neutral', usage: update },
    } };
    state = reduceTimelineEvent(state, JSON.parse(JSON.stringify(message))).state;
  }
  expect(state.agent?.lastUsage).toEqual({ tokenScope: 'call', totalTokens: 8, contextWindowUsedTokens: 10 });
  const restored = applyAgentSnapshot(createReplicaState(), { ...snapshot(), payload: state.agent! });
  expect(restored.agent?.lastUsage).toEqual(state.agent?.lastUsage);
  const replaced = applyAgentSnapshot(restored, snapshot());
  expect(replaced.agent?.lastUsage).toBeUndefined();
});

it.each([undefined, null, 'old-turn', 'actual-turn'])('reconciles authoritative runtime turn %s in live delivery and snapshot replay', activeTurnId => {
  const original = snapshot('running');
  original.payload.activeTurn = { turnId: 'old-turn', startedAt: '2026-09-10T00:00:00.000Z' };
  const message: AgentStreamMessage = {
    protocolVersion: '1.8.0', type: 'agent_stream', payload: {
      agentId: 'agent-one', timestamp: '2026-09-10T01:00:00.000Z', event: {
        type: 'runtime_updated', providerId: 'codex', runtimeInfo: { providerId: 'codex', sessionId: 'root', status: activeTurnId ? 'running' : 'idle' },
        ...(activeTurnId === undefined ? {} : { activeTurnId }),
      },
    },
  };
  const expected = activeTurnId === null ? null : activeTurnId === 'actual-turn'
    ? { turnId: activeTurnId, startedAt: message.payload.timestamp } : original.payload.activeTurn;
  const live = reduceTimelineEvent(applyAgentSnapshot(createReplicaState(), original), message).state;
  expect(live.agent?.activeTurn).toEqual(expected);
  const reloaded = applyAgentSnapshot(createReplicaState(), { ...original, payload: live.agent! });
  expect(reduceTimelineEvent(reloaded, message).state.agent?.activeTurn).toEqual(expected);
});

it('retains the source turn start through live delivery and repeated snapshot handoff', () => {
  const initial = applyAgentSnapshot(createReplicaState(), snapshot());
  const started: AgentStreamMessage = {
    protocolVersion: '1.8.0', type: 'agent_stream',
    payload: { agentId: 'agent-one', timestamp: '2026-09-10T00:00:00.000Z',
      event: { type: 'turn_started', providerId: 'provider-neutral', turnId: 'turn-one' } },
  };
  const live = reduceTimelineEvent(initial, started).state;
  expect(live.agent?.activeTurn).toEqual({ turnId: 'turn-one', startedAt: started.payload.timestamp });
  const restored = applyAgentSnapshot(createReplicaState(), { ...snapshot('running'), payload: live.agent! });
  expect(reduceTimelineEvent(restored, started).state.agent?.activeTurn).toEqual(live.agent?.activeTurn);
});

function snapshot(
  status: AgentSnapshot['payload']['status'] = 'idle',
  pendingInteractions: AgentInteractionRequest[] = [],
): AgentSnapshot {
  return {
    protocolVersion: '1.8.0',
    type: 'agent_snapshot',
    payload: {
      id: 'agent-one',
      providerId: 'provider-neutral',
      createdAt: '2026-09-02T00:00:00.000Z',
      updatedAt: '2026-09-02T00:00:01.000Z',
      status,
      activeTurn: null,
      capabilities,
      pendingInteractions,
      runtimeInfo: {
        providerId: 'provider-neutral',
        sessionId: 'session-one',
        status,
      },
    },
  };
}

function stream(
  seq: number,
  item: Extract<AgentStreamMessage['payload']['event'], { type: 'timeline' }>['item'],
  epoch = 'epoch-one',
  resources: ResourceBinding[] = [],
): AgentStreamMessage {
  return {
    protocolVersion: '1.8.0',
    type: 'agent_stream',
    payload: {
      agentId: 'agent-one',
      epoch,
      seq,
      timestamp: `2026-09-02T00:00:${String(seq).padStart(2, '0')}.000Z`,
      event: { type: 'timeline', providerId: 'provider-neutral', item, resources },
    },
  };
}

function entry(seqStart: number, seqEnd: number, item: ProjectedTimelineEntry['item']): ProjectedTimelineEntry {
  return {
    providerId: 'provider-neutral',
    item,
    timestamp: `2026-09-02T00:00:${String(seqStart).padStart(2, '0')}.000Z`,
    seqStart,
    seqEnd,
    sourceSeqRanges: [{ startSeq: seqStart, endSeq: seqEnd }],
    collapsed: [],
    resources: [],
  };
}

function page(
  direction: HistoryPage['payload']['direction'],
  entries: ProjectedTimelineEntry[],
  options: Partial<HistoryPage['payload']> = {},
): HistoryPage {
  const start = entries[0]?.seqStart ?? 0;
  const end = entries.at(-1)?.seqEnd ?? 0;
  return {
    protocolVersion: '1.8.0',
    type: 'timeline_page',
    payload: {
      requestId: 'timeline-request',
      agentId: 'agent-one',
      direction,
      epoch: 'epoch-one',
      reset: false,
      staleCursor: false,
      gap: false,
      window: { minSeq: start, maxSeq: end, nextSeq: end + 1 },
      startCursor: entries.length > 0 ? { epoch: 'epoch-one', seq: start } : null,
      endCursor: entries.length > 0 ? { epoch: 'epoch-one', seq: end } : null,
      hasOlder: false,
      hasNewer: false,
      entries,
      error: null,
      ...options,
    },
  };
}

const question: AgentInteractionRequest = {
  kind: 'question',
  requestId: 'question-one',
  questions: [{
    questionId: 'choice',
    header: 'Runtime',
    prompt: 'Choose a runtime',
    required: true,
    selection: 'single',
    options: [{ value: 'web', label: 'Web' }],
    allowCustomText: false,
    allowDismiss: false,
  }],
};

describe('agent replica reducer', () => {
  it('replaces Agent snapshot state without clearing an independently loaded Timeline', () => {
    let state = createReplicaState();
    state = applyAgentSnapshot(state, snapshot('idle'));
    state = applyHistoryPage(state, page('tail', [
      entry(1, 1, { type: 'user_message', text: 'Keep this row' }),
    ])).state;

    const updated = applyAgentSnapshot(state, snapshot('running'));

    expect(updated.agent?.status).toBe('running');
    expect(updated.timeline.entries.map(({ item }) => item)).toEqual([
      { type: 'user_message', text: 'Keep this row' },
    ]);
  });

  it('buffers live rows before the tail fetch and converges with the authoritative page', () => {
    let state = createReplicaState();
    const buffered = reduceTimelineEvent(state, stream(3, {
      type: 'assistant_message', text: 'C', messageId: 'answer',
    }));
    expect(buffered.status).toBe('buffered');
    state = buffered.state;

    const fetched = applyHistoryPage(state, page('tail', [
      entry(1, 3, { type: 'assistant_message', text: 'ABC', messageId: 'answer' }),
    ], { window: { minSeq: 1, maxSeq: 3, nextSeq: 4 } }));

    expect(fetched.status).toBe('applied');
    expect(fetched.state.timeline.entries).toHaveLength(1);
    expect(fetched.state.timeline.entries[0]?.item).toEqual({
      type: 'assistant_message', text: 'ABC', messageId: 'answer',
    });
    expect(fetched.state.timeline.nextSeq).toBe(4);
    expect(fetched.state.timeline.pendingLive).toEqual([]);
  });

  it('suppresses duplicate live sequence delivery without duplicating content', () => {
    const state = applyHistoryPage(createReplicaState(), page('tail', [
      entry(1, 1, { type: 'assistant_message', text: 'A', messageId: 'answer' }),
    ])).state;
    const duplicate = reduceTimelineEvent(state, stream(1, {
      type: 'assistant_message', text: 'A', messageId: 'answer',
    }));

    expect(duplicate.status).toBe('duplicate');
    expect(duplicate.state).toBe(state);
    expect(duplicate.state.timeline.entries[0]?.item).toEqual({
      type: 'assistant_message', text: 'A', messageId: 'answer',
    });
  });

  it('pauses a forward gap and drains the buffered head after an after page fills it', () => {
    const initial = applyHistoryPage(createReplicaState(), page('tail', [
      entry(1, 1, { type: 'user_message', text: 'Start' }),
    ])).state;
    const gap = reduceTimelineEvent(initial, stream(3, {
      type: 'assistant_message', text: 'Head', messageId: 'answer',
    }));
    expect(gap.status).toBe('gap');
    expect(gap.expectedSeq).toBe(2);
    expect(gap.state.timeline.entries).toHaveLength(1);

    const recovered = applyHistoryPage(gap.state, page('after', [
      entry(2, 2, { type: 'reasoning', text: 'Inspecting' }),
    ], {
      window: { minSeq: 1, maxSeq: 3, nextSeq: 4 },
      startCursor: { epoch: 'epoch-one', seq: 2 },
      endCursor: { epoch: 'epoch-one', seq: 2 },
      hasNewer: true,
    }));

    expect(recovered.status).toBe('applied');
    expect(recovered.state.timeline.entries.map(({ item }) => item.type)).toEqual([
      'user_message', 'reasoning', 'assistant_message',
    ]);
    expect(recovered.state.timeline.nextSeq).toBe(4);
    expect(recovered.state.timeline.pendingLive).toEqual([]);
  });

  it('prepends an older page while preserving the live head and chronological order', () => {
    let state = applyHistoryPage(createReplicaState(), page('tail', [
      entry(3, 3, { type: 'assistant_message', text: 'Newest' }),
    ], {
      window: { minSeq: 1, maxSeq: 3, nextSeq: 4 },
      hasOlder: true,
    })).state;
    state = reduceTimelineEvent(state, stream(4, { type: 'error', message: 'Live failure' })).state;

    const older = applyHistoryPage(state, page('before', [
      entry(1, 1, { type: 'user_message', text: 'Oldest' }),
      entry(2, 2, { type: 'reasoning', text: 'Earlier reasoning' }),
    ], {
      window: { minSeq: 1, maxSeq: 98, nextSeq: 99 },
      startCursor: { epoch: 'epoch-one', seq: 1 },
      endCursor: { epoch: 'epoch-one', seq: 2 },
      hasOlder: false,
      hasNewer: true,
    }));

    expect(older.state.timeline.entries.map(({ seqStart }) => seqStart)).toEqual([1, 2, 3, 4]);
    expect(older.state.timeline.nextSeq).toBe(5);
    expect(older.state.timeline.hasOlder).toBe(false);
  });

  it('keeps the held rows on a replacement epoch until its tail is read, buffers the new epoch and ignores the old one', () => {
    let state = applyHistoryPage(createReplicaState(), page('tail', [
      entry(1, 1, { type: 'user_message', text: 'Held row' }),
    ])).state;
    state = applyTimelineReplacement(state, 'epoch-two');

    expect(state.timeline).toMatchObject({ epoch: 'epoch-one', pendingEpoch: 'epoch-two', initialized: true });
    expect(state.timeline.entries).toHaveLength(1);
    expect(state.retiredEpochs).toEqual([]);

    const ignored = reduceTimelineEvent(state, stream(2, { type: 'assistant_message', text: 'Late old row' }, 'epoch-one'));
    expect(ignored.status).toBe('duplicate');
    expect(ignored.state).toBe(state);

    const buffered = reduceTimelineEvent(state, stream(1, { type: 'assistant_message', text: 'New epoch row' }, 'epoch-two'));
    expect(buffered.status).toBe('buffered');
    expect(buffered.state.timeline.pendingLive).toHaveLength(1);
  });

  it('treats an authoritative tail page from a new epoch as a replacement boundary', () => {
    const initial = applyHistoryPage(createReplicaState(), page('tail', [
      entry(1, 1, { type: 'user_message', text: 'Old epoch' }),
    ])).state;
    const replacementPage = page('tail', [
      { ...entry(1, 1, { type: 'assistant_message', text: 'New epoch' }), sourceSeqRanges: [{ startSeq: 1, endSeq: 1 }] },
    ], {
      epoch: 'epoch-two',
      startCursor: { epoch: 'epoch-two', seq: 1 },
      endCursor: { epoch: 'epoch-two', seq: 1 },
    });

    const replaced = applyHistoryPage(initial, replacementPage);
    expect(replaced.status).toBe('applied');
    expect(replaced.state.retiredEpochs).toContain('epoch-one');
    expect(replaced.state.timeline.entries[0]?.item).toMatchObject({ text: 'New epoch' });
    expect(reduceTimelineEvent(replaced.state, stream(2, {
      type: 'assistant_message', text: 'Late old epoch',
    }, 'epoch-one')).status).toBe('stale_epoch');
  });

  it('preserves interaction changes that arrive after a snapshot request began', () => {
    let state = applyAgentSnapshot(createReplicaState(), snapshot('waiting'));
    const interactionBaseline = state.interactionRevision;
    state = applyInteractionRequested(state, question);

    state = applyAgentSnapshot(state, snapshot('waiting', []), { interactionBaseline });
    expect(state.pendingInteractions).toEqual([question]);

    const resolveBaseline = state.interactionRevision;
    state = applyInteractionResolved(state, question.requestId);
    state = applyAgentSnapshot(state, snapshot('waiting', [question]), {
      interactionBaseline: resolveBaseline,
    });
    expect(state.pendingInteractions).toEqual([]);
  });

  it('invalidates a pending interaction without changing the timeline', () => {
    let state = applyAgentSnapshot(createReplicaState(), snapshot('waiting', [question]));
    const timeline = state.timeline;

    state = applyInteractionInvalidated(state, question.requestId);

    expect(state.pendingInteractions).toEqual([]);
    expect(state.timeline).toBe(timeline);
    expect(state.interactionChanges[question.requestId]).not.toHaveProperty('request');
  });

  it('coalesces incremental tool and todo lifecycle events like projected history', () => {
    let state = applyHistoryPage(createReplicaState(), page('tail', [])).state;
    state = reduceTimelineEvent(state, stream(1, {
      type: 'tool_call', callId: 'call-one', name: 'read',
      detail: { type: 'read', filePath: '/workspace/a.md' }, status: 'running', error: null,
    })).state;
    state = reduceTimelineEvent(state, stream(2, {
      type: 'todo', items: [{ text: 'Inspect', completed: false, status: 'in_progress' }],
    })).state;
    state = reduceTimelineEvent(state, stream(3, {
      type: 'tool_call', callId: 'call-one', name: 'read',
      detail: { type: 'read', filePath: '/workspace/a.md' }, status: 'completed', error: null,
    })).state;
    state = reduceTimelineEvent(state, stream(4, {
      type: 'todo', items: [{ text: 'Inspect', completed: true, status: 'completed' }],
    })).state;

    expect(state.timeline.entries).toHaveLength(2);
    expect(state.timeline.entries[0]).toMatchObject({
      seqStart: 1,
      seqEnd: 3,
      item: { type: 'tool_call', callId: 'call-one', status: 'completed' },
      collapsed: ['tool_lifecycle'],
    });
    expect(state.timeline.entries[1]).toMatchObject({
      seqStart: 2,
      seqEnd: 4,
      item: { type: 'todo', items: [{ completed: true }] },
    });
  });

  it('converges a provisional live resource binding and terminal update with projected history', () => {
    const provisional = { locator: 'output.png', resourceId: 'resource-provisional', status: 'pending' as const };
    const replacement = { locator: 'output.png', resourceId: 'resource-canonical', status: 'pending' as const };
    const terminal = {
      status: 'available' as const,
      mediaType: 'image/png',
      byteLength: 42,
      sha256: 'canonical-digest',
    };
    const item = { type: 'assistant_message' as const, text: 'Generated output', messageId: 'answer' };
    let liveState = reduceTimelineEvent(
      createReplicaState(),
      stream(1, item, 'epoch-one', [provisional]),
    ).state;

    liveState = applyTimelineResourceBindingReplacement(liveState, {
      protocolVersion: '1.8.0',
      type: 'timeline_resource_binding_replaced',
      payload: {
        agentId: 'agent-one', epoch: 'epoch-one', seq: 1,
        previous: provisional, replacement,
      },
    });
    liveState = applyResourceUpdate(liveState, {
      protocolVersion: '1.8.0',
      type: 'resource_update',
      payload: { agentId: 'agent-one', resourceId: replacement.resourceId, state: terminal },
    });
    liveState = applyHistoryPage(liveState, page('tail', [])).state;

    const projected = { ...entry(1, 1, item), resources: [{ ...replacement, status: 'available' as const }] };
    const historyState = applyHistoryPage(createReplicaState(), page('tail', [projected])).state;
    expect(liveState.timeline.entries).toEqual(historyState.timeline.entries);
    expect(liveState.resources).toEqual({ [replacement.resourceId]: terminal });
  });
});

describe('incremental timeline identity', () => {
  const cases: [string, ProjectedTimelineEntry['item'], ProjectedTimelineEntry['item']][] = [
    ['assistant', { type: 'assistant_message', messageId: 'reply', text: 'First ' }, { type: 'assistant_message', messageId: 'reply', text: 'second' }],
    ['reasoning', { type: 'reasoning', text: 'First ' }, { type: 'reasoning', text: 'second' }],
    ['tool', { type: 'tool_call', callId: 'call', name: 'read', status: 'running', detail: { type: 'read', filePath: '/file' }, error: null },
      { type: 'tool_call', callId: 'call', name: 'read', status: 'completed', detail: { type: 'read', filePath: '/file' }, error: null }],
    ['compaction', { type: 'compaction', status: 'loading' }, { type: 'compaction', status: 'completed' }],
    ['todo', { type: 'todo', items: [{ text: 'Check', completed: false }] },
      { type: 'todo', items: [{ text: 'Check', completed: true }] }],
  ];
  function freeze(value: unknown): void {
    if (!value || typeof value !== 'object' || Object.isFrozen(value)) return;
    Object.freeze(value);
    for (const child of Object.values(value)) freeze(child);
  }
  it.each(cases)('updates %s without copying unrelated history or mutating a prior snapshot', (_, first, second) => {
    const old = applyHistoryPage(createReplicaState(), page('tail', [
      entry(1, 1, { type: 'user_message', text: 'Question' }), entry(2, 2, first),
    ])).state;
    const original = structuredClone(old);
    freeze(old);
    const message = stream(3, second);
    const updated = reduceTimelineEvent(old, message).state;
    expect(updated.timeline.entries[0]).toBe(old.timeline.entries[0]);
    expect(updated.timeline.entries[1]).not.toBe(old.timeline.entries[1]);
    expect(updated.timeline.entries[1]!.seqEnd).toBe(3);
    expect(updated.timeline.entries[1]!.sourceSeqRanges).toEqual([{ startSeq: 2, endSeq: 3 }]);
    expect(old).toEqual(original);
    expect(reduceTimelineEvent(updated, message).state).toBe(updated);
    if (second.type === 'assistant_message' || second.type === 'reasoning') {
      expect(updated.timeline.entries[1]!.item).toMatchObject({ text: 'First second' });
    } else expect(updated.timeline.entries[1]!.item).toEqual(second);
  });
  it('preserves existing entries when appending messages or loading earlier history', () => {
    const old = applyHistoryPage(createReplicaState(), page('tail', [entry(5, 5, { type: 'user_message', text: 'Question' })])).state;
    freeze(old);
    const appended = reduceTimelineEvent(old, stream(6, { type: 'assistant_message', text: 'Answer' })).state;
    expect(appended.timeline.entries[0]).toBe(old.timeline.entries[0]);
    const earlier = applyHistoryPage(appended, page('before', [entry(1, 1, { type: 'user_message', text: 'Earlier' })])).state;
    expect(earlier.timeline.entries[1]).toBe(old.timeline.entries[0]);
    expect(earlier.timeline.entries[2]).toBe(appended.timeline.entries[1]);
    expect(earlier.timeline.entries.map(entry => entry.seqStart)).toEqual([1, 5, 6]);
  });
});


it('converges live and Relay history compaction lifecycles without joining independent cycles', () => {
  const store = new TimelineStore('epoch-one');
  let live = applyHistoryPage(createReplicaState(), page('tail', [])).state;
  const append = (item: ProjectedTimelineEntry['item'], turnId = 'turn-one', providerId = 'opencode') => {
    const seq = store.rows().length + 1;
    store.append({ providerId, sourceKey: `row-${seq}`, occurredAt: 1725000000000 + seq, turnId, item });
    const row = store.rows().at(-1)!;
    const message = stream(seq, item);
    message.payload.timestamp = row.timestamp;
    message.payload.event = { type: 'timeline', providerId, turnId, item, resources: [] };
    live = reduceTimelineEvent(live, message).state;
    const history = applyHistoryPage(createReplicaState(), projectTimelinePage(store, { requestId: 'tail', agentId: 'agent-one', direction: 'tail', limit: 100 })).state;
    expect(live.timeline.entries).toEqual(history.timeline.entries);
  };
  append({ type: 'compaction', status: 'loading', trigger: 'manual', preTokens: 100 });
  append({ type: 'reasoning', text: 'Summarizing' });
  append({ type: 'compaction', status: 'loading' }, 'other-turn');
  append({ type: 'compaction', status: 'completed' }, 'turn-one', 'claude');
  append({ type: 'compaction', status: 'completed' });
  expect(live.timeline.entries[0]).toMatchObject({ seqStart: 1, seqEnd: 5, item: { type: 'compaction', status: 'completed', trigger: 'manual', preTokens: 100 } });
  append({ type: 'compaction', status: 'loading', trigger: 'auto' });
  append({ type: 'compaction', status: 'completed' });
  expect(live.timeline.entries).toHaveLength(5);
  expect(live.timeline.entries.at(-1)).toMatchObject({ seqStart: 6, seqEnd: 7, item: { type: 'compaction', status: 'completed', trigger: 'auto' } });
  append({ type: 'compaction', status: 'loading' });
  append({ type: 'compaction', status: 'loading' });
  append({ type: 'compaction', status: 'completed' });
  append({ type: 'compaction', status: 'completed' });
  expect(live.timeline.entries.slice(-3).map(entry => [entry.seqStart, entry.seqEnd])).toEqual([[8, 8], [9, 10], [11, 11]]);
});


it('maintains waiting state through native restore and returns to the latest authoritative work state', () => {
  const request: AgentInteractionRequest = { kind: 'question', requestId: 'approval', questions: [{ id: 'q', title: 'Continue?', options: [{ value: 'yes', label: 'Yes' }] }] };
  let state = applyAgentSnapshot(createReplicaState(), snapshot('running'));
  state = applyInteractionRequested(state, request);
  expect(state.agent?.status).toBe('waiting');
  expect(state.agent?.pendingInteractions).toEqual(state.pendingInteractions);
  state = reduceTimelineEvent(state, { protocolVersion: '1.8.0', type: 'agent_stream', payload: { agentId: 'agent-one', timestamp: '2026-09-26T00:00:00.000Z', event: { type: 'runtime_updated', providerId: 'provider-neutral', runtimeInfo: { providerId: 'provider-neutral', sessionId: 'session-one', status: 'running', connection: { state: 'restoring' } } } } }).state;
  expect(state.agent?.status).toBe('waiting');
  expect(state.pendingInteractions).toHaveLength(1);
  state = applyInteractionResolved(state, request.requestId);
  expect(state.agent?.status).toBe('running');
  expect(state.agent?.pendingInteractions).toEqual([]);
});

it('retains settled background results while coalescing live deltas and replaying history', () => {
  let live = applyAgentSnapshot(createReplicaState(), snapshot());
  live = applyHistoryPage(live, { ...page('tail', []), payload: { ...page('tail', []).payload, window: { minSeq: 0, maxSeq: 0, nextSeq: 1 } } }).state;
  const background = { id: 'review', kind: 'review' as const, status: 'silent' as const };
  for (const message of [stream(1, { type: 'assistant_message', text: 'Quiet ', background }),
    stream(2, { type: 'assistant_message', text: 'late delta', background: { ...background, status: 'pending' } }),
    stream(3, { type: 'assistant_message', text: 'Human reply' })]) live = reduceTimelineEvent(live, JSON.parse(JSON.stringify(message))).state;
  expect(live.timeline.entries).toHaveLength(2);
  expect(live.timeline.entries[0]?.item).toMatchObject({ text: 'Quiet late delta', background: { status: 'silent' } });
  const restored = applyHistoryPage(applyAgentSnapshot(createReplicaState(), snapshot()), page('tail', live.timeline.entries)).state;
  expect(restored.timeline.entries).toEqual(live.timeline.entries);
});

it('retains lifecycle-only failure through later snapshots, pagination, and delayed quiet rows', () => {
  let state = applyHistoryPage(applyAgentSnapshot(createReplicaState(), snapshot()), page('tail', [])).state;
  const background = { id: 'review', kind: 'review' as const, status: 'silent' as const };
  state = applyHistoryPage(state, page('tail', [entry(1, 1, { type: 'assistant_message', text: 'Quiet reply', background })])).state;
  state = reduceTimelineEvent(state, { protocolVersion: '1.8.0', type: 'agent_stream', payload: { agentId: 'agent-one', timestamp: '2026-10-12T00:00:00Z',
    event: { type: 'background_activity_updated', providerId: 'fixture', background: { ...background, status: 'failed' } } } }).state;
  state = applyAgentSnapshot(state, snapshot());
  expect(state.timeline.entries[0]?.item.background?.status).toBe('failed');
  const stale = page('tail', [entry(1, 1, { type: 'assistant_message', text: 'Quiet reply', background })]);
  state = applyHistoryPage(state, stale).state;
  expect(state.timeline.entries[0]?.item.background?.status).toBe('failed');
});

describe('absorbing a replacement by item key', () => {
  const keyed = (key: string, seq: number, item: ProjectedTimelineEntry['item'], seqEnd = seq): ProjectedTimelineEntry => ({ ...entry(seq, seqEnd, item), itemKey: key });
  const assistant = (key: string, text: string, seq: number) => keyed(key, seq, { type: 'assistant_message', text, messageId: key });
  const tail = (entries: ProjectedTimelineEntry[], epoch: string, options: Partial<HistoryPage['payload']> = {}) => page('tail', entries, {
    epoch, startCursor: { epoch, seq: entries[0]?.seqStart ?? 0 }, endCursor: { epoch, seq: entries.at(-1)?.seqEnd ?? 0 }, ...options });
  const held = (...entries: ProjectedTimelineEntry[]) => applyHistoryPage(createReplicaState(), tail(entries, 'epoch-one')).state;
  const keysOf = (state: ReturnType<typeof createReplicaState>) => state.timeline.entries.map(row => row.itemKey);

  it('keeps unchanged rows as they are, updates a changed row in place, drops a missing row and inserts a new one in order', () => {
    const state = held(assistant('a', 'A', 1), assistant('b', 'B', 2), assistant('c', 'C', 3), assistant('d', 'D', 4));
    const [a, , c] = state.timeline.entries;
    const replaced = applyHistoryPage(applyTimelineReplacement(state, 'epoch-two'), tail([
      assistant('a', 'A', 1), assistant('b', 'B changed', 2), assistant('n', 'New', 3), assistant('c', 'C', 4),
    ], 'epoch-two'));

    expect(replaced.status).toBe('applied');
    expect(keysOf(replaced.state)).toEqual(['a', 'b', 'n', 'c']);
    expect(replaced.state.timeline.entries[0]).toBe(a);
    expect(replaced.state.timeline.entries[3]?.item).toBe(c!.item);
    expect(replaced.state.timeline.entries[3]).toMatchObject({ seqStart: 4, seqEnd: 4, sourceSeqRanges: [{ startSeq: 4, endSeq: 4 }] });
    expect(replaced.state.timeline.entries[1]?.item).toMatchObject({ text: 'B changed' });
    expect(replaced.state.timeline).toMatchObject({ epoch: 'epoch-two', nextSeq: 5 });
    expect(replaced.state.timeline.pendingEpoch).toBeUndefined();
    expect(replaced.state.retiredEpochs).toEqual(['epoch-one']);
  });

  it('drops rows older than the new window and never passes through an empty state', () => {
    const state = held(assistant('old', 'Old', 1), assistant('a', 'A', 2));
    const marked = applyTimelineReplacement(state, 'epoch-two');
    expect(marked.timeline.entries).toHaveLength(2);
    const replaced = applyHistoryPage(marked, tail([assistant('a', 'A', 1)], 'epoch-two', { hasOlder: true }));
    expect(keysOf(replaced.state)).toEqual(['a']);
    expect(replaced.state.timeline.hasOlder).toBe(true);
  });

  it('retires the old epoch only when the tail is applied', () => {
    const state = held(assistant('a', 'A', 1));
    const marked = applyTimelineReplacement(state, 'epoch-two');
    expect(marked.retiredEpochs).toEqual([]);
    expect(applyHistoryPage(marked, tail([assistant('a', 'A', 1)], 'epoch-two')).state.retiredEpochs).toEqual(['epoch-one']);
  });

  it('retargets a second replacement while one is pending, with no queue', () => {
    const state = held(assistant('a', 'A', 1));
    const second = applyTimelineReplacement(applyTimelineReplacement(state, 'epoch-two'), 'epoch-three');
    expect(second.timeline.pendingEpoch).toBe('epoch-three');
    expect(second.retiredEpochs).toEqual(['epoch-two']);
    const replaced = applyHistoryPage(second, tail([assistant('a', 'A', 1)], 'epoch-three'));
    expect(replaced.state.timeline.epoch).toBe('epoch-three');
    expect(replaced.state.timeline.pendingEpoch).toBeUndefined();
    expect(replaced.state.retiredEpochs).toEqual(['epoch-two', 'epoch-one']);
  });

  it('buffers every frame of the pending epoch, a gap included, and applies them after the tail', () => {
    let state = applyTimelineReplacement(held(assistant('a', 'A', 1)), 'epoch-two');
    for (const seq of [3, 2]) {
      const result = reduceTimelineEvent(state, stream(seq, { type: 'assistant_message', text: `Frame ${seq}`, messageId: `m${seq}` }, 'epoch-two'));
      expect(result.status).toBe('buffered');
      state = result.state;
    }
    const replaced = applyHistoryPage(state, tail([assistant('a', 'A', 1)], 'epoch-two'));
    expect(replaced.status).toBe('applied');
    expect(replaced.state.timeline.entries.map(row => row.item.type === 'assistant_message' ? row.item.text : '')).toEqual(['A', 'Frame 2', 'Frame 3']);
    expect(replaced.state.timeline.pendingLive).toEqual([]);
  });

  it('answers a page that says the cursor is stale or ahead with one replaced reduction that keeps the rows', () => {
    const state = held(assistant('a', 'A', 1));
    for (const flags of [{ reset: true, staleCursor: true }, { gap: true }]) {
      const result = applyHistoryPage(state, page('after', [], { epoch: 'epoch-two', ...flags }));
      expect(result).toMatchObject({ status: 'replaced', epoch: 'epoch-two' });
      expect(result.state.timeline.entries).toHaveLength(1);
    }
    const sameEpoch = applyHistoryPage(state, page('after', [], { epoch: 'epoch-one', gap: true }));
    expect(sameEpoch).toMatchObject({ status: 'replaced', epoch: 'epoch-one' });
    // The epoch the replica holds is pending too: its frames wait for the tail, as for any replacement.
    expect(sameEpoch.state.timeline.pendingEpoch).toBe('epoch-one');
    const waiting = reduceTimelineEvent(sameEpoch.state, stream(2, { type: 'assistant_message', text: 'Waits', messageId: 'w' }));
    expect(waiting.status).toBe('buffered');
    const read = applyHistoryPage(waiting.state, tail([assistant('a', 'A', 1)], 'epoch-one'));
    expect(read.state.timeline.pendingEpoch).toBeUndefined();
    expect(read.state.timeline.entries.map(row => row.item.type === 'assistant_message' ? row.item.text : '')).toEqual(['A', 'Waits']);
  });

  it('replaces rows without keys, which key by epoch, through one transition and never an empty state', () => {
    const state = applyHistoryPage(createReplicaState(), page('tail', [entry(1, 1, { type: 'user_message', text: 'Old' })])).state;
    const marked = applyTimelineReplacement(state, 'epoch-two');
    expect(marked.timeline.entries).toHaveLength(1);
    const replaced = applyHistoryPage(marked, page('tail', [entry(1, 1, { type: 'user_message', text: 'Old' })], { epoch: 'epoch-two' }));
    expect(replaced.state.timeline.entries).toHaveLength(1);
    expect(replaced.state.timeline.entries[0]).not.toBe(state.timeline.entries[0]);
  });

  it('holds one row per key: a live event updates the held row in place and keeps its position', () => {
    let state = held(assistant('a', 'A', 1), keyed('tool', 2, { type: 'tool_call', callId: 'c', name: 'bash', detail: { type: 'other', description: 'x' }, status: 'running', error: null }), assistant('b', 'B', 3));
    const frame = (seq: number, itemKey: string, item: ProjectedTimelineEntry['item']): AgentStreamMessage => {
      const message = stream(seq, item);
      (message.payload as { event: { itemKey?: string } }).event.itemKey = itemKey;
      return message;
    };
    state = reduceTimelineEvent(state, frame(4, 'tool', { type: 'tool_call', callId: 'c', name: 'bash', detail: { type: 'other', description: 'x' }, status: 'completed', error: null })).state;
    state = reduceTimelineEvent(state, frame(5, 'b', { type: 'assistant_message', text: ' more', messageId: 'b' })).state;
    state = reduceTimelineEvent(state, frame(6, 'n', { type: 'assistant_message', text: 'New', messageId: 'n' })).state;
    expect(keysOf(state)).toEqual(['a', 'tool', 'b', 'n']);
    expect(state.timeline.entries[1]).toMatchObject({ seqStart: 2, seqEnd: 4, item: { status: 'completed' } });
    expect(state.timeline.entries[2]?.item).toMatchObject({ text: 'B more' });
  });

  it('drops the keys an older page repeats, so an item updated above the window neither repeats nor leaves a hole', () => {
    const state = applyHistoryPage(createReplicaState(), tail([assistant('c', 'C', 3), assistant('d', 'D', 4)], 'epoch-one', { hasOlder: true })).state;
    const older = applyHistoryPage(state, page('before', [assistant('b', 'B', 2), assistant('c', 'C updated above', 1)], { epoch: 'epoch-one', hasOlder: false }));
    const keys = keysOf(older.state);
    expect(new Set(keys).size).toBe(keys.length);
    expect(keys).toEqual(['c', 'b', 'd'].sort((x, y) => (older.state.timeline.entries.find(r => r.itemKey === x)!.seqStart - older.state.timeline.entries.find(r => r.itemKey === y)!.seqStart)));
    expect(older.state.timeline.entries.find(row => row.itemKey === 'c')?.item).toMatchObject({ text: 'C' });
  });

  it('builds the same row live as from a page: a page of the same epoch leaves the live rows as they are', () => {
    let state = held();
    const message = (seq: number, text: string): AgentStreamMessage => {
      const result = stream(seq, { type: 'assistant_message', text, messageId: 'm' });
      (result.payload as { event: { itemKey?: string } }).event.itemKey = 'm';
      return result;
    };
    for (const [seq, text] of [[1, 'Hel'], [2, 'lo'], [3, '']] as const) state = reduceTimelineEvent(state, message(seq, text)).state;
    const [live] = state.timeline.entries;
    const reread = applyHistoryPage(state, tail([{ ...keyed('m', 1, { type: 'assistant_message', text: 'Hello', messageId: 'm' }, 3), collapsed: ['assistant_merge'] }], 'epoch-one', { window: { minSeq: 1, maxSeq: 3, nextSeq: 4 } }));
    expect(reread.state.timeline.entries[0]).toBe(live);
  });

  it('applies only the tail of the pending epoch: a tail of the held epoch does not end the replacement', () => {
    const marked = applyTimelineReplacement(held(assistant('a', 'A', 1)), 'epoch-two');
    const heldTail = applyHistoryPage(marked, tail([assistant('a', 'A', 1)], 'epoch-one'));
    expect(heldTail.status).toBe('duplicate');
    expect(heldTail.state).toBe(marked);
    expect(applyHistoryPage(marked, page('after', [], { epoch: 'epoch-one' })).status).toBe('duplicate');
  });

  it('keeps an item updated above the window where it is, so older history stays reachable after a reconnect', () => {
    // The journal updates `todo` in place and keeps its first sequence 1; the client holds only the newest rows.
    const all = Array.from({ length: 40 }, (_, index) => assistant(`n${index + 2}`, `Row ${index + 2}`, index + 2));
    const window = all.slice(20);
    const state = applyHistoryPage(createReplicaState(), tail(window, 'epoch-one', { hasOlder: true })).state;
    const updatedTodo = { ...keyed('todo', 1, { type: 'todo', items: [{ text: 'a', completed: true }] }), seqEnd: 43 };
    const fresh = assistant('n42', 'Row 42', 42);
    const after = page('after', [updatedTodo, fresh], { epoch: 'epoch-one', window: { minSeq: 1, maxSeq: 43, nextSeq: 44 }, startCursor: { epoch: 'epoch-one', seq: 1 }, endCursor: { epoch: 'epoch-one', seq: 43 } });
    const next = applyHistoryPage(state, after).state;
    // Sorted by first sequence: the todo is not at the top (it is older history), and the next older page starts below the oldest held row.
    expect(next.timeline.entries.map(row => row.seqStart)).toEqual([...next.timeline.entries.map(row => row.seqStart)].sort((x, y) => x - y));
    expect(keysOf(next)[0]).toBe('n22');
    expect(next.timeline.entries.at(-1)?.itemKey).toBe('n42');
    expect(next.timeline.hasOlder).toBe(true);
    const older = applyHistoryPage(next, page('before', [keyed('todo', 1, { type: 'todo', items: [] }), ...all.slice(0, 20)], { epoch: 'epoch-one', hasOlder: false }));
    expect(keysOf(older.state).slice(0, 3)).toEqual(['todo', 'n2', 'n3']);
    expect(new Set(keysOf(older.state)).size).toBe(keysOf(older.state).length);
  });

  it('updates a held row in place without moving it when an after page carries its new content', () => {
    const state = held(keyed('todo', 1, { type: 'todo', items: [] }), assistant('a', 'A', 2));
    const after = applyHistoryPage(state, page('after', [{ ...keyed('todo', 1, { type: 'todo', items: [{ text: 'x', completed: false }] }), seqEnd: 3 }], { epoch: 'epoch-one', window: { minSeq: 1, maxSeq: 3, nextSeq: 4 } }));
    expect(keysOf(after.state)).toEqual(['todo', 'a']);
    expect(after.state.timeline.entries[0]).toMatchObject({ seqStart: 1, seqEnd: 3, item: { items: [{ text: 'x' }] } });
  });

  it('leaves a live frame for an item above the window to the older page, so live and paged order agree', () => {
    const state = applyHistoryPage(createReplicaState(), tail([assistant('n22', 'Row 22', 22), assistant('n23', 'Row 23', 23)], 'epoch-one', { hasOlder: true })).state;
    const frame = (seq: number, itemKey: string, itemSeqStart: number): AgentStreamMessage => {
      const message = stream(seq, { type: 'todo', items: [{ text: 'a', completed: true }] }, 'epoch-one');
      Object.assign((message.payload as { event: object }).event, { itemKey, itemSeqStart });
      return message;
    };
    const next = reduceTimelineEvent(state, frame(24, 'todo', 1));
    expect(next.status).toBe('applied');
    expect(keysOf(next.state)).toEqual(['n22', 'n23']);
    expect(next.state.timeline.nextSeq).toBe(25);
    // A new item inside the window still lands at the end, and the older page then brings the todo in its place.
    const inside = reduceTimelineEvent(next.state, { ...frame(25, 'n24', 24) });
    expect(keysOf(inside.state)).toEqual(['n22', 'n23', 'n24']);
    const older = applyHistoryPage(inside.state, page('before', [keyed('todo', 1, { type: 'todo', items: [] })], { epoch: 'epoch-one', hasOlder: false }));
    expect(keysOf(older.state)).toEqual(['todo', 'n22', 'n23', 'n24']);
  });
});

describe('rows restored from the device', () => {
  const record = () => ({ snapshot: snapshot().payload, epoch: 'epoch-one', nextSeq: 3, hasOlder: true,
    entries: [entry(1, 1, { type: 'assistant_message', text: 'one', messageId: 'm1' }), entry(2, 2, { type: 'assistant_message', text: 'two', messageId: 'm2' })] });

  it('seeds only a replica that has read nothing', () => {
    const restored = restoreFromDevice(createReplicaState(), record());
    expect(restored.timeline).toMatchObject({ initialized: true, epoch: 'epoch-one', nextSeq: 3, hasOlder: true, restoredFromDevice: true });
    expect(restored.agent?.id).toBe('agent-one');
    expect(restoreFromDevice(restored, { ...record(), epoch: 'epoch-two' }).timeline.epoch).toBe('epoch-one');
    expect(restoreFromDevice(applyAgentSnapshot(createReplicaState(), snapshot()), record()).timeline.initialized).toBe(false);
  });

  it('are confirmed by the first page that reads forward from them, and not by one that reads older rows', () => {
    const restored = restoreFromDevice(createReplicaState(), record());
    const older = applyHistoryPage(restored, page('before', [entry(0, 0, { type: 'assistant_message', text: 'zero', messageId: 'm0' })], { endCursor: { epoch: 'epoch-one', seq: 0 } }));
    expect(older.status).toBe('applied');
    expect(older.state.timeline.restoredFromDevice).toBe(true);
    const nothingNew = applyHistoryPage(restored, page('after', [], { window: { minSeq: 1, maxSeq: 2, nextSeq: 3 } }));
    expect(nothingNew.status).toBe('applied');
    expect(nothingNew.state.timeline.restoredFromDevice).toBeUndefined();
  });

  it('are replaced by the tail of the new epoch when the Relay does not hold the stored position, and then confirmed', () => {
    const restored = restoreFromDevice(createReplicaState(), record());
    const stale = applyHistoryPage(restored, page('after', [], { epoch: 'epoch-two', reset: true, staleCursor: true }));
    expect(stale.status).toBe('replaced');
    expect(stale.state.timeline).toMatchObject({ pendingEpoch: 'epoch-two', restoredFromDevice: true });
    expect(stale.state.timeline.entries).toHaveLength(2);
    const tail = applyHistoryPage(stale.state, page('tail', [entry(1, 1, { type: 'assistant_message', text: 'one', messageId: 'm1' })], { epoch: 'epoch-two' }));
    expect(tail.status).toBe('applied');
    expect(tail.state.timeline).toMatchObject({ epoch: 'epoch-two' });
    expect(tail.state.timeline.restoredFromDevice).toBeUndefined();
    expect(tail.state.timeline.pendingEpoch).toBeUndefined();
  });
});
