import { describe, expect, it } from 'vitest';

import { recordingShape } from './journal-recording.js';
import type { ProviderObservation } from './index.js';

const row = (key: string, turnId: string, liveOnly = false): ProviderObservation => ({ type: 'observation', sourceKey: key, occurredAt: 1, delivery: 'live',
  event: { type: 'timeline', provider: 'test', turnId, item: { type: liveOnly ? 'todo' : 'assistant_message', ...(liveOnly ? { items: [] } : { text: key }) } as never },
  itemIdentity: { key, completes: true, ...(liveOnly ? { liveOnly: true as const } : {}) } });
const recorded = (...live: ProviderObservation[]) => ({ live, reread: [] });

describe('the shape a recorder compares two runs by', () => {
  it('keeps the live order of native items, unless the adapter declares a turn\'s siblings unordered', () => {
    const first = recorded(row('a', 't1'), row('b', 't2'), row('c', 't2'));
    const swapped = recorded(row('a', 't1'), row('c', 't2'), row('b', 't2'));
    expect(recordingShape(swapped)).not.toEqual(recordingShape(first));
    expect(recordingShape(swapped, 'siblings_unordered')).toEqual(recordingShape(first, 'siblings_unordered'));
    const acrossTurns = recorded(row('b', 't2'), row('c', 't2'), row('a', 't1'));
    expect(recordingShape(acrossTurns, 'siblings_unordered')).not.toEqual(recordingShape(first, 'siblings_unordered'));
  });

  it('gives a live-only item no place among the others, as the journal compares it by key', () => {
    const before = recorded(row('todo', 't1', true), row('a', 't1'), row('b', 't2'));
    const after = recorded(row('a', 't1'), row('b', 't2'), row('todo', 't2', true));
    expect(recordingShape(after)).toEqual(recordingShape(before));
  });
});
