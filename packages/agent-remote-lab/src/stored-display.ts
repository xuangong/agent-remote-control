import { createStoredRecord, decodeStoredRecord, DEFAULT_WINDOW_LIMITS, type AgentReplica, type AgentReplicaState, type StoredSession } from '@orchardworks/agent-remote-web';
import { deviceStore, type DeviceScope, type SessionIdentity, type StoredRecord } from '@orchardworks/agent-remote-web/device-store';
import type { ControllerLocation } from '@orchardworks/agent-remote-hosted/controller-location';
import { cachedRowsScope, storedRowsScope } from './workspace-access.js';

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

function recordOf(scope: DeviceScope, target: ControllerLocation): { session: StoredSession; record: StoredRecord } | undefined {
  const identity = sessionIdentity(target);
  const record = identity && deviceStore.read(scope, identity);
  if (!record) return undefined;
  if (!decoded.has(record)) decoded.set(record, decodeStoredRecord(record, scope, identity!));
  const session = decoded.get(record);
  const agent = session?.snapshot;
  // The record must be this exact native session: the key says so, and so does what is inside.
  return session && agent && agent.providerId === target.providerId && agent.runtimeInfo.providerId === target.providerId && agent.runtimeInfo.sessionId === target.nativeSessionId ? { session, record } : undefined;
}

/** The stored rows of a conversation as a display, from memory, and only while the Relay has confirmed this person's lease. */
export function readStoredDisplay(baseUrl: string, target?: ControllerLocation): AgentReplicaState | undefined {
  const scope = storedRowsScope(baseUrl);
  const found = scope && target && recordOf(scope, target);
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
  const scope = storedRowsScope(baseUrl), identity = sessionIdentity(target);
  if (scope && identity) await deviceStore.load(scope, identity);
}

/**
 * Seeds an unread replica with the rows this device last read, at the journal position they ended. The connection's first page confirms them or
 * replaces them by key. A person whose lease is not confirmed gets nothing.
 */
export function restoreReplicaFromDevice(baseUrl: string, target: ControllerLocation, replica: AgentReplica): void {
  const apply = () => {
    const scope = storedRowsScope(baseUrl), found = scope && recordOf(scope, target);
    if (found) replica.restoreFromDevice(found.session);
  };
  const scope = storedRowsScope(baseUrl), identity = sessionIdentity(target);
  if (!scope || !identity) return;
  if (deviceStore.read(scope, identity)) apply(); else void deviceStore.load(scope, identity).then(apply);
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
  const scope = storedRowsScope(baseUrl), identity = sessionIdentity(target);
  if (!scope || !identity || !isStoredSource(target, state)) return;
  const record = createStoredRecord(scope, identity, { agentId: state.agent.id, epoch: state.timeline.epoch!, nextSeq: state.timeline.nextSeq,
    hasOlder: state.timeline.hasOlder, entries: state.timeline.entries, snapshot: state.agent }, DEFAULT_WINDOW_LIMITS, Date.now());
  if (record) deviceStore.put(record);
}

/** Forgets what this device kept of a conversation, for a person who lost access to it. */
export function forgetStoredSession(baseUrl: string, target: ControllerLocation): void {
  const scope = storedRowsScope(baseUrl), identity = sessionIdentity(target);
  if (scope && identity) deviceStore.forget(scope, identity);
}

/** Pins a mounted conversation's record: it is never evicted from disk while it is mounted. */
export function pinStoredSession(baseUrl: string, target: ControllerLocation): () => void {
  const scope = storedRowsScope(baseUrl), identity = sessionIdentity(target);
  return scope && identity ? deviceStore.pin(scope, identity) : () => {};
}

/**
 * Whether this device holds rows for the conversation that stay hidden only until the Relay confirms the lease. While that is so the page shows a quiet shell,
 * with no opening word and no placeholder, instead of words that the rows are about to replace.
 */
export function storedRowsPending(baseUrl: string, target?: ControllerLocation): boolean {
  const identity = target && sessionIdentity(target);
  return !!identity && !storedRowsScope(baseUrl) && !!deviceStore.read(cachedRowsScope(baseUrl), identity);
}
