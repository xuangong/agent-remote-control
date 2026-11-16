import { describe, expect, it } from 'vitest';

import { bodyFromRow, itemEntry, stampRow } from './journal-items.js';
import { JournalInvalidPublicationError, type JournalItem } from './types.js';

describe('journal items', () => {
  it('stamps a row with its epoch, sequence and timestamp without sharing the input', () => {
    const input = { itemKey: 'm1', providerId: 'codex', sourceKey: 's1', occurredAt: 0, item: { type: 'reasoning' as const, text: 'a' } };
    const row = stampRow('epoch-1', 7, input);
    expect(row).toMatchObject({ epoch: 'epoch-1', seq: 7, itemKey: 'm1', timestamp: '1970-01-01T00:00:00.000Z', resources: [] });
    input.item.text = 'changed';
    expect(row.item).toEqual({ type: 'reasoning', text: 'a' });
  });

  it('refuses to project an evicted item', () => {
    const evicted: JournalItem = { itemKey: 'm1', providerId: 'codex', seqStart: 1, seqEnd: 1, sourceSeqRanges: [{ startSeq: 1, endSeq: 1 }], state: 'complete', liveOnly: false, body: null };
    expect(() => itemEntry(evicted)).toThrow(JournalInvalidPublicationError);
  });

  it('builds the body of a complete item read again from history', () => {
    expect(bodyFromRow({ itemKey: 'm1', providerId: 'codex', sourceKey: 'h1', occurredAt: 0, item: { type: 'assistant_message', text: 'Hi', messageId: 'm1' } }))
      .toEqual({ item: { type: 'assistant_message', text: 'Hi', messageId: 'm1' }, timestamp: '1970-01-01T00:00:00.000Z', collapsed: [], resources: [] });
  });
});
