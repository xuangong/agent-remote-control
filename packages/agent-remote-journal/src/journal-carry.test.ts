import { describe, expect, it } from 'vitest';

import { bodyFromRow } from './journal-items.js';
import { expectNoChange, openJournal, text } from './journal.test-fixture.js';
import { JournalBodyMissingError, JournalStaleRevisionError, type JournalRowInput } from './types.js';
import { SessionJournal } from './session-journal.js';

const background = { id: 'review-1', kind: 'review' as const, status: 'visible' as const };
const user = (extra: object = {}): JournalRowInput => ({
  itemKey: 'u1', providerId: 'codex', sourceKey: 'u1', occurredAt: 0, turnId: 'turn-1', item: { type: 'user_message', text: 'ask', ...extra },
});
const call = (extra: object = {}): JournalRowInput => ({
  itemKey: 'c1', providerId: 'codex', sourceKey: 'c1', occurredAt: 0, turnId: 'turn-1',
  item: { type: 'tool_call', callId: 'c1', name: 'shell', status: 'completed', error: null, detail: { type: 'shell', command: 'ls' }, ...extra },
});

describe('what a replacement keeps', () => {
  it('carries the alias of a surviving user message and the background of a surviving tool call', () => {
    const { journal, publish } = openJournal();
    journal.append(publish(), user());
    journal.alias(publish(), 'u1', 'client-1');
    journal.append(publish(), call({ background }));
    journal.replace(publish(), [{ row: user(), digest: 'du' }, { row: call(), digest: 'dc' }], 0);
    const [first, second] = journal.state().items;
    expect(first).toMatchObject({ itemKey: 'u1', clientMessageId: 'client-1', body: { item: { clientMessageId: 'client-1' } } });
    expect(second?.body?.item).toMatchObject({ background });
    expect(journal.index()[0]).toMatchObject({ clientMessageId: 'client-1' });
  });

  it('carries the kept background and alias of an evicted item', () => {
    const { journal, publish } = openJournal();
    journal.append(publish(), user());
    journal.alias(publish(), 'u1', 'client-1');
    journal.complete(publish(), 'u1', 'du');
    journal.append(publish(), call({ background }));
    journal.complete(publish(), 'c1', 'dc');
    journal.append(publish(), text('m2', 'd2', 'second', 'turn-2'));
    expect(journal.evict(1)).toEqual(['u1', 'c1']);
    journal.replace(publish(), [{ row: user(), digest: 'du' }, { row: call(), digest: 'dc' }, { row: text('m2', 'h2', 'second', 'turn-2'), digest: 'd2' }], 0);
    const [first, second] = journal.state().items;
    expect(first?.body?.item).toMatchObject({ clientMessageId: 'client-1' });
    expect(second?.body?.item).toMatchObject({ background });
  });

  it('keeps what the reread brings when it brings its own background', () => {
    const { journal, publish } = openJournal();
    journal.append(publish(), call({ background }));
    const newer = { id: 'review-2', kind: 'review' as const, status: 'visible' as const };
    journal.replace(publish(), [{ row: call({ background: newer }), digest: 'dc' }], 0);
    expect(journal.state().items[0]?.body?.item).toMatchObject({ background: newer });
  });

  it('carries an open item the reread lacks as a sealed, relay-only item', () => {
    const { journal, publish } = openJournal();
    journal.append(publish(), text('m1', 'd1', 'one'));
    journal.append(publish(), text('m2', 'd2', 'two'));
    journal.append(publish(), text('x', 'dx', 'open'));
    journal.replace(publish(), [
      { row: text('m2', 'h2', 'two'), digest: 'd2' }, { row: text('m1', 'h1', 'one'), digest: 'd1' },
    ], 0);
    expect(journal.index().map(({ itemKey }) => itemKey)).toEqual(['m2', 'x', 'm1']);
    const sealed = journal.index()[1];
    expect(sealed).toMatchObject({ state: 'complete', liveOnly: true, resident: true });
    expect(sealed?.digest).toBeUndefined();
    expect(journal.state().items[1]?.body?.item).toMatchObject({ text: 'open' });
  });
});

describe('revisions across epochs', () => {
  it('refuses a correction computed against the revision of an earlier epoch', () => {
    const { journal, publish } = openJournal();
    journal.append(publish(), text('m1', 'd1', 'one'));
    journal.complete(publish(), 'm1', 'd1');
    const revision = journal.index()[0]!.revision;
    journal.replace(publish(), [{ row: text('m1', 'h1', 'one'), digest: 'd1' }], 0);
    expect(journal.index()[0]!.revision).toBeGreaterThan(revision);
    expectNoChange(journal, () => journal.correct(publish(), text('m1', 'h2', 'two'), 'd2', revision), JournalStaleRevisionError);
  });
});

