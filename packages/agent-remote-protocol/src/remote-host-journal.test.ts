import { describe, expect, it } from 'vitest';

import { JOURNAL_FILL_MAX_ITEMS, JOURNAL_MESSAGE_MAX_BYTES, JOURNAL_PUBLISH_MAX_ENTRIES } from './remote-host-journal.js';
import { decodeRemoteHostUplinkMessage, encodeRemoteHostUplinkMessage } from './remote-host-uplink.js';

const SESSION = 'codex:thread-1';
const DIGEST = 'a'.repeat(64);
const row = { itemKey: 'item-1', providerId: 'codex', sourceKey: 'delta-1', occurredAt: 1_725_000_000_000, turnId: 'turn-1',
  item: { type: 'assistant_message', text: 'Hello', messageId: 'item-1' } };
const snapshot = {
  id: 'session-1', providerId: 'codex', createdAt: '2026-11-15T00:00:00.000Z', updatedAt: '2026-11-15T00:00:01.000Z', status: 'idle', activeTurn: null,
  capabilities: { history: true, sendMessage: true, steer: true, cancel: true, readResource: true, interactions: { question: true, planApproval: true, toolApproval: true } },
  pendingInteractions: [], runtimeInfo: { providerId: 'codex', sessionId: 'session-1', status: 'idle' },
};
const message = (fields: Record<string, unknown>) => ({ uplinkVersion: 2, ...fields });
const publish = (entries: unknown[]) => message({ type: 'journal_publish', sessionKey: SESSION, generation: 1, entries });
const seal = (sequence: number) => ({ sequence, op: 'seal', itemKey: 'item-1' });
const indexEntry = { itemKey: 'item-1', seqStart: -2, seqEnd: -1, state: 'complete', digest: DIGEST, liveOnly: false, revision: 3, resident: true };

const valid: Array<Record<string, unknown>> = [
  message({ type: 'journal_open', requestId: 'open-1', sessionKey: SESSION, publisherId: 'controller-1' }),
  publish([
    { sequence: 1, op: 'append', row },
    { sequence: 2, op: 'complete', itemKey: 'item-1', digest: DIGEST },
    { sequence: 3, op: 'seal', itemKey: 'item-1' },
    { sequence: 4, op: 'alias', itemKey: 'item-1', clientMessageId: 'operation-1' },
    { sequence: 5, op: 'correct', row, digest: DIGEST, expectedRevision: 3 },
    { sequence: 6, op: 'replace', items: [{ row, digest: DIGEST }] },
    { sequence: 7, op: 'prepend', items: [{ row, digest: DIGEST }] },
    { sequence: 8, op: 'head', head: { snapshot, observedAt: 1_725_000_000_000 } },
  ]),
  message({ type: 'journal_fill', requestId: 'fill-1', sessionKey: SESSION, items: [{ row, digest: DIGEST }] }),
  message({ type: 'journal_older_done', requestId: 'older-1', sessionKey: SESSION, olderAvailable: true }),
  message({ type: 'journal_opened', requestId: 'open-1', sessionKey: SESSION, generation: 1, watermark: 0, epoch: 'epoch-1', index: [indexEntry] }),
  message({ type: 'journal_ack', sessionKey: SESSION, generation: 1, watermark: 8, cursor: { epoch: 'epoch-1', seq: 4 } }),
  message({ type: 'journal_refused', sessionKey: SESSION, generation: 1, sequence: 3, reason: 'stale_revision', itemKey: 'item-1' }),
  message({ type: 'journal_fill_request', requestId: 'fill-1', sessionKey: SESSION, itemKeys: ['item-1', 'item-2'] }),
  message({ type: 'journal_older_request', requestId: 'older-1', sessionKey: SESSION, limit: 50 }),
];

