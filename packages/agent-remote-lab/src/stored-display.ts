import { createStoredRecord, decodeStoredRecord, DEFAULT_WINDOW_LIMITS, type AgentReplica, type AgentReplicaState, type StoredSession } from '@orchardworks/agent-remote-web';
import { deviceStore, type SessionIdentity, type StoredRecord } from '@orchardworks/agent-remote-web/device-store';
import type { ControllerLocation } from '@orchardworks/agent-remote-protocol/model';
import { storedRowsRelay } from './workspace-access.js';

/** What the device store calls a conversation: where it runs, with which Provider, and its native id. */
export function sessionIdentity(target: Pick<ControllerLocation, 'hostId' | 'providerId' | 'nativeSessionId'>): SessionIdentity | undefined {
  return target.providerId && target.nativeSessionId ? [target.hostId ?? 'local', target.providerId, target.nativeSessionId] : undefined;
}

const displayStates = new WeakMap<AgentReplicaState, AgentReplicaState>();
/** A live state as a display: nothing that was live (turn, interactions, cursor, delivery) is carried, so it cannot authorize an operation or seed a recovery. */
export function workspaceDisplayState(state: AgentReplicaState): AgentReplicaState {
  const previous = displayStates.get(state);
  if (previous) return previous;
  const display: AgentReplicaState = { agent: state.agent && { ...state.agent, activeTurn: null, pendingInteractions: [] },
    timeline: { ...state.timeline, nextSeq: 0, hasOlder: false, pendingLive: [] },
    pendingInteractions: [], interactionRevision: 0, interactionChanges: {}, resources: state.resources, diagnostics: [], retiredEpochs: [], outgoingMessages: [],
  };
  displayStates.set(state, display);
  return display;
}

const decoded = new WeakMap<StoredRecord, StoredSession | undefined>();
const displays = new WeakMap<StoredSession, AgentReplicaState>();

function recordOf(relayUrl: string, target: ControllerLocation): { session: StoredSession; record: StoredRecord } | undefined {
  const identity = sessionIdentity(target);
  const record = identity && deviceStore.read(relayUrl, identity);
  if (!record) return undefined;
  if (!decoded.has(record)) decoded.set(record, decodeStoredRecord(record, relayUrl, identity!));
  const session = decoded.get(record);
  const agent = session?.snapshot;
  // The record must be this exact native session: the key says so, and so does what is inside.
  return session && agent && agent.providerId === target.providerId && agent.runtimeInfo.providerId === target.providerId && agent.runtimeInfo.sessionId === target.nativeSessionId ? { session, record } : undefined;
}

/** The stored rows of a conversation as a display, from memory, and only while the Relay has confirmed this person's lease. */
export function readStoredDisplay(baseUrl: string, target?: ControllerLocation): AgentReplicaState | undefined {
  const relay = storedRowsRelay(baseUrl);
  const found = relay && target && recordOf(relay, target);
  if (!found) return undefined;
  let display = displays.get(found.session);
  if (!display) {
    display = { agent: found.session.snapshot,
      timeline: { epoch: found.session.epoch, initialized: true, entries: found.session.entries, nextSeq: 0, hasOlder: false, pendingLive: [], restoredFromDevice: true },
      pendingInteractions: [], interactionRevision: 0, interactionChanges: {}, resources: {}, diagnostics: [], retiredEpochs: [], outgoingMessages: [] };
    displays.set(found.session, display);
  }
  return display;
}

/** Brings a conversation's record into memory when the preload did not, so `readStoredDisplay` can answer. */
export async function loadStoredDisplay(baseUrl: string, target: ControllerLocation): Promise<void> {
  const relay = storedRowsRelay(baseUrl), identity = sessionIdentity(target);
  if (relay && identity) await deviceStore.load(relay, identity);
}

/**
 * Seeds an unread replica with the rows this device last read, at the journal position they ended. The connection's first page confirms them or
 * replaces them by key. A person whose lease is not confirmed gets nothing.
 */
export function restoreReplicaFromDevice(baseUrl: string, target: ControllerLocation, replica: AgentReplica): void {
  const apply = () => {
    const relay = storedRowsRelay(baseUrl), found = relay && recordOf(relay, target);
    if (found) replica.restoreFromDevice(found.session);
  };
  const relay = storedRowsRelay(baseUrl), identity = sessionIdentity(target);
  if (!relay || !identity) return;
  if (deviceStore.read(relay, identity)) apply(); else void deviceStore.load(relay, identity).then(apply);
}

/** A state that may become a record: read from the Relay by this connection, for exactly this session, and not itself waiting on a replacement. */
export function isStoredSource(target: ControllerLocation, state: AgentReplicaState): state is AgentReplicaState & { agent: NonNullable<AgentReplicaState['agent']> } {
  return !!state.agent && state.timeline.initialized && !!target.nativeSessionId && !!state.timeline.epoch
    && !state.timeline.restoredFromDevice && state.timeline.pendingEpoch === undefined
    && Number.isSafeInteger(state.timeline.nextSeq) && state.timeline.nextSeq > 0
    && state.agent.providerId === target.providerId && state.agent.runtimeInfo.providerId === target.providerId
    && state.agent.runtimeInfo.sessionId === target.nativeSessionId;
}

export function saveStoredDisplay(baseUrl: string, target: ControllerLocation, state: AgentReplicaState): void {
  const relay = storedRowsRelay(baseUrl), identity = sessionIdentity(target);
  if (!relay || !identity || !isStoredSource(target, state)) return;
  const record = createStoredRecord(relay, identity, { agentId: state.agent.id, epoch: state.timeline.epoch!, nextSeq: state.timeline.nextSeq,
    hasOlder: state.timeline.hasOlder, entries: state.timeline.entries, snapshot: state.agent }, DEFAULT_WINDOW_LIMITS, Date.now());
  if (record) deviceStore.put(record);
}

/** Forgets what this device kept of a conversation, for a person who lost access to it. */
export function forgetStoredSession(baseUrl: string, target: ControllerLocation): void {
  const relay = storedRowsRelay(baseUrl), identity = sessionIdentity(target);
  if (relay && identity) deviceStore.forget(relay, identity);
}

/** Pins a mounted conversation's record: it is never evicted from disk while it is mounted. */
export function pinStoredSession(baseUrl: string, target: ControllerLocation): () => void {
  const relay = storedRowsRelay(baseUrl), identity = sessionIdentity(target);
  return relay && identity ? deviceStore.pin(relay, identity) : () => {};
}
