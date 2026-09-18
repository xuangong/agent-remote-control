import { expect, it } from 'vitest';
import { CodexEventProjector } from './projector.js';

it('projects sleep lifecycle and history as a wait without inventing elapsed time', () => {
  const projector = new CodexEventProjector('thread');
  const item = { type: 'sleep', id: 'sleep-call', durationMs: 15000 };
  for (const [method, status] of [['item/started', 'running'], ['item/completed', 'completed']] as const) {
    const observation = projector.projectNotification(method, { threadId: 'thread', turnId: 'turn', item });
    expect(observation?.event).toMatchObject({ type: 'timeline', item: {
      type: 'tool_call', callId: 'sleep-call', name: 'clock.sleep', status,
      detail: { type: 'other', description: 'Wait up to 15 seconds (requested)' }, error: null,
    } });
    expect(observation?.event).not.toHaveProperty('item.result.durationMs');
    if (status === 'completed') expect(projector.projectHistoryItem(item, 'turn')?.event).toEqual(observation?.event);
  }
});

it.each([undefined, -1, NaN, '15000'])('does not invent a requested duration for malformed sleep duration %s', durationMs => {
  const event = new CodexEventProjector('thread').projectHistoryItem({ type: 'sleep', id: 'sleep', durationMs });
  expect(event?.event).toMatchObject({ item: { type: 'tool_call', detail: { description: 'Wait' } } });
});
