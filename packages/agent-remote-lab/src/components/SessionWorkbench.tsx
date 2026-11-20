import type { ImageDraftBinding, ImageDraftRecipient } from '@orchardworks/agent-client-web/browser';
import { assistantStatus, isUncertainSend, sessionFiles, timelineEntryKey, remoteSessionState, sessionActivityLabel, sessionNotice, sessionNoticeWords, type RemoteSessionState, type SessionDescription, type SessionAttribution, type SessionFacts, type SessionNotice } from '@orchardworks/agent-client';
import { SessionControlNotice } from './SessionControlNotice.js';
import { SessionViewFrame } from './SessionViewFrame.js';
import { useFeedbackToast, useToastAnchor } from './Toast.js';
import type { ImageUploadReceipt, MessagePart, ResourceResponseState } from '@orchardworks/agent-remote-protocol';
import type { AgentCommand, AgentCommandResult, AgentMessageOptions } from '@orchardworks/agent-remote-protocol';
import { memo, useContext, useEffect, useId, useLayoutEffect, useMemo, useRef, useState, type ComponentProps, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import type {
  AgentInteractionResponse,
  ResourceBinding,
} from '@orchardworks/agent-remote-protocol';
import type { AgentReplicaState, RemoteSessionStatus, SessionHandoffState } from '@orchardworks/agent-client';
import { SessionAttributions, AgentCommandDetails, AgentTimeline, ProcessModeContext, type AgentTimelineProps, type TimelineEntrySelection, TimelineSearch, PreviewDock, TimelineLettersVisible, type AgentChildSessionView, type QuestionDraft, type SessionLinkResolver } from '@orchardworks/agent-client-web/react';


import { AgentComposer as DraftComposer, type SessionViewActions, type TimelineReadingPositions } from '@orchardworks/agent-client-web/react';

import { PlanningControl } from './PlanningControl.js';
import { SessionViewOptions } from './SessionViewOptions.js';
import { useLettersVisible, useProcessMode, type ProcessAssistant } from '../hooks/useProcessMode.js';
import { SessionTodoPanel, type SessionTodoPanelProps } from '@orchardworks/agent-client-web/react';
import { SessionHeading } from './SessionHeading.js';
import { SessionHeadingActionsPresentationContext } from './SessionHeadingActions.js';
import { SessionTimelineTools } from './SessionTimelineTools.js';
import { IconButton } from '../ui/IconButton.js';

import { useTimelineScroll } from '../hooks/useTimelineScroll.js';
import { AssistantDetailsHostContext, type AssistantDetailsHost } from './assistant/details-host.js';
import { TileHeader } from './assistant/TileHeader.js';
import { usePhoneLayout } from '../hooks/usePhoneLayout.js';
import { AssistantDetails, type AssistantRef } from './assistant/AssistantDetails.js';
import { ModelSettings } from './assistant/ModelSettings.js';
import { FilePreviewContext, useTranslate } from '@orchardworks/agent-client-web/react';


import type { TraceEntryRequest } from '../trace-model.js';

export type LabWorkbenchActions = SessionViewActions;

export function SessionWorkbench({ assistant, details, conversationTitle, sessionDescription, onNavigateAttribution, todo, processAssistant, sessionState: suppliedSessionState, handoff, workspaceLink, readingPositions: suppliedReadingPositions, draftScope, imageDraftBinding, imageRecipient, isAuthenticationError = noAuthenticationError, authenticationNotice, renderSessionSettingError, renderCommandError, readOnly: recordingReadOnly = false, draftOnly = false, opening = false, mutationBlocked = false, pendingFirstInputContext, onPendingInputChange, onInspectEntry, revealEntry, state, sessionStatus: connectionStatus, attachingAgentId, actions: suppliedActions, visible = true, questionDrafts, onQuestionDraftChange, messageDraft, draftSessionKey, onMessageDraftChange, onOpenChildSession, childrenFor, resolveSessionLink, conversationPath, headingStart, headingMode = 'inline', sessionManager, headingContext, composerContext, composerNotice, composerStatus, nativeTakeover, consoleCommands, onExecuteConsoleCommand, entrySelection, timelineStart, timelineEnd, sendLater, loadingNotice, host }: { entrySelection?: TimelineEntrySelection;
  /** Who answers in this conversation: the live line's name and the avatar at the foot of the answers. */
  assistant?: AgentTimelineProps['assistant'];
  /** What the assistant's details show beyond this conversation's own process mode, settings and files: who it is, where it works, its sessions. */
  details?: Partial<AssistantRef>;
  /** The session's title as words; a tile shows it beside the assistant's name when it differs from the name. */
  conversationTitle?: string;
  /** The bot this conversation is, when it is one: the view options choose its own process mode. */
  processAssistant?: ProcessAssistant;
  /** The session's Host as the Relay last said: an offline Host is said once, and the composer stays enabled. */
  host?: SessionFacts['host'];
  /** Said in place of Opening session while the conversation cannot load yet, for example because its Host is offline. */
  loadingNotice?: { title: string; detail: string };
  /** This is a stand-in for a session whose Window is still loading: plain messages typed into it wait for the pane that replaces it. */
  opening?: boolean;
  /** Sends from a draft-only composer whose Host is offline: the message waits for the Host. */
  sendLater?: ComponentProps<typeof DraftComposer>['sendLater'];
  /** Content above this conversation's own entries once its oldest page is loaded: a bot's earlier sessions after a handoff. */
  timelineStart?: ReactNode; timelineEnd?: ReactNode; sessionDescription?: SessionDescription; onNavigateAttribution?(attribution: SessionAttribution): void | Promise<void>; todo?: SessionTodoPanelProps; sessionState?: RemoteSessionState; handoff?: SessionHandoffState; readOnly?: boolean; draftOnly?: boolean; mutationBlocked?: boolean; pendingFirstInputContext?: ComponentProps<typeof DraftComposer>['pendingFirstInputContext']; onPendingInputChange?(count: number): void; workspaceLink?: ReactNode; readingPositions?: TimelineReadingPositions; draftScope?: string; imageDraftBinding?: ImageDraftBinding; imageRecipient?: ImageDraftRecipient; isAuthenticationError?(error: unknown): boolean; authenticationNotice?: ReactNode; renderSessionSettingError?(error: unknown): ReactNode; renderCommandError?(error: unknown): ReactNode; onInspectEntry?: (key: string) => void; revealEntry?: TraceEntryRequest; composerContext?: ReactNode; composerNotice?: ReactNode; composerStatus?: ReactNode; headingContext?: ReactNode; nativeTakeover?: ReactNode; consoleCommands?: readonly (AgentCommand & { aliases?: readonly string[] })[]; onExecuteConsoleCommand?(id: string, args: string): Promise<AgentCommandResult>; state?: AgentReplicaState; sessionStatus: RemoteSessionStatus; attachingAgentId?: string; actions: LabWorkbenchActions; conversationPath?: ReactNode; headingStart?: ReactNode;
  /**
   * `assistant`: the assistant view's top bar is the heading, and this conversation puts its search there. `tile`: a Window
   * tile, whose heading is the assistant's (avatar, name, the session's title and a sentence), its details opening over the window.
   */
  headingMode?: 'inline' | 'toolbar' | 'assistant' | 'tile'; sessionManager?: ReactNode; resolveSessionLink?: SessionLinkResolver; childrenFor?: (nativeSessionId: string) => readonly AgentChildSessionView[]; onOpenChildSession?: (child: AgentChildSessionView) => void | Promise<void>; visible?: boolean; draftSessionKey?: string; messageDraft?: string; onMessageDraftChange?(text: string): void; questionDrafts?: Readonly<Record<string, QuestionDraft>>; onQuestionDraftChange?: (requestId: string, draft: QuestionDraft) => void }) {
  const displayScope = draftSessionKey ?? state?.agent?.runtimeInfo.sessionId ?? attachingAgentId;
  const providedHost = useContext(AssistantDetailsHostContext);
  const assistantChrome = headingMode === 'assistant', tileChrome = headingMode === 'tile';
  // A tile opens its assistant's details over the window, or as a sheet on a phone.
  const phone = usePhoneLayout();
  const [tileDetailsOpen, setTileDetailsOpen] = useState(false);
  const [tileDetailsSlot, setTileDetailsSlot] = useState<HTMLElement | null>(null);
  const tileDetailsId = useId();
  const detailsHost: AssistantDetailsHost | undefined = providedHost ?? (tileChrome ? { surface: phone ? 'sheet' : 'panel', slot: tileDetailsSlot, open: tileDetailsOpen,
    setOpen: setTileDetailsOpen } : undefined);
  const process = useProcessMode(processAssistant);
  const [lettersVisible, setLettersVisible] = useLettersVisible();
  const session = suppliedSessionState ?? remoteSessionState(state, connectionStatus);
  const sessionStatus = session.connection;
  const controlReadOnly = !!nativeTakeover || (!draftOnly && session.readOnly);
  const readOnly = recordingReadOnly || controlReadOnly;
  // The composer presents failures of its own setting and command controls where they happen.
  const { actions: suppliedFeedbackActions, reauthenticate } = useActionFeedback(suppliedActions, state?.agent?.id, isAuthenticationError,
    renderCommandError ? ['Change session setting', 'Run command'] : ['Change session setting']);
  const actions: LabWorkbenchActions = draftOnly ? {} : readOnly || mutationBlocked ? { searchTimeline: suppliedFeedbackActions.searchTimeline, loadSearchMatch: suppliedFeedbackActions.loadSearchMatch, loadOlder: suppliedFeedbackActions.loadOlder, requestResource: suppliedFeedbackActions.requestResource, resolveResource: suppliedFeedbackActions.resolveResource, deleteMessage: suppliedFeedbackActions.deleteMessage } : session.synchronized ? { ...suppliedFeedbackActions,
    retryMessage: session.operations.send_message.allowed ? suppliedFeedbackActions.retryMessage : undefined,
    editPrompt: session.operations.send_message.allowed ? suppliedFeedbackActions.editPrompt : undefined,
    cancel: session.operations.cancel.allowed ? suppliedFeedbackActions.cancel : undefined,
    setPlanning: session.operations.set_planning.allowed ? suppliedFeedbackActions.setPlanning : undefined,
    setSessionSetting: session.operations.set_session_setting.allowed ? suppliedFeedbackActions.setSessionSetting : undefined,
    executeCommand: session.operations.execute_command.allowed ? suppliedFeedbackActions.executeCommand : undefined,
    respondToInteraction: session.operations.interaction_response.allowed ? suppliedFeedbackActions.respondToInteraction : undefined,
  } : { deleteMessage: suppliedFeedbackActions.deleteMessage };
  const localPositions = useMemo(() => new Map(), []);
  const readingPositions = suppliedReadingPositions ?? localPositions;
  const [composerHidden, setComposerHidden] = useState(false);
  const composerId = useId();
  const [timelineToolsTarget, setTimelineToolsTarget] = useState<HTMLDivElement | null>(null);
  const [headingSearchTarget, setHeadingSearchTarget] = useState<HTMLSpanElement | null>(null);
  const toastAnchor = useToastAnchor(visible && !!state?.agent && !composerHidden);
  const composerTouchBoundary = useRef<HTMLDivElement>(null);
  const toastToggleAnchor = useToastAnchor<HTMLButtonElement>(visible && !!state?.agent);
  const [inspected, setInspected] = useState<{ agentId: string; command: AgentCommand }>();
  const selectedCommand = inspected?.agentId === state?.agent?.id ? inspected?.command : undefined;
  const hasReplica = state !== undefined;
  const nativeFailure = state?.agent?.runtimeInfo.failure;
  const failureInTimeline = !!nativeFailure?.turnId && state?.timeline.entries.some(entry =>
    entry.turnId === nativeFailure.turnId && entry.item.type === 'error' && entry.item.message === nativeFailure.message);
  const runtimeMutationDisabled = mutationBlocked || !session.operations.interaction_response.allowed;
  // The one business notice of the session (target T5), said once: above the timeline for a refused, failed or unavailable
  // session, in the composer's context for an offline Host, and by the composer's control notice for a read-only lease.
  const facts: SessionFacts = { session, host, replica: state };
  const notice = sessionNotice(facts);
  const activity = session.activity;
  const activityLabel = sessionActivityLabel(facts) ?? '';
  const timelineNotice = notice && (notice.kind === 'unavailable' || notice.kind === 'agent_unavailable' || notice.kind === 'failed' && !failureInTimeline) ? notice : undefined;
  const hasTarget = (draftSessionKey ?? attachingAgentId) !== undefined;
  const hostNotice = notice?.kind === 'host_offline' && !(state === undefined && loadingNotice) ? sessionNoticeWords(notice) : undefined;
  const viewOptions = <SessionViewOptions key={displayScope} process={process} lettersVisible={lettersVisible} onLettersVisibleChange={setLettersVisible} />;
  // The assistant's details: what its place and its presentation know, with this conversation's process mode, settings and files.
  const t = useTranslate();
  const filePreview = useContext(FilePreviewContext);
  const detailsShown = !!detailsHost?.open && visible && (detailsHost.surface === 'sheet' || !!detailsHost.slot);
  const files = useMemo(() => detailsShown && state ? sessionFiles(state.timeline.entries) : [], [detailsShown, state?.timeline.entries]);
  const reportedSession = state?.agent?.runtimeInfo.sessionId;
  const assistantRef: AssistantRef | undefined = detailsShown ? {
    id: details?.id ?? displayScope ?? 'assistant', name: details?.name ?? assistant?.name ?? t('conversation.assistant'), ...details,
    ...(detailsHost?.actions ? { actions: detailsHost.actions } : {}), ...(detailsHost?.where ? { where: detailsHost.where } : {}),
    ...(detailsHost?.setPicture ? { setPicture: detailsHost.setPicture } : {}),
    process, letters: { visible: lettersVisible, set: setLettersVisible },
    sessions: { ...details?.sessions, ...(state?.agent?.cwd ? { directory: state.agent.cwd } : {}), ...(reportedSession ? { sessionId: reportedSession } : {}),
      subagents: reportedSession ? childrenFor?.(reportedSession) ?? [] : [], ...(onOpenChildSession ? { openSubagent: onOpenChildSession } : {}),
      tools: <>{details?.sessions?.tools}{workspaceLink}</> },
    ...(state?.agent && !draftOnly ? { settings: <ModelSettings state={state} sessionState={session} readOnly={readOnly || mutationBlocked}
      {...(actions.setSessionSetting ? { onSelect: (id: string, value: string) => actions.setSessionSetting!(id, value) } : {})} {...(renderSessionSettingError ? { renderError: renderSessionSettingError } : {})}
      planning={<PlanningControl sessionState={session} key={state.agent.id} state={state} sessionStatus={sessionStatus} onSetPlanning={actions.setPlanning} />} /> } : {}),
    files, ...(filePreview && state ? { openFile: (file, trigger) => {
      const entry = state.timeline.entries.find(item => timelineEntryKey(item) === file.entryKey);
      filePreview.open({ locator: file.path, returnFocus: trigger, context: { scopeKey: JSON.stringify([state.agent?.id, file.entryKey]), bindings: entry?.resources ?? [],
        resources: state.resources, ...(actions.resolveResource ? { resolveResource: actions.resolveResource } : {}), ...(actions.requestResource ? { requestResource: actions.requestResource } : {}) } });
    } } : {}),
  } : undefined;
  const detailsPanel = assistantRef && detailsHost ? <AssistantDetails assistant={assistantRef} surface={detailsHost.surface} onClose={() => detailsHost.setOpen(false)} /> : null;
  const layoutClass = [todo ? 'lab-workbench-with-todo' : '', selectedCommand ? 'lab-command-details-open' : '', headingMode !== 'inline' ? 'lab-workbench-toolbar-heading' : ''].filter(Boolean).join(' ');
  return <ProcessModeContext.Provider value={process.mode}><TimelineLettersVisible.Provider value={lettersVisible}>
    <SessionAttributions description={sessionDescription} onNavigate={onNavigateAttribution}>{({ toggle, details }) => <SessionViewFrame className={layoutClass}>
    {assistantChrome ? null : <div className="lab-workbench-heading-group" hidden={headingMode === 'toolbar' && !headingContext && !details}>
    {tileChrome ? <TileHeader name={assistant?.name ?? t('conversation.assistant')} avatar={assistant?.avatar} title={conversationPath} titleText={conversationTitle}
      status={assistantStatus({ activity: activity ?? 'unknown', ...(host ? { host } : {}), asleep: false, waitingToSend: false, ...(notice ? { notice } : {}) }, t)}
      detailsOpen={tileDetailsOpen} detailsId={tileDetailsId} onToggleDetails={() => setTileDetailsOpen(open => !open)}
      trailing={<>{sessionManager}<span className="lab-heading-search-slot" ref={setHeadingSearchTarget} />{toggle}</>} />
    : <SessionHeading hidden={headingMode === 'toolbar'}
      leading={headingMode === 'inline' ? <>{headingStart}{workspaceLink}{viewOptions}<span className="lab-heading-search-slot" ref={setHeadingSearchTarget} /></> : undefined}
      trailing={headingMode === 'inline' ? <>{sessionManager}<span className="lab-conversation-status">{activityLabel}</span></> : undefined}>
        {conversationPath}
        <h2 hidden={!!conversationPath} className="agent-session-title" data-session-status={activity}>{hasReplica || hasTarget ? 'Conversation' : 'Ready for a session'}</h2>
        {headingMode === 'inline' ? toggle : null}
    </SessionHeading>}
    {details}
    {headingContext}
    </div>}
    {todo ? <SessionTodoPanel key={displayScope} {...todo} disabled={todo.disabled || readOnly || mutationBlocked} /> : null}
    <PreviewDock sessionId={state?.agent?.id ?? attachingAgentId} />
    <WorkbenchTimeline toolsTargetRef={setTimelineToolsTarget} toolsCollapsible={headingMode === 'toolbar'} toolsScope={displayScope}
      searchTriggerTarget={headingMode === 'inline' || tileChrome ? headingSearchTarget : assistantChrome ? detailsHost?.tools ?? null : undefined} nativeTakeover={!!nativeTakeover} readOnly={readOnly} state={state} sessionStatus={sessionStatus} attachingAgentId={attachingAgentId}
      visible={visible} readingPositions={readingPositions} actions={actions} revealEntry={revealEntry}
      notice={timelineNotice} hasTarget={hasTarget} runtimeMutationDisabled={runtimeMutationDisabled}
      onInspectEntry={onInspectEntry} onOpenChildSession={onOpenChildSession} childrenFor={childrenFor} resolveSessionLink={resolveSessionLink}
      questionDrafts={questionDrafts} onQuestionDraftChange={onQuestionDraftChange} entrySelection={entrySelection} timelineStart={timelineStart} timelineEnd={timelineEnd} loadingNotice={loadingNotice} assistant={assistant} />
    {headingMode === 'toolbar' && timelineToolsTarget ? createPortal(<SessionHeadingActionsPresentationContext.Provider value="inline">{workspaceLink}{sessionManager}{viewOptions}{toggle}</SessionHeadingActionsPresentationContext.Provider>, timelineToolsTarget) : null}
    <div className="lab-composer-region">
    {composerStatus}
    <div ref={toastAnchor} className="lab-composer-dock" hidden={!state?.agent && !nativeTakeover && !draftOnly && !hasTarget} data-collapsed={composerHidden || undefined}>
      <div className="lab-composer-context" hidden={composerHidden}>
        {hostNotice ? <p className="lab-composer-host-notice" role="status">{hostNotice}</p> : null}
        {composerContext}
        {composerNotice}
        {reauthenticate ? authenticationNotice : null}
      </div>
      <div ref={composerTouchBoundary} className="lab-composer-input-shell">
        <button ref={toastToggleAnchor} type="button" className="lab-composer-toggle" aria-controls={composerId} aria-expanded={!composerHidden}
          aria-label={composerHidden ? 'Show message input' : 'Hide message input'} title={composerHidden ? 'Show message input' : 'Hide message input'}
          onClick={() => setComposerHidden(hidden => !hidden)}>
          <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
            <path d={composerHidden ? 'm7 14 5-5 5 5' : 'm7 10 5 5 5-5'} />
          </svg>
        </button>
        <div id={composerId} className="lab-composer-body" hidden={composerHidden && !controlReadOnly}>
          <DraftComposer
            keyboardDismissBoundaryRef={composerTouchBoundary}
            settings={assistantChrome || tileChrome ? 'none' : 'inline'}
            sessionState={session}
            host={host}
            draftOnly={draftOnly}
            opening={opening}
            mutationBlocked={mutationBlocked}
            onPendingInputChange={onPendingInputChange}
            pendingFirstInputContext={pendingFirstInputContext}
            readOnly={readOnly}
            readOnlyCollapsed={composerHidden}
            readOnlyLabel={controlReadOnly && !recordingReadOnly ? 'Read only' : undefined}
            readOnlyNotice={nativeTakeover ?? (!draftOnly && !recordingReadOnly && controlReadOnly && state?.sessionControl ? <SessionControlNotice handoff={handoff ?? session.handoff} control={state.sessionControl} connected={sessionStatus === 'ready'} onTakeControl={suppliedActions.takeControl} /> : undefined)}
            consoleCommands={!readOnly && !mutationBlocked && sessionStatus === 'ready' ? consoleCommands : []}
            onExecuteConsoleCommand={!readOnly && !mutationBlocked && sessionStatus === 'ready' ? onExecuteConsoleCommand : undefined}
            sessionControls={state?.agent && !draftOnly ? <PlanningControl sessionState={session} key={state.agent.id} state={state} sessionStatus={sessionStatus} onSetPlanning={actions.setPlanning} /> : null}
            state={state}
            sessionKey={draftSessionKey ?? state?.agent?.id}
            draftScope={draftScope}
            imageDraftBinding={imageDraftBinding} imageRecipient={imageRecipient}
            visible={visible}
            activityVisible={visible && !composerHidden}
            onSendMessageContent={readOnly || mutationBlocked ? undefined : suppliedFeedbackActions.sendMessageContent}
            onUploadResource={visible ? actions.uploadResource : undefined}
            onUploadImage={visible ? actions.uploadImage : undefined}
            draft={messageDraft}
            onDraftChange={onMessageDraftChange}
            onSendMessage={readOnly || mutationBlocked ? undefined : suppliedFeedbackActions.sendMessage}
            sendLater={readOnly ? undefined : sendLater}
            onCancel={actions.cancel}
            onSetSessionSetting={actions.setSessionSetting}
            renderSessionSettingError={renderSessionSettingError}
            renderCommandError={renderCommandError}
            onListCommands={actions.listCommands}
            onExecuteCommand={actions.executeCommand}
            onRequestResource={actions.requestResource}
            onResolveResource={actions.resolveResource}
            onInspectCommand={(command) => { if (state?.agent) setInspected({ agentId: state.agent.id, command }); }}
          />
        </div>
      </div>
    </div>
    </div>
    {selectedCommand && state ? <AgentCommandDetails key={`${state.agent?.id}:${selectedCommand.id}`} command={selectedCommand} resources={state.resources}
      onRequestResource={actions.requestResource} onResolveResource={actions.resolveResource}
      resourceScopeKey={JSON.stringify([state.agent?.id, selectedCommand.id])}
      onClose={() => setInspected(undefined)} /> : null}
    {tileChrome && !phone ? <aside ref={setTileDetailsSlot} id={tileDetailsId} className="lab-tile-details orchard-panel" aria-label={t('details.title')} hidden={!tileDetailsOpen}>
      <header className="lab-assistant-details-head"><h2>{t('details.title')}</h2>
        <IconButton icon="close" label={t('details.close')} onClick={() => setTileDetailsOpen(false)} /></header>
    </aside> : null}
    {detailsPanel && detailsHost?.surface === 'panel' && detailsHost.slot ? createPortal(detailsPanel, detailsHost.slot) : detailsPanel}
  </SessionViewFrame>}</SessionAttributions></TimelineLettersVisible.Provider></ProcessModeContext.Provider>;
}


const noAuthenticationError = () => false;
/** Stream capacity explains what frees a slot, and a paused session says how it resumes; other interruptions only reconnect. */
function useActionFeedback(actions: LabWorkbenchActions, sessionId: string | undefined, isAuthenticationError: (error: unknown) => boolean, presentedInline: readonly string[]): { actions: LabWorkbenchActions; reauthenticate: boolean } {
  const activeSession = useRef(sessionId);
  activeSession.current = sessionId;
  const [failure, setFailure] = useState<{ title: string; message: string; reauthenticate: boolean }>();
  useFeedbackToast(failure?.title ?? 'Session action', failure?.reauthenticate ? undefined : failure?.message);
  useEffect(() => setFailure(undefined), [sessionId]);
  /** `recorded` tells the failures the conversation shows itself, which need no toast. */
  function report<Args extends unknown[], Result>(title: string, action: ((...args: Args) => Result) | undefined, recorded: (error: unknown) => boolean = () => false) {
    return action ? async (...args: Args): Promise<Awaited<Result>> => {
      setFailure(undefined);
      try { return await action(...args); }
      catch (error) {
        if (activeSession.current === sessionId && !recorded(error)) setFailure({ title, message: error instanceof Error ? error.message : 'The action could not be confirmed. Check its status before retrying.', reauthenticate: isAuthenticationError(error) });
        throw error;
      }
    } : undefined;
  }
  // An uncertain send stays on its outgoing message, which says in plain words what to check and what Retry does next.
  const reportedActions = useMemo(() => ({ ...actions,
    sendMessage: report('Send message', actions.sendMessage, isUncertainSend), sendMessageContent: report('Send message', actions.sendMessageContent, isUncertainSend),
    retryMessage: report('Retry message', actions.retryMessage, isUncertainSend),
    steer: report('Steer session', actions.steer), cancel: report('Stop work', actions.cancel),
    respondToInteraction: report('Submit response', actions.respondToInteraction),
    setPlanning: report('Change session mode', actions.setPlanning), setSessionSetting: report('Change session setting', actions.setSessionSetting),
    listCommands: report('Load commands', actions.listCommands), executeCommand: report('Run command', actions.executeCommand),
    loadOlder: report('Load conversation history', actions.loadOlder),
    editPrompt: report('Edit prompt', actions.editPrompt),
  }), [actions, sessionId]);
  return { actions: reportedActions, reauthenticate: failure?.reauthenticate === true && !presentedInline.includes(failure.title) };
}

const WorkbenchTimeline = memo(function WorkbenchTimeline({ nativeTakeover, readOnly, state, sessionStatus, attachingAgentId, visible, readingPositions, actions, revealEntry,
  notice, hasTarget, runtimeMutationDisabled, onInspectEntry, onOpenChildSession, childrenFor, resolveSessionLink,
  questionDrafts, onQuestionDraftChange, toolsTargetRef, toolsCollapsible, toolsScope, searchTriggerTarget, entrySelection, timelineStart, timelineEnd, loadingNotice, assistant }: Pick<Parameters<typeof SessionWorkbench>[0], 'readOnly' | 'state' | 'sessionStatus' | 'attachingAgentId' | 'visible' | 'actions' | 'revealEntry' | 'onInspectEntry' | 'onOpenChildSession' | 'childrenFor' | 'resolveSessionLink' | 'questionDrafts' | 'onQuestionDraftChange' | 'timelineStart' | 'timelineEnd' | 'entrySelection' | 'loadingNotice' | 'assistant'> & {
    readingPositions: NonNullable<Parameters<typeof useTimelineScroll>[2]>; toolsTargetRef(node: HTMLDivElement | null): void; toolsCollapsible: boolean; toolsScope?: string;
    /** The session's notice when it belongs above the timeline: refused, failed or unavailable. */
    notice?: SessionNotice;
    /** The view has a session to show, resolved or not: the empty state is only for a view with none. */
    hasTarget: boolean;
    /** A visible heading hosts the search trigger so it never covers Timeline content; null until it mounts. */
    searchTriggerTarget?: HTMLElement | null;
    runtimeMutationDisabled: boolean; nativeTakeover?: boolean;
  }) {
  const searchScope = JSON.stringify([state?.agent?.id, state?.timeline.epoch]);
  const [openSearchScope, setOpenSearchScope] = useState<string>();
  const [searchSelection, setSearchSelection] = useState<{ scope: string; key: string; request: number }>();
  const searchTrigger = useRef<HTMLButtonElement>(null);
  const searchOpen = !!visible && !!state?.timeline.initialized && openSearchScope === searchScope;
  const selectedSearchKey = searchSelection?.scope === searchScope ? searchSelection.key : undefined;
  function closeSearch(options?: { restoreFocus?: boolean }) {
    setOpenSearchScope(undefined);
    setSearchSelection(undefined);
    if (options?.restoreFocus !== false) requestAnimationFrame(() => searchTrigger.current?.focus({ preventScroll: true }));
  }
  const display = useContext(ProcessModeContext);
  const lettersVisible = useContext(TimelineLettersVisible);
  useLayoutEffect(() => { setSearchSelection(undefined); }, [lettersVisible]);
  const contentRevision = useMemo(() => ({}), [state, display, lettersVisible, notice, questionDrafts, childrenFor]);
  const scroll = useTimelineScroll(JSON.stringify([state?.agent?.id]), visible, readingPositions, undefined,
    actions.loadOlder ? { hasOlder: state?.timeline.hasOlder === true, cursor: state?.timeline.entries[0]?.seqStart.toString(), load: actions.loadOlder } : undefined, contentRevision, 'bottom');
  const consumedReveal = useRef<string>();
  useLayoutEffect(() => {
    if (!visible || !revealEntry) return;
    const request = JSON.stringify([state?.agent?.id, state?.timeline.epoch, revealEntry.requestId]);
    if (consumedReveal.current !== request && scroll.revealEntry(revealEntry.key, revealEntry.align)) consumedReveal.current = request;
  }, [visible, revealEntry, state?.agent?.id, state?.timeline.epoch, state?.timeline.entries, display, lettersVisible]);
  // The search panel floats over the top of the timeline. While it shows a chosen result, the timeline gets that much room
  // above its oldest entry, so that the result is revealed below the panel, the first one included. Opening the panel and
  // searching leave the reading position alone.
  const stage = useRef<HTMLDivElement>(null);
  const searchInset = () => {
    const panel = stage.current?.querySelector<HTMLElement>('.lab-timeline-controls > .agent-session-search');
    const timeline = scroll.viewportRef.current;
    if (!panel || !timeline) return 0;
    return Math.max(0, Math.ceil(panel.getBoundingClientRect().bottom - timeline.getBoundingClientRect().top));
  };
  const applySearchInset = () => {
    const inset = searchOpen && selectedSearchKey ? searchInset() : 0;
    if (inset) stage.current?.style.setProperty('--lab-search-inset', `${inset}px`);
    else stage.current?.style.removeProperty('--lab-search-inset');
    return inset;
  };
  useLayoutEffect(() => {
    applySearchInset();
    const panel = stage.current?.querySelector('.lab-timeline-controls > .agent-session-search');
    if (!searchOpen || !selectedSearchKey || !panel || typeof ResizeObserver === 'undefined') return;
    const observer = new ResizeObserver(() => { applySearchInset(); });
    observer.observe(panel);
    return () => observer.disconnect();
  }, [searchOpen, selectedSearchKey]);
  useLayoutEffect(() => {
    if (visible && selectedSearchKey) scroll.revealEntry(selectedSearchKey, 'center', applySearchInset());
  }, [visible, selectedSearchKey, searchSelection?.request]);
  const hasReplica = state !== undefined;
  const isAttaching = !hasReplica && hasTarget;
  const searchButton = state?.timeline.initialized ? <button ref={searchTrigger} type="button" className="lab-timeline-search-trigger"
    hidden={searchOpen && !searchTriggerTarget} aria-label="Search this session" title="Search this session" aria-expanded={searchOpen}
    onClick={() => { if (searchOpen) closeSearch(); else setOpenSearchScope(searchScope); }}>
    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" aria-hidden="true"><circle cx="10.5" cy="10.5" r="6.5" /><path d="m16 16 5 5" /></svg>
  </button> : null;
  return <div ref={stage} className="lab-timeline-stage" onKeyDownCapture={event => {
      if (event.target instanceof Node && !event.currentTarget.contains(event.target)) return;
      if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 'f' && state?.timeline.initialized) {
        event.preventDefault(); event.stopPropagation(); setOpenSearchScope(searchScope);
      }
    }}>
      <SessionTimelineTools key={toolsScope} collapsible={toolsCollapsible} searchOpen={searchOpen} timelineRef={scroll.viewportRef} onDismissSearch={() => closeSearch({ restoreFocus: false })}
        searchPanel={searchOpen && state ? <TimelineSearch key={searchScope} state={state} search={actions.searchTimeline} onClose={closeSearch} onClearSelection={() => setSearchSelection(undefined)}
          onSelect={async (match, signal) => {
            if (actions.loadSearchMatch) await scroll.loadOlder(() => actions.loadSearchMatch!(match, { signal }));
            else if (!state.timeline.entries.some(entry => entry.seqStart === match.seq)) throw new Error('This result loads when the session is ready.');
            signal.throwIfAborted();
            setSearchSelection(previous => ({ scope: searchScope, key: match.key, request: (previous?.request ?? 0) + 1 }));
          }} /> : null}>
      {searchTriggerTarget === undefined ? <>
        <div className="lab-timeline-session-tools" ref={toolsTargetRef} />
        {searchButton}
      </> : null}
      </SessionTimelineTools>
      {searchTriggerTarget && searchButton ? createPortal(searchButton, searchTriggerTarget) : null}
      <div className="lab-timeline-scroll" data-testid="timeline" ref={scroll.viewportRef} tabIndex={0} onScroll={scroll.onScroll} onWheel={scroll.onWheel} onPointerDown={scroll.onPointerDown} onKeyDown={scroll.onKeyDown} onFocus={scroll.onFocus} onTouchStart={scroll.onTouchStart} onTouchMove={scroll.onTouchMove}>
        <div className="lab-conversation-content" ref={scroll.contentRef}>
          {hasReplica ? <>
            {notice ? <p className="lab-control-note" role="alert">{sessionNoticeWords(notice)}</p> : null}
            <AgentTimeline
              state={state}
              assistant={assistant}
              onEditPrompt={actions.editPrompt}
              onRetryMessage={actions.retryMessage}
              onDeleteMessage={actions.deleteMessage}
              onInspectEntry={onInspectEntry}
              inspectedEntryKey={revealEntry?.key}
              inspectedRequestId={revealEntry?.requestId}
              searchEntryKey={selectedSearchKey}
              searchRequestId={searchSelection?.request}
              historyLoading={scroll.historyLoading}
              historyError={scroll.historyError}
              onOpenChildSession={onOpenChildSession}
              childrenFor={childrenFor}
              resolveSessionLink={resolveSessionLink}
              onLoadOlder={actions.loadOlder ? () => scroll.loadOlder(actions.loadOlder!) : undefined}
              onInteractionResponse={actions.respondToInteraction}
              interactionsReadOnly={readOnly}
              interactionsWaitingForConnection={!readOnly && (sessionStatus !== 'ready' || runtimeMutationDisabled)}
              interactionDisabled={sessionStatus !== 'ready' || runtimeMutationDisabled}
              onDownloadResource={actions.downloadResource}
              onResourceRequest={actions.requestResource}
              onResourceResolve={actions.resolveResource}
              questionDrafts={questionDrafts}
              onQuestionDraftChange={onQuestionDraftChange}
              entrySelection={entrySelection}
              timelineStart={timelineStart}
              timelineEnd={timelineEnd}
            />
          </> : nativeTakeover ? null : isAttaching ? <>
            {/* A conversation that is still opening shows nothing until its rows exist, unless something must be said (a Host that is away). */}
            {loadingNotice ? <div className="lab-empty-state">
              <span className="lab-empty-icon" aria-hidden="true">↗</span>
              <h3>{loadingNotice.title}</h3>
              <p>{loadingNotice.detail}</p>
            </div> : null}
            {/* What follows the conversation (messages waiting for an offline Host) shows before it loads too. */}
            {timelineEnd ? <div className="agent-timeline-entries lab-timeline-end">{timelineEnd}</div> : null}
          </> : <div className="lab-empty-state">
            <span className="lab-empty-icon" aria-hidden="true">↗</span>
            <h3>Start with a Provider</h3>
            <p>Open a registered Agent to observe its Timeline, interactions, and durable resources.</p>
          </div>}
        </div>
      </div>
      {scroll.showLatest ? <button className="lab-back-to-latest" type="button" onClick={scroll.scrollToLatest}>Back to latest <span aria-hidden="true">↓</span></button> : null}
    </div>;
});
