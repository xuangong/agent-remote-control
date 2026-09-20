import { useEffect, useLayoutEffect, useRef, type RefObject, type ReactNode } from 'react';
import type { AgentReplica, RemoteAgentTransport } from '@agent-remote-controller/agent-remote-web';
import { TimelineDisplay, type TimelineDisplayMode } from '@agent-remote-controller/agent-remote-web/react';
import type { AskEntry, AskInput, AskInputSender } from '../hooks/useAskConversations.js';
import { useConversationSession } from '../hooks/useConversationSession.js';
import type { ForkStore, SessionFork } from '../session-forks.js';
import { sessionActivity } from '../session-activity.js';
import { sessionKey } from '../session-tree.js';
import { useAskPosition } from '../hooks/useAskPosition.js';
import { LabWorkbench } from './LabWorkbench.js';

export function AskConversation({ entry, store, replica, transport, draft, onDraftChange, onClose, onClean, onRetry, onSendInput, simple, onToggleSimple, triggerRef }: {
  triggerRef: RefObject<HTMLButtonElement>; entry: AskEntry; store: ForkStore; replica?: AgentReplica; transport: RemoteAgentTransport;
  simple: boolean; onToggleSimple(): void;
  draft: string; onDraftChange(value: string): void; onClose(): void; onClean(): void; onRetry(): void; onSendInput(id: string, send: AskInputSender): void;
}) {
  const panel = useRef<HTMLElement>(null);
  useAskPosition(panel, triggerRef);
  useLayoutEffect(() => {
    const previous = document.activeElement;
    panel.current?.focus({ preventScroll: true });
    const element = panel.current;
    return () => {
      if (element?.contains(document.activeElement) && previous instanceof HTMLElement && previous.isConnected) previous.focus({ preventScroll: true });
    };
  }, []);
  const tools = <div className="lab-ask-controls">
    <button type="button" aria-label="Clean Ask" title="Start a fresh Ask conversation" disabled={entry.busy || !!entry.inputs?.length} onClick={onClean}>Clean</button>
    <button type="button" className="lab-ask-view-toggle" aria-label="Simple view" aria-pressed={simple} title={simple ? 'Show content only' : 'Show simple timeline'} onClick={onToggleSimple}>
      <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" aria-hidden="true"><path d="M9 6h11M9 12h11M9 18h11" /><path d="M4 6h.01M4 12h.01M4 18h.01" strokeWidth="3" strokeLinecap="round" /></svg>
    </button>
    <button type="button" aria-label="Minimize Ask" title="Minimize Ask" onClick={onClose}>×</button>
  </div>;
  return <div className="lab-ask-viewport"><section className="lab-ask-window" role="dialog" aria-label="Ask" aria-modal="false" tabIndex={-1} ref={panel}
    onKeyDown={event => { if (event.key === 'Escape' && !event.defaultPrevented) { event.preventDefault(); onClose(); } }}>
    {entry.inputs?.length ? <div className="lab-ask-waiting" role="status">Waiting to send: {entry.inputs.map(input => input.text).join(" · ")}</div> : null}
    {entry.error ? <div className="lab-ask-error" role="alert">{entry.error}<button type="button" disabled={entry.busy} onClick={onRetry}>Retry</button></div> : null}
    {entry.record?.target ? <AskChat key={entry.record.id} record={store.get(entry.record.id)} inputs={entry.error ? undefined : entry.inputs} onSendInput={onSendInput} replica={replica} transport={transport}
      mode={simple ? 'simple' : 'content'} busy={entry.busy} draft={draft} onDraftChange={onDraftChange} tools={tools} /> : <>
      <header className="lab-ask-heading"><strong>Ask</strong>{tools}</header>
      <div className="lab-ask-opening" role="status">{entry.busy ? 'Opening Ask…' : 'Ask about this conversation.'}</div>
      <textarea className="lab-ask-draft" aria-label="Ask draft" rows={2} placeholder="Ask anything…" value={draft} onChange={event => onDraftChange(event.target.value)} />
    </>}
  </section></div>;
}

function AskChat({ mode, record, inputs, onSendInput, replica, transport, draft, onDraftChange, tools, busy }: {
  mode: TimelineDisplayMode; record: SessionFork; inputs?: AskInput[]; onSendInput(id: string, send: AskInputSender): void; replica?: AgentReplica; transport: RemoteAgentTransport;
  draft: string; onDraftChange(value: string): void; tools: ReactNode; busy?: boolean;
}) {
  const session = record.target!;
  const { state, status, actions, questions, setQuestions, sendQueuedInput } = useConversationSession(session, transport, replica, busy);
  useEffect(() => {
    if (sendQueuedInput && !busy && inputs?.[0]) onSendInput(inputs[0].id, sendQueuedInput);
  }, [sendQueuedInput, inputs, onSendInput, busy]);
  return <TimelineDisplay.Provider value={mode}><LabWorkbench compact state={state}
    sessionStatus={status} attachingAgentId={session.agentId} actions={actions}
    draftSessionKey={sessionKey(session)} messageDraft={draft} onMessageDraftChange={onDraftChange}
    questionDrafts={questions} onQuestionDraftChange={(id, value) => setQuestions(current => ({ ...current, [id]: value }))}
    conversationPath={<strong className="agent-session-title" data-session-status={sessionActivity(state)}>Ask</strong>}
    sessionManager={tools} /></TimelineDisplay.Provider>;
}
