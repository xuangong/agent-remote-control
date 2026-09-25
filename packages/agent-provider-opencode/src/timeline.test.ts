import { expect, test } from 'vitest';
import type { ProviderObservation } from '@orchardworks/agent-provider-sdk';
import { orderedSnapshot, reconcileTimeline } from './timeline.js';
const text = (key: string, value: string): ProviderObservation => ({ type: 'observation', sourceKey: key, occurredAt: 1, delivery: 'history', event: { type: 'timeline', provider: 'opencode', item: { type: 'assistant_message', messageId: key, text: value } } });
test('replaces when a newly discovered item belongs before existing history', () => {
  expect(reconcileTimeline([text('a', 'A'), text('c', 'C')], [text('a', 'A'), text('b', 'B'), text('c', 'C')], [], true)[0]?.type).toBe('timeline_replacement');
});
test('preserves observed older history when bounded native pagination trims only a prefix', () => {
  expect(reconcileTimeline([text('a', 'A'), text('b', 'B')], [text('b', 'B'), text('c', 'C')], [], true, 'older', true)).toEqual([{ ...text('c', 'C'), delivery: 'live' }]);
  expect(reconcileTimeline([text('a', 'A'), text('b', 'B')], [text('b', 'B')], [], true, 'older', false)[0]?.type).toBe('timeline_replacement');
});
test('updates a late tool result without replacing or appending repeated text', () => {
  const tool = (status: 'running' | 'completed'): ProviderObservation => ({ ...text('tool', ''), event: { type: 'timeline', provider: 'opencode', item: { type: 'tool_call', callId: 'call', name: 'bash', status, error: null, detail: { type: 'shell', command: 'pwd' } } } });
  const changes = reconcileTimeline([tool('running'), text('a', 'answer')], [tool('completed'), text('a', 'answer')], [], true);
  expect(changes).toHaveLength(1);
  expect(changes[0]).toMatchObject({ type: 'observation', event: { item: { callId: 'call', status: 'completed' } } });
});
test('anchors resolved interactions to their native predecessor during corrections', () => {
  const receipt = text('receipt', 'answered');
  const changes = reconcileTimeline([text('a', 'old'), text('b', 'next')], [text('a', 'corrected'), text('b', 'next')], [{ observation: receipt, after: 'a' }], true);
  expect(changes[0]).toMatchObject({ type: 'timeline_replacement', observations: [text('a', 'corrected'), receipt, text('b', 'next')] });
});
test('keeps receipts outside the current native page out of a corrected tail', () => {
  const receipt = { observation: text('receipt', 'old answer'), after: 'a' };
  const changes = reconcileTimeline([text('b', 'old'), text('c', 'current')], [text('b', 'corrected'), text('c', 'current')], [receipt], true, 'older', true);
  expect(changes[0]).toMatchObject({ type: 'timeline_replacement', observations: [text('b', 'corrected'), text('c', 'current')] });
});

test('restores a receipt with its older native page and places unanchored entries first', () => {
  const receipt = text('receipt', 'old answer');
  const initial = text('initial', 'initial todo');
  expect(orderedSnapshot([text('a', 'old')], [{ observation: receipt, after: 'a' }])).toEqual([text('a', 'old'), receipt]);
  expect(orderedSnapshot([text('b', 'current')], [{ observation: initial }, { observation: receipt, after: 'a' }])).toEqual([initial, text('b', 'current')]);
});
