import type { ProjectedTimelineEntry } from '@orchardworks/agent-remote-protocol';
import { vectorText, windowVectors, type VectorItem } from '@orchardworks/agent-remote-journal/testing';
import { describe, expect, it } from 'vitest';

import { absorbWindow } from './absorb-window.js';

/**
 * The replica's side of the window vectors: whatever the journal decided, the replica that receives the window as the tail of
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

  it('counts a key repeated in the window once, at its first place', () => {
    const [a, b] = [entryOf({ key: 'a' }, 1), entryOf({ key: 'b' }, 2)];
    expect(absorbWindow([], null, 'epoch-2', [a, b, { ...a, seqStart: 3, seqEnd: 3 }]).map(({ itemKey }) => itemKey)).toEqual(['a', 'b']);
  });

  it('leaves the arguments as they were', () => {
    const held = [entryOf({ key: 'a' }, 1)];
    const window = [entryOf({ key: 'a' }, 5), entryOf({ key: 'b' }, 6)];
    const before = JSON.stringify([held, window]);
    absorbWindow(held, 'epoch-1', 'epoch-2', window);
    expect(JSON.stringify([held, window])).toBe(before);
  });
});
