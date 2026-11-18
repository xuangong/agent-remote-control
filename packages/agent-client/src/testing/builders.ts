import type { AgentSnapshotPayload, ProjectedTimelineEntry } from '@orchardworks/agent-remote-protocol';
import type { SessionIdentity, StoredRecord } from '../device-store.js';
import { createStoredRecord, DEFAULT_WINDOW_LIMITS, type SessionToStore } from '../session-record.js';

/** The Relay URL the builders store records under; it names a person, so a record under another URL belongs to someone else. */
export const TEST_RELAY_URL = 'https://relay.example/u/a/';
export const TEST_NOW = Date.parse('2026-11-18T00:00:00.000Z');

export const buildSessionIdentity = (nativeSessionId = 'native-1'): SessionIdentity => ['local', 'codex', nativeSessionId];

export function buildSnapshot(overrides: Partial<AgentSnapshotPayload> & { nativeSessionId?: string } = {}): AgentSnapshotPayload {
  const { nativeSessionId = 'native-1', ...rest } = overrides;
  return {
    id: 'agent-1', providerId: 'codex', createdAt: '2026-11-15T00:00:00.000Z', updatedAt: '2026-11-15T00:00:01.000Z', status: 'idle', activeTurn: null,
    capabilities: { history: true, sendMessage: true, steer: true, cancel: true, readResource: true, interactions: { question: true, planApproval: true, toolApproval: true } },
    pendingInteractions: [], runtimeInfo: { providerId: 'codex', sessionId: nativeSessionId, status: 'idle' }, ...rest,
  };
}

/** One assistant message at journal sequence `seq`; its item key is `m<seq>`. */
export function buildEntry(seq: number, text = `row ${seq}`): ProjectedTimelineEntry {
  return {
    providerId: 'codex', itemKey: `m${seq}`, item: { type: 'assistant_message', text, messageId: `m${seq}` }, timestamp: '2026-11-15T00:00:00.000Z',
    seqStart: seq, seqEnd: seq, sourceSeqRanges: [{ startSeq: seq, endSeq: seq }], collapsed: [], resources: [],
  };
}

export const buildSessionToStore = (rows = 3, overrides: Partial<SessionToStore> & { text?: string; nativeSessionId?: string } = {}): SessionToStore => {
  const { text, nativeSessionId, ...rest } = overrides;
  return { agentId: 'agent-1', epoch: 'e1', nextSeq: rows + 1, hasOlder: false, entries: Array.from({ length: rows }, (_, index) => buildEntry(index + 1, text)),
    snapshot: buildSnapshot({ nativeSessionId }), ...rest };
};

/** A record as the device store keeps it: `rows` messages of one session under a Relay URL, last updated at `updatedAt`. */
export function buildStoredRecord(overrides: { relayUrl?: string; nativeSessionId?: string; rows?: number; updatedAt?: number; text?: string } = {}): StoredRecord {
  const { relayUrl = TEST_RELAY_URL, nativeSessionId = 'native-1', rows = 3, updatedAt = TEST_NOW, text } = overrides;
  return createStoredRecord(relayUrl, buildSessionIdentity(nativeSessionId), buildSessionToStore(rows, { text, nativeSessionId }), DEFAULT_WINDOW_LIMITS, updatedAt)!;
}
