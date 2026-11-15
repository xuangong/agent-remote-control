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

  it('never evicts a sealed item, which has no digest to fill it back', () => {
    const { journal, publish } = openJournal();
    journal.append(publish(), text('s1', 'ds1', 'sealed', 'turn-1'));
    journal.seal(publish(), 's1');
    journal.append(publish(), text('m2', 'd2', 'second', 'turn-2'));
    journal.complete(publish(), 'm2', 'digest-2');
    journal.append(publish(), text('m3', 'd3', 'third', 'turn-3'));
    expect(evictableItems(journal.state().items, 1)).toEqual(['m2']);
    expect(journal.evict(1)).toEqual(['m2']);
    expect(journal.index()[0]).toMatchObject({ itemKey: 's1', resident: true });
  });

  it('rejects a turn count that is not a non-negative integer', () => {
    const { journal } = threeTurns();
    for (const bad of [-1, 1.5, Number.NaN, Number.POSITIVE_INFINITY]) {
      expect(() => evictableItems(journal.state().items, bad)).toThrow('Journal turns to keep must be a non-negative integer.');
    }
  });

  it('leaves a mismatched fill untouched and reports what evict and fill changed', () => {
    const { journal } = threeTurns();
    journal.takeChanges();
    journal.evict(1);
    expect(journal.takeChanges()?.upsert.map(({ itemKey }) => itemKey)).toEqual(['m1', 'm2']);
    expect(journal.takeChanges()).toBeUndefined();
    const body = bodyFromRow(text('m1', 'h1', 'first', 'turn-1'));
    expect(journal.fill('m1', body, 'digest-other')).toBe('mismatch');
    expect(journal.index()[0]).toMatchObject({ itemKey: 'm1', resident: false });
    expect(journal.takeChanges()).toBeUndefined();
    expect(journal.fill('m1', body, 'digest-1')).toBe('filled');
    expect(journal.takeChanges()?.upsert.map(({ itemKey }) => itemKey)).toEqual(['m1']);
  });

  it('changes nothing when the body is already resident, whatever the digest', () => {
    const { journal } = threeTurns();
    journal.takeChanges();
    const before = journal.state();
    expect(journal.fill('m1', bodyFromRow(text('m1', 'x', 'other')), 'digest-other')).toBe('filled');
    expect(journal.state()).toEqual(before);
    expect(journal.takeChanges()).toBeUndefined();
  });

  it('stores a copy of the filled body', () => {
    const { journal } = threeTurns();
    journal.evict(1);
    const body = bodyFromRow(text('m1', 'h1', 'first', 'turn-1'));
    journal.fill('m1', body, 'digest-1');
    if (body.item.type === 'assistant_message') body.item.text = 'changed';
    expect(journal.state().items[0]?.body?.item).toMatchObject({ text: 'first' });
  });

  it('restores the alias and background of an item after eviction and fill', () => {
    const { journal, publish } = openJournal();
    const background = { id: 'review-1', kind: 'review' as const, status: 'visible' as const };
    journal.append(publish(), { itemKey: 'u1', providerId: 'codex', sourceKey: 'u1', occurredAt: 0, turnId: 'turn-1', item: { type: 'user_message', text: 'ask' } });
    journal.alias(publish(), 'u1', 'client-1');
    journal.complete(publish(), 'u1', 'digest-u1');
    journal.append(publish(), { itemKey: 'c1', providerId: 'codex', sourceKey: 'c1', occurredAt: 0, turnId: 'turn-1', item: { type: 'tool_call', callId: 'c1', name: 'shell', status: 'completed', error: null, detail: { type: 'shell', command: 'ls' }, background } });
    journal.complete(publish(), 'c1', 'digest-c1');
    journal.append(publish(), text('m2', 'd2', 'second', 'turn-2'));
    expect(journal.evict(1)).toEqual(['u1', 'c1']);
    const user = bodyFromRow({ itemKey: 'u1', providerId: 'codex', sourceKey: 'u1', occurredAt: 0, item: { type: 'user_message', text: 'ask' } });
    const call = bodyFromRow({ itemKey: 'c1', providerId: 'codex', sourceKey: 'c1', occurredAt: 0, item: { type: 'tool_call', callId: 'c1', name: 'shell', status: 'completed', error: null, detail: { type: 'shell', command: 'ls' } } });
    expect(journal.fill('u1', user, 'digest-u1')).toBe('filled');
    expect(journal.fill('c1', call, 'digest-c1')).toBe('filled');
    const [filledUser, filledCall] = journal.state().items;
    expect(filledUser?.body?.item).toMatchObject({ clientMessageId: 'client-1' });
    expect(filledCall?.body?.item).toMatchObject({ background });
  });
});
