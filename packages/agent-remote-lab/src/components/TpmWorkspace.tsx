import { useEffect, useLayoutEffect, useRef, useState, type RefObject, type ReactNode } from 'react';
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
import { tpmMainTarget } from '../tpm-main-sessions.js';
import { LabWorkbench } from './LabWorkbench.js';
import { SessionViewPlacement } from './SessionDock.js';
import { AskResize } from './AskResize.js';
import { tpmPhaseLabel } from './TpmMenu.js';

export function TpmWorkspace(props: Omit<Parameters<typeof TpmWorkspaceContent>[0], 'docked' | 'dockControls'>) {
  return <SessionViewPlacement id={`tpm:${props.item.key}`} title={props.item.work.title} visible={props.visible}>
    {({ docked, controls }) => <TpmWorkspaceContent {...props} docked={docked} dockControls={controls} />}
  </SessionViewPlacement>;
}

/** The shell controls presentation; the ordinary conversation owns input and recovery. */
function TpmWorkspaceContent({ item, mainTitle, session, replica, visible, storageScope, triggerRef, transport, draftBinding, busy, attaching, error, navigation,
  docked, dockControls, layer, initialOffset, onFocus, onClose, onShowList, onOpenMain, onRename, onAction, onResolve, onRetry, onConfirmTodo }: {
  item: TpmItem; mainTitle?: string; session?: OpenedSession; replica?: AgentReplica; visible: boolean; storageScope: string; triggerRef: RefObject<HTMLButtonElement>;
  transport: RemoteAgentTransport; draftBinding: DraftBinding; busy?: boolean; attaching?: boolean; error?: string; navigation?: SessionViewNavigationFactory;
  docked: boolean; dockControls: ReactNode;
  layer?: number; initialOffset?: number; onFocus?(): void;
  onRename?(title: string): Promise<unknown>;
  onClose(): void; onShowList(): void; onOpenMain(): void; onAction(action: TpmAction): Promise<unknown>;
  onConfirmTodo?(decision: SessionTodoDecision): Promise<unknown>;
  onResolve(intentId: string, resolution: 'accepted' | 'rejected', nativeSessionId?: string): Promise<unknown>; onRetry(): void;
}) {
  const panel = useRef<HTMLElement>(null);
  const returnFocus = useRef<HTMLElement | null>(null);
  const [documentVisible, setDocumentVisible] = useState(false);
  const [editingTitle, setEditingTitle] = useState(false);
  const [titleDraft, setTitleDraft] = useState('');
  const [savingTitle, setSavingTitle] = useState(false);
  const [titleError, setTitleError] = useState<string>();
  const titleInput = useRef<HTMLInputElement>(null);
  const titleButton = useRef<HTMLButtonElement>(null);
  const renameInFlight = useRef(false);
  const wasEditingTitle = useRef(false);
  useLayoutEffect(() => {
    if (editingTitle) { titleInput.current?.select(); wasEditingTitle.current = true; }
    else if (wasEditingTitle.current && !savingTitle) { titleButton.current?.focus(); wasEditingTitle.current = false; }
  }, [editingTitle, savingTitle]);
  const cancelRename = () => setEditingTitle(false);
  async function saveTitle() {
    const title = titleDraft.trim();
    if (!title || !onRename || renameInFlight.current) return;
    if (title === item.work.title) { cancelRename(); return; }
    renameInFlight.current = true; setSavingTitle(true); setTitleError(undefined);
    try { await onRename(title); cancelRename(); }
    catch (error) { setTitleError(error instanceof Error ? error.message : 'Could not rename the TPM session.'); }
    finally { renameInFlight.current = false; setSavingTitle(false); }
  }
  const [actionError, setActionError] = useState<string>();
  const [verifiedSessionId, setVerifiedSessionId] = useState('');
  useAskPosition(panel, triggerRef, JSON.stringify([storageScope, 'tpm', item.key]), { initialOffset, docked, belowAnchor: true });
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
  const main = tpmMainTarget(item);
  const mainLabel = mainTitle?.trim() || main.nativeSessionId;
  const unavailable = !item.online || busy;
  const creationUnresolved = work.creationStatus === 'unknown' || work.creationStatus === 'abandoned';
  const archiveLabel = work.archived ? 'Restore TPM session' : work.phase === 'completed' ? 'Archive TPM session' : 'Stop and archive TPM session';
  return <div className="lab-ask-viewport lab-tpm-viewport" style={{ zIndex: layer }} hidden={!visible}>
    <section ref={panel} className="lab-ask-window lab-tpm-window" role="dialog" aria-label={`TPM: ${work.title}`} aria-modal="false" tabIndex={-1} onPointerDownCapture={onFocus} onFocusCapture={onFocus}>
      <header className="lab-ask-heading lab-tpm-heading"><div><span className="lab-tpm-eyebrow">TPM · {item.hostName}</span>{onRename ? <button ref={titleButton} type="button" className="lab-tpm-title-button" aria-label="Rename TPM session" title={work.title} disabled={!!unavailable || savingTitle} onClick={() => { setTitleDraft(work.title); setTitleError(undefined); setEditingTitle(true); }}><strong>{work.title}</strong><svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" aria-hidden="true"><path d="m16 3 5 5-12 12-6 1 1-6ZM14 5l5 5" /></svg></button> : <strong title={work.title}>{work.title}</strong>}</div>
        <div className="lab-ask-controls">{dockControls}<button type="button" disabled={!!unavailable} aria-label={archiveLabel} title={archiveLabel} onClick={() => run(async () => {
          await onAction(work.archived ? 'unarchive' : 'archive');
          if (!work.archived) onShowList();
        })}><svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="M4 8v12h16V8M3 3h18v5H3z" /><path d={work.archived ? 'M12 17v-6m-3 3 3-3 3 3' : 'M9 12h6'} /></svg></button><button type="button" aria-label="Back to TPM works" title="Back to works" onClick={onShowList}>Works</button><button type="button" aria-label="Minimize TPM" title="Minimize TPM" onClick={onClose}>×</button></div>
      </header>
      {editingTitle ? <form className="lab-tpm-name-editor" onSubmit={event => { event.preventDefault(); void saveTitle(); }} onKeyDown={event => {
        if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); if (!savingTitle) cancelRename(); }
      }}>
        <label>Name<input ref={titleInput} aria-label="TPM session name" maxLength={256} required value={titleDraft} disabled={savingTitle} onChange={event => setTitleDraft(event.target.value)} /></label>
        <div><button type="button" disabled={savingTitle} onClick={cancelRename}>Cancel</button><button type="submit" disabled={savingTitle || !!unavailable || !titleDraft.trim()}>{savingTitle ? 'Saving…' : 'Save'}</button></div>
        {titleError ? <p role="alert">{titleError}</p> : null}
      </form> : null}
      <div className="lab-tpm-work-status">
        <span className="lab-tpm-phase" data-tpm-phase={work.phase}>{tpmPhaseLabel[work.phase]}</span>
        {work.archived ? <span>{work.phase === 'completed' ? 'Archived' : 'Stopped · Archived'}</span> : work.paused && work.phase !== 'completed' ? <span>Work paused</span> : null}
        {!work.archived && !work.paused && work.phase !== 'completed' ? work.waiting === 'user' ? <span className="lab-tpm-needs-user">Waiting for your decision</span> : work.waiting === 'main_session' ? <span>Waiting for main-session progress</span> : null : null}
        {work.health ? <span className="lab-tpm-health">{work.health}</span> : null}{!item.online ? <span className="lab-tpm-health">Host offline</span> : null}
        <button className="lab-tpm-main-link" type="button" aria-label={`Open main session: ${mainLabel}`} title={`${mainLabel} · ${main.providerId} · ${main.nativeSessionId}`} onClick={onOpenMain}><span>Main:</span><span className="lab-tpm-main-title">{mainLabel}</span><span aria-hidden="true">↗</span></button>
      </div>
      <nav className="lab-tpm-toolbar" aria-label="Work view">
        <button type="button" aria-pressed={!documentVisible} onClick={() => setDocumentVisible(false)}>Conversation</button>
        <button type="button" aria-label="Plan & acceptance" aria-pressed={documentVisible} onClick={() => setDocumentVisible(true)}>Plan & acceptance</button>
        {work.delegated !== undefined && !work.archived && work.phase !== 'completed' && !work.paused ? <button type="button" className="lab-tpm-delegation" aria-label="Background delegation" aria-pressed={work.delegated !== false}
          title={work.delegated !== false ? 'Stop automatic follow-up. The current turn can finish.' : 'Let TPM follow up automatically, even while this page is closed.'}
          disabled={unavailable || creationUnresolved} onClick={() => run(() => onAction(work.delegated !== false ? 'undelegate' : 'delegate'))}>{work.delegated !== false ? 'Delegated' : 'Delegate'}</button> : null}
        {work.phase === 'completed' ? <button className="lab-tpm-reopen" type="button" aria-label="Reopen work" disabled={unavailable || creationUnresolved} onClick={() => run(() => onAction('reopen'))}>Reopen work</button> : null}
        {!work.archived && work.paused && work.phase !== 'completed' ? <button className="lab-tpm-reopen" type="button" aria-label="Resume work" disabled={unavailable || creationUnresolved} onClick={() => run(() => onAction('resume'))}>Resume work</button> : null}

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
        {session ? <TpmChat displayBinding={{ scope: storageScope, key: `tpm:${item.key}` }} session={session} replica={replica} transport={transport} draftBinding={draftBinding} navigation={navigation} title={work.title}
          todo={work.todo ? { list: work.todo, disabled: unavailable || work.paused || work.archived, onConfirm: onConfirmTodo,
            context: work.document || work.acceptance ? <details><summary>Specification & acceptance</summary><MarkdownContent markdown={`${work.document}\n\n${work.acceptance}`} /></details> : undefined } : undefined} /> : <>
          <div className="lab-ask-opening" role="status">{attaching ? 'Opening TPM conversation…' : work.creationStatus === 'abandoned' ? 'This work was abandoned.' : work.tpmNativeSessionId ? 'The TPM conversation is unavailable. Retry attachment when the Controller is online.' : 'The TPM session has not been created. Review its work health before continuing.'}</div>
          <TpmDraft binding={draftBinding} />
        </>}
      </div>
      <AskResize label="TPM" />
    </section>
  </div>;
}

