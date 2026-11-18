import type { ProjectedTimelineEntry } from '@orchardworks/agent-remote-protocol';
import { describe, expect, it } from 'vitest';

import { timelineEntryKey } from './timeline-entry-key.js';
import { absorbWindow } from './window-absorption.js';

const row = (seq: number, text: string, extra: Partial<ProjectedTimelineEntry> = {}): ProjectedTimelineEntry => ({
  providerId: 'claude', item: { type: 'assistant_message', messageId: `m${seq}`, text }, timestamp: '2026-11-18T00:00:00.000Z',
  seqStart: seq, seqEnd: seq, sourceSeqRanges: [{ startSeq: seq, endSeq: seq }], collapsed: [], resources: [], ...extra,
});

describe('a row read without item keys (smart reading off)', () => {
  it('is identified by provider, position and native identity, not by the epoch it was read in', () => {
    expect(timelineEntryKey(row(7, 'hello'))).toBe('claude:7:m7');
  });

  it('keeps its key and its object when a replacement epoch brings the same rows, so a reader keeps their line', () => {
    const held = [row(1, 'a'), row(2, 'b'), row(3, 'c')];
    const window = [row(1, 'a'), row(2, 'b'), row(3, 'c'), row(4, 'd')];
    const absorbed = absorbWindow(held, window);
    expect(absorbed.map(timelineEntryKey)).toEqual(['claude:1:m1', 'claude:2:m2', 'claude:3:m3', 'claude:4:m4']);
    expect(absorbed.slice(0, 3)).toEqual(held);
    absorbed.slice(0, 3).forEach((kept, index) => expect(kept).toBe(held[index]));
  });

  it('takes the new content when the same position and identity now hold other text', () => {
    const held = [row(1, 'before')];
    const [taken] = absorbWindow(held, [row(1, 'after')]);
    expect(taken?.item).toMatchObject({ text: 'after' });
  });
});
