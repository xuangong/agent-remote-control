import type { ProjectedTimelineEntry } from '@orchardworks/agent-remote-protocol';
import { describe, expect, it } from 'vitest';

import { absorbWindow } from './window-absorption.js';

const entry = (key: string, extra: Partial<ProjectedTimelineEntry> = {}): ProjectedTimelineEntry => ({
  providerId: 'codex', itemKey: key, item: { type: 'assistant_message', text: key, messageId: key }, timestamp: '2026-09-02T00:00:00.000Z',
  seqStart: 1, seqEnd: 1, sourceSeqRanges: [{ startSeq: 1, endSeq: 1 }], collapsed: [], resources: [], ...extra,
});

describe('what makes a held row equal to the window row', () => {
  it('ignores the background outcome and the client message id, which the journal adds later', () => {
    const held = entry('a');
    const [kept] = absorbWindow([held], [entry('a', { item: { type: 'assistant_message', text: 'a', messageId: 'a', background: { id: 'b1', kind: 'review', status: 'visible' } } })]);
    expect(kept).toBe(held);
  });

  it('compares the ids of the resources, so a row whose resources changed is the window row', () => {
    const resource = (resourceId: string) => ({ locator: 'a.png', resourceId, status: 'available' as const });
    const held = entry('a', { resources: [resource('r1')] });
    const incoming = entry('a', { resources: [resource('r2')] });
    const [taken] = absorbWindow([held], [incoming]);
    expect(taken).not.toBe(held);
    expect(taken?.resources).toEqual(incoming.resources);
  });
});

describe('absorbWindow', () => {
  it('counts a key repeated in the window once, at its first place', () => {
    const repeated = entry('a', { seqStart: 3, seqEnd: 3 });
    expect(absorbWindow([], [entry('a'), entry('b'), repeated]).map(({ itemKey }) => itemKey)).toEqual(['a', 'b']);
  });

  it('leaves its arguments as they were', () => {
    const held = [entry('a')];
    const offered = [entry('a', { seqStart: 5, seqEnd: 5 }), entry('b', { seqStart: 6, seqEnd: 6 })];
    const before = JSON.stringify([held, offered]);
    absorbWindow(held, offered);
    expect(JSON.stringify([held, offered])).toBe(before);
  });
});
