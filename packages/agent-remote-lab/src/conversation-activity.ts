import type { AgentReplica, AgentReplicaState, RemoteActivityState, RemoteSessionClient, RemoteSessionStatus } from '@orchardworks/agent-remote-web';

/**
 * The activity an activity-only subscription reports, read from a shown conversation's replica. The Host
 * derives status from the same snapshot, and the cursor from its attention cursor or else the timeline end.
 */
export function conversationActivity(state: AgentReplicaState, connection: RemoteSessionStatus): RemoteActivityState {
  const agent = state.agent;
  if (connection !== 'ready' || !agent) {
    if (connection === 'unavailable') {
      const refusal = [...state.diagnostics].reverse().find(diagnostic => !diagnostic.recoverable);
      return { connection: 'unavailable', error: refusal?.message ?? 'The session is unavailable.' };
    }
    const latest = state.diagnostics.at(-1);
    if (connection === 'disconnected') return { connection: 'disconnected', ...(latest && ['session_paused', 'session_capacity'].includes(latest.code) ? { error: latest.message } : {}) };
    return { connection: 'connecting' };
  }
  const activity = agent.status === 'closed' || agent.status === 'failed' ? agent.status
    : agent.pendingInteractions.length || agent.status === 'waiting' ? 'waiting'
    : agent.activeTurn || agent.status === 'running' ? 'running' : agent.status;
  const background = agent.attention?.background;
  const timeline = state.timeline;
  const cursor = agent.attention?.cursor ?? (timeline.initialized && timeline.epoch ? { epoch: timeline.epoch, seq: timeline.nextSeq - 1 } : undefined);
  return { connection: 'ready', activity, ...(background ? { background: { id: background.id, kind: background.kind, status: background.status } } : {}), ...(cursor ? { cursor } : {}) };
}

/** Reports a shown conversation's activity as it changes, until stopped. */
export function observeConversation(source: { client: RemoteSessionClient; replica: AgentReplica }, changed: (state: RemoteActivityState) => void): () => void {
  let last: string | undefined;
  const publish = () => {
    const state = conversationActivity(source.replica.getState(), source.client.getSessionState().connection);
    const identity = JSON.stringify(state);
    if (identity === last) return;
    last = identity;
    changed(state);
  };
  const stopStatus = source.client.subscribeStatus(publish);
  const stopReplica = source.replica.subscribe(publish);
  return () => { stopStatus(); stopReplica(); };
}
