import './earlier-conversation.css';
import { Fragment, useEffect, useMemo, useReducer, useState } from 'react';
import { AgentReplica, type AgentReplicaState, type RemoteAgentTransport } from '@orchardworks/agent-client';
import { AgentTimeline, useAgentReplica, useTranslate } from '@orchardworks/agent-client-web/react';
import { SessionChangeLine } from '@orchardworks/agent-client-web/primitives';
import { loadStoredDisplay, readStoredDisplay } from '../kernel/stored-display.js';
import { knownTitle, sessionKey, type SessionEntry } from '../kernel/session-tree.js';

/** What reading an earlier session needs: HTTP pages only. `connect` is never called, so no stream or control is taken. */
export type EarlierTransport = Pick<RemoteAgentTransport, 'fetchSnapshot' | 'fetchTimeline'> & Partial<Pick<RemoteAgentTransport, 'connect'>>;
export type EarlierDirectory = (hostId: string) => { attach(providerId: string, nativeSessionId: string, signal?: AbortSignal): Promise<{ agentId: string }> };
const PAGE = 100;

/** An earlier session shown read-only: no turn in progress, so no live line, no interactions to answer, nothing to send. */
function readOnly(state: AgentReplicaState): AgentReplicaState {
  const agent = state.agent && { ...state.agent, activeTurn: null, pendingInteractions: [],
    ...(state.agent.status === 'running' || state.agent.status === 'starting' || state.agent.status === 'waiting' ? { status: 'idle' as const } : {}) };
  return { ...state, agent, pendingInteractions: [], outgoingMessages: [] };
}

function EarlierSession({ session, transport, directory, cached, onComplete }: {
  session: SessionEntry; transport: EarlierTransport; directory: EarlierDirectory; cached?: AgentReplicaState; onComplete(complete: boolean): void;
}) {
  const t = useTranslate();
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
  const title = knownTitle(session);
  return <section className="lab-earlier-session" aria-label={title ? t('sessions.earlier.labelTitled', { title }) : t('sessions.earlier.label')} data-session={key}>
    {shown ? <AgentTimeline state={readOnly(shown)} interactionsReadOnly interactionDisabled
      onLoadOlder={read.state === 'ready' ? loadOlder : undefined} /> : null}
    {read.state === 'loading' && !shown ? <p className="lab-earlier-status" role="status">{t('sessions.earlier.loading')}</p> : null}
    {read.state === 'error' ? <p className="lab-earlier-status">{t('sessions.earlier.unavailable')}{' '}
      <button type="button" onClick={() => setAttempt(value => value + 1)}>{t('common.retry')}</button></p> : null}
  </section>;
}

/**
 * A bot's earlier sessions after handoffs, read-only above its current conversation. `sessions` lists them newest first
 * (the predecessor, then older ones); the oldest shown reads first. An older session is revealed only once the one after it
 * has no older pages. A session-change line follows each of them, so each later session, the current one included, starts
 * after "Continued in a new session".
 */
export function EarlierConversation({ baseUrl, transport, directory, sessions, readCached }: {
  baseUrl: string; transport: EarlierTransport; directory: EarlierDirectory; sessions: readonly SessionEntry[];
  /** The last display of a session this browser saved; defaults to the workspace cache. */
  readCached?(session: SessionEntry): AgentReplicaState | undefined;
}) {
  const t = useTranslate();
  const [revealed, setRevealed] = useState(1);
  const [completeKeys, setCompleteKeys] = useState<ReadonlySet<string>>(new Set());
  const shown = sessions.slice(0, revealed);
  const oldest = shown.at(-1);
  const locate = (session: SessionEntry) => ({ hostId: session.hostId ?? 'local', providerId: session.providerId, nativeSessionId: session.nativeSessionId });
  const read = readCached ?? ((session: SessionEntry) => readStoredDisplay(baseUrl, locate(session)));
  // A record the preload left on disk is loaded when its session is shown.
  const [, loaded] = useReducer((count: number) => count + 1, 0);
  const shownKeys = shown.map(sessionKey).join('\n');
  useEffect(() => {
    if (readCached) return;
    let stale = false;
    void Promise.all(shown.map(session => loadStoredDisplay(baseUrl, locate(session)))).then(() => { if (!stale) loaded(); });
    return () => { stale = true; };
  }, [baseUrl, shownKeys, readCached]);
  if (!sessions.length) return null;
  return <div className="lab-earlier-conversation">
    {oldest && completeKeys.has(sessionKey(oldest)) && revealed < sessions.length
      ? <button type="button" className="lab-earlier-reveal" onClick={() => setRevealed(value => value + 1)}>{t('sessions.earlier.show')}</button> : null}
    {[...shown].reverse().map(session => <Fragment key={sessionKey(session)}>
      <EarlierSession session={session} transport={transport} directory={directory} cached={read(session)}
        onComplete={complete => setCompleteKeys(current => {
          const key = sessionKey(session);
          if (current.has(key) === complete) return current;
          const next = new Set(current); if (complete) next.add(key); else next.delete(key); return next;
        })} />
      <SessionChangeLine>{t('conversation.sessionChange')}</SessionChangeLine>
    </Fragment>)}
  </div>;
}
