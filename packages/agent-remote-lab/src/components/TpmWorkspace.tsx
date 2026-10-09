import { useEffect, useLayoutEffect, useRef, useState, type RefObject } from 'react';
import type { SessionTodoDecision } from '@orchardworks/agent-remote-protocol';
import type { SessionTodoPanelProps } from '@orchardworks/agent-remote-web/react';
import type { AgentReplica, RemoteAgentTransport } from '@orchardworks/agent-remote-web';
import { CommunicationNavigationContext, MarkdownContent } from '@orchardworks/agent-remote-web/react';
import { useBoundDraft, type DraftBinding } from '../draft-store.js';
import type { OpenedSession } from '../directory-client.js';
import type { TpmAction, TpmItem } from '../hooks/useTpmWork.js';
import { useAskPosition } from '../hooks/useAskPosition.js';
import { useConversationSession } from '../hooks/useConversationSession.js';
import type { SessionViewNavigationFactory } from '../session-view-navigation.js';
import { sessionKey } from '../session-tree.js';
import { LabWorkbench } from './LabWorkbench.js';
import { AskResize } from './AskResize.js';
import { tpmPhaseLabel } from './TpmMenu.js';

/** The floating shell controls presentation; the ordinary conversation owns input and recovery. */
export function TpmWorkspace({ item, session, replica, visible, storageScope, triggerRef, transport, draftBinding, busy, attaching, error, navigation,
  onClose, onShowList, onOpenMain, onAction, onResolve, onRetry, onConfirmTodo }: {
  item: TpmItem; session?: OpenedSession; replica?: AgentReplica; visible: boolean; storageScope: string; triggerRef: RefObject<HTMLButtonElement>;
  transport: RemoteAgentTransport; draftBinding: DraftBinding; busy?: boolean; attaching?: boolean; error?: string; navigation?: SessionViewNavigationFactory;
  onClose(): void; onShowList(): void; onOpenMain(): void; onAction(action: TpmAction): Promise<unknown>;
  onConfirmTodo?(decision: SessionTodoDecision): Promise<unknown>;
  onResolve(intentId: string, resolution: 'accepted' | 'rejected', nativeSessionId?: string): Promise<unknown>; onRetry(): void;
}) {
  const panel = useRef<HTMLElement>(null);
  const returnFocus = useRef<HTMLElement | null>(null);
  const [documentVisible, setDocumentVisible] = useState(false);
  const [actionError, setActionError] = useState<string>();
  const [verifiedSessionId, setVerifiedSessionId] = useState('');
  useAskPosition(panel, triggerRef, JSON.stringify([storageScope, 'tpm', item.key]));
  useLayoutEffect(() => {
    const element = panel.current;
    if (!visible || !element) return;
    const previous = document.activeElement;
    if (!element.contains(previous)) returnFocus.current = previous instanceof HTMLElement && previous !== document.body ? previous : triggerRef.current;
    element.focus({ preventScroll: true });
    return () => {
      if (!element.contains(document.activeElement)) return;
      const target = returnFocus.current;
      queueMicrotask(() => { if (target?.isConnected && (document.activeElement === document.body || element.contains(document.activeElement))) target.focus({ preventScroll: true }); });
    };
  }, [visible, triggerRef]);
  useEffect(() => {
    if (!visible) return;
    const dismiss = (event: KeyboardEvent) => {
      if (event.key !== 'Escape' || event.defaultPrevented || !(event.target instanceof Node) || !panel.current?.contains(event.target)) return;
      event.preventDefault(); onClose();
    };
    window.addEventListener('keydown', dismiss);
    return () => window.removeEventListener('keydown', dismiss);
  }, [visible, onClose]);
  function run(operation: () => Promise<unknown>) {
    setActionError(undefined);
    void operation().catch(error => setActionError(error instanceof Error ? error.message : 'TPM operation failed.'));
  }
  const work = item.work;
  const unavailable = !item.online || busy;
  const creationUnresolved = work.creationStatus === 'unknown' || work.creationStatus === 'abandoned';
  return <div className="lab-ask-viewport lab-tpm-viewport" hidden={!visible}>
    <section ref={panel} className="lab-ask-window lab-tpm-window" role="dialog" aria-label={`TPM: ${work.title}`} aria-modal="false" tabIndex={-1}>
      <header className="lab-ask-heading lab-tpm-heading"><div><span className="lab-tpm-eyebrow">TPM · {item.hostName}</span><strong title={work.title}>{work.title}</strong></div>
        <div className="lab-ask-controls"><button type="button" aria-label="Back to TPM works" title="Back to works" onClick={onShowList}>Works</button><button type="button" aria-label="Minimize TPM" title="Minimize TPM" onClick={onClose}>×</button></div>
      </header>
      <div className="lab-tpm-work-status">
        <span className="lab-tpm-phase" data-tpm-phase={work.phase}>{tpmPhaseLabel[work.phase]}</span>
        {work.paused ? <span>Background follow-up paused</span> : null}
        {work.waiting === 'user' ? <span className="lab-tpm-needs-user">Waiting for your decision</span> : work.waiting === 'main_session' ? <span>Waiting for main-session progress</span> : null}
        {work.health ? <span className="lab-tpm-health">{work.health}</span> : null}{!item.online ? <span className="lab-tpm-health">Host offline</span> : null}
        <button className="lab-tpm-main-link" type="button" aria-label="Open main session" onClick={onOpenMain}>Main session ↗</button>
      </div>
      <nav className="lab-tpm-toolbar" aria-label="Work view">
        <button type="button" aria-pressed={!documentVisible} onClick={() => setDocumentVisible(false)}>Conversation</button>
        <button type="button" aria-label="Plan & acceptance" aria-pressed={documentVisible} onClick={() => setDocumentVisible(true)}>Plan & acceptance</button>
        {work.phase === 'completed' ? <button className="lab-tpm-reopen" type="button" aria-label="Reopen work" disabled={unavailable || creationUnresolved} onClick={() => run(() => onAction('reopen'))}>Reopen work</button> : null}
      </nav>
      {work.summary || work.nextAction ? <details className="lab-tpm-progress"><summary title={work.summary || work.nextAction}>{work.summary || work.nextAction}</summary>{work.summary && work.nextAction ? <small>Next: {work.nextAction}</small> : null}</details> : null}
      {work.creationStatus === 'unknown' ? <details className="lab-tpm-uncertain" open>
        <summary>Uncertain TPM creation</summary>
        <p>A creation receipt was lost. Verify the native session identity on this Controller before binding it, or abandon this work.</p>
        <label>Verified TPM session ID<input aria-label="Verified TPM session ID" value={verifiedSessionId} maxLength={128} onChange={event => setVerifiedSessionId(event.target.value)} /></label>
        <div><button type="button" aria-label="Confirm TPM creation" disabled={unavailable || !verifiedSessionId.trim()} onClick={() => run(() => onResolve('creation', 'accepted', verifiedSessionId.trim()))}>Bind verified session</button>
          <button type="button" aria-label="Abandon uncertain TPM creation" disabled={unavailable} onClick={() => run(() => onResolve('creation', 'rejected'))}>Abandon work</button></div>
      </details> : null}
      {!work.detailsOmitted && work.outbox?.filter(intent => intent.status === 'unknown').map(intent => <details className="lab-tpm-uncertain" key={intent.id}>
        <summary>Uncertain {intent.target === 'main' ? 'main-session message' : 'TPM check'}</summary>
        <p>{intent.text}</p><small>{intent.error ?? 'Delivery could not be confirmed. Review session evidence before resolving.'}</small>
        <div><button type="button" aria-label={`Mark ${intent.id} as accepted`} disabled={unavailable} onClick={() => run(() => onResolve(intent.id, 'accepted'))}>Confirm accepted</button>
          <button type="button" aria-label={`Mark ${intent.id} as rejected`} disabled={unavailable} onClick={() => run(() => onResolve(intent.id, 'rejected'))}>Confirm not accepted</button></div>
      </details>)}
      {error || actionError ? <div role="alert" className="lab-ask-error">{actionError ?? error}{error ? <button type="button" disabled={attaching || !item.online} onClick={onRetry}>{work.detailsOmitted ? 'Reload work details' : 'Retry conversation'}</button> : null}</div> : null}
      <article className="lab-tpm-document" aria-label="Plan & acceptance" hidden={!documentVisible}>
        {work.detailsOmitted ? <p role="status">{error ? 'The current plan could not be loaded. Reload work details to try again.' : 'Loading the current plan & acceptance…'}</p> : work.document ? <MarkdownContent markdown={work.document} /> : <p>The TPM has not written a plan yet. Discuss the outcome in Conversation to get started.</p>}
        {work.acceptance ? <><h2>Acceptance</h2><MarkdownContent markdown={work.acceptance} /></> : null}
        {work.evidence.length ? <><h2>Evidence</h2><ul>{work.evidence.map((evidence, index) => <li key={index}><MarkdownContent markdown={evidence} /></li>)}</ul></> : null}
      </article>
      <div className="lab-tpm-conversation" hidden={documentVisible}>
        {session ? <TpmChat session={session} replica={replica} transport={transport} draftBinding={draftBinding} navigation={navigation} title={work.title}
          todo={work.todo ? { list: work.todo, disabled: unavailable || work.paused, onConfirm: onConfirmTodo,
            context: work.document || work.acceptance ? <details><summary>Specification & acceptance</summary><MarkdownContent markdown={`${work.document}\n\n${work.acceptance}`} /></details> : undefined } : undefined} /> : <>
          <div className="lab-ask-opening" role="status">{attaching ? 'Opening TPM conversation…' : work.creationStatus === 'abandoned' ? 'This work was abandoned.' : work.tpmNativeSessionId ? 'The TPM conversation is unavailable. Retry attachment when the Controller is online.' : 'The TPM session has not been created. Review its work health before continuing.'}</div>
          <TpmDraft binding={draftBinding} />
        </>}
      </div>
      <AskResize label="TPM" />
    </section>
  </div>;
}

