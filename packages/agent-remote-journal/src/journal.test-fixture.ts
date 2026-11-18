import { expect } from 'vitest';

import { SessionJournal } from './session-journal.js';
import type { JournalItemInput, JournalPublication, JournalRowInput } from './types.js';
import { sequentialEpochs } from './testing.js';

export const PUBLISHER = 'controller-1';

/** A journal claimed by one publisher, with a function that numbers its publications: each is the one after the journal's watermark, as a publisher that retries a refused entry numbers it. */
export function openJournal() {
  const journal = SessionJournal.create('host-1:codex:session-1', 'epoch-1', sequentialEpochs());
  const { generation } = journal.claim(PUBLISHER);
  const publish = (): JournalPublication => ({ publisherId: PUBLISHER, generation, sequence: (journal.publisher?.watermark ?? 0) + 1 });
  return { journal, publish };
}

export const text = (itemKey: string, sourceKey: string, chunk: string, turnId = 'turn-1'): JournalRowInput => ({
  itemKey, providerId: 'codex', sourceKey, occurredAt: 1_725_000_000_000, turnId,
  item: { type: 'assistant_message', text: chunk, messageId: itemKey },
});

/** Runs `run`, which must throw the expected error, and checks that neither the state nor the pending changes moved. */
export function expectNoChange(journal: SessionJournal, run: () => unknown, error: string | RegExp | (new (...args: never[]) => Error)): void {
  journal.takeChanges();
  const before = journal.state();
  expect(run).toThrow(error);
  expect(journal.state()).toEqual(before);
  expect(journal.takeChanges()).toBeUndefined();
}

/** Overwrites every string and extends every array of a value, to prove that it shares nothing with the journal. */
export function scribble(value: unknown): void {
  if (Array.isArray(value)) {
    for (const entry of value) scribble(entry);
    value.push({ scribbled: true });
  } else if (value !== null && typeof value === 'object') {
    const record = value as Record<string, unknown>;
    for (const key of Object.keys(record)) {
      if (typeof record[key] === 'string') record[key] = 'scribbled';
      else scribble(record[key]);
    }
  }
}

/** What a test reads of each item: its place, state and whether its body is resident. */
export function indexOf(journal: SessionJournal) {
  return journal.state().items.map(item => ({
    itemKey: item.itemKey, seqStart: item.seqStart, seqEnd: item.seqEnd, state: item.state,
    ...(item.digest === undefined ? {} : { digest: item.digest }), liveOnly: item.liveOnly,
    ...(item.clientMessageId === undefined ? {} : { clientMessageId: item.clientMessageId }), resident: item.body !== null,
  }));
}

/** Gives an empty journal the items of a window, as a Controller's first publication does. */
export function seedJournal(journal: SessionJournal, publication: JournalPublication, items: readonly JournalItemInput[]): void {
  journal.sync(publication, items, { roomBytes: Number.MAX_SAFE_INTEGER });
}
