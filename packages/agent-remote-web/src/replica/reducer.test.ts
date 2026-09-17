import { describe, expect, it } from 'vitest';
import type {
  AgentInteractionRequest,
  AgentSnapshot,
  AgentStreamMessage,
  HistoryPage,
  ProjectedTimelineEntry,
  ResourceBinding,
} from '@agent-remote-controller/agent-remote-protocol';

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
} from './reducer.js';

const capabilities = {
  history: true,
  sendMessage: true,
  steer: true,
  cancel: true,
  readResource: true,
  interactions: { question: true, planApproval: true, toolApproval: true },
};

it.each([undefined, null, 'old-turn', 'actual-turn'])('reconciles authoritative runtime turn %s in live delivery and snapshot replay', activeTurnId => {
  const original = snapshot('running');
  original.payload.activeTurn = { turnId: 'old-turn', startedAt: '2026-09-10T00:00:00.000Z' };
  const message: AgentStreamMessage = {
    protocolVersion: '1.4.0', type: 'agent_stream', payload: {
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
    protocolVersion: '1.4.0', type: 'agent_stream',
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
    protocolVersion: '1.4.0',
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
    protocolVersion: '1.4.0',
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
    protocolVersion: '1.4.0',
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

  it('atomically resets the Timeline on a replacement epoch and rejects retired epoch delivery', () => {
    let state = applyHistoryPage(createReplicaState(), page('tail', [
      entry(1, 1, { type: 'user_message', text: 'Retired row' }),
    ])).state;
    state = applyTimelineReplacement(state, 'epoch-two');

    expect(state.timeline).toMatchObject({ epoch: 'epoch-two', initialized: false, entries: [] });
    expect(state.retiredEpochs).toEqual(['epoch-one']);

    const stale = reduceTimelineEvent(state, stream(2, {
      type: 'assistant_message', text: 'Late old row',
    }, 'epoch-one'));
    expect(stale.status).toBe('stale_epoch');
    expect(stale.state).toBe(state);

    const buffered = reduceTimelineEvent(state, stream(1, {
      type: 'assistant_message', text: 'New epoch row',
    }, 'epoch-two'));
    expect(buffered.status).toBe('buffered');
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
      protocolVersion: '1.4.0',
      type: 'timeline_resource_binding_replaced',
      payload: {
        agentId: 'agent-one', epoch: 'epoch-one', seq: 1,
        previous: provisional, replacement,
      },
    });
    liveState = applyResourceUpdate(liveState, {
      protocolVersion: '1.4.0',
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
