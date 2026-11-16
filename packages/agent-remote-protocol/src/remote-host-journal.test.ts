import { describe, expect, it } from 'vitest';

import { JOURNAL_FILL_MAX_ITEMS, JOURNAL_INDEX_PAGE_MAX_ITEMS, JOURNAL_MESSAGE_MAX_BYTES, JOURNAL_PUBLISH_MAX_ENTRIES } from './remote-host-journal.js';
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
const binding = { locator: 'docs/plan.md', resourceId: 'resource-1', status: 'pending' };
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
    { sequence: 8, op: 'head', head: { snapshot, observedAt: 1_725_000_000_000, attentionItemKey: 'item-1' } },
    { sequence: 9, op: 'correct', row, expectedRevision: 3 },
    { sequence: 10, op: 'rebind', itemKey: 'item-1', previous: binding, replacement: { ...binding, resourceId: 'resource-2', status: 'available' } },
    { sequence: 11, op: 'outcome', providerId: 'codex', turnId: 'turn-1', background: { id: 'review-1', kind: 'review', status: 'visible' }, occurredAt: 1_725_000_000_000 },
    { sequence: 12, op: 'replace', items: [{ row }] },
    { sequence: 13, op: 'prepend', items: [{ row, digest: DIGEST }, { row: { ...row, itemKey: 'item-2' } }] },
  ]),
  publish([
    { sequence: 1, op: 'outcome', providerId: 'codex', background: { id: 'review-1', kind: 'review', status: 'visible' }, occurredAt: 1 },
    { sequence: 2, op: 'head', head: { snapshot, observedAt: 1, attentionItemKey: 'k'.repeat(4096) } },
  ]),
  message({ type: 'journal_unserve', sessionKey: SESSION, generation: 2 }),
  message({ type: 'journal_request_refused', requestId: 'fill-1', sessionKey: SESSION, reason: 'not_followed' }),
  message({ type: 'journal_request_refused', requestId: 'older-1', sessionKey: SESSION, reason: 'not_ready' }),
  message({ type: 'journal_open', requestId: 'open-2', sessionKey: SESSION, publisherId: 'controller-1', reset: true }),
  message({ type: 'journal_fill', requestId: 'fill-1', sessionKey: SESSION, items: [{ row, digest: DIGEST }] }),
  message({ type: 'journal_older_done', requestId: 'older-1', sessionKey: SESSION, olderAvailable: true }),
  message({ type: 'journal_opened', requestId: 'open-1', sessionKey: SESSION, generation: 1, watermark: 0, epoch: 'epoch-1', index: [indexEntry] }),
  message({ type: 'journal_opened', requestId: 'open-1', sessionKey: SESSION, generation: 1, watermark: 0, epoch: 'epoch-1', index: [indexEntry], indexAfter: -2 }),
  message({ type: 'journal_index_request', requestId: 'index-1', sessionKey: SESSION, generation: 1, epoch: 'epoch-1', after: -2 }),
  message({ type: 'journal_open_refused', requestId: 'index-1', sessionKey: SESSION, reason: 'stale_epoch' }),
  message({ type: 'journal_index_page', requestId: 'index-1', sessionKey: SESSION, index: [indexEntry], indexAfter: -2 }),
  message({ type: 'journal_index_page', requestId: 'index-2', sessionKey: SESSION, index: [] }),
  message({ type: 'journal_index_page', requestId: 'index-3', sessionKey: SESSION, index: [indexEntry, { ...indexEntry, itemKey: 'item-2', seqStart: 4, seqEnd: 4 }], indexAfter: 4 }),
  message({ type: 'journal_refused', sessionKey: SESSION, generation: 1, sequence: 4, reason: 'quota_exceeded', itemKey: 'item-1' }),
  message({ type: 'journal_refused', sessionKey: SESSION, generation: 2, sequence: 3, reason: 'incomplete' }),
  message({ type: 'journal_refused', sessionKey: SESSION, generation: 2, sequence: 9, reason: 'sequence_gap' }),
  message({ type: 'journal_open_refused', requestId: 'open-1', sessionKey: SESSION, reason: 'index_too_large' }),
  message({ type: 'journal_open_refused', requestId: 'open-2', sessionKey: SESSION, reason: 'invalid' }),
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
    expect(decodeRemoteHostUplinkMessage(JSON.stringify({ ...registered, journal: 3 })).status).toBe('rejected');
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
    ['a correction without a revision', publish([{ sequence: 1, op: 'correct', row }])],
    ['a rebind without its replacement', publish([{ sequence: 1, op: 'rebind', itemKey: 'item-1', previous: binding }])],
    ['an outcome without a provider', publish([{ sequence: 1, op: 'outcome', background: { id: 'review-1', kind: 'review', status: 'visible' }, occurredAt: 1 }])],
    ['an outcome at a time that is no date', publish([{ sequence: 1, op: 'outcome', providerId: 'codex', background: { id: 'review-1', kind: 'review', status: 'visible' }, occurredAt: 8_640_000_000_000_001 }])],
    ['a runtime event entry, which no longer exists', publish([{ sequence: 1, op: 'event', event: { type: 'turn_started', providerId: 'codex' }, occurredAt: 1 }])],
    ['a head whose attention item key is empty', publish([{ sequence: 1, op: 'head', head: { snapshot, observedAt: 1, attentionItemKey: '' } }])],
    ['a replacement item with an empty digest', publish([{ sequence: 1, op: 'replace', items: [{ row, digest: '' }] }])],
    ['a fill item without a digest', message({ type: 'journal_fill', requestId: 'f', sessionKey: SESSION, items: [{ row }] })],
    ['an outcome without its time', publish([{ sequence: 1, op: 'outcome', providerId: 'codex', background: { id: 'review-1', kind: 'review', status: 'visible' } }])],
    ['a rebind without what it replaces', publish([{ sequence: 1, op: 'rebind', itemKey: 'item-1', replacement: binding }])],
    ['a head whose attention item key is too long', publish([{ sequence: 1, op: 'head', head: { snapshot, observedAt: 1, attentionItemKey: 'k'.repeat(4097) } }])],
    ['an unserve with an extra field', message({ type: 'journal_unserve', sessionKey: SESSION, generation: 2, reason: 'quota' })],
    ['a request refusal with an extra field', message({ type: 'journal_request_refused', requestId: 'f', sessionKey: SESSION, reason: 'not_ready', detail: 'x' })],
    ['an unserve for generation zero', message({ type: 'journal_unserve', sessionKey: SESSION, generation: 0 })],
    ['a request refusal without a reason', message({ type: 'journal_request_refused', requestId: 'f', sessionKey: SESSION })],
    ['a request refusal with an unknown reason', message({ type: 'journal_request_refused', requestId: 'f', sessionKey: SESSION, reason: 'tired' })],
    ['an open that resets with a false flag', message({ type: 'journal_open', requestId: 'o', sessionKey: SESSION, publisherId: 'controller-1', reset: false })],
    ['an open whose reset is not a flag', message({ type: 'journal_open', requestId: 'o', sessionKey: SESSION, publisherId: 'controller-1', reset: 'yes' })],
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
    ['a first page with a cursor that is not a position', message({ type: 'journal_opened', requestId: 'o', sessionKey: SESSION, generation: 1, watermark: 0, epoch: 'e', index: [], indexAfter: 1.5 })],
    ['an index request without a position', message({ type: 'journal_index_request', requestId: 'i', sessionKey: SESSION, generation: 1, epoch: 'e' })],
    ['an index request without an epoch', message({ type: 'journal_index_request', requestId: 'i', sessionKey: SESSION, generation: 1, after: 1 })],
    ['an index request for generation zero', message({ type: 'journal_index_request', requestId: 'i', sessionKey: SESSION, generation: 0, epoch: 'e', after: 1 })],
    ['an index request without a request id', message({ type: 'journal_index_request', sessionKey: SESSION, generation: 1, epoch: 'e', after: 1 })],
    ['an index page above the page bound', message({ type: 'journal_index_page', requestId: 'i', sessionKey: SESSION,
      index: Array.from({ length: JOURNAL_INDEX_PAGE_MAX_ITEMS + 1 }, (_, at) => ({ ...indexEntry, itemKey: `i${at}`, seqStart: at, seqEnd: at })) })],
    ['an index page whose range is reversed', message({ type: 'journal_index_page', requestId: 'i', sessionKey: SESSION, index: [{ ...indexEntry, seqStart: 3, seqEnd: 2 }] })],
    ['an index page without a request id', message({ type: 'journal_index_page', sessionKey: SESSION, index: [indexEntry] })],
    ['an index page whose entries repeat a position', message({ type: 'journal_index_page', requestId: 'i', sessionKey: SESSION, index: [indexEntry, { ...indexEntry, itemKey: 'item-2' }] })],
    ['an index page whose positions go backwards', message({ type: 'journal_index_page', requestId: 'i', sessionKey: SESSION, index: [{ ...indexEntry, seqStart: 5, seqEnd: 5 }, indexEntry] })],
    ['a first page whose positions go backwards', message({ type: 'journal_opened', requestId: 'o', sessionKey: SESSION, generation: 1, watermark: 0, epoch: 'e', index: [{ ...indexEntry, seqStart: 5, seqEnd: 5 }, indexEntry] })],
    ['an index page whose cursor is not its last position', message({ type: 'journal_index_page', requestId: 'i', sessionKey: SESSION, index: [indexEntry], indexAfter: -1 })],
    ['an index page with a cursor and no entries', message({ type: 'journal_index_page', requestId: 'i', sessionKey: SESSION, index: [], indexAfter: -2 })],
    ['a first page with a cursor and no entries', message({ type: 'journal_opened', requestId: 'o', sessionKey: SESSION, generation: 1, watermark: 0, epoch: 'e', index: [], indexAfter: 0 })],
    ['a first page whose cursor is not its last position', message({ type: 'journal_opened', requestId: 'o', sessionKey: SESSION, generation: 1, watermark: 0, epoch: 'e', index: [indexEntry], indexAfter: 7 })],
    ['a first page above the page bound', message({ type: 'journal_opened', requestId: 'o', sessionKey: SESSION, generation: 1, watermark: 0, epoch: 'e',
      index: Array.from({ length: JOURNAL_INDEX_PAGE_MAX_ITEMS + 1 }, (_, at) => ({ ...indexEntry, itemKey: `i${at}`, seqStart: at, seqEnd: at })) })],
    ['an acknowledgement without an epoch', message({ type: 'journal_ack', sessionKey: SESSION, generation: 1, watermark: 1, cursor: { seq: 1 } })],
    ['a refusal with an unknown reason', message({ type: 'journal_refused', sessionKey: SESSION, generation: 1, sequence: 1, reason: 'nope' })],
    ['an open refusal with an unknown reason', message({ type: 'journal_open_refused', requestId: 'o', sessionKey: SESSION, reason: 'nope' })],
    ['an open refusal without a request id', message({ type: 'journal_open_refused', sessionKey: SESSION, reason: 'invalid' })],
    ['an open refusal with a generation', message({ type: 'journal_open_refused', requestId: 'o', sessionKey: SESSION, reason: 'invalid', generation: 1 })],
    ['an open without a publisher', message({ type: 'journal_open', requestId: 'o', sessionKey: SESSION })],
  ])('rejects %s', (_name, value) => {
    expect(decodeRemoteHostUplinkMessage(JSON.stringify(value)).status).toBe('rejected');
    expect(encodeRemoteHostUplinkMessage(value as never).status).toBe('rejected');
  });
});
