import { useContext, useEffect, useLayoutEffect, useRef, useState, type RefObject, type ReactNode } from 'react';
import type { SessionTodoDecision } from '@orchardworks/agent-remote-protocol';
import type { SessionTodoPanelProps } from '@orchardworks/agent-client-web/react';
import type { AgentReplica, RemoteAgentTransport } from '@orchardworks/agent-client';
import { CommunicationNavigationContext, MarkdownContent, SessionAttributions } from '@orchardworks/agent-client-web/react';
import { useBoundDraft, type DraftBinding } from '../draft-store.js';
import type { OpenedSession } from '../directory-client.js';
import type { TpmAction, TpmItem } from '../hooks/useTpmWork.js';
import { useAskPosition } from '../hooks/useAskPosition.js';
import { useConversationSession } from '../hooks/useConversationSession.js';
import type { SessionViewNavigationFactory } from '../session-view-navigation.js';
import { sessionKey } from '../session-tree.js';
import { tpmMainTarget } from '../tpm-main-sessions.js';
import { SessionDescriptionsContext } from '../session-description-context.js';
import { describeSession } from '../session-description.js';
import { useWindowLayout, WindowPresentationContext } from '../window-workspace-context.js';
import { featureView } from '../window-feature-views.js';
import { LabWorkbench } from './LabWorkbench.js';
import { SessionViewPlacement } from './SessionDock.js';
import { SessionHeadingActions } from './SessionHeadingActions.js';
import { SessionTitleInteractionContext } from './SessionTitleInteraction.js';
import { AskResize } from './AskResize.js';
import { tpmPhaseWords } from './TpmMenu.js';
import { useTranslate } from '@orchardworks/agent-client-web/react';
import { enumWords, errorWords } from '../team-words.js';

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
  const t = useTranslate();
  const descriptions = useContext(SessionDescriptionsContext);
  const shared = useWindowLayout();
  const titleInteraction = useContext(SessionTitleInteractionContext);
  const presentedViewId = useContext(WindowPresentationContext) ?? shared?.window.selectedViewId;
  const sharedView = shared && featureView(shared.window, 'tpm', item.key);
  const selected = !!sharedView && sharedView.id === presentedViewId;
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
    catch (error) { setTitleError(errorWords(t, error, 'team.tpm.renameFailed')); }
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
    void operation().catch(error => setActionError(errorWords(t, error, 'team.tpm.operationFailed')));
  }
  const work = item.work;
  const main = tpmMainTarget(item);
  const mainLabel = mainTitle?.trim() || main.nativeSessionId;
  const identity = session ?? (work.tpmNativeSessionId ? { hostId: item.hostId, providerId: work.providerId, nativeSessionId: work.tpmNativeSessionId, title: work.title } : undefined);
  const projected = identity ? descriptions?.describe(identity) ?? describeSession({ session: identity, tpmWorks: [item], t,
    sessions: [{ ...main, title: mainTitle?.trim() || main.nativeSessionId }] }) : undefined;
  const description = descriptions || !projected ? projected : { ...projected, attributions: projected.attributions.map(attribution => ({
    ...attribution, target: attribution.target?.kind === 'session' && sessionKey(attribution.target) === sessionKey(main) ? attribution.target : undefined,
  })) };
  const unavailable = !item.online || busy;
  const creationUnresolved = work.creationStatus === 'unknown' || work.creationStatus === 'abandoned';
  const archiveLabel = work.archived ? t('team.tpm.restoreSession') : work.phase === 'completed' ? t('team.tpm.archiveSession') : t('team.tpm.stopAndArchive');
  const focusWorkspace = (event: { target: EventTarget }) => {
    if (event.target instanceof Element && event.target.closest('[data-pane-selection-ignore]')) return;
    onFocus?.();
  };
  return <SessionAttributions description={description} onNavigate={descriptions?.navigate ?? onOpenMain}>{({ toggle, details }) => <div className="lab-ask-viewport lab-tpm-viewport" style={{ zIndex: layer }} hidden={!visible}>
    <section ref={panel} className="lab-ask-window lab-tpm-window lab-session-pane-selection" role="dialog" aria-label={t('team.tpm.dialog', { title: work.title })} aria-modal="false" tabIndex={-1}
      data-view-id={sharedView?.id} data-selected={selected || undefined} aria-current={selected || undefined} onPointerDownCapture={focusWorkspace} onFocusCapture={focusWorkspace}>
      <header className="lab-ask-heading lab-tpm-heading"><div className="lab-tpm-heading-title" {...titleInteraction}><span className="lab-tpm-eyebrow">{t('team.tpm.eyebrow', { host: item.hostName })}</span>{onRename ? <button ref={titleButton} type="button" className="lab-tpm-title-button" aria-label={t('team.tpm.renameSession')} title={work.title} disabled={!!unavailable || savingTitle} onClick={() => { setTitleDraft(work.title); setTitleError(undefined); setEditingTitle(true); }}><strong>{work.title}</strong><svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" aria-hidden="true"><path d="m16 3 5 5-12 12-6 1 1-6ZM14 5l5 5" /></svg></button> : <strong title={work.title}>{work.title}</strong>}</div>
        <div className="lab-ask-controls">{toggle}{dockControls ? <SessionHeadingActions sessionKey={item.key} alwaysCollapsed>{dockControls}</SessionHeadingActions> : null}<button type="button" disabled={!!unavailable} aria-label={archiveLabel} title={archiveLabel} onClick={() => run(async () => {
          await onAction(work.archived ? 'unarchive' : 'archive');
          if (!work.archived) onShowList();
        })}><svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="M4 8v12h16V8M3 3h18v5H3z" /><path d={work.archived ? 'M12 17v-6m-3 3 3-3 3 3' : 'M9 12h6'} /></svg></button><button type="button" aria-label={t('team.tpm.backToWorks')} title={t('team.tpm.backToWorksTitle')} onClick={onShowList}>{t('team.tpm.worksButton')}</button><button type="button" aria-label={t('team.tpm.minimize')} title={t('team.tpm.minimize')} onClick={onClose}>×</button></div>
      </header>
      {details}
      {editingTitle ? <form className="lab-tpm-name-editor" onSubmit={event => { event.preventDefault(); void saveTitle(); }} onKeyDown={event => {
        if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); if (!savingTitle) cancelRename(); }
      }}>
        <label>{t('team.tpm.name')}<input ref={titleInput} aria-label={t('team.tpm.sessionName')} maxLength={256} required value={titleDraft} disabled={savingTitle} onChange={event => setTitleDraft(event.target.value)} /></label>
        <div><button type="button" disabled={savingTitle} onClick={cancelRename}>{t('common.cancel')}</button><button type="submit" disabled={savingTitle || !!unavailable || !titleDraft.trim()}>{savingTitle ? t('common.saving') : t('common.save')}</button></div>
        {titleError ? <p role="alert">{titleError}</p> : null}
      </form> : null}
      <div className="lab-tpm-work-status">
        <span className="lab-tpm-phase" data-tpm-phase={work.phase}>{enumWords(t, tpmPhaseWords, work.phase)}</span>
        {work.archived ? <span>{work.phase === 'completed' ? t('team.tpm.archivedMark') : t('team.tpm.stoppedArchived')}</span> : work.paused && work.phase !== 'completed' ? <span>{t('team.tpm.workPaused')}</span> : null}
        {!work.archived && !work.paused && work.phase !== 'completed' ? work.waiting === 'user' ? <span className="lab-tpm-needs-user">{t('team.tpm.waitingForYou')}</span> : work.waiting === 'main_session' ? <span>{t('team.tpm.waitingForMain')}</span> : null : null}
        {work.health ? <span className="lab-tpm-health">{work.health}</span> : null}{!item.online ? <span className="lab-tpm-health">{t('team.tpm.hostOffline')}</span> : null}
        {!description ? <button className="lab-tpm-main-link" type="button" aria-label={t('team.tpm.openMainNamed', { title: mainLabel })} title={`${mainLabel} · ${main.providerId} · ${main.nativeSessionId}`} onClick={onOpenMain}><span>{t('team.tpm.mainLabel')}</span><span className="lab-tpm-main-title">{mainLabel}</span><span aria-hidden="true">↗</span></button> : null}
      </div>
      <nav className="lab-tpm-toolbar" aria-label={t('team.tpm.workView')}>
        <button type="button" aria-pressed={!documentVisible} onClick={() => setDocumentVisible(false)}>{t('team.tpm.conversation')}</button>
        <button type="button" aria-label={t('team.tpm.planAndAcceptance')} aria-pressed={documentVisible} onClick={() => setDocumentVisible(true)}>{t('team.tpm.planAndAcceptance')}</button>
        {work.delegated !== undefined && !work.archived && work.phase !== 'completed' && !work.paused ? <button type="button" className="lab-tpm-delegation" aria-label={t('team.tpm.backgroundDelegation')} aria-pressed={work.delegated !== false}
          title={work.delegated !== false ? t('team.tpm.stopFollowUp') : t('team.tpm.startFollowUp')}
          disabled={unavailable || creationUnresolved} onClick={() => run(() => onAction(work.delegated !== false ? 'undelegate' : 'delegate'))}>{work.delegated !== false ? t('team.tpm.delegated') : t('team.tpm.delegate')}</button> : null}
        {work.phase === 'completed' ? <button className="lab-tpm-reopen" type="button" aria-label={t('team.tpm.reopenWork')} disabled={unavailable || creationUnresolved} onClick={() => run(() => onAction('reopen'))}>{t('team.tpm.reopenWork')}</button> : null}
        {!work.archived && work.paused && work.phase !== 'completed' ? <button className="lab-tpm-reopen" type="button" aria-label={t('team.tpm.resumeWork')} disabled={unavailable || creationUnresolved} onClick={() => run(() => onAction('resume'))}>{t('team.tpm.resumeWork')}</button> : null}

      </nav>
      {work.summary || work.nextAction ? <details className="lab-tpm-progress"><summary title={work.summary || work.nextAction}>{work.summary || work.nextAction}</summary>{work.summary && work.nextAction ? <small>{t('team.tpm.next', { next: work.nextAction })}</small> : null}</details> : null}
      {work.creationStatus === 'unknown' ? <details className="lab-tpm-uncertain" open>
        <summary>{t('team.tpm.uncertainCreation')}</summary>
        <p>{t('team.tpm.creationReceiptLost')}</p>
        <label>{t('team.tpm.verifiedId')}<input aria-label={t('team.tpm.verifiedId')} value={verifiedSessionId} maxLength={128} onChange={event => setVerifiedSessionId(event.target.value)} /></label>
        <div><button type="button" aria-label={t('team.tpm.confirmCreation')} disabled={unavailable || !verifiedSessionId.trim()} onClick={() => run(() => onResolve('creation', 'accepted', verifiedSessionId.trim()))}>{t('team.tpm.bindVerified')}</button>
          <button type="button" aria-label={t('team.tpm.abandonCreation')} disabled={unavailable} onClick={() => run(() => onResolve('creation', 'rejected'))}>{t('team.tpm.abandonWork')}</button></div>
      </details> : null}
      {!work.detailsOmitted && work.outbox?.filter(intent => intent.status === 'unknown').map(intent => <details className="lab-tpm-uncertain" key={intent.id}>
        <summary>{intent.target === 'main' ? t('team.tpm.uncertainMainMessage') : t('team.tpm.uncertainCheck')}</summary>
        <p>{intent.text}</p><small>{intent.error ?? t('team.tpm.deliveryUnconfirmed')}</small>
        <div><button type="button" aria-label={t('team.tpm.markAccepted', { id: intent.id })} disabled={unavailable} onClick={() => run(() => onResolve(intent.id, 'accepted'))}>{t('team.tpm.confirmAccepted')}</button>
          <button type="button" aria-label={t('team.tpm.markRejected', { id: intent.id })} disabled={unavailable} onClick={() => run(() => onResolve(intent.id, 'rejected'))}>{t('team.tpm.confirmNotAccepted')}</button></div>
      </details>)}
      {error || actionError ? <div role="alert" className="lab-ask-error">{actionError ?? error}{error ? <button type="button" disabled={attaching || !item.online} onClick={onRetry}>{work.detailsOmitted ? t('team.tpm.reloadDetails') : t('team.tpm.retryConversation')}</button> : null}</div> : null}
      <article className="lab-tpm-document" aria-label={t('team.tpm.planAndAcceptance')} hidden={!documentVisible}>
        {work.detailsOmitted ? <p role="status">{error ? t('team.tpm.planLoadFailed') : t('team.tpm.planLoading')}</p> : work.document ? <MarkdownContent markdown={work.document} /> : <p>{t('team.tpm.noPlan')}</p>}
        {work.acceptance ? <><h2>{t('team.tpm.acceptance')}</h2><MarkdownContent markdown={work.acceptance} /></> : null}
        {work.evidence.length ? <><h2>{t('team.tpm.evidence')}</h2><ul>{work.evidence.map((evidence, index) => <li key={index}><MarkdownContent markdown={evidence} /></li>)}</ul></> : null}
      </article>
      <div className="lab-tpm-conversation" hidden={documentVisible}>
        {session ? <TpmChat displayBinding={{ scope: storageScope, key: `tpm:${item.key}` }} session={session} replica={replica} transport={transport} draftBinding={draftBinding} navigation={navigation} title={work.title}
          todo={work.todo ? { list: work.todo, disabled: unavailable || work.paused || work.archived, onConfirm: onConfirmTodo,
            context: work.document || work.acceptance ? <details><summary>{t('team.tpm.specification')}</summary><MarkdownContent markdown={`${work.document}\n\n${work.acceptance}`} /></details> : undefined } : undefined} /> : <>
          <div className="lab-ask-opening" role="status">{attaching ? t('team.tpm.opening') : work.creationStatus === 'abandoned' ? t('team.tpm.abandoned') : work.tpmNativeSessionId ? t('team.tpm.conversationUnavailable') : t('team.tpm.notCreated')}</div>
          <TpmDraft binding={draftBinding} />
        </>}
      </div>
      <AskResize label="TPM" />
    </section>
  </div>}</SessionAttributions>;
}

