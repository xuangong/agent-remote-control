import { useEffect, useState } from 'react';
import type { AgentReplicaState } from '../replica/types.js';

export interface AgentActivityStatusProps {
  state: AgentReplicaState;
  disabled: boolean;
  commandPending?: boolean;
  interruptDisabled: boolean;
  interruptLabel: string;
  onInterrupt(): void;
}

export function AgentActivityStatus({ state, disabled, commandPending = false, interruptDisabled, interruptLabel, onInterrupt }: AgentActivityStatusProps) {
  const agent = state.agent;
  const terminal = agent?.status === 'failed' || agent?.status === 'closed';
  const active = Boolean(agent?.activeTurn) && !terminal;
  const working = !terminal && (active || agent?.status === 'running');
  const waiting = !terminal && (state.pendingInteractions.length > 0 || agent?.status === 'waiting');
  const label = disabled ? 'Connection unavailable'
    : agent?.status === 'failed' ? 'Agent failed'
    : agent?.status === 'closed' ? 'Closed'
    : waiting ? 'Waiting for response'
    : working ? 'Working'
    : commandPending ? 'Executing command'
    : agent?.status === 'starting' ? 'Starting' : 'Ready';
  const timestamp = agent?.activeTurn?.startedAt;
  const startedAt = typeof timestamp === 'string' ? Date.parse(timestamp) : NaN;
  const timed = active && !disabled && Number.isFinite(startedAt);
  const [now, setNow] = useState(Date.now);
  useEffect(() => {
    setNow(Date.now());
    if (!timed) return;
    const interval = setInterval(() => setNow(Date.now()), 1_000);
    return () => clearInterval(interval);
  }, [agent?.id, agent?.activeTurn?.turnId, startedAt, timed]);
  const seconds = Math.max(0, Math.floor((now - startedAt) / 1_000));
  return <div className="agent-activity" data-active={disabled || terminal || working || waiting || commandPending || agent?.status === 'starting'} aria-label="Agent activity" data-testid="agent-activity">
    <div className="agent-activity-summary">
      <span className={`agent-presence agent-state-${disabled ? 'offline' : terminal ? agent?.status : waiting ? 'waiting' : working ? 'running' : 'idle'}`} aria-hidden="true" />
      <span data-testid="agent-activity-label" aria-live="polite">{label}</span>
      {timed ? <time className="agent-activity-elapsed" data-testid="turn-elapsed" aria-label="Turn elapsed time" aria-live="off" dateTime={`PT${seconds}S`}>{formatElapsed(seconds)}</time>
        : working && !disabled ? <span className="agent-activity-elapsed">Start time unavailable</span> : null}
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
