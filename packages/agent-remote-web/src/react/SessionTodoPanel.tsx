import { useEffect, useRef, useState, type ReactNode } from 'react';
import type { SessionTodoDecision, SessionTodoList } from '@orchardworks/agent-remote-protocol';
import { MarkdownContent } from './MarkdownContent.js';

export interface SessionTodoPanelProps {
  list: SessionTodoList;
  disabled?: boolean;
  context?: ReactNode;
  onConfirm?(decision: SessionTodoDecision): Promise<unknown>;
}

/** Optional session companion. Rendering never advances the list or acknowledges consent. */
export function SessionTodoPanel({ list, disabled, context, onConfirm }: SessionTodoPanelProps) {
  const root = useRef<HTMLDetailsElement>(null);
  const inFlight = useRef(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();
  const current = list.steps.find(step => step.status !== 'completed');
  const completed = list.steps.filter(step => step.status === 'completed').length;
  const request = current?.status === 'waiting' && current.kind === 'confirmation' && !current.confirmation?.decision ? current.confirmation : undefined;
  useEffect(() => {
    const dismiss = (event: Event) => {
      if (root.current && !root.current.contains(event.target as Node)) root.current.open = false;
    };
    document.addEventListener('pointerdown', dismiss, true);
    return () => document.removeEventListener('pointerdown', dismiss, true);
  }, []);
  useEffect(() => { setError(undefined); }, [list.revision]);
  async function decide(decision: SessionTodoDecision['decision']) {
    if (!current || !request || !onConfirm || disabled || inFlight.current) return;
    inFlight.current = true; setBusy(true); setError(undefined);
    try { await onConfirm({ revision: list.revision, stepId: current.id, requestId: request.id, decision }); }
    catch (error) { setError(error instanceof Error ? error.message : 'The decision could not be saved. Please retry.'); }
    finally { inFlight.current = false; setBusy(false); }
  }
  return <details ref={root} className="agent-session-todo" onKeyDown={event => {
    if (event.key === 'Escape') { event.stopPropagation(); if (root.current) { root.current.open = false; root.current.querySelector('summary')?.focus(); } }
  }}>
    <summary aria-label="Session todo list"><span>Todo {completed}/{list.steps.length}</span><span className="agent-session-todo-current">{current?.title ?? 'Completed'}</span>{request ? <span className="agent-session-todo-attention">Your decision</span> : null}</summary>
    <div className="agent-session-todo-panel">
      {request ? <section className="agent-session-todo-confirmation" aria-label="Current proposal">
        <strong>{current!.title}</strong><MarkdownContent markdown={request.content} />
        {context}
        <div className="agent-session-todo-actions">
          <button type="button" aria-label="Approve current todo step" disabled={disabled || busy || !onConfirm} onClick={() => void decide('approve')}>{busy ? 'Saving…' : 'Agree'}</button>
          <button type="button" aria-label="Request todo changes" disabled={disabled || busy || !onConfirm} onClick={() => void decide('revise')}>Needs changes</button>
        </div>
        {error ? <p role="alert">{error}</p> : null}
      </section> : null}
      <ol>{list.steps.map(step => <li key={step.id} data-status={step.status} aria-current={step.id === current?.id ? 'step' : undefined}>
        <details><summary><span aria-hidden="true">{step.status === 'completed' ? '✓' : step.id === current?.id ? '→' : '○'}</span> {step.title}{step.kind === 'confirmation' ? <small> · User confirmation</small> : null}</summary>
          <p>{step.acceptance}</p>{step.note ? <p>{step.note}</p> : null}
          {step.evidence?.map((evidence, index) => <p key={index}>{evidence}</p>)}
          {step.confirmation?.decision ? <p>{step.confirmation.decision === 'approve' ? 'Explicitly approved' : 'Changes requested'}</p> : null}
        </details>
      </li>)}</ol>
      {list.changes.length ? <details><summary>Plan changes</summary><ul>{list.changes.map((change, index) => <li key={index}><details><summary>{change.reason}</summary><p>Previous remaining steps:</p><ol>{change.previous.map(step => <li key={step.id}>{step.title}: {step.acceptance}</li>)}</ol></details></li>)}</ul></details> : null}
    </div>
  </details>;
}
