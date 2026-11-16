import { expect, it } from 'vitest';
import type { AgentSnapshotPayload, ProjectedTimelineEntry } from '@orchardworks/agent-remote-protocol';
import { createStoredRecord, decodeStoredRecord, displaySnapshot, windowForStorage } from './session-record.js';
import { deviceKey, type DeviceScope, type SessionIdentity } from './device-store.js';

const scope: DeviceScope = { relayUrl: 'https://relay/u/a/', principalId: 'alice' };
const identity: SessionIdentity = ['h', 'codex', 'native-1'];
const snapshot = (): AgentSnapshotPayload => ({
  id: 'agent-1', providerId: 'codex', createdAt: '2026-11-15T00:00:00.000Z', updatedAt: '2026-11-15T00:00:01.000Z', status: 'running',
  activeTurn: { turnId: 'turn-1', startedAt: '2026-11-15T00:00:00.500Z' },
  capabilities: { history: true, sendMessage: true, steer: true, cancel: true, readResource: true, interactions: { question: true, planApproval: true, toolApproval: true } },
  pendingInteractions: [],
  runtimeInfo: { providerId: 'codex', sessionId: 'native-1', status: 'running', connection: { state: 'restoring' } },
});
const entry = (seq: number, text = `row ${seq}`): ProjectedTimelineEntry => ({
  providerId: 'codex', item: { type: 'assistant_message', text, messageId: `m${seq}` }, itemKey: `key-${seq}`, timestamp: '2026-11-15T00:00:00.000Z',
  seqStart: seq, seqEnd: seq, sourceSeqRanges: [{ startSeq: seq, endSeq: seq }], collapsed: [], resources: [],
});
const limits = { maxEntries: 3, maxBytes: 100_000 };

it('keeps the newest entries within the entry limit and says it trimmed', () => {
  const window = windowForStorage([1, 2, 3, 4, 5].map(seq => entry(seq)), limits)!;
  expect(window.entries.map(item => item.seqStart)).toEqual([3, 4, 5]);
  expect(window.trimmed).toBe(true);
});

it('keeps the newest entries within the byte limit', () => {
  const size = JSON.stringify(entry(1)).length;
  const window = windowForStorage([1, 2, 3].map(seq => entry(seq)), { maxEntries: 10, maxBytes: size * 2 + 1 })!;
  expect(window.entries.map(item => item.seqStart)).toEqual([2, 3]);
});

it('stores nothing when the newest entry alone is over the byte limit, and an empty conversation as empty', () => {
  expect(windowForStorage([entry(1, 'x'.repeat(500))], { maxEntries: 10, maxBytes: 100 })).toBeUndefined();
  expect(windowForStorage([], limits)).toEqual({ entries: [], trimmed: false, bytes: 0 });
});

it('does not claim what was live: no active turn, interactions or runtime connection', () => {
  const display = displaySnapshot(snapshot());
  expect(display.activeTurn).toBeNull();
  expect(display.pendingInteractions).toEqual([]);
  expect(display.runtimeInfo.connection).toBeUndefined();
});

it('keys a record by Relay, principal and identity and decodes only for that scope', () => {
  const record = createStoredRecord(scope, identity, { agentId: 'agent-1', epoch: 'e1', nextSeq: 6, hasOlder: false, entries: [1, 2, 3, 4, 5].map(seq => entry(seq)), snapshot: snapshot() }, limits, 1234)!;
  expect(record.key).toBe(deviceKey(scope, identity));
  expect(record).toMatchObject({ epoch: 'e1', nextSeq: 6, hasOlder: true, updatedAt: 1234 });
  const decoded = decodeStoredRecord(structuredClone(record), scope, identity)!;
  expect(decoded.entries.map(item => item.itemKey)).toEqual(['key-3', 'key-4', 'key-5']);
  expect(decodeStoredRecord(structuredClone(record), { ...scope, principalId: 'bob' }, identity)).toBeUndefined();
  expect(decodeStoredRecord(structuredClone(record), { ...scope, relayUrl: 'https://other/' }, identity)).toBeUndefined();
  expect(decodeStoredRecord(structuredClone(record), scope, ['h', 'codex', 'native-2'])).toBeUndefined();
});

it('refuses damaged records', () => {
  const record = createStoredRecord(scope, identity, { agentId: 'agent-1', epoch: 'e1', nextSeq: 3, hasOlder: false, entries: [entry(1), entry(2)], snapshot: snapshot() }, limits, 9)!;
  expect(decodeStoredRecord({ ...record, version: 2 }, scope, identity)).toBeUndefined();
  expect(decodeStoredRecord({ ...record, nextSeq: 0 }, scope, identity)).toBeUndefined();
  expect(decodeStoredRecord({ ...record, entries: [{ ...entry(1), item: { type: 'bogus' } }] }, scope, identity)).toBeUndefined();
  expect(decodeStoredRecord({ ...record, snapshot: null }, scope, identity)).toBeUndefined();
  expect(decodeStoredRecord('not a record', scope, identity)).toBeUndefined();
});
