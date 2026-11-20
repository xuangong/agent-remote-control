import { useVisibleClock } from './visible-clock.js';
import { elapsedWords, sessionActivityLabel, sessionNotice, type AgentReplicaState, type RemoteSessionState, type SessionFacts } from '@orchardworks/agent-client';
import { useTranslate } from './locale.js';

export interface AgentActivityStatusProps {
  state?: AgentReplicaState;
  sessionState: RemoteSessionState;
  host?: SessionFacts['host'];
  visible?: boolean;
  commandPending?: boolean;
}

/**
 * The session's activity: its business label only (target T5) and the time the turn has run. The composer keeps it for assistive
 * technology, out of sight, since the timeline's status line says it on screen (I4); Interrupt is the composer's stop button.
 * A notice dims the presence dot; the words of the notice are said elsewhere, once.
 */
export function AgentActivityStatus({ state, sessionState: session, host, visible = true, commandPending = false }: AgentActivityStatusProps) {
  const t = useTranslate();
  const agent = state?.agent;
  const facts: SessionFacts = { session, host, replica: state };
  const label = sessionActivityLabel(facts, commandPending, t);
  const notice = sessionNotice(facts) !== undefined;
  const terminal = session.activity === 'failed' || session.activity === 'closed';
  const working = session.activity === 'running';
  const waiting = session.activity === 'waiting';
  const active = Boolean(agent?.activeTurn) && (working || waiting);
  const timestamp = agent?.activeTurn?.startedAt;
  const startedAt = typeof timestamp === 'string' ? Date.parse(timestamp) : NaN;
  const timed = active && Number.isFinite(startedAt);
  const now = useVisibleClock(timed && visible);
  const seconds = Math.max(0, Math.floor((now - startedAt) / 1_000));
  return <div className="agent-activity" data-notice={notice || undefined} data-active={notice || terminal || working || waiting || commandPending || session.activity === 'starting'} aria-label={t('composer.activity')} data-testid="agent-activity">
    <div className="agent-activity-summary">
      <span className={`agent-presence agent-state-${notice ? 'notice' : terminal ? session.activity : waiting ? 'waiting' : working ? 'running' : 'idle'}`} aria-hidden="true" />
      <span className="agent-activity-label" data-testid="agent-activity-label" aria-live="polite" hidden={label === undefined}>{label}</span>
      {timed ? <time className="agent-activity-elapsed" data-testid="turn-elapsed" aria-label={t('composer.elapsed')} aria-live="off" dateTime={`PT${seconds}S`}>{elapsedWords(seconds, t)}</time>
        : working ? <span className="agent-activity-elapsed">{t('composer.startUnknown')}</span> : null}
    </div>
  </div>;
}
