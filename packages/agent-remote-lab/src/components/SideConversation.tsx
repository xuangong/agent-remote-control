import { SessionLink } from './SessionLink.js';
import { useEffect, useRef, useState } from 'react';
import { AgentReplica, RemoteSessionClient, type AgentReplicaState, type RemoteAgentTransport, type RemoteSessionStatus } from '@agent-remote-controller/agent-remote-web';
import type { AgentCommandResult } from '@agent-remote-controller/agent-remote-protocol';
import type { QuestionDraft } from '@agent-remote-controller/agent-remote-web/react';
import type { OpenedSession } from '../directory-client.js';
import { forkDisplayState, type ForkStore, type SessionFork } from '../session-forks.js';
import { forkActions, forkCommands } from '../fork-actions.js';
import { ForkEntries, ForkReference } from './ForkReference.js';
import { LabWorkbench, type LabWorkbenchActions } from './LabWorkbench.js';
import { sessionKey } from '../session-tree.js';

export function SideConversation({ session, transport, store, draft, onDraftChange, onClose, onOpenSource, onFork, onOpenFork, onFocus, initialInput, visible = true, expanded = true, focused = true, position = 1, selectedChild }: {
  expanded?: boolean; focused?: boolean; position?: number; selectedChild?: string | null;
  initialInput?: { pending: boolean; error?: string };
  session: OpenedSession; transport: RemoteAgentTransport; store: ForkStore; draft: string; onDraftChange(text: string): void;
  onFocus?(): void; onClose(): void; onOpenSource(session: OpenedSession): void; onOpenFork(fork: SessionFork): void;
  onFork(state: AgentReplicaState, session: OpenedSession, id: string, args: string): Promise<AgentCommandResult>; visible?: boolean;
}) {
  const [state, setState] = useState<AgentReplicaState>();
  const [status, setStatus] = useState<RemoteSessionStatus>('connecting');
  const [questions, setQuestions] = useState<Record<string, QuestionDraft>>({});
  const client = useRef<RemoteSessionClient>();
  const panel = useRef<HTMLElement>(null);
  useEffect(() => {
    const replica = new AgentReplica();
    const connection = new RemoteSessionClient(session.agentId, transport, replica, { historyPageSize: 100 });
    client.current = connection;
    setState(undefined); setStatus('connecting'); setQuestions({});
    const unsubscribe = replica.subscribe(() => setState(replica.getState()));
    const unsubscribeStatus = connection.subscribeStatus(setStatus);
    connection.start();
    return () => { unsubscribe(); unsubscribeStatus(); connection.stop(); if (client.current === connection) client.current = undefined; };
  }, [session.agentId, transport]);
  useEffect(() => { if (status === 'ready' && focused && expanded && visible) panel.current?.querySelector<HTMLTextAreaElement>('textarea')?.focus({ preventScroll: true }); }, [session.agentId, status, focused, expanded, visible]);
  const record = store.find(session);
  const title = record?.firstInput?.trim().slice(0, 72) || session.title;
  const active = client.current;
  const actions: LabWorkbenchActions = active && status === 'ready' && !initialInput?.pending ? {
    loadOlder: () => active.loadOlder(), sendMessage: async (text, options) => { await active.sendMessage(text, options); }, cancel: async () => { await active.cancel(); },
    setPlanning: async (value) => { await active.setPlanning(value); }, setSessionSetting: async (id, value) => { await active.setSessionSetting(id, value); },
    listCommands: () => active.listCommands(), executeCommand: (id, args) => active.executeCommand(id, args),
    respondToInteraction: async (id, response) => { await active.respondToInteraction(id, response); }, requestResource: async (binding) => { await active.requestResource(binding.resourceId); },
    resolveResource: (locator, sourceLocator) => active.resolveResource(locator, sourceLocator),
  } : {};
  return <aside className="lab-side-conversation" aria-label="Side conversation" ref={panel} onFocusCapture={onFocus} hidden={!expanded} style={{ order: position }}>
    <LabWorkbench state={forkDisplayState(state, record)} sessionStatus={status} attachingAgentId={session.agentId}
      visible={visible && expanded} actions={forkActions(actions, store, record, transport)} messageDraft={draft} onMessageDraftChange={onDraftChange}
      questionDrafts={questions} onQuestionDraftChange={(id, value) => setQuestions((current) => ({ ...current, [id]: value }))}
      conversationPath={<span className="lab-side-title" title={title}><span className="lab-window-number">{position + 1}</span><span className="lab-side-title-text">{title}</span></span>}
      sessionManager={<><SessionLink session={session} /><button className="lab-side-close" type="button" aria-label="Close side conversation, back to source" title="Close side conversation" onClick={onClose}>
        <svg className="lab-side-back-icon" width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="m14 6-6 6 6 6" /></svg>
        <span className="lab-side-back-label" aria-hidden="true">Back</span><span className="lab-side-close-icon" aria-hidden="true">×</span>
      </button></>}
      composerContext={record ? <ForkReference fork={record} onOpen={onOpenSource} /> : undefined}
      composerNotice={<>{initialInput?.pending ? <p className="lab-control-note" role="status">Sending the first branch message…</p> : initialInput?.error ? <p className="lab-control-note" role="alert">{initialInput.error}</p> : null}<ForkEntries forks={store.all().filter((fork) => fork.target && sessionKey(fork.source) === sessionKey(session))} selectedChild={selectedChild} onOpen={onOpenFork} /></>}
      consoleCommands={!initialInput?.pending && state?.agent?.capabilities.sendMessage && state.agent.capabilities.history ? forkCommands : []}
      onExecuteConsoleCommand={(id, args) => { if (!state) return Promise.reject(new Error('The side session is not ready.')); return onFork(state, session, id, args); }} />
  </aside>;
}