function TpmChat({ session, replica, transport, draftBinding, navigation, title, todo }: {
  session: OpenedSession; replica?: AgentReplica; transport: RemoteAgentTransport; draftBinding: DraftBinding; navigation?: SessionViewNavigationFactory; title: string; todo?: SessionTodoPanelProps;
}) {
  const { state, sessionState, status, actions, questions, setQuestions } = useConversationSession(session, transport, replica);
  const { communication, ...viewNavigation } = navigation?.(session, state) ?? {};
  return <CommunicationNavigationContext.Provider value={communication}><LabWorkbench todo={todo} defaultDisplayMode="content" headingMode="toolbar" {...viewNavigation}
    state={state} sessionState={sessionState} sessionStatus={status} attachingAgentId={session.agentId} actions={actions}
    draftSessionKey={sessionKey(session)} draftBinding={draftBinding} questionDrafts={questions}
    onQuestionDraftChange={(id, value) => setQuestions(current => ({ ...current, [id]: value }))}
    conversationPath={<strong className="agent-session-title" data-session-status={state?.agent?.status}>{title}</strong>} />
  </CommunicationNavigationContext.Provider>;
}
function TpmDraft({ binding }: { binding: DraftBinding }) {
  const draft = useBoundDraft(binding);
  return <textarea className="lab-ask-draft" aria-label="TPM draft" rows={2} placeholder="Ask about this work…" value={draft.text ?? ''} onChange={event => draft.set(event.target.value)} />;
}
