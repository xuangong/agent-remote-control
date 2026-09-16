import { useRef, useState } from 'react';
import type { AgentChildSession } from '@borgee/agent-remote-protocol';

export interface AgentChildSessionListProps {
  readonly children: readonly AgentChildSession[];
  readonly label?: string;
  readonly collapsible?: boolean;
  readonly onOpenChildSession?: (child: AgentChildSession) => void | Promise<void>;
}

const statusLabels: Record<AgentChildSession['status'], string> = {
  starting: 'Starting', idle: 'Ready', running: 'Working', waiting: 'Waiting for response', failed: 'Failed', closed: 'Closed',
};

export function AgentChildSessionList({ children, label = 'Subagents', collapsible = false, onOpenChildSession }: AgentChildSessionListProps) {
  const inFlight = useRef(false);
  const [opening, setOpening] = useState<string>();
  const [failure, setFailure] = useState<string>();
  async function open(child: AgentChildSession): Promise<void> {
    if (!onOpenChildSession || inFlight.current) return;
    inFlight.current = true;
    setOpening(child.nativeSessionId);
    setFailure(undefined);
    try { await onOpenChildSession(child); }
    catch (error) { setFailure(error instanceof Error ? error.message : 'This subagent could not be opened.'); }
    finally { inFlight.current = false; setOpening(undefined); }
  }
  if (children.length === 0) return null;
  const Container = collapsible ? 'details' : 'section';
  const Heading = collapsible ? 'summary' : 'p';
  return <Container className="agent-child-sessions" aria-label={label}>
    <Heading className="agent-child-heading">{label} <span>{children.length}</span></Heading>
    <ul>
      {children.map((child) => <li key={child.nativeSessionId}>
        <button type="button" className="agent-child-session" data-child-session-id={child.nativeSessionId}
          disabled={!onOpenChildSession || opening !== undefined} aria-busy={opening === child.nativeSessionId}
          onClick={() => { void open(child); }}>
          <span className="agent-child-icon" aria-hidden="true">↳</span>
          <span className="agent-child-content">
            <span className="agent-child-title">{child.title}{child.role ? <small>{child.role}</small> : null}</span>
            {child.description ? <span className="agent-child-description">{child.description}</span> : null}
          </span>
          <span className={`agent-child-status agent-child-status-${child.status}`}>
            {opening === child.nativeSessionId ? 'Opening…' : statusLabels[child.status]}
            {child.observation === 'saved_history' ? <small>Saved history</small> : null}
          </span>
          <span className="agent-child-arrow" aria-hidden="true">→</span>
        </button>
      </li>)}
    </ul>
    {failure ? <p className="agent-history-error" role="alert">{failure}</p> : null}
  </Container>;
}
