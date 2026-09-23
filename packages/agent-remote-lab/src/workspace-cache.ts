import { decodeAgentSnapshot, decodeHistoryPage, PROTOCOL_VERSION } from '@orchardworks/agent-remote-protocol';
import type { AgentReplicaState } from '@orchardworks/agent-remote-web';
import type { ControllerLocation } from '@orchardworks/agent-remote-hosted/controller-location';

const keyFor = (scope: string) => `agent-remote:recovery:${scope}:workspace`;
const maxCharacters = 750_000;
const identity = (target: ControllerLocation) => JSON.stringify([target.hostId ?? 'local', target.providerId, target.nativeSessionId]);

/** One bounded display snapshot per account. It never seeds a transport cursor or outbox. */
export function saveWorkspaceSnapshot(scope: string, target: ControllerLocation, state: AgentReplicaState): void {
  if (!state.agent || !state.timeline.initialized || !target.nativeSessionId || !state.timeline.epoch) return;
  const agent = { ...state.agent, activeTurn: null, pendingInteractions: [] };
  const entries = state.timeline.entries.slice(-150);
  const history = { protocolVersion: PROTOCOL_VERSION, type: 'timeline_page', payload: {
    requestId: 'display-cache', agentId: agent.id, epoch: state.timeline.epoch, direction: 'tail',
    reset: false, staleCursor: false, gap: false,
    window: { minSeq: 1, maxSeq: Math.max(0, state.timeline.nextSeq - 1), nextSeq: state.timeline.nextSeq },
    startCursor: null, endCursor: null, hasOlder: false, hasNewer: false, error: null, entries,
  } };
  try {
    let encoded = JSON.stringify({ identity: identity(target), snapshot: { protocolVersion: PROTOCOL_VERSION, type: 'agent_snapshot', payload: agent }, history });
    while (encoded.length > maxCharacters && entries.length) {
      entries.splice(0, Math.max(1, Math.floor(entries.length / 2)));
      encoded = JSON.stringify({ identity: identity(target), snapshot: { protocolVersion: PROTOCOL_VERSION, type: 'agent_snapshot', payload: agent }, history });
    }
    if (encoded.length <= maxCharacters) localStorage.setItem(keyFor(scope), encoded);
  } catch { /* Quota failure must not affect the live workspace or durable drafts. */ }
}
export function readWorkspaceSnapshot(scope: string, target?: ControllerLocation): AgentReplicaState | undefined {
  if (!target?.nativeSessionId) return;
  try {
    const raw = localStorage.getItem(keyFor(scope));
    if (!raw || raw.length > maxCharacters) return;
    const saved = JSON.parse(raw);
    if (saved.identity !== identity(target)) return;
    const snapshot = decodeAgentSnapshot(JSON.stringify(saved.snapshot));
    const history = decodeHistoryPage(JSON.stringify(saved.history));
    if (snapshot.status !== 'ok' || history.status !== 'ok') return;
    const agent = snapshot.value.payload;
    if (agent.runtimeInfo.sessionId !== target.nativeSessionId || agent.providerId !== target.providerId || history.value.payload.agentId !== agent.id) return;
    return { agent: { ...agent, activeTurn: null, pendingInteractions: [] },
      timeline: { epoch: history.value.payload.epoch, initialized: true, entries: history.value.payload.entries, nextSeq: 0, hasOlder: false, pendingLive: [] },
      pendingInteractions: [], interactionRevision: 0, interactionChanges: {}, resources: {}, diagnostics: [], retiredEpochs: [], outgoingMessages: [],
    };
  } catch { return; }
}
