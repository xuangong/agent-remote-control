import { describe, expect, it } from 'vitest';

import { bodyFromRow } from './journal-items.js';
import { MemoryJournalStore } from './journal-store.js';
import { expectNoChange, openJournal, PUBLISHER, scribble, text } from './journal.test-fixture.js';
import { SessionJournal } from './session-journal.js';
import { JournalFencedError, JournalInvalidPublicationError, type JournalHead, type JournalPublication, type JournalRowInput } from './types.js';
import { sequentialEpochs } from './testing.js';

describe('appending at scale', () => {
  it('folds 20,000 deltas into one item', () => {
    const { journal, publish } = openJournal();
    for (let at = 0; at < 20_000; at += 1) journal.append(publish(), text('m1', `d${at}`, 'a'));
    const [item] = journal.state().items;
    expect(item?.body?.item).toMatchObject({ type: 'assistant_message', text: 'a'.repeat(20_000) });
    expect(item).toMatchObject({ seqStart: 1, seqEnd: 20_000, sourceSeqRanges: [{ startSeq: 1, endSeq: 20_000 }] });
    expect(item?.body?.collapsed).toEqual(['assistant_merge']);
  });

  it('folds 20,000 rows that alternate between two open items', () => {
    const { journal, publish } = openJournal();
    for (let at = 0; at < 20_000; at += 1) journal.append(publish(), text(at % 2 === 0 ? 'm1' : 'm2', `d${at}`, at % 2 === 0 ? 'a' : 'b'));
    const [first, second] = journal.state().items;
    expect(first?.body?.item).toMatchObject({ text: 'a'.repeat(10_000) });
    expect(second?.body?.item).toMatchObject({ text: 'b'.repeat(10_000) });
    expect(first?.sourceSeqRanges).toHaveLength(10_000);
    expect(first?.sourceSeqRanges.slice(0, 2)).toEqual([{ startSeq: 1, endSeq: 1 }, { startSeq: 3, endSeq: 3 }]);
    expect(second?.sourceSeqRanges.at(-1)).toEqual({ startSeq: 20_000, endSeq: 20_000 });
    expect([first?.seqEnd, second?.seqEnd]).toEqual([19_999, 20_000]);
  });

  it('keeps adjacent sequences in one range and tool calls replaced in place', () => {
    const { journal, publish } = openJournal();
    const call = (sourceKey: string, status: 'running' | 'completed'): JournalRowInput => ({
      itemKey: 'c1', providerId: 'codex', sourceKey, occurredAt: 0,
      item: { type: 'tool_call', callId: 'c1', name: 'shell', status, error: null, detail: { type: 'shell', command: 'ls' } },
    });
    journal.append(publish(), call('s1', 'running'));
    journal.append(publish(), text('m1', 'd1', 'x'));
    journal.append(publish(), call('s2', 'completed'));
    const [first] = journal.state().items;
    expect(first?.sourceSeqRanges).toEqual([{ startSeq: 1, endSeq: 1 }, { startSeq: 3, endSeq: 3 }]);
    expect(first?.body?.item).toMatchObject({ status: 'completed' });
    expect(first?.body?.collapsed).toEqual(['tool_lifecycle']);
  });
});

describe('a row that cannot be copied or merged', () => {
  it('changes nothing when appended to an existing item', () => {
    const { journal, publish } = openJournal();
    journal.append(publish(), text('m1', 'd1', 'Hel'));
    expectNoChange(journal, () => journal.append(publish(), { ...text('m1', 'd2', 'lo'), sourceKey: (() => 0) as never }), Error);
    expectNoChange(journal, () => journal.append(publish(), { ...text('m1', 'd2', 'lo'), resources: {} as never }), Error);
    expect(journal.append(publish(), text('m1', 'd3', 'lo'))?.seq).toBe(2);
    expect(journal.state().items[0]?.body?.item).toMatchObject({ text: 'Hello' });
  });
});

