import { describe, expect, it } from 'vitest';

import { projectCodexThreadHistory } from './history.js';

describe('projectCodexThreadHistory', () => {
  it('projects completed turns in native order with history delivery', () => {
    const history = projectCodexThreadHistory({
      thread: {
        id: 'thread-1',
        turns: [
          {
            id: 'turn-1',
            startedAt: 1,
            completedAt: 2,
            items: [
              { type: 'userMessage', id: 'user-1', clientId: 'client-1', content: [{ type: 'text', text: 'Hello' }] },
              { type: 'agentMessage', id: 'assistant-1', text: 'Hi' },
            ],
          },
        ],
      },
    }, 'thread-1');

    expect(history).toHaveLength(2);
    expect(history.map((entry) => ({ sourceKey: entry.sourceKey, occurredAt: entry.occurredAt, delivery: entry.delivery, item: entry.event.type === 'timeline' ? entry.event.item : null }))).toEqual([
      {
        sourceKey: 'item:user-1:completed', occurredAt: 1000, delivery: 'history',
        item: { type: 'user_message', text: 'Hello', messageId: 'user-1', clientMessageId: 'client-1' },
      },
      {
        sourceKey: 'item:assistant-1:completed', occurredAt: 2000, delivery: 'history',
        item: { type: 'assistant_message', text: 'Hi', messageId: 'assistant-1' },
      },
    ]);
  });

  it('rejects a thread/read response for a different thread', () => {
    expect(() => projectCodexThreadHistory({ thread: { id: 'other', turns: [] } }, 'thread-1'))
      .toThrow('Codex thread/read returned other instead of thread-1');
  });

  it('reports a history item of a type it does not know as one diagnostic, naming the type only, and shows no row for it (gap 10)', () => {
    const diagnostics: string[] = [];
    const history = projectCodexThreadHistory({
      thread: { id: 'thread-1', turns: [{
        id: 'turn-1', completedAt: 2,
        items: [{ type: 'futureTool', id: 'future-1', payload: 'z'.repeat(2_000) }, { type: 'agentMessage', id: 'agent-1', text: 'Hi' }],
      }] },
    }, 'thread-1', { diagnostic: line => diagnostics.push(line) });

    expect(history.map(({ itemIdentity }) => itemIdentity?.key)).toEqual(['assistant:agent-1']);
    expect(diagnostics.map(line => JSON.parse(line))).toEqual([{ event: 'native_event_unknown', providerId: 'codex', kind: 'item:futureTool', delivery: 'history', reason: 'unknown_kind' }]);
  });
});

it('preserves failed turn reasons as historical errors without replaying lifecycle state', () => {
  const history = projectCodexThreadHistory({ thread: { id: 'thread-1', turns: [
    { id: 'failed', status: 'failed', completedAt: 2, error: { message: 'Encrypted output could not be decoded.' }, items: [] },
    { id: 'completed', status: 'completed', completedAt: 3, error: null, items: [] },
  ] } }, 'thread-1');
  expect(history).toEqual([expect.objectContaining({ sourceKey: 'turn:failed:error', delivery: 'history', occurredAt: 2000,
    event: { type: 'timeline', provider: 'codex', turnId: 'failed', item: { type: 'error', message: 'Encrypted output could not be decoded.' } } })]);
});
