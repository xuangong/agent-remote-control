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

  it('keeps unsupported history items visible with bounded details', () => {
    const history = projectCodexThreadHistory({
      thread: { id: 'thread-1', turns: [{
        id: 'turn-1', completedAt: 2,
        items: [{ type: 'futureTool', id: 'future-1', payload: 'z'.repeat(2_000) }],
      }] },
    }, 'thread-1');

    expect(history).toHaveLength(1);
    expect(history[0]).toMatchObject({
      delivery: 'history', sourceKey: 'item:future-1:completed',
      event: { type: 'timeline', item: { type: 'error' } },
    });
    const event = history[0]?.event;
    if (event?.type !== 'timeline' || event.item.type !== 'error') {
      throw new Error('Expected an unsupported history item diagnostic');
    }
    expect(event.item.message).toContain('futureTool');
    expect(event.item.message.length).toBeLessThanOrEqual(640);
  });
});
