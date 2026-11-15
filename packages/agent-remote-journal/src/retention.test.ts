import { describe, expect, it } from 'vitest';

import { bodyFromRow } from './journal-items.js';
import { evictableItems } from './retention.js';
import { openJournal, text } from './journal.test-fixture.js';

function threeTurns() {
  const { journal, publish } = openJournal();
  journal.append(publish(), text('m1', 'd1', 'first', 'turn-1'));
  journal.complete(publish(), 'm1', 'digest-1');
  journal.append(publish(), { ...text('i1', 'i1', 'ask', 'turn-1'), liveOnly: true });
  journal.complete(publish(), 'i1', 'digest-i1');
  journal.append(publish(), text('m2', 'd2', 'second', 'turn-2'));
  journal.complete(publish(), 'm2', 'digest-2');
  journal.append(publish(), text('m3', 'd3', 'third', 'turn-3'));
  return { journal, publish };
}

describe('retention', () => {
  it('evicts complete bodies outside the latest turns, never live-only or open items', () => {
    const { journal } = threeTurns();
    expect(evictableItems(journal.state().items, 2)).toEqual(['m1']);
    expect(evictableItems(journal.state().items, 0)).toEqual(['m1', 'm2']);
  });

  it('asks for a fill when a page reaches an evicted body and accepts only the recorded digest', () => {
    const { journal } = threeTurns();
    expect(journal.evict(2)).toEqual(['m1']);
    expect(journal.index()[0]).toMatchObject({ itemKey: 'm1', resident: false });
    const request = { requestId: 'r', agentId: 'a', direction: 'tail' as const, limit: 10 };
    expect(journal.page(request, { olderBeyondJournal: false })).toEqual({ kind: 'missing', itemKeys: ['m1'] });
    const body = bodyFromRow(text('m1', 'h1', 'first', 'turn-1'));
    expect(journal.fill('m1', body, 'digest-other')).toBe('mismatch');
    expect(journal.fill('m1', body, 'digest-1')).toBe('filled');
    expect(journal.page(request, { olderBeyondJournal: false }).kind).toBe('page');
    expect(journal.fill('unknown', body, 'digest-1')).toBe('unknown');
  });
});