function TpmChat({ session, replica, transport, draftBinding, navigation, title, todo, displayBinding }: {
  displayBinding: { scope: string; key: string };
  session: OpenedSession; replica?: AgentReplica; transport: RemoteAgentTransport; draftBinding: DraftBinding; navigation?: SessionViewNavigationFactory; title: string; todo?: SessionTodoPanelProps;
}) {
  const { state, sessionState, status, actions, questions, setQuestions, imageRecipient, operationBinding } = useConversationSession(session, transport, replica, false, { nativePrefixOnly: true });
  const { communication, ...viewNavigation } = navigation?.(session, state) ?? {};
  return <CommunicationNavigationContext.Provider value={communication}><LabWorkbench showAttributions={false} displayBinding={displayBinding} todo={todo} headingMode="toolbar" {...viewNavigation}
    state={state} sessionState={sessionState} sessionStatus={status} attachingAgentId={operationBinding.source.agentId} actions={actions} operationBinding={operationBinding}
    draftSessionKey={sessionKey(session)} draftBinding={draftBinding} imageRecipient={imageRecipient} questionDrafts={questions}
    onQuestionDraftChange={(id, value) => setQuestions(current => ({ ...current, [id]: value }))}
    conversationPath={<strong className="agent-session-title" data-session-status={state?.agent?.status}>{title}</strong>} />
  </CommunicationNavigationContext.Provider>;
}
function TpmDraft({ binding }: { binding: DraftBinding }) {
  const t = useTranslate();
  const draft = useBoundDraft(binding);
  return <textarea className="lab-ask-draft" aria-label={t('team.tpm.draft')} rows={2} placeholder={t('team.tpm.draftPlaceholder')} value={draft.text ?? ''} onChange={event => draft.set(event.target.value)} />;
}
