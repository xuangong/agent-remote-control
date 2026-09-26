import { remoteSessionState, type RemoteSessionState } from '../client/session-state.js';
import { useVisibleClock } from './visible-clock.js';
import type { AgentReplicaState } from '../replica/types.js';

export interface AgentActivityStatusProps {
  state: AgentReplicaState;
  sessionState?: RemoteSessionState;
  visible?: boolean;
  disabled: boolean;
  disabledLabel?: string;
  commandPending?: boolean;
  interruptDisabled: boolean;
  interruptLabel: string;
  onInterrupt(): void;
}

export function AgentActivityStatus({ state, sessionState, visible = true, disabled: blocked, disabledLabel, commandPending = false, interruptDisabled, interruptLabel, onInterrupt }: AgentActivityStatusProps) {
  const agent = state.agent;
  const session = sessionState ?? remoteSessionState(state, blocked ? 'connecting' : 'ready');
  const disabled = blocked || !session.synchronized || session.controlChecking;
  const terminal = session.activity === 'failed' || session.activity === 'closed';
  const working = session.activity === 'running';
  const waiting = session.activity === 'waiting';
  const active = Boolean(agent?.activeTurn) && (working || waiting);
  const runtimeConnection = session.runtime;
  const runtimeUnavailable = runtimeConnection !== undefined && runtimeConnection.state !== 'connected';
  const unavailable = disabled || runtimeUnavailable;
  const label = disabled ? disabledLabel ?? 'Waiting for session'
    : runtimeConnection?.state === 'reconnecting' ? 'Reconnecting'
    : runtimeConnection?.state === 'restoring' ? 'Restoring'
    : runtimeConnection?.state === 'unavailable' ? 'Native runtime unavailable'
    : session.activity === 'failed' ? 'Agent failed'
    : session.activity === 'closed' ? 'Closed'
    : waiting ? 'Waiting for response'
    : working ? 'Working'
    : commandPending ? 'Executing command'
    : session.activity === 'starting' ? 'Starting' : 'Ready';
  const timestamp = agent?.activeTurn?.startedAt;
  const startedAt = typeof timestamp === 'string' ? Date.parse(timestamp) : NaN;
  const timed = active && !unavailable && Number.isFinite(startedAt);
  const now = useVisibleClock(timed && visible);
  const seconds = Math.max(0, Math.floor((now - startedAt) / 1_000));
  return <div className="agent-activity" data-active={runtimeUnavailable || terminal || working || waiting || commandPending || session.activity === 'starting'} aria-label="Agent activity" data-testid="agent-activity">
    <div className="agent-activity-summary">
      <span className={`agent-presence agent-state-${unavailable ? 'offline' : terminal ? session.activity : waiting ? 'waiting' : working ? 'running' : 'idle'}`} aria-hidden="true" />
      <span data-testid="agent-activity-label" aria-live="polite">{label}</span>
      {timed ? <time className="agent-activity-elapsed" data-testid="turn-elapsed" aria-label="Turn elapsed time" aria-live="off" dateTime={`PT${seconds}S`}>{formatElapsed(seconds)}</time>
        : working && !unavailable ? <span className="agent-activity-elapsed">Start time unavailable</span> : null}
    </div>
    <button type="button" data-testid="cancel-submit" disabled={interruptDisabled}
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
