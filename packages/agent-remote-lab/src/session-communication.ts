import { timelineEntryKey, type AgentReplicaState } from '@orchardworks/agent-remote-web';
import type { ProjectedTimelineEntry } from '@orchardworks/agent-remote-protocol';
import type { OpenedSession } from './directory-client.js';
import { sessionKey, type SessionEntry } from './session-tree.js';

export interface CommunicationSnapshot { session: OpenedSession; state?: AgentReplicaState }
export function communicationResolver(source: OpenedSession, snapshots: readonly CommunicationSnapshot[]) {
  const identities = new Map<string, Map<string, SessionEntry>>();
  const add = (name: string, session: SessionEntry) => {
    const candidates = identities.get(name) ?? new Map<string, SessionEntry>();
    const previous = candidates.get(sessionKey(session));
    candidates.set(sessionKey(session), previous?.agentId ? previous : session); identities.set(name, candidates);
  };
  for (const { session, state } of snapshots) {
    if (session.providerId !== source.providerId || (session.hostId ?? 'local') !== (source.hostId ?? 'local')) continue;
    for (const record of state?.timeline.entries ?? []) {
      if (record.item.type === 'agent_communication') {
        // A local receipt is positive evidence; an absent turn alone does not prove a sender.
        if (record.turnId) add(record.item.recipient, session);
      } else if (record.item.type === 'tool_call' && record.item.detail.type === 'other') {
        const detail = record.item.detail;
        for (const ref of [...(detail.sessionReference ? [detail.sessionReference] : []), ...(detail.sessionReferences ?? [])]) {
          add(ref.title, { providerId: session.providerId, hostId: session.hostId, nativeSessionId: ref.nativeSessionId, title: ref.title });
        }
      }
    }
    // These are native child descriptors, never favorite/catalog display titles.
    for (const child of state?.agent?.runtimeInfo.childSessions ?? []) {
      add(child.title, { ...child, providerId: session.providerId, hostId: session.hostId, parentNativeSessionId: session.nativeSessionId, parentAgentId: session.agentId });
    }
  }
  const unique = (name: string) => { const values = identities.get(name); return values?.size === 1 ? [...values.values()][0] : undefined; };
  for (const { session, state } of snapshots) {
    if (session.providerId !== source.providerId || (session.hostId ?? 'local') !== (source.hostId ?? 'local')) continue;
    for (const record of state?.timeline.entries ?? []) {
      if (record.item.type !== 'agent_communication') continue;
      const sender = unique(record.item.sender), recipient = unique(record.item.recipient);
      // Session communication belongs to one of its endpoints. A resolved peer identifies
      // the opposite endpoint without assigning meaning to mutable conversation titles.
      if (recipient && sessionKey(recipient) !== sessionKey(session) && !sender) add(record.item.sender, session);
      if (sender && sessionKey(sender) !== sessionKey(session) && !recipient) add(record.item.recipient, session);
    }
  }
  return (entry: ProjectedTimelineEntry) => entry.item.type === 'agent_communication' ? { sender: unique(entry.item.sender), recipient: unique(entry.item.recipient) } : {};
}
export function communicationParticipants(entry: ProjectedTimelineEntry, source: OpenedSession, snapshots: readonly CommunicationSnapshot[]) {
  return communicationResolver(source, snapshots)(entry);
}
export function communicationDirection(recipient: SessionEntry | undefined, source: SessionEntry, visible: readonly OpenedSession[]): 'left' | 'right' | undefined {
  if (!recipient) return;
  const from = visible.findIndex(session => sessionKey(session) === sessionKey(source));
  const to = visible.findIndex(session => sessionKey(session) === sessionKey(recipient));
  if (from < 0 || to < 0 || Math.abs(from - to) !== 1) return;
  return to < from ? 'left' : 'right';
}
export function findReceivedCommunication(state: AgentReplicaState, entry: ProjectedTimelineEntry): ProjectedTimelineEntry | undefined {
  const message = entry.item;
  if (message.type !== 'agent_communication') return;
  return state.timeline.entries.find(record => record.turnId && record.item.type === 'agent_communication'
    && record.item.messageId === message.messageId && record.item.sender === message.sender && record.item.recipient === message.recipient);
}

/** Load by native message identity, preserving receiver order even when timestamps coincide. */
export async function loadReceivedCommunication(
  connection: { client: import('@orchardworks/agent-remote-web').RemoteSessionClient; replica: import('@orchardworks/agent-remote-web').AgentReplica },
  entry: ProjectedTimelineEntry, signal: AbortSignal,
): Promise<{ key: string }> {
  await waitForCommunicationSession(connection.client, signal);
  const epoch = connection.replica.getState().timeline.epoch;
  for (;;) {
    signal.throwIfAborted();
    const state = connection.replica.getState();
    if (state.timeline.epoch !== epoch) throw new Error('The receiving conversation changed. Open the letter again.');
    const received = findReceivedCommunication(state, entry);
    if (received) return { key: timelineEntryKey(epoch, received) };
    const before = state.timeline.entries[0]?.seqStart;
    if (!state.timeline.hasOlder || before === undefined) throw new Error('The receiving history does not contain this letter. Refresh the session and retry.');
    await connection.client.loadOlder();
    signal.throwIfAborted();
    if (connection.replica.getState().timeline.entries[0]?.seqStart === before) throw new Error('Earlier receiving history could not be loaded. Retry the letter.');
    await new Promise(resolve => setTimeout(resolve, 0));
  }
}
export function waitForCommunicationSession(client: import('@orchardworks/agent-remote-web').RemoteSessionClient, signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    let stop = () => {}; let done = false;
    const finish = (error?: unknown) => { if (done) return; done = true; stop(); signal.removeEventListener('abort', abort); error ? reject(error) : resolve(); };
    const abort = () => finish(signal.reason);
    const check = () => { if (signal.aborted) abort(); else if (client.getSessionState().connection === 'ready') finish(); };
    signal.addEventListener('abort', abort, { once: true });
    stop = client.subscribeSessionState(() => queueMicrotask(check));
    check();
  });
}