describe('sealing and filling', () => {
  it('refuses to seal an item whose body is evicted', () => {
    const { journal, publish } = openJournal();
    journal.append(publish(), text('m1', 'd1', 'one', 'turn-1'));
    journal.complete(publish(), 'm1', 'd1');
    journal.append(publish(), text('m2', 'd2', 'two', 'turn-2'));
    journal.evict(1);
    expectNoChange(journal, () => journal.seal(publish(), 'm1'), JournalBodyMissingError);
  });

  it('refuses a fill for an item that has no recorded digest', () => {
    const { journal, publish } = openJournal();
    journal.append(publish(), text('m1', 'd1', 'one'));
    const state = journal.state();
    (state.items[0] as { body: null }).body = null;
    const restored = new SessionJournal(state);
    journal.takeChanges();
    expect(restored.fill('m1', bodyFromRow(text('m1', 'h1', 'one')), 'any')).toBe('mismatch');
    expect(restored.index()[0]).toMatchObject({ resident: false });
  });
});

describe('eviction and fill', () => {
  it('serve an identical page entry', () => {
    const { journal, publish } = openJournal();
    const delta = (sourceKey: string, chunk: string): JournalRowInput => ({
      ...text('m1', sourceKey, chunk, 'turn-1'), occurredAt: 1_725_000_100_000,
      resources: [{ locator: 'file:///a', resourceId: 'r1', status: 'available' }],
    });
    journal.append(publish(), delta('d1', 'Hel'));
    journal.append(publish(), delta('d2', 'lo'));
    journal.complete(publish(), 'm1', 'digest-1');
    journal.append(publish(), text('m2', 'd3', 'second', 'turn-2'));
    const request = { requestId: 'r', agentId: 'a', direction: 'tail' as const, limit: 10 };
    const before = journal.page(request, { olderBeyondJournal: false });
    expect(journal.evict(1)).toEqual(['m1']);
    expect(journal.fill('m1', bodyFromRow({ ...text('m1', 'h1', 'Hello', 'turn-1'), occurredAt: 1_725_000_900_000 }), 'digest-1')).toBe('filled');
    expect(journal.page(request, { olderBeyondJournal: false })).toEqual(before);
    expect(before.kind === 'page' && before.page.payload.entries[0]).toMatchObject({ collapsed: ['assistant_merge'] });
  });
});

describe('backgrounds on fill', () => {
  const callWith = (status: 'pending' | 'visible', id = 'review-1') => call({ background: { id, kind: 'review' as const, status } });
  const evicted = () => {
    const { journal, publish } = openJournal();
    journal.append(publish(), callWith('visible'));
    journal.complete(publish(), 'c1', 'dc');
    journal.append(publish(), text('m2', 'd2', 'second', 'turn-2'));
    journal.evict(1);
    return journal;
  };

  it('never regresses a finished outcome the item kept', () => {
    const journal = evicted();
    journal.fill('c1', bodyFromRow(callWith('pending')), 'dc');
    expect(journal.state().items[0]?.body?.item).toMatchObject({ background: { id: 'review-1', status: 'visible' } });
  });

  it('lets a different background win', () => {
    const journal = evicted();
    journal.fill('c1', bodyFromRow(callWith('pending', 'review-2')), 'dc');
    expect(journal.state().items[0]?.body?.item).toMatchObject({ background: { id: 'review-2', status: 'pending' } });
  });
});

describe('one revision counter', () => {
  const complete = (key: string) => ({ row: text(key, `h-${key}`, key), digest: `digest-${key}` });

  it('never reuses a revision for a key that a replacement dropped and a prepend brought back', () => {
    const { journal, publish } = openJournal();
    journal.prepend(publish(), [complete('m1')]);
    const old = journal.index()[0]!.revision;
    journal.replace(publish(), [], 0);
    journal.prepend(publish(), [complete('m1')]);
    expect(journal.index()[0]!.revision).toBeGreaterThan(old);
    expectNoChange(journal, () => journal.correct(publish(), text('m1', 'h2', 'two'), 'd2', old), JournalStaleRevisionError);
  });

  it('does not restart at 1 when a replacement fills an emptied journal', () => {
    const { journal, publish } = openJournal();
    journal.prepend(publish(), [complete('m1')]);
    journal.replace(publish(), [], 0);
    journal.replace(publish(), [complete('m1')], 0);
    expect(journal.index()[0]!.revision).toBeGreaterThan(1);
  });

  it('continues from the highest revision of a stored state that has no counter', () => {
    const { journal, publish } = openJournal();
    journal.append(publish(), text('m1', 'd1', 'one'));
    journal.complete(publish(), 'm1', 'digest-1');
    const state = journal.state();
    delete (state.meta as { lastRevision?: number }).lastRevision;
    const restored = new SessionJournal(state);
    restored.alias({ publisherId: 'controller-1', generation: 1, sequence: 3 }, 'm1', 'client-1');
    expect(restored.index()[0]!.revision).toBe(journal.index()[0]!.revision + 1);
  });
});
