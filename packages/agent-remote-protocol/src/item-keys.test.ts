import { describe, expect, it } from 'vitest';

import { decodeClientMessage, decodeServerMessage, PROTOCOL_VERSION } from './index.js';

const entry = (extra: Record<string, unknown> = {}) => ({
  providerId: 'copilot', item: { type: 'assistant_message', text: 'Hi', messageId: 'm1' }, timestamp: '2026-11-16T00:00:00.000Z',
  seqStart: 1, seqEnd: 1, sourceSeqRanges: [{ startSeq: 1, endSeq: 1 }], collapsed: [], resources: [], ...extra,
});
const pageOf = (entries: unknown[]) => ({ protocolVersion: PROTOCOL_VERSION, type: 'timeline_page', payload: {
  requestId: 'r', agentId: 'a', direction: 'tail', epoch: 'e', reset: false, staleCursor: false, gap: false,
  window: { minSeq: 1, maxSeq: 1, nextSeq: 2 }, startCursor: null, endCursor: null, hasOlder: false, hasNewer: false, entries, error: null } });
const streamOf = (event: Record<string, unknown>) => ({ protocolVersion: PROTOCOL_VERSION, type: 'agent_stream', payload: {
  agentId: 'a', epoch: 'e', seq: 1, timestamp: '2026-11-16T00:00:00.000Z', event: { type: 'timeline', providerId: 'copilot', resources: [], item: { type: 'assistant_message', text: 'Hi' }, ...event } } });
const status = (decode: typeof decodeServerMessage | typeof decodeClientMessage, message: unknown) => decode(JSON.stringify(message)).status;

describe('item keys', () => {
  it('asks for them in negotiate and echoes them in negotiated, as the literal true and nothing else', () => {
    const negotiate = { protocolVersion: PROTOCOL_VERSION, type: 'negotiate' };
    expect(status(decodeClientMessage, { ...negotiate, itemKeys: true })).toBe('ok');
    expect(status(decodeClientMessage, { ...negotiate, itemKeys: false })).toBe('rejected');
    expect(status(decodeClientMessage, { ...negotiate, observation: 'activity', itemKeys: true })).toBe('ok');
    const negotiated = { protocolVersion: PROTOCOL_VERSION, type: 'negotiated', sessionControl: true };
    expect(status(decodeServerMessage, { ...negotiated, itemKeys: true })).toBe('ok');
    expect(status(decodeServerMessage, { ...negotiated, itemKeys: 'yes' })).toBe('rejected');
  });

  it('puts the key on page entries and on live timeline events, 1 to 4096 characters, and keeps frames without it valid', () => {
    expect(status(decodeServerMessage, pageOf([entry({ itemKey: 'assistant:m1' })]))).toBe('ok');
    expect(status(decodeServerMessage, pageOf([entry()]))).toBe('ok');
    expect(status(decodeServerMessage, pageOf([entry({ itemKey: '' })]))).toBe('rejected');
    expect(status(decodeServerMessage, pageOf([entry({ itemKey: 'k'.repeat(4096) })]))).toBe('ok');
    expect(status(decodeServerMessage, pageOf([entry({ itemKey: 'k'.repeat(4097) })]))).toBe('rejected');
    expect(status(decodeServerMessage, streamOf({ itemKey: 'assistant:m1' }))).toBe('ok');
    expect(status(decodeServerMessage, streamOf({}))).toBe('ok');
    expect(status(decodeServerMessage, streamOf({ itemKey: '' }))).toBe('rejected');
  });

  it('has a failed compaction', () => {
    const compaction = (state: string) => pageOf([entry({ item: { type: 'compaction', status: state } })]);
    expect(status(decodeServerMessage, compaction('failed'))).toBe('ok');
    expect(status(decodeServerMessage, compaction('loading'))).toBe('ok');
    expect(status(decodeServerMessage, compaction('aborted'))).toBe('rejected');
  });
});
