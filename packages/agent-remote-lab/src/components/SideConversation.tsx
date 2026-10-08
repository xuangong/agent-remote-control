import { CommunicationNavigationContext } from '@orchardworks/agent-remote-web/react';
import type { DraftBinding } from '../draft-store.js';
import { SessionLink } from './SessionLink.js';
import { useEffect, useRef, type ReactNode } from 'react';
import { useConversationSession } from '../hooks/useConversationSession.js';
import { type AgentReplica, type AgentReplicaState, type RemoteAgentTransport } from '@orchardworks/agent-remote-web';
import type { AgentCommandResult } from '@orchardworks/agent-remote-protocol';
import type { OpenedSession } from '../directory-client.js';
import { forkDisplayState, type ForkStore, type SessionFork } from '../session-forks.js';
import { forkActions, forkCommands } from '../fork-actions.js';
import { ForkEntries, ForkReference } from './ForkReference.js';
import { LabWorkbench } from './LabWorkbench.js';
import { sessionKey } from '../session-tree.js';
import type { SessionViewNavigationFactory } from '../session-view-navigation.js';

export function SideConversation({ session, replica: cachedReplica, transport, store, draft, draftBinding, onDraftChange, onClose, onOpenSource, onFork, onOpenFork, onUnlink, standalone = false, onFocus, onActivityChange, initialInput, visible = true, expanded = true, focused = true, position = 1, selectedChild, navigation, renderAsk }: {
  navigation?: SessionViewNavigationFactory;
  renderAsk?(source: OpenedSession, state: AgentReplicaState | undefined): ReactNode;
  replica?: AgentReplica;
  standalone?: boolean; onUnlink?(fork: SessionFork): Promise<void>;
  expanded?: boolean; focused?: boolean; position?: number; selectedChild?: string | null;
  initialInput?: { pending: boolean; error?: string };
  session: OpenedSession; transport: RemoteAgentTransport; store: ForkStore; draftBinding?: DraftBinding; draft?: string; onDraftChange?(text: string): void;
  onActivityChange?(agentId: string, status: import('@orchardworks/agent-remote-protocol').AgentStatus | undefined): void;
  onFocus?(): void; onClose(): void; onOpenSource(session: OpenedSession): void; onOpenFork(fork: SessionFork): void;
  onFork(state: AgentReplicaState, session: OpenedSession, id: string, args: string): Promise<AgentCommandResult>; visible?: boolean;
}) {
  const { state, sessionState, handoff, status, questions, setQuestions, actions } = useConversationSession(session, transport, cachedReplica, initialInput?.pending);
  const { communication, ...viewNavigation } = navigation?.(session, state) ?? {};
  const panel = useRef<HTMLElement>(null);
  useEffect(() => {
    if (status === 'ready' && focused && expanded && visible && !panel.current?.contains(document.activeElement)) {
      panel.current?.querySelector<HTMLTextAreaElement>('textarea')?.focus({ preventScroll: true });
    }
  }, [session.agentId, status, focused, expanded, visible]);
  const activity = state?.agent?.status;
  useEffect(() => { onActivityChange?.(session.agentId, activity); }, [session.agentId, activity, onActivityChange]);
  const record = store.find(session);
  const title = record?.firstInput?.trim().slice(0, 72) || session.title;
  return <aside className="lab-side-conversation lab-session-composition" aria-label="Side conversation" tabIndex={-1} ref={panel} onFocusCapture={onFocus} onClickCapture={onFocus} hidden={!expanded} style={{ order: position }}>
    <CommunicationNavigationContext.Provider value={communication}><LabWorkbench {...viewNavigation} sessionState={sessionState} handoff={handoff} draftSessionKey={sessionKey(session)} state={forkDisplayState(state, record)} sessionStatus={status} attachingAgentId={session.agentId}
      visible={visible && expanded} actions={forkActions(actions, store, record, transport)} draftBinding={draftBinding} messageDraft={draft} onMessageDraftChange={onDraftChange}
      questionDrafts={questions} onQuestionDraftChange={(id, value) => setQuestions((current) => ({ ...current, [id]: value }))}
      conversationPath={<span className="lab-side-title" title={title}>{standalone ? null : <span className="lab-window-number">{position + 1}</span>}<span className="lab-side-title-text agent-session-title" data-session-status={activity}>{title}</span></span>}
      sessionManager={<><SessionLink session={session} />{standalone ? null : <button className="lab-side-close" type="button" aria-label="Close side conversation, back to source" title="Close side conversation" onClick={onClose}>
        <svg className="lab-side-back-icon" width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="m14 6-6 6 6 6" /></svg>
        <span className="lab-side-back-label" aria-hidden="true">Back</span><span className="lab-side-close-icon" aria-hidden="true">×</span>
      </button>}</>}
      composerContext={record && record.linked !== false ? <ForkReference fork={record} onOpen={onOpenSource} onUnlink={onUnlink} /> : undefined}
      composerNotice={<>{initialInput?.pending ? <p className="lab-control-note" role="status">Sending the first branch message…</p> : initialInput?.error ? <p className="lab-control-note" role="alert">{initialInput.error}</p> : null}<ForkEntries forks={store.linked().filter((fork) => fork.target && sessionKey(fork.source) === sessionKey(session))} selectedChild={selectedChild} onOpen={onOpenFork} onUnlink={onUnlink} /></>}
      consoleCommands={status === 'ready' && !initialInput?.pending && state?.agent?.capabilities.sendMessage && state.agent.capabilities.history ? forkCommands : []}
      onExecuteConsoleCommand={(id, args) => { if (!state || status !== 'ready' || initialInput?.pending) return Promise.reject(new Error('The side session is not ready.')); return onFork(state, session, id, args); }} /></CommunicationNavigationContext.Provider>
    {renderAsk?.(session, state)}
  </aside>;
}