describe('journal uplink envelopes', () => {
  it.each(valid.map(value => [value.type as string, value] as const))('round trips %s', (_type, value) => {
    const decoded = decodeRemoteHostUplinkMessage(JSON.stringify(value));
    expect(decoded).toEqual({ status: 'ok', value });
    if (decoded.status === 'ok') expect(encodeRemoteHostUplinkMessage(decoded.value)).toEqual({ status: 'ok', json: JSON.stringify(value) });
  });

  it('lets the Relay acknowledge journals when it registers a Host', () => {
    const registered = { uplinkVersion: 2, type: 'registered', journal: 1, hostId: 'host', heartbeat: { intervalMs: 20_000, timeoutMs: 10_000 } };
    expect(decodeRemoteHostUplinkMessage(JSON.stringify(registered)).status).toBe('ok');
    expect(decodeRemoteHostUplinkMessage(JSON.stringify({ ...registered, journal: 2 })).status).toBe('rejected');
  });

  it.each<[string, Record<string, unknown>]>([
    ['a publication without entries', publish([])],
    ['an entry with an unknown operation', publish([{ sequence: 1, op: 'erase', itemKey: 'item-1' }])],
    ['an entry that repeats a sequence', publish([seal(2), seal(2)])],
    ['an entry whose sequence goes backwards', publish([seal(3), seal(2)])],
    ['an entry with sequence zero', publish([seal(0)])],
    ['a completion without a digest', publish([{ sequence: 1, op: 'complete', itemKey: 'item-1' }])],
    ['a row with an extra field', publish([{ sequence: 1, op: 'append', row: { ...row, title: 'Secret' } }])],
    ['a row with an unknown item type', publish([{ sequence: 1, op: 'append', row: { ...row, item: { type: 'banner', text: 'x' } } }])],
    ['a correction with revision zero', publish([{ sequence: 1, op: 'correct', row, digest: DIGEST, expectedRevision: 0 }])],
    ['a publication with too many entries', publish(Array.from({ length: JOURNAL_PUBLISH_MAX_ENTRIES + 1 }, (_, at) => seal(at + 1)))],
    ['a publication above the byte bound', publish([{ sequence: 1, op: 'append', row: { ...row, item: { type: 'assistant_message', text: 'x'.repeat(JOURNAL_MESSAGE_MAX_BYTES) } } }])],
    ['a fill that repeats an item', message({ type: 'journal_fill', requestId: 'f', sessionKey: SESSION, items: [{ row, digest: DIGEST }, { row, digest: DIGEST }] })],
    ['a fill with too many items', message({ type: 'journal_fill', requestId: 'f', sessionKey: SESSION,
      items: Array.from({ length: JOURNAL_FILL_MAX_ITEMS + 1 }, (_, at) => ({ row: { ...row, itemKey: `item-${at}` }, digest: DIGEST })) })],
    ['a fill request with no items', message({ type: 'journal_fill_request', requestId: 'f', sessionKey: SESSION, itemKeys: [] })],
    ['a fill request that repeats an item', message({ type: 'journal_fill_request', requestId: 'f', sessionKey: SESSION, itemKeys: ['a', 'a'] })],
    ['an older request with limit zero', message({ type: 'journal_older_request', requestId: 'o', sessionKey: SESSION, limit: 0 })],
    ['an older request above the limit', message({ type: 'journal_older_request', requestId: 'o', sessionKey: SESSION, limit: 201 })],
    ['an index entry whose range is reversed', message({ type: 'journal_opened', requestId: 'o', sessionKey: SESSION, generation: 1, watermark: 0, epoch: 'e', index: [{ ...indexEntry, seqStart: 3, seqEnd: 2 }] })],
    ['an acknowledgement without an epoch', message({ type: 'journal_ack', sessionKey: SESSION, generation: 1, watermark: 1, cursor: { seq: 1 } })],
    ['a refusal with an unknown reason', message({ type: 'journal_refused', sessionKey: SESSION, generation: 1, sequence: 1, reason: 'nope' })],
    ['an open without a publisher', message({ type: 'journal_open', requestId: 'o', sessionKey: SESSION })],
  ])('rejects %s', (_name, value) => {
    expect(decodeRemoteHostUplinkMessage(JSON.stringify(value)).status).toBe('rejected');
    expect(encodeRemoteHostUplinkMessage(value as never).status).toBe('rejected');
  });
});