function TpmChat({ session, replica, transport, draftBinding, navigation, title, todo, displayBinding }: {
  displayBinding: { scope: string; key: string };
  session: OpenedSession; replica?: AgentReplica; transport: RemoteAgentTransport; draftBinding: DraftBinding; navigation?: SessionViewNavigationFactory; title: string; todo?: SessionTodoPanelProps;
}) {
  const { state, sessionState, status, actions, questions, setQuestions, imageRecipient, operationBinding } = useConversationSession(session, transport, replica, false, { nativePrefixOnly: true });
  const { communication, ...viewNavigation } = navigation?.(session, state) ?? {};
  return <CommunicationNavigationContext.Provider value={communication}><LabWorkbench displayBinding={displayBinding} todo={todo} defaultDisplayMode="content" headingMode="toolbar" {...viewNavigation}
    state={state} sessionState={sessionState} sessionStatus={status} attachingAgentId={operationBinding.source.agentId} actions={actions} operationBinding={operationBinding}
    draftSessionKey={sessionKey(session)} draftBinding={draftBinding} imageRecipient={imageRecipient} questionDrafts={questions}
    onQuestionDraftChange={(id, value) => setQuestions(current => ({ ...current, [id]: value }))}
    conversationPath={<strong className="agent-session-title" data-session-status={state?.agent?.status}>{title}</strong>} />
  </CommunicationNavigationContext.Provider>;
}
function TpmDraft({ binding }: { binding: DraftBinding }) {
  const draft = useBoundDraft(binding);
  return <textarea className="lab-ask-draft" aria-label="TPM draft" rows={2} placeholder="Ask about this work…" value={draft.text ?? ''} onChange={event => draft.set(event.target.value)} />;
}
