import { describe, expect, it } from 'vitest';
import type { ProjectedTimelineEntry } from '@orchardworks/agent-remote-protocol';

import { createTimelineRenderModel } from './timeline-render-model.js';

function entry(
  seqStart: number,
  item: ProjectedTimelineEntry['item'],
  providerId = 'provider-one',
): ProjectedTimelineEntry {
  return {
    providerId,
    item,
    timestamp: `2026-09-06T00:00:0${seqStart}.000Z`,
    seqStart,
    seqEnd: seqStart,
    sourceSeqRanges: [{ startSeq: seqStart, endSeq: seqStart }],
    collapsed: [],
    resources: [],
  };
}

describe('createTimelineRenderModel', () => {
  it('assigns stable entry keys and only groups adjacent messages from the same sender', () => {
    const model = createTimelineRenderModel([
      entry(4, { type: 'assistant_message', messageId: 'reply-one', text: 'One' }),
      entry(5, { type: 'assistant_message', messageId: 'reply-two', text: 'Two' }),
      entry(6, { type: 'tool_call', callId: 'read-config', name: 'read', status: 'running', error: null, detail: { type: 'read', filePath: '/workspace/config' } }),
      entry(7, { type: 'assistant_message', messageId: 'reply-three', text: 'Three' }),
      entry(8, { type: 'user_message', clientMessageId: 'prompt-one', text: 'Four' }),
      entry(9, { type: 'user_message', clientMessageId: 'prompt-two', text: 'Five' }),
    ]);

    expect(model.map(({ key, messageGroup }) => ({ key, messageGroup }))).toEqual([
      { key: 'provider-one:4:reply-one', messageGroup: 'first' },
      { key: 'provider-one:5:reply-two', messageGroup: 'last' },
      { key: 'provider-one:6:read-config', messageGroup: undefined },
      { key: 'provider-one:7:reply-three', messageGroup: 'single' },
      { key: 'provider-one:8:prompt-one', messageGroup: 'first' },
      { key: 'provider-one:9:prompt-two', messageGroup: 'last' },
    ]);
  });

  it('retains the first sequence key when a projected entry extends its range', () => {
    const initial = entry(11, { type: 'reasoning', text: 'Initial detail' });
    const extended = { ...initial, seqEnd: 14, sourceSeqRanges: [{ startSeq: 11, endSeq: 14 }] };

    expect(createTimelineRenderModel([initial])[0]?.key).toBe('provider-one:11:reasoning');
    expect(createTimelineRenderModel([extended])[0]?.key).toBe('provider-one:11:reasoning');
  });

});