describe('rows and publications that cannot be applied', () => {
  it('rejects a row whose time cannot be stamped before changing anything', () => {
    const { journal, publish } = openJournal();
    journal.append(publish(), text('m1', 'd1', 'Hel'));
    for (const occurredAt of [Number.NaN, 9e15, Number.POSITIVE_INFINITY]) {
      expectNoChange(journal, () => journal.append(publish(), { ...text('m2', 'd2', 'x'), occurredAt }), JournalInvalidPublicationError);
      expectNoChange(journal, () => journal.append(publish(), { ...text('m1', 'd2', 'x'), occurredAt }), JournalInvalidPublicationError);
    }
    let thrown: unknown;
    try { journal.append(publish(), { ...text('m2', 'd2', 'x'), occurredAt: Number.NaN }); } catch (error) { thrown = error; }
    expect(thrown).toMatchObject({ reason: expect.stringContaining('occurredAt') });
  });

  it('rejects a publication sequence that is not a positive safe integer', () => {
    const { journal } = openJournal();
    for (const sequence of [0, -1, 1.5, Number.NaN, Number.MAX_SAFE_INTEGER + 1, Number.POSITIVE_INFINITY]) {
      const publication = { publisherId: PUBLISHER, generation: 1, sequence };
      expectNoChange(journal, () => journal.append(publication, text('m1', 'd1', 'x')), JournalInvalidPublicationError);
      expectNoChange(journal, () => journal.complete(publication, 'm1', 'd'), JournalInvalidPublicationError);
      expectNoChange(journal, () => journal.sync(publication, [], { roomBytes: Number.MAX_SAFE_INTEGER }), JournalInvalidPublicationError);
    }
  });

  it('reports a fenced publisher before an invalid sequence', () => {
    const { journal } = openJournal();
    journal.claim(PUBLISHER);
    expect(() => journal.complete({ publisherId: PUBLISHER, generation: 1, sequence: 0 }, 'm1', 'd')).toThrow(JournalFencedError);
  });
});

/** A journal with an open text item `m1` and a user message `u1`, and the operations that publish to it. */
function base() {
  const { journal, publish } = openJournal();
  journal.append(publish(), text('m1', 'd1', 'Hello'));
  journal.append(publish(), { itemKey: 'u1', providerId: 'codex', sourceKey: 'u1', occurredAt: 0, item: { type: 'user_message', text: 'ask' } });
  return { journal, publish };
}

const operations: Record<string, (journal: SessionJournal, publication: JournalPublication) => unknown> = {
  complete: (journal, publication) => journal.complete(publication, 'm1', 'digest-1'),
  alias: (journal, publication) => journal.alias(publication, 'u1', 'client-1'),
  window: (journal, publication) => journal.sync(publication, [{ row: text('m9', 'h9', 'fresh'), digest: 'digest-9' }], { roomBytes: Number.MAX_SAFE_INTEGER }),
  prepend: (journal, publication) => journal.prepend(publication, [{ row: text('m0', 'h0', 'old'), digest: 'digest-0' }]),
};

describe.each(Object.keys(operations))('%s', name => {
  const run = operations[name] as (journal: SessionJournal, publication: JournalPublication) => unknown;

  it('is refused for a publication of an older connection', () => {
    const { journal, publish } = base();
    const stale = publish();
    journal.claim(PUBLISHER);
    expectNoChange(journal, () => run(journal, stale), JournalFencedError);
  });

  it('ignores a publication it already applied', () => {
    const { journal, publish } = base();
    const publication = publish();
    run(journal, publication);
    journal.takeChanges();
    const applied = journal.state();
    expect(() => run(journal, publication)).not.toThrow();
    expect(journal.state()).toEqual(applied);
    expect(journal.takeChanges()).toBeUndefined();
  });

  it('shares nothing with its caller or with what the journal hands out', () => {
    const { journal, publish } = base();
    const result = run(journal, publish());
    const applied = journal.state();
    scribble(result);
    scribble(journal.state());
    scribble(journal.takeChanges());
    expect(journal.state()).toEqual(applied);
  });
});

describe('inputs of a publication', () => {
  it('stay the caller\'s after a window and a prepend', () => {
    const { journal, publish } = base();
    const prepended = [{ row: { ...text('m0', 'h0', 'old'), resources: [{ locator: 'l', resourceId: 'r', status: 'available' as const }] }, digest: 'digest-0' }];
    journal.prepend(publish(), prepended);
    const replaced = [{ row: { ...text('m9', 'h9', 'fresh'), resources: [{ locator: 'l', resourceId: 'r', status: 'available' as const }] }, digest: 'digest-9' }];
    journal.sync(publish(), replaced, { roomBytes: Number.MAX_SAFE_INTEGER });
    const applied = journal.state();
    scribble(prepended);
    scribble(replaced);
    expect(journal.state()).toEqual(applied);
  });
});

/** A small deterministic generator. */
function seeded(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let mixed = Math.imul(state ^ (state >>> 15), 1 | state);
    mixed = (mixed + Math.imul(mixed ^ (mixed >>> 7), 61 | mixed)) ^ mixed;
    return ((mixed ^ (mixed >>> 14)) >>> 0) / 4_294_967_296;
  };
}

