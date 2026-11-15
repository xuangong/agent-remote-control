import { SessionJournal } from './session-journal.js';
import type { JournalPublication, JournalRowInput } from './types.js';

export const PUBLISHER = 'controller-1';

/** A journal claimed by one publisher, with a function that numbers its publications. */
export function openJournal() {
  const journal = SessionJournal.create('host-1:codex:session-1', 'epoch-1');
  const { generation } = journal.claim(PUBLISHER);
  let sequence = 0;
  const publish = (): JournalPublication => ({ publisherId: PUBLISHER, generation, sequence: ++sequence });
  return { journal, publish };
}

export const text = (itemKey: string, sourceKey: string, chunk: string, turnId = 'turn-1'): JournalRowInput => ({
  itemKey, providerId: 'codex', sourceKey, occurredAt: 1_725_000_000_000, turnId,
  item: { type: 'assistant_message', text: chunk, messageId: itemKey },
});
