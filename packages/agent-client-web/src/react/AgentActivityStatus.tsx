import { useVisibleClock } from './visible-clock.js';
import { sessionActivityLabel, sessionNotice, type AgentReplicaState, type RemoteSessionState, type SessionFacts } from '@orchardworks/agent-client';

export interface AgentActivityStatusProps {
  state?: AgentReplicaState;
  sessionState: RemoteSessionState;
  host?: SessionFacts['host'];
  visible?: boolean;
  commandPending?: boolean;
  interruptDisabled: boolean;
  interruptLabel: string;
  onInterrupt(): void;
}

/** The session's activity line: its business label only (target T5). A notice dims the presence dot; the words of the notice are said elsewhere, once. */
export function AgentActivityStatus({ state, sessionState: session, host, visible = true, commandPending = false, interruptDisabled, interruptLabel, onInterrupt }: AgentActivityStatusProps) {
  const agent = state?.agent;
  const facts: SessionFacts = { session, host, replica: state };
  const label = sessionActivityLabel(facts, commandPending);
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
  return <div className="agent-activity" data-connection-pending={notice || undefined} data-active={notice || terminal || working || waiting || commandPending || session.activity === 'starting'} aria-label="Agent activity" data-testid="agent-activity">
    <div className="agent-activity-summary">
      <span className={`agent-presence agent-state-${notice ? 'offline' : terminal ? session.activity : waiting ? 'waiting' : working ? 'running' : 'idle'}`} aria-hidden="true" />
      <span className="agent-activity-label" data-testid="agent-activity-label" aria-live="polite" hidden={label === undefined}>{label}</span>
      {timed ? <time className="agent-activity-elapsed" data-testid="turn-elapsed" aria-label="Turn elapsed time" aria-live="off" dateTime={`PT${seconds}S`}>{formatElapsed(seconds)}</time>
        : working ? <span className="agent-activity-elapsed">Start time unavailable</span> : null}
    </div>
    <button type="button" data-testid="cancel-submit" disabled={interruptDisabled} hidden={!working && !waiting && !commandPending}
      title={agent?.capabilities.cancel ? 'Interrupt the current native operation' : 'Interrupt is unavailable for this Provider.'}
      onClick={onInterrupt}>{interruptLabel}</button>
  </div>;
}

function formatElapsed(seconds: number): string {
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  const remainder = String(seconds % 60).padStart(2, '0');
  if (minutes < 60) return `${minutes}m ${remainder}s`;
  return `${Math.floor(minutes / 60)}h ${String(minutes % 60).padStart(2, '0')}m ${remainder}s`;
}