describe('a store that replays the changes', () => {
  it('restores the journal that a few thousand mixed operations produced', async () => {
    const random = seeded(20_261_115);
    const pick = <T,>(values: readonly T[]): T => values[Math.floor(random() * values.length)] as T;
    const journal = SessionJournal.create('host-1:codex:session-1', 'epoch-1', sequentialEpochs());
    let publisherId = PUBLISHER;
    let { generation, watermark: sequence } = journal.claim(publisherId);
    const store = new MemoryJournalStore();
    const snapshotAt = (observedAt: number): JournalHead => ({
      observedAt,
      snapshot: {
        id: 'session-1', providerId: 'codex', createdAt: '2026-11-15T00:00:00.000Z', updatedAt: '2026-11-15T00:00:01.000Z', status: 'idle', activeTurn: null,
        capabilities: { history: true, sendMessage: true, steer: true, cancel: true, readResource: true, interactions: { question: true, planApproval: true, toolApproval: true } },
        pendingInteractions: [], runtimeInfo: { providerId: 'codex', sessionId: 'session-1', status: 'idle' },
      },
    });
    const keys = ['m0', 'm1', 'm2', 'm3', 'm4', 'm5', 'u0', 'u1'];
    const row = (key: string, chunk: string, turn: string): JournalRowInput => key.startsWith('u')
      ? { itemKey: key, providerId: 'codex', sourceKey: `${key}-${chunk}`, occurredAt: 1_725_000_000_000, turnId: turn, item: { type: 'user_message', text: chunk } }
      : { ...text(key, `${key}-${chunk}`, chunk, turn), liveOnly: random() < 0.1 };
    const completeOf = (key: string) => ({ row: row(key, 'reread', pick(['turn-1', 'turn-2', 'turn-3'])), digest: `digest-${key}-${Math.floor(random() * 3)}` });
    const counts = new Map<string, number>();
    let stamp = 0;
    for (let step = 0; step < 4000; step += 1) {
      const publication = (): JournalPublication => ({ publisherId, generation, sequence: random() < 0.05 ? Math.max(1, sequence - 1) : ++sequence });
      const key = pick(keys);
      const turn = pick(['turn-1', 'turn-2', 'turn-3']);
      const operation = pick(['append', 'append', 'append', 'complete', 'alias', 'window', 'prepend', 'evict', 'fill', 'claim', 'stale', 'head']);
      counts.set(operation, (counts.get(operation) ?? 0) + 1);
      try {
        switch (operation) {
          case 'append': journal.append(publication(), row(key, `c${stamp++}`, turn)); break;
          case 'complete': journal.complete(publication(), key, `digest-${key}-${Math.floor(random() * 3)}`); break;
          case 'alias': journal.alias(publication(), key, `client-${Math.floor(random() * 3)}`); break;
          case 'window': journal.sync(publication(), keys.filter(() => random() < 0.5).map(completeOf), { roomBytes: Number.MAX_SAFE_INTEGER }); break;
          case 'prepend': journal.prepend(publication(), keys.filter(() => random() < 0.3).map(completeOf)); break;
          case 'evict': journal.evict(Math.floor(random() * 3)); break;
          case 'fill': {
            const fillKey = pick(keys);
            journal.fill(fillKey, bodyFromRow(row(fillKey, 'filled', turn)), `digest-${fillKey}-${Math.floor(random() * 3)}`);
            break;
          }
          case 'claim': publisherId = random() < 0.8 ? PUBLISHER : 'controller-2'; ({ generation, watermark: sequence } = journal.claim(publisherId)); break;
          case 'head': journal.setHead(publication(), snapshotAt(stamp++)); break;
          default: journal.append({ publisherId, generation: generation - 1, sequence: 1 }, row(key, 'stale', turn));
        }
      } catch (error) {
        if (!(error instanceof Error) || !error.name.startsWith('Journal')) throw error;
      }
      if (random() < 0.3) {
        const changes = journal.takeChanges();
        if (changes) await store.apply(changes);
      }
    }
    const changes = journal.takeChanges();
    if (changes) await store.apply(changes);
    for (const operation of ['append', 'complete', 'alias', 'window', 'prepend', 'evict', 'fill', 'claim', 'stale', 'head']) expect(counts.get(operation)).toBeGreaterThan(20);
    expect(new SessionJournal((await store.load(journal.sessionKey))!, sequentialEpochs()).state()).toEqual(journal.state());
  });
});
