import { conversationLocalStorage } from './conversation-storage.js';
import { decodeAgentSnapshot, decodeHistoryPage, PROTOCOL_VERSION } from '@orchardworks/agent-remote-protocol';
import type { AgentReplicaState } from '@orchardworks/agent-remote-web';
import type { ControllerLocation } from '@orchardworks/agent-remote-hosted/controller-location';

const keyFor = (scope: string) => `agent-remote:recovery:${scope}:workspace`;
const maxCharacters = 750_000;
const maxTotalCharacters = 1_500_000;
const maxSnapshots = 6;
const identity = (target: ControllerLocation) => JSON.stringify([target.hostId ?? 'local', target.providerId, target.nativeSessionId]);
const snapshotKey = (scope: string, identity: string) => `${keyFor(scope)}:${encodeURIComponent(identity)}`;
type CachedSnapshot = { identity: string; characters: number };

const displayStates = new WeakMap<AgentReplicaState, AgentReplicaState>();
/** Display data cannot authorize operations, revive interactions, or seed a recovery cursor. */
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

function readIndex(raw: string | null): CachedSnapshot[] {
  if (!raw || raw.length > maxCharacters) return [];
  try {
    const parsed = JSON.parse(raw);
    if (parsed?.version !== 2 || !Array.isArray(parsed.snapshots)) return [];
    return parsed.snapshots.filter((entry: CachedSnapshot) => entry && typeof entry.identity === 'string'
      && entry.identity.length < 4096 && Number.isInteger(entry.characters) && entry.characters > 0 && entry.characters <= maxCharacters).slice(0, maxSnapshots);
  } catch { return []; }
}

function pruneSnapshots(scope: string): void {
  const prefix = `${keyFor(scope)}:`, retained = new Set<string>();
  let total = 0;
  for (const entry of readIndex(conversationLocalStorage.getItem(keyFor(scope)))) {
    const key = snapshotKey(scope, entry.identity), raw = conversationLocalStorage.getItem(key);
    if (!raw || raw.length > maxCharacters || total + raw.length > maxTotalCharacters || retained.has(key)) continue;
    retained.add(key); total += raw.length;
  }
  const keys: string[] = [];
  for (let index = 0, count = conversationLocalStorage.length; index < count; index++) {
    const key = conversationLocalStorage.key(index);
    if (key?.startsWith(prefix)) keys.push(key);
  }
  // Separate-tab writes and failed index updates may leave unreferenced bodies.
  // This cache is disposable; never retain those bodies at the expense of drafts.
  for (const key of keys) if (!retained.has(key)) conversationLocalStorage.removeItem(key);
}

/** A bounded recent-session display cache per account. It never seeds a transport cursor or outbox. */
export function saveWorkspaceSnapshot(scope: string, target: ControllerLocation, state: AgentReplicaState): void {
  if (!state.agent || !state.timeline.initialized || !target.nativeSessionId || !state.timeline.epoch
    || state.agent.providerId !== target.providerId || state.agent.runtimeInfo.providerId !== target.providerId
    || state.agent.runtimeInfo.sessionId !== target.nativeSessionId) return;
  const agent = { ...state.agent, activeTurn: null, pendingInteractions: [] };
  const entries = state.timeline.entries.slice(-150);
  const history = { protocolVersion: PROTOCOL_VERSION, type: 'timeline_page', payload: {
    requestId: 'display-cache', agentId: agent.id, epoch: state.timeline.epoch, direction: 'tail',
    reset: false, staleCursor: false, gap: false,
    window: { minSeq: 1, maxSeq: Math.max(0, state.timeline.nextSeq - 1), nextSeq: state.timeline.nextSeq },
    startCursor: null, endCursor: null, hasOlder: false, hasNewer: false, error: null, entries,
  } };
  try {
    pruneSnapshots(scope);
    let encoded = JSON.stringify({ identity: identity(target), snapshot: { protocolVersion: PROTOCOL_VERSION, type: 'agent_snapshot', payload: agent }, history });
    while (encoded.length > maxCharacters && entries.length) {
      entries.splice(0, Math.max(1, Math.floor(entries.length / 2)));
      encoded = JSON.stringify({ identity: identity(target), snapshot: { protocolVersion: PROTOCOL_VERSION, type: 'agent_snapshot', payload: agent }, history });
    }
    if (encoded.length > maxCharacters) return;
    const key = identity(target), raw = conversationLocalStorage.getItem(keyFor(scope));
    const previous = readIndex(raw);
    // Preserve the previous single-session display cache during the first bounded-cache write.
    if (!previous.length && raw && raw.length <= maxCharacters) {
      let legacy: { identity?: unknown; snapshot?: unknown; history?: unknown } | undefined;
      try { legacy = JSON.parse(raw); } catch { /* A new snapshot replaces malformed cache metadata. */ }
      if (typeof legacy?.identity === 'string' && legacy.identity.length < 4096 && legacy.snapshot && legacy.history && legacy.identity !== key) {
        conversationLocalStorage.setItem(snapshotKey(scope, legacy.identity), raw);
        previous.push({ identity: legacy.identity, characters: raw.length });
      }
    }
    const snapshots = [{ identity: key, characters: encoded.length }, ...previous.filter(item => item.identity !== key)];
    let total = snapshots.reduce((sum, item) => sum + item.characters, 0);
    while (snapshots.length > maxSnapshots || total > maxTotalCharacters) {
      const removed = snapshots.pop()!;
      total -= removed.characters;
      conversationLocalStorage.removeItem(snapshotKey(scope, removed.identity));
    }
    conversationLocalStorage.setItem(snapshotKey(scope, key), encoded);
    conversationLocalStorage.setItem(keyFor(scope), JSON.stringify({ version: 2, snapshots }));
  } catch { /* Quota failure must not affect the live workspace or durable drafts. */ }
  finally { try { pruneSnapshots(scope); } catch { /* Storage may be unavailable. */ } }
}
export function readWorkspaceSnapshot(scope: string, target?: ControllerLocation): AgentReplicaState | undefined {
  if (!target?.nativeSessionId) return;
  try {
    let raw = conversationLocalStorage.getItem(keyFor(scope));
    if (!raw || raw.length > maxCharacters) return;
    const indexed = readIndex(raw).find(item => item.identity === identity(target));
    if (indexed) raw = conversationLocalStorage.getItem(snapshotKey(scope, indexed.identity));
    if (!raw || raw.length > maxCharacters) return;
    const saved = JSON.parse(raw);
    if (saved.identity !== identity(target)) return;
    const snapshot = decodeAgentSnapshot(JSON.stringify(saved.snapshot));
    const history = decodeHistoryPage(JSON.stringify(saved.history));
    if (snapshot.status !== 'ok' || history.status !== 'ok') return;
    const agent = snapshot.value.payload;
    if (agent.runtimeInfo.sessionId !== target.nativeSessionId || agent.providerId !== target.providerId
      || agent.runtimeInfo.providerId !== target.providerId || history.value.payload.agentId !== agent.id) return;
    return { agent: { ...agent, activeTurn: null, pendingInteractions: [] },
      timeline: { epoch: history.value.payload.epoch, initialized: true, entries: history.value.payload.entries, nextSeq: 0, hasOlder: false, pendingLive: [] },
      pendingInteractions: [], interactionRevision: 0, interactionChanges: {}, resources: {}, diagnostics: [], retiredEpochs: [], outgoingMessages: [],
    };
  } catch { return; }
}
