import { useRef, useState, type ReactNode } from 'react';
import type { AgentChildSession } from '@orchardworks/agent-remote-protocol';

export type AgentChildSessionView = Pick<AgentChildSession, 'nativeSessionId' | 'title'> & Partial<AgentChildSession>;

export interface AgentChildSessionListProps {
  readonly children: readonly AgentChildSessionView[];
  readonly childrenFor?: (nativeSessionId: string) => readonly AgentChildSessionView[];
  readonly label?: string;
  readonly collapsible?: boolean;
  readonly onOpenChildSession?: (child: AgentChildSessionView) => void | Promise<void>;
}

const statusLabels: Record<AgentChildSession['status'], string> = {
  starting: 'Starting', idle: 'Ready', running: 'Working', waiting: 'Waiting for response', failed: 'Failed', closed: 'Closed',
};

export function AgentChildSessionList({ children, childrenFor, label = 'Subagents', collapsible = false, onOpenChildSession }: AgentChildSessionListProps) {
  const [expanded, setExpanded] = useState<ReadonlySet<string>>(() => new Set());
  const inFlight = useRef(false);
  const [opening, setOpening] = useState<string>();
  const [failure, setFailure] = useState<string>();
  async function open(child: AgentChildSessionView): Promise<void> {
    if (!onOpenChildSession || inFlight.current) return;
    inFlight.current = true;
    setOpening(child.nativeSessionId);
    setFailure(undefined);
    try { await onOpenChildSession(child); }
    catch (error) { setFailure(error instanceof Error ? error.message : 'This subagent could not be opened.'); }
    finally { inFlight.current = false; setOpening(undefined); }
  }
  if (children.length === 0) return null;
  const nodes = childTree(children, childrenFor);
  const working = nodes.reduce((sum, node) => sum + node.working, 0);
  const count = nodes.reduce((sum, node) => sum + node.total, 0);
  function renderNode(node: ChildNode): ReactNode {
    const child = node.child;
    const isExpanded = expanded.has(child.nativeSessionId);
    return <li key={child.nativeSessionId} data-child-branch={child.nativeSessionId}>
      <div className="agent-child-branch-row">
        {node.children.length > 0 ? <button type="button" className="agent-child-toggle"
          aria-label={`${isExpanded ? 'Collapse' : 'Expand'} subagents of ${child.title}`} aria-expanded={isExpanded}
          onClick={() => setExpanded(current => {
            const next = new Set(current);
            if (next.has(child.nativeSessionId)) next.delete(child.nativeSessionId); else next.add(child.nativeSessionId);
            return next;
          })}>{isExpanded ? '▾' : '▸'}</button> : null}
        <button type="button" className="agent-child-session" data-child-session-id={child.nativeSessionId} data-working={child.status === 'running' || undefined}
          disabled={!onOpenChildSession || opening !== undefined} aria-busy={opening === child.nativeSessionId}
          onClick={() => { void open(child); }}>
          <span className="agent-child-icon" aria-hidden="true">↳</span>
          <span className="agent-child-content">
            <span className="agent-child-title"><span className="agent-session-title" data-session-status={child.status}>{child.title}</span>{child.role ? <small>{child.role}</small> : null}</span>
            {node.children.length > 0 ? <small className="agent-child-descendants" data-working={node.working > (child.status === 'running' ? 1 : 0) || undefined}>{node.total - 1} subagents{node.working ? ` · ${node.working} working in branch` : ''}</small> : null}
            {child.description ? <span className="agent-child-description">{child.description}</span> : null}
          </span>
          <span className={`agent-child-status agent-child-status-${child.status ?? 'unknown'}`}>
            {opening === child.nativeSessionId ? 'Opening…' : child.status ? statusLabels[child.status] : child.observation === 'saved_history' ? 'Saved history' : 'Status unavailable'}
            {child.observation === 'saved_history' && child.status ? <small>Saved history</small> : null}
          </span>
          <span className="agent-child-arrow" aria-hidden="true">→</span>
        </button>
      </div>
      {isExpanded && node.children.length > 0 ? <ul className="agent-child-nested">{node.children.map(renderNode)}</ul> : null}
    </li>;
  }
  const Container = collapsible ? 'details' : 'section';
  const Heading = collapsible ? 'summary' : 'p';
  return <Container className="agent-child-sessions" aria-label={label}>
    <Heading className="agent-child-heading" data-working={working > 0 || undefined}>{label} <span>{count}</span>{' '}{working > 0 ? <span className="agent-child-working-count">{working} working</span> : null}</Heading>
    <ul>{nodes.map(renderNode)}</ul>
    {failure ? <p className="agent-history-error" role="alert">{failure}</p> : null}
  </Container>;
}

interface ChildNode { child: AgentChildSessionView; children: ChildNode[]; total: number; working: number }
function childTree(children: readonly AgentChildSessionView[], childrenFor: AgentChildSessionListProps['childrenFor'], ancestors = new Set<string>()): ChildNode[] {
  return children.filter(child => !ancestors.has(child.nativeSessionId)).map(child => {
    const nested = childTree(childrenFor?.(child.nativeSessionId) ?? [], childrenFor, new Set([...ancestors, child.nativeSessionId]));
    return { child, children: nested, total: 1 + nested.reduce((sum, node) => sum + node.total, 0),
      working: (child.status === 'running' ? 1 : 0) + nested.reduce((sum, node) => sum + node.working, 0) };
  });
}
