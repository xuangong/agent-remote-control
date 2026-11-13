import './earlier-conversation.css';
import { useEffect, useMemo, useState } from 'react';
import { AgentReplica, type AgentReplicaState, type RemoteAgentTransport } from '@orchardworks/agent-remote-web';
import { AgentTimeline, useAgentReplica } from '@orchardworks/agent-remote-web/react';
import { readWorkspaceSnapshot } from '../workspace-cache.js';
import { sessionKey, type SessionEntry } from '../session-tree.js';

/** What reading an earlier session needs: HTTP pages only. `connect` is never called, so no stream or control is taken. */
export type EarlierTransport = Pick<RemoteAgentTransport, 'fetchSnapshot' | 'fetchTimeline'> & Partial<Pick<RemoteAgentTransport, 'connect'>>;
export type EarlierDirectory = (hostId: string) => { attach(providerId: string, nativeSessionId: string, signal?: AbortSignal): Promise<{ agentId: string }> };
const PAGE = 100;

/** An earlier session shown read-only: no turn in progress, no interactions to answer, nothing to send. */
function readOnly(state: AgentReplicaState): AgentReplicaState {
  return { ...state, agent: state.agent ? { ...state.agent, activeTurn: null, pendingInteractions: [] } : state.agent, pendingInteractions: [], outgoingMessages: [] };
}

function EarlierSession({ session, transport, directory, cached, onComplete }: {
  session: SessionEntry; transport: EarlierTransport; directory: EarlierDirectory; cached?: AgentReplicaState; onComplete(complete: boolean): void;
}) {
  const key = sessionKey(session);
  const replica = useMemo(() => new AgentReplica(), [key]);
  const live = useAgentReplica(replica);
  const [read, setRead] = useState<{ state: 'loading' | 'ready' | 'error'; agentId?: string }>({ state: 'loading' });
  const [attempt, setAttempt] = useState(0);
  useEffect(() => {
    const controller = new AbortController(), signal = controller.signal;
    setRead({ state: 'loading' });
    (async () => {
      const { agentId } = await directory(session.hostId ?? 'local').attach(session.providerId, session.nativeSessionId, signal);
      replica.applySnapshot(await transport.fetchSnapshot(agentId, { signal }));
      replica.applyHistory(await transport.fetchTimeline(agentId, 'tail', undefined, PAGE, { signal }));
      if (!signal.aborted) setRead({ state: 'ready', agentId });
    })().catch(() => { if (!signal.aborted) setRead({ state: 'error' }); });
    return () => controller.abort();
  }, [replica, attempt]);
  const complete = read.state === 'ready' && !live.timeline.hasOlder;
  useEffect(() => { onComplete(complete); }, [complete]);
  const shown = read.state === 'ready' ? live : cached;
  async function loadOlder() {
    const first = live.timeline.entries[0];
    if (!read.agentId || !first || !live.timeline.epoch) return;
    replica.applyHistory(await transport.fetchTimeline(read.agentId, 'before', { epoch: live.timeline.epoch, seq: first.seqStart }, PAGE));
  }
  return <section className="lab-earlier-session" aria-label={`Earlier conversation: ${session.title || session.nativeSessionId}`} data-session={key}>
    {shown ? <AgentTimeline state={readOnly(shown)} showHeader={false} interactionsReadOnly interactionDisabled
      onLoadOlder={read.state === 'ready' ? loadOlder : undefined} /> : null}
    {read.state === 'loading' && !shown ? <p className="lab-earlier-status" role="status">Loading earlier conversation…</p> : null}
    {read.state === 'error' ? <p className="lab-earlier-status">Earlier conversation is unavailable.{' '}
      <button type="button" onClick={() => setAttempt(value => value + 1)}>Retry</button></p> : null}
  </section>;
}

/**
 * A bot's earlier sessions after handoffs, read-only above its current conversation. `sessions` lists them newest first
 * (the predecessor, then older ones); the oldest shown reads first. An older session is revealed only once the one after it
 * has no older pages. A quiet line separates them from the current conversation; Bot mode does not announce the handoff.
 */
export function EarlierConversation({ baseUrl, transport, directory, sessions, readCached }: {
  baseUrl: string; transport: EarlierTransport; directory: EarlierDirectory; sessions: readonly SessionEntry[];
  /** The last display of a session this browser saved; defaults to the workspace cache. */
  readCached?(session: SessionEntry): AgentReplicaState | undefined;
}) {
  const [revealed, setRevealed] = useState(1);
  const [completeKeys, setCompleteKeys] = useState<ReadonlySet<string>>(new Set());
  const shown = sessions.slice(0, revealed);
  const oldest = shown.at(-1);
  const read = readCached ?? ((session: SessionEntry) => readWorkspaceSnapshot(baseUrl, { hostId: session.hostId ?? 'local', providerId: session.providerId, nativeSessionId: session.nativeSessionId }));
  if (!sessions.length) return null;
  return <div className="lab-earlier-conversation">
    {oldest && completeKeys.has(sessionKey(oldest)) && revealed < sessions.length
      ? <button type="button" className="lab-earlier-reveal" onClick={() => setRevealed(value => value + 1)}>Show earlier conversation</button> : null}
    {[...shown].reverse().map(session => <EarlierSession key={sessionKey(session)} session={session} transport={transport} directory={directory} cached={read(session)}
      onComplete={complete => setCompleteKeys(current => {
        const key = sessionKey(session);
        if (current.has(key) === complete) return current;
        const next = new Set(current); if (complete) next.add(key); else next.delete(key); return next;
      })} />)}
    <div className="lab-earlier-divider" role="separator" aria-label="Earlier conversation" />
  </div>;
}
