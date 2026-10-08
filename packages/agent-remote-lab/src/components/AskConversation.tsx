import { useBoundDraft, type DraftBinding } from '../draft-store.js';
import { useEffect, useLayoutEffect, useRef, type RefObject, type ReactNode } from 'react';
import type { AgentReplica, RemoteAgentTransport } from '@orchardworks/agent-remote-web';
import { CommunicationNavigationContext } from '@orchardworks/agent-remote-web/react';
import type { SessionViewNavigationFactory } from '../session-view-navigation.js';
import type { AskEntry, AskInput, AskInputSender } from '../hooks/useAskConversations.js';
import { useConversationSession } from '../hooks/useConversationSession.js';
import type { ForkStore, SessionFork } from '../session-forks.js';
import { sessionKey } from '../session-tree.js';
import { useAskPosition } from '../hooks/useAskPosition.js';
import { askCommand } from '../fork-actions.js';
import { LabWorkbench } from './LabWorkbench.js';
import { AskResize } from './AskResize.js';

export function AskConversation({ entry, store, replica, transport, draftBinding, onClose, onToggleEnabled, onClean, onRetry, onSendInput, triggerRef, storageScope, navigation }: {
  navigation?: SessionViewNavigationFactory;
  storageScope: string; triggerRef: RefObject<HTMLButtonElement>; entry: AskEntry; store: ForkStore; replica?: AgentReplica; transport: RemoteAgentTransport;
  draftBinding: DraftBinding; onClose(): void; onToggleEnabled(): void; onClean(): void; onRetry(): void; onSendInput(id: string, send: AskInputSender): void;
}) {
  const panel = useRef<HTMLElement>(null);
  const returnFocus = useRef<HTMLElement | null>(null);
  const busy = !!entry.busy || !!entry.restoring;
  useAskPosition(panel, triggerRef, storageScope);
  useEffect(() => {
    const dismiss = (event: KeyboardEvent) => {
      if (event.key !== 'Escape' || event.defaultPrevented || !(event.target instanceof Node) || !panel.current?.contains(event.target)) return;
      event.preventDefault();
      onClose();
    };
    window.addEventListener('keydown', dismiss);
    return () => window.removeEventListener('keydown', dismiss);
  }, [onClose]);
  useLayoutEffect(() => {
    const previous = document.activeElement;
    const element = panel.current;
    if (!element?.contains(previous)) returnFocus.current = previous instanceof HTMLElement && previous !== document.body ? previous : triggerRef.current;
    if (!entry.restoring && !entry.restoreOnly) element?.focus({ preventScroll: true });
    return () => {
      if (!element?.contains(document.activeElement)) return;
      const target = returnFocus.current;
      // The minimized trigger becomes visible after the unmount commit.
      queueMicrotask(() => {
        if (document.activeElement === document.body && target?.isConnected) target.focus({ preventScroll: true });
      });
    };
  }, [triggerRef]);
  const tools = <div className="lab-ask-controls">
    <button type="button" aria-label="Clean Ask" title="Start a fresh Ask conversation" disabled={busy || !!entry.inputs?.length} onClick={onClean}>Clean</button>
    <button type="button" aria-label="Minimize Ask" title="Minimize Ask" onClick={onClose}>×</button>
  </div>;
  return <div className="lab-ask-viewport"><section className="lab-ask-window" role="dialog" aria-label="Ask" aria-modal="false" tabIndex={-1} ref={panel}>
    {entry.inputs?.length ? <div className="lab-ask-waiting" role="status">Waiting to send: {entry.inputs.map(input => input.text).join(" · ")}</div> : null}
    {entry.error ? <div className="lab-ask-error" role="alert">{entry.error}<button type="button" disabled={busy} onClick={onRetry}>Retry</button></div> : null}
    {entry.attached && entry.record?.target ? <AskChat key={entry.record.id} record={store.get(entry.record.id)} inputs={entry.error ? undefined : entry.inputs} onSendInput={onSendInput} replica={replica} transport={transport}
      navigation={navigation} onToggleEnabled={onToggleEnabled} busy={busy} draftBinding={draftBinding} tools={tools} /> : <>
      <header className="lab-ask-heading"><strong>Ask</strong>{tools}</header>
      {busy || !entry.error ? <div className="lab-ask-opening" role="status">{busy ? 'Opening Ask…' : 'Ask about this conversation.'}</div> : null}
      <AskDraft binding={draftBinding} />
    </>}
    <AskResize />
  </section></div>;
}

function AskChat({ record, inputs, onSendInput, replica, transport, draftBinding, tools, busy, onToggleEnabled, navigation }: {
  navigation?: SessionViewNavigationFactory;
  onToggleEnabled(): void; record: SessionFork; inputs?: AskInput[]; onSendInput(id: string, send: AskInputSender): void; replica?: AgentReplica; transport: RemoteAgentTransport;
  draftBinding: DraftBinding; tools: ReactNode; busy?: boolean;
}) {
  const session = record.target!;
  const { state, sessionState, status, actions, questions, setQuestions, sendQueuedInput } = useConversationSession(session, transport, replica, busy);
  const { communication, ...viewNavigation } = navigation?.(session, state) ?? {};
  useEffect(() => {
    if (sendQueuedInput && !busy && inputs?.[0]) onSendInput(inputs[0].id, sendQueuedInput);
  }, [sendQueuedInput, inputs, onSendInput, busy]);
  return <CommunicationNavigationContext.Provider value={communication}><LabWorkbench defaultDisplayMode="content" {...viewNavigation} sessionState={sessionState} state={state}
    consoleCommands={[askCommand]} onExecuteConsoleCommand={async (_id, args) => {
      if (args.trim()) {
        if (!actions.sendMessage) throw new Error('Wait for Ask to finish synchronizing.');
        await actions.sendMessage(args.trim());
      } else onToggleEnabled();
      return {};
    }}
    sessionStatus={status} attachingAgentId={session.agentId} actions={actions}
    draftSessionKey={sessionKey(session)} draftBinding={draftBinding}
    questionDrafts={questions} onQuestionDraftChange={(id, value) => setQuestions(current => ({ ...current, [id]: value }))}
    conversationPath={<strong className="agent-session-title" data-session-status={state?.agent?.status}>Ask</strong>}
    sessionManager={tools} /></CommunicationNavigationContext.Provider>;
}

function AskDraft({ binding }: { binding: DraftBinding }) {
  const draft = useBoundDraft(binding);
  return <textarea className="lab-ask-draft" aria-label="Ask draft" rows={2} placeholder="Ask anything…" value={draft.text} onChange={event => draft.set(event.target.value)} />;
}
