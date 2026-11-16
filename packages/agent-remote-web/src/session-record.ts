import { decodeAgentSnapshot, decodeHistoryPage, PROTOCOL_VERSION, type AgentSnapshotPayload, type ProjectedTimelineEntry } from '@orchardworks/agent-remote-protocol';
import { deviceKey, type DeviceScope, type SessionIdentity, type StoredRecord } from './device-store.js';

export const STORED_SESSION_VERSION = 1;

/** How much of one conversation a device keeps. */
export interface StoredWindowLimits { readonly maxEntries: number; readonly maxBytes: number }
export const DEFAULT_WINDOW_LIMITS: StoredWindowLimits = { maxEntries: 200, maxBytes: 1_048_576 };

/** What a confirmed replica hands over to be kept. */
export interface SessionToStore {
  readonly agentId: string;
  readonly epoch: string;
  /** The next sequence the replica expects; the cursor of what it holds is `nextSeq - 1`. */
  readonly nextSeq: number;
  readonly hasOlder: boolean;
  readonly entries: readonly ProjectedTimelineEntry[];
  readonly snapshot: AgentSnapshotPayload;
}
export interface StoredSession extends SessionToStore { readonly updatedAt: number }

/** The newest entries that fit the limits, oldest first; undefined when entries exist and not even the newest one fits. */
export function windowForStorage(entries: readonly ProjectedTimelineEntry[], limits: StoredWindowLimits): { entries: ProjectedTimelineEntry[]; trimmed: boolean; bytes: number } | undefined {
  const kept: ProjectedTimelineEntry[] = [];
  let bytes = 0;
  for (let index = entries.length - 1; index >= 0; index--) {
    const entry = entries[index]!;
    const size = JSON.stringify(entry).length;
    if (kept.length >= limits.maxEntries || bytes + size > limits.maxBytes) break;
    kept.push(entry);
    bytes += size;
  }
  if (entries.length > 0 && kept.length === 0) return undefined;
  kept.reverse();
  return { entries: kept, trimmed: kept.length < entries.length, bytes };
}

/** The Snapshot as a device may show it before the Relay answers: what was running or pending then is not claimed now. */
export function displaySnapshot(snapshot: AgentSnapshotPayload): AgentSnapshotPayload {
  const { connection: _connection, ...runtimeInfo } = snapshot.runtimeInfo;
  return { ...snapshot, activeTurn: null, pendingInteractions: [], runtimeInfo };
}

export function createStoredRecord(scope: DeviceScope, identity: SessionIdentity, session: SessionToStore, limits: StoredWindowLimits, now: number): StoredRecord | undefined {
  const window = windowForStorage(session.entries, limits);
  if (!window) return undefined;
  const snapshot = displaySnapshot(session.snapshot);
  return {
    key: deviceKey(scope, identity), relayUrl: scope.relayUrl, principalId: scope.principalId, version: STORED_SESSION_VERSION,
    agentId: session.agentId, epoch: session.epoch, nextSeq: session.nextSeq, hasOlder: session.hasOlder || window.trimmed,
    entries: window.entries, snapshot, updatedAt: now, bytes: window.bytes + JSON.stringify(snapshot).length + 256,
  };
}

/** The record's content when it belongs to `scope` and `identity`, has the current version and passes the protocol's own validation; undefined otherwise. */
export function decodeStoredRecord(value: unknown, scope: DeviceScope, identity: SessionIdentity): StoredSession | undefined {
  if (!value || typeof value !== 'object') return undefined;
  const record = value as Partial<StoredRecord>;
  if (record.key !== deviceKey(scope, identity) || record.relayUrl !== scope.relayUrl || record.principalId !== scope.principalId) return undefined;
  if (record.version !== STORED_SESSION_VERSION || typeof record.agentId !== 'string' || !record.agentId || typeof record.epoch !== 'string' || !record.epoch
    || !Number.isSafeInteger(record.nextSeq) || record.nextSeq! < 1 || typeof record.hasOlder !== 'boolean' || !Array.isArray(record.entries)
    || !Number.isSafeInteger(record.updatedAt) || !record.snapshot || typeof record.snapshot !== 'object') return undefined;
  const history = decodeHistoryPage(JSON.stringify({ protocolVersion: PROTOCOL_VERSION, type: 'timeline_page', payload: {
    requestId: 'device-store', agentId: record.agentId, direction: 'tail', epoch: record.epoch, reset: false, staleCursor: false, gap: false,
    window: { minSeq: 1, maxSeq: record.nextSeq! - 1, nextSeq: record.nextSeq }, startCursor: null, endCursor: null,
    hasOlder: record.hasOlder, hasNewer: false, entries: record.entries, error: null,
  } }));
  const snapshot = decodeAgentSnapshot(JSON.stringify({ protocolVersion: PROTOCOL_VERSION, type: 'agent_snapshot', payload: record.snapshot }));
  if (history.status !== 'ok' || snapshot.status !== 'ok' || snapshot.value.payload.id !== record.agentId) return undefined;
  return { agentId: record.agentId, epoch: record.epoch, nextSeq: record.nextSeq!, hasOlder: record.hasOlder, entries: history.value.payload.entries,
    snapshot: snapshot.value.payload, updatedAt: record.updatedAt! };
}
