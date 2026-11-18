import type { ProjectedTimelineEntry } from '@orchardworks/agent-remote-protocol';
import { vectorText, windowVectors, type VectorItem } from '@orchardworks/agent-remote-journal/testing';
import { describe, expect, it } from 'vitest';

import { absorbWindow } from '@orchardworks/agent-client';

/**
 * S3, the client end of the window decision. The replica's side of the window vectors: whatever the journal decided, the replica that receives the window as the tail of
 * an epoch ends with the window's items by key, and a row it held with the same content stays the same object.
 */
const entryOf = (item: VectorItem, seq: number): ProjectedTimelineEntry => ({
  providerId: 'codex', itemKey: item.key, item: { type: 'assistant_message', text: vectorText(item), messageId: item.key },
  timestamp: '2026-09-02T00:00:00.000Z', seqStart: seq, seqEnd: seq, sourceSeqRanges: [{ startSeq: seq, endSeq: seq }], collapsed: [], resources: [],
});

describe('absorbWindow over the window vectors', () => {
  it.each(windowVectors.map(vector => [vector.name, vector] as const))('%s', (_name, vector) => {
    const held = vector.held.map((item, at) => entryOf(item, at + 1));
    const window = vector.window.map((item, at) => entryOf(item, at + 10));
    const absorbed = absorbWindow(held, 'epoch-1', 'epoch-2', window);
    expect(absorbed.map(({ itemKey }) => itemKey)).toEqual(vector.window.map(({ key }) => key));
    absorbed.forEach((entry, at) => {
      const before = held.find(({ itemKey }) => itemKey === entry.itemKey);
      const sameText = before !== undefined && vectorText(vector.held.find(({ key }) => key === entry.itemKey)!) === vectorText(vector.window[at]!);
      if (sameText) expect(entry.item).toBe(before.item);
      else expect(entry.item).toEqual(window[at]!.item);
      expect(entry.seqStart).toBe(window[at]!.seqStart);
    });
  });
});
