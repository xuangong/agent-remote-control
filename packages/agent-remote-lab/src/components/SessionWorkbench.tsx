import { remoteSessionState, type RemoteSessionState } from '@orchardworks/agent-remote-web';
import { SessionControlNotice } from './SessionControlNotice.js';
import { SessionViewFrame } from './SessionViewFrame.js';
import { useFeedbackToast, useToastAnchor } from './Toast.js';
import type { ImageUploadReceipt, MessagePart, ResourceResponseState } from '@orchardworks/agent-remote-protocol';
import type { AgentCommand, AgentCommandResult, AgentMessageOptions } from '@orchardworks/agent-remote-protocol';
import { memo, useContext, useEffect, useId, useLayoutEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import type {
  AgentInteractionResponse,
  ResourceBinding,
} from '@orchardworks/agent-remote-protocol';
import type { AgentReplicaState, RemoteSessionStatus, SessionHandoffState } from '@orchardworks/agent-remote-web';
import { AgentCommandDetails, AgentTimeline, TimelineSearch, PreviewDock, TimelineDisplay, TimelineLettersVisible, createTimelineRenderModel, isContentOnlyItem, type TimelineDisplayMode, type AgentChildSessionView, type QuestionDraft, type SessionLinkResolver } from '@orchardworks/agent-remote-web/react';


import { AgentComposer as DraftComposer, type SessionViewActions, type TimelineReadingPositions } from '@orchardworks/agent-remote-web/react';

import { PlanningControl } from './PlanningControl.js';
import { SessionViewOptions, type SessionDisplayPreferences } from './SessionViewOptions.js';
import { SessionHeading } from './SessionHeading.js';
import { SessionTimelineTools } from './SessionTimelineTools.js';

import { useTimelineScroll } from '../hooks/useTimelineScroll.js';
import { useRecoveryNotice } from '../hooks/useRecoveryNotice.js';


import type { TraceEntryRequest } from '../trace-model.js';

export type LabWorkbenchActions = SessionViewActions;

export function SessionWorkbench({ displayPreferences, onDisplayPreferencesChange, defaultDisplayMode = 'preview', sessionState: suppliedSessionState, handoff, workspaceLink, readingPositions: suppliedReadingPositions, draftScope, isAuthenticationError = noAuthenticationError, authenticationNotice, renderSessionSettingError, readOnly: recordingReadOnly = false, onInspectEntry, revealEntry, state, sessionStatus: connectionStatus, attachingAgentId, actions: suppliedActions, visible = true, questionDrafts, onQuestionDraftChange, messageDraft, draftSessionKey, onMessageDraftChange, onOpenChildSession, childrenFor, resolveSessionLink, conversationPath, headingStart, headingMode = 'inline', sessionManager, composerContext, composerNotice, nativeTakeover, consoleCommands, onExecuteConsoleCommand }: { displayPreferences?: SessionDisplayPreferences; onDisplayPreferencesChange?(preferences: SessionDisplayPreferences): void; defaultDisplayMode?: TimelineDisplayMode; sessionState?: RemoteSessionState; handoff?: SessionHandoffState; readOnly?: boolean; workspaceLink?: ReactNode; readingPositions?: TimelineReadingPositions; draftScope?: string; isAuthenticationError?(error: unknown): boolean; authenticationNotice?: ReactNode; renderSessionSettingError?(error: unknown): ReactNode; onInspectEntry?: (key: string) => void; revealEntry?: TraceEntryRequest; composerContext?: ReactNode; composerNotice?: ReactNode; nativeTakeover?: ReactNode; consoleCommands?: readonly (AgentCommand & { aliases?: readonly string[] })[]; onExecuteConsoleCommand?(id: string, args: string): Promise<AgentCommandResult>; state?: AgentReplicaState; sessionStatus: RemoteSessionStatus; attachingAgentId?: string; actions: LabWorkbenchActions; conversationPath?: ReactNode; headingStart?: ReactNode; headingMode?: 'inline' | 'toolbar'; sessionManager?: ReactNode; resolveSessionLink?: SessionLinkResolver; childrenFor?: (nativeSessionId: string) => readonly AgentChildSessionView[]; onOpenChildSession?: (child: AgentChildSessionView) => void | Promise<void>; visible?: boolean; draftSessionKey?: string; messageDraft?: string; onMessageDraftChange?(text: string): void; questionDrafts?: Readonly<Record<string, QuestionDraft>>; onQuestionDraftChange?: (requestId: string, draft: QuestionDraft) => void }) {
  const displayScope = draftSessionKey ?? state?.agent?.runtimeInfo.sessionId ?? attachingAgentId;
  const [localDisplay, setLocalDisplay] = useState(() => ({ scope: displayScope, value: { mode: defaultDisplayMode, lettersVisible: true } }));
  let localPreferences = localDisplay.value;
  if (localDisplay.scope !== displayScope) {
    localPreferences = { mode: defaultDisplayMode, lettersVisible: true };
    setLocalDisplay({ scope: displayScope, value: localPreferences });
  }
  const preferences = displayPreferences ?? localPreferences;
  function changeDisplayPreferences(value: SessionDisplayPreferences): void {
    if (onDisplayPreferencesChange) onDisplayPreferencesChange(value);
    else setLocalDisplay({ scope: displayScope, value });
  }
  const revealedDisplayRequest = useRef<string>();
  useLayoutEffect(() => {
    if (!visible || !revealEntry || !state) return;
    const request = JSON.stringify([displayScope, state.timeline.epoch, revealEntry.requestId, revealEntry.key]);
    if (revealedDisplayRequest.current === request) return;
    const item = createTimelineRenderModel(state.timeline.epoch, state.timeline.entries).find(entry => entry.key === revealEntry.key)?.entry.item;
    if (!item) return;
    revealedDisplayRequest.current = request;
    const mode = preferences.mode === 'content' && !isContentOnlyItem(item) ? 'simple' : preferences.mode;
    const lettersVisible = item.type === 'agent_communication' ? true : preferences.lettersVisible;
    if (mode !== preferences.mode || lettersVisible !== preferences.lettersVisible) changeDisplayPreferences({ mode, lettersVisible });
  }, [visible, displayScope, state?.timeline.epoch, state?.timeline.entries, revealEntry, preferences.mode, preferences.lettersVisible]);
  const session = suppliedSessionState ?? remoteSessionState(state, connectionStatus);
  const sessionStatus = session.connection;
  const controlReadOnly = !!nativeTakeover || session.readOnly;
  const readOnly = recordingReadOnly || controlReadOnly;
  const { actions: suppliedFeedbackActions, reauthenticate } = useActionFeedback(suppliedActions, state?.agent?.id, isAuthenticationError);
  const actions: LabWorkbenchActions = readOnly ? { searchTimeline: suppliedFeedbackActions.searchTimeline, loadSearchMatch: suppliedFeedbackActions.loadSearchMatch, loadOlder: suppliedFeedbackActions.loadOlder, requestResource: suppliedFeedbackActions.requestResource, resolveResource: suppliedFeedbackActions.resolveResource, deleteMessage: suppliedFeedbackActions.deleteMessage } : session.synchronized ? { ...suppliedFeedbackActions,
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
  const toastAnchor = useToastAnchor(visible && !!state?.agent && !composerHidden);
  const toastToggleAnchor = useToastAnchor<HTMLButtonElement>(visible && !!state?.agent);
  const [inspected, setInspected] = useState<{ agentId: string; command: AgentCommand }>();
  const selectedCommand = inspected?.agentId === state?.agent?.id ? inspected?.command : undefined;
  const hasReplica = state !== undefined;
  const isAttaching = !hasReplica && attachingAgentId !== undefined;
  const loadingLabel = sessionStatus === 'catching_up' ? 'Loading conversation' : 'Opening session';
  const connectionFailure = sessionStatus === 'connecting'
    ? state?.diagnostics.find((diagnostic) => !diagnostic.recoverable)
    : undefined;
  const nativeFailure = state?.agent?.runtimeInfo.failure;
  const agentFailure = state?.agent?.status === 'failed'
    ? nativeFailure?.message.trim() || state.agent.lastError?.trim() || 'The Agent reported a failed runtime without error details.'
    : undefined;
  const failureInTimeline = !!nativeFailure?.turnId && state?.timeline.entries.some(entry =>
    entry.turnId === nativeFailure.turnId && entry.item.type === 'error' && entry.item.message === nativeFailure.message);
  const runtimeConnection = session.runtime;
  const runtimeMutationDisabled = !session.operations.interaction_response.allowed;
  const runtimeNotice = runtimeConnection?.state === 'reconnecting'
    ? 'Native runtime is reconnecting. Changes are temporarily unavailable.'
    : runtimeConnection?.state === 'restoring'
      ? 'Native runtime is restoring this session. Changes are temporarily unavailable.'
      : runtimeConnection?.state === 'unavailable'
        ? 'Native runtime is unavailable. Changes are unavailable.'
        : undefined;
  const runtimeError = connectionFailure?.message
    ?? (runtimeConnection?.state === 'unavailable' ? runtimeNotice : undefined);
  const recoveryNoticeDue = useRecoveryNotice(
    draftSessionKey ?? attachingAgentId ?? state?.agent?.id ?? '', sessionStatus,
    runtimeConnection?.state === 'reconnecting' || runtimeConnection?.state === 'restoring',
    visible && !readOnly && !runtimeError && !agentFailure,
  );
  useFeedbackToast('Session runtime', visible && !readOnly ? runtimeError
    ?? (recoveryNoticeDue ? runtimeNotice ?? 'Timeline synchronization is reconnecting.' : undefined) : undefined,
    runtimeError ? 'error' : 'info');
  const activity = session.activity;
  const activityLabel = state?.sessionControl?.nativeOwner ? (state.sessionControl.nativeOwner.kind === 'native_cli' ? 'Native CLI has control' : 'Native control transferred')
    : agentFailure ? 'Agent failed'
    : connectionFailure ? 'Connection failed'
    : sessionStatus === 'disconnected' ? 'Reconnecting'
    : sessionStatus === 'connecting' ? 'Opening session'
    : session.controlChecking ? 'Checking control'
    : sessionStatus === 'catching_up' ? 'Synchronizing'
    : sessionStatus === 'idle' ? 'Disconnected'
    : !state?.agent ? 'Opening session'
    : runtimeConnection?.state === 'reconnecting' ? 'Reconnecting'
    : runtimeConnection?.state === 'restoring' ? 'Restoring'
    : runtimeConnection?.state === 'unavailable' ? 'Unavailable'
    : activity === 'closed' ? 'Closed'
    : activity === 'starting' ? 'Starting'
    : activity === 'waiting' ? 'Waiting for response'
    : activity === 'running' ? 'Working'
    : 'Ready';
  const viewOptions = <SessionViewOptions key={displayScope} preferences={preferences} onChange={changeDisplayPreferences} />;
  const tools = <>{sessionManager}{viewOptions}</>;
  const layoutClass = [selectedCommand ? 'lab-command-details-open' : '', headingMode === 'toolbar' ? 'lab-workbench-toolbar-heading' : ''].filter(Boolean).join(' ');
  return <TimelineDisplay.Provider value={preferences.mode}><TimelineLettersVisible.Provider value={preferences.lettersVisible}><SessionViewFrame className={layoutClass}>
    <SessionHeading hidden={headingMode === 'toolbar'}
      leading={headingMode === 'inline' ? <>{headingStart}{workspaceLink}{viewOptions}</> : undefined}
      trailing={headingMode === 'inline' ? <>{sessionManager}<span className="lab-conversation-status">{hasReplica ? activityLabel : isAttaching ? loadingLabel : 'Awaiting Agent'}</span></> : undefined}>
        {conversationPath}
        <h2 hidden={!!conversationPath} className="agent-session-title" data-session-status={activity}>{hasReplica ? 'Conversation' : isAttaching ? `${sessionStatus === 'catching_up' ? 'Loading conversation' : 'Opening session'} ${attachingAgentId}` : 'Ready for a session'}</h2>
    </SessionHeading>
    <PreviewDock sessionId={state?.agent?.id ?? attachingAgentId} />
    <WorkbenchTimeline toolsTargetRef={setTimelineToolsTarget} toolsCollapsible={headingMode === 'toolbar'} toolsScope={displayScope} nativeTakeover={!!nativeTakeover} readOnly={readOnly} state={state} sessionStatus={sessionStatus} attachingAgentId={attachingAgentId}
      visible={visible} readingPositions={readingPositions} actions={actions} revealEntry={revealEntry}
      agentFailure={failureInTimeline ? undefined : agentFailure} connectionFailure={connectionFailure} runtimeNotice={runtimeNotice} runtimeMutationDisabled={runtimeMutationDisabled}
      onInspectEntry={onInspectEntry} onOpenChildSession={onOpenChildSession} childrenFor={childrenFor} resolveSessionLink={resolveSessionLink}
      questionDrafts={questionDrafts} onQuestionDraftChange={onQuestionDraftChange} />
    {headingMode === 'toolbar' && timelineToolsTarget ? createPortal(tools, timelineToolsTarget) : null}
    <div ref={toastAnchor} className="lab-composer-dock" hidden={!state?.agent && !nativeTakeover} data-collapsed={composerHidden || undefined}>
      <div hidden={composerHidden}>
        {composerContext}
        {composerNotice}
        {reauthenticate ? authenticationNotice : null}
      </div>
      <div className="lab-composer-input-shell">
        <button ref={toastToggleAnchor} type="button" className="lab-composer-toggle" aria-controls={composerId} aria-expanded={!composerHidden}
          aria-label={composerHidden ? 'Show message input' : 'Hide message input'} title={composerHidden ? 'Show message input' : 'Hide message input'}
          onClick={() => setComposerHidden(hidden => !hidden)}>
          <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
            <path d={composerHidden ? 'm7 14 5-5 5 5' : 'm7 10 5 5 5-5'} />
          </svg>
        </button>
        <div id={composerId} className="lab-composer-body" hidden={composerHidden && !controlReadOnly}>
          <DraftComposer
            sessionState={session}
            readOnly={readOnly}
            readOnlyCollapsed={composerHidden}
            readOnlyLabel={controlReadOnly && !recordingReadOnly ? 'Read only' : undefined}
            readOnlyNotice={nativeTakeover ?? (!recordingReadOnly && controlReadOnly && state?.sessionControl ? <SessionControlNotice handoff={handoff ?? session.handoff} control={state.sessionControl} connected={sessionStatus === 'ready'} onTakeControl={suppliedActions.takeControl} /> : undefined)}
            consoleCommands={!readOnly && sessionStatus === 'ready' ? consoleCommands : []}
            onExecuteConsoleCommand={!readOnly && sessionStatus === 'ready' ? onExecuteConsoleCommand : undefined}
            sessionControls={state?.agent ? <PlanningControl sessionState={session} key={state.agent.id} state={state} sessionStatus={sessionStatus} onSetPlanning={actions.setPlanning} /> : null}
            state={state}
            sessionKey={draftSessionKey ?? state?.agent?.id}
            draftScope={draftScope}
            visible={visible}
            activityVisible={visible && !composerHidden}
            onSendMessageContent={readOnly ? undefined : suppliedFeedbackActions.sendMessageContent}
            onUploadImage={visible ? actions.uploadImage : undefined}
            draft={messageDraft}
            onDraftChange={onMessageDraftChange}
            disabled={sessionStatus !== 'ready'}
            disabledLabel={activityLabel}
            recovering={!readOnly && !runtimeError && session.recovering}
            onSendMessage={readOnly ? undefined : suppliedFeedbackActions.sendMessage}
            onCancel={actions.cancel}
            onSetSessionSetting={actions.setSessionSetting}
            renderSessionSettingError={renderSessionSettingError}
            onListCommands={actions.listCommands}
            onExecuteCommand={actions.executeCommand}
            onRequestResource={actions.requestResource}
            onResolveResource={actions.resolveResource}
            onInspectCommand={(command) => { if (state?.agent) setInspected({ agentId: state.agent.id, command }); }}
          />
        </div>
      </div>
    </div>
    {selectedCommand && state ? <AgentCommandDetails key={`${state.agent?.id}:${selectedCommand.id}`} command={selectedCommand} resources={state.resources}
      onRequestResource={actions.requestResource} onResolveResource={actions.resolveResource}
      resourceScopeKey={JSON.stringify([state.agent?.id, state.timeline.epoch, selectedCommand.id])}
      onClose={() => setInspected(undefined)} /> : null}
  </SessionViewFrame></TimelineLettersVisible.Provider></TimelineDisplay.Provider>;
}


const noAuthenticationError = () => false;

function useActionFeedback(actions: LabWorkbenchActions, sessionId: string | undefined, isAuthenticationError: (error: unknown) => boolean): { actions: LabWorkbenchActions; reauthenticate: boolean } {
  const activeSession = useRef(sessionId);
  activeSession.current = sessionId;
  const [failure, setFailure] = useState<{ title: string; message: string; reauthenticate: boolean }>();
  useFeedbackToast(failure?.title ?? 'Session action', failure?.reauthenticate ? undefined : failure?.message);
  useEffect(() => setFailure(undefined), [sessionId]);
  function report<Args extends unknown[], Result>(title: string, action: ((...args: Args) => Result) | undefined) {
    return action ? async (...args: Args): Promise<Awaited<Result>> => {
      setFailure(undefined);
      try { return await action(...args); }
      catch (error) {
        if (activeSession.current === sessionId) setFailure({ title, message: error instanceof Error ? error.message : 'The action could not be confirmed. Check its status before retrying.', reauthenticate: isAuthenticationError(error) });
        throw error;
      }
    } : undefined;
  }
  const reportedActions = useMemo(() => ({ ...actions,
    sendMessage: report('Send message', actions.sendMessage), sendMessageContent: report('Send message', actions.sendMessageContent), retryMessage: report('Retry message', actions.retryMessage),
    steer: report('Steer session', actions.steer), cancel: report('Stop work', actions.cancel),
    respondToInteraction: report('Submit response', actions.respondToInteraction),
    setPlanning: report('Change session mode', actions.setPlanning), setSessionSetting: report('Change session setting', actions.setSessionSetting),
    listCommands: report('Load commands', actions.listCommands), executeCommand: report('Run command', actions.executeCommand),
    loadOlder: report('Load conversation history', actions.loadOlder),
    editPrompt: report('Edit prompt', actions.editPrompt),
  }), [actions, sessionId]);
  return { actions: reportedActions, reauthenticate: failure?.reauthenticate === true && failure.title !== 'Change session setting' };
}

const WorkbenchTimeline = memo(function WorkbenchTimeline({ nativeTakeover, readOnly, state, sessionStatus, attachingAgentId, visible, readingPositions, actions, revealEntry,
  agentFailure, connectionFailure, runtimeNotice, runtimeMutationDisabled, onInspectEntry, onOpenChildSession, childrenFor, resolveSessionLink,
  questionDrafts, onQuestionDraftChange, toolsTargetRef, toolsCollapsible, toolsScope }: Pick<Parameters<typeof SessionWorkbench>[0], 'readOnly' | 'state' | 'sessionStatus' | 'attachingAgentId' | 'visible' | 'actions' | 'revealEntry' | 'onInspectEntry' | 'onOpenChildSession' | 'childrenFor' | 'resolveSessionLink' | 'questionDrafts' | 'onQuestionDraftChange'> & {
    readingPositions: NonNullable<Parameters<typeof useTimelineScroll>[2]>; toolsTargetRef(node: HTMLDivElement | null): void; toolsCollapsible: boolean; toolsScope?: string; agentFailure?: string;
    connectionFailure?: { message: string }; runtimeNotice?: string; runtimeMutationDisabled: boolean; nativeTakeover?: boolean;
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
  const display = useContext(TimelineDisplay);
  const lettersVisible = useContext(TimelineLettersVisible);
  useLayoutEffect(() => { setSearchSelection(undefined); }, [lettersVisible]);
  const contentRevision = useMemo(() => ({}), [state, display, lettersVisible, agentFailure, connectionFailure, runtimeNotice, questionDrafts, childrenFor]);
  const scroll = useTimelineScroll(JSON.stringify([state?.agent?.id, state?.timeline.epoch]), visible, readingPositions, undefined,
    actions.loadOlder ? { hasOlder: state?.timeline.hasOlder === true, cursor: state?.timeline.entries[0]?.seqStart.toString(), load: actions.loadOlder } : undefined, contentRevision, 'bottom');
  const consumedReveal = useRef<string>();
  useLayoutEffect(() => {
    if (!visible || !revealEntry) return;
    const request = JSON.stringify([state?.agent?.id, state?.timeline.epoch, revealEntry.requestId]);
    if (consumedReveal.current !== request && scroll.revealEntry(revealEntry.key, revealEntry.align)) consumedReveal.current = request;
  }, [visible, revealEntry, state?.agent?.id, state?.timeline.epoch, state?.timeline.entries, display, lettersVisible]);
  useLayoutEffect(() => {
    if (visible && selectedSearchKey) scroll.revealEntry(selectedSearchKey);
  }, [visible, selectedSearchKey, searchSelection?.request]);
  const hasReplica = state !== undefined;
  const isAttaching = !hasReplica && attachingAgentId !== undefined;
  return <div className="lab-timeline-stage" onKeyDownCapture={event => {
      if (event.target instanceof Node && !event.currentTarget.contains(event.target)) return;
      if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 'f' && state?.timeline.initialized) {
        event.preventDefault(); event.stopPropagation(); setOpenSearchScope(searchScope);
      }
    }}>
      <SessionTimelineTools key={toolsScope} collapsible={toolsCollapsible} searchOpen={searchOpen}>
      <div className="lab-timeline-session-tools" ref={toolsTargetRef} />
      {state?.timeline.initialized ? <button ref={searchTrigger} type="button" className="lab-timeline-search-trigger"
        hidden={searchOpen} aria-label="Search this session" title="Search this session" aria-expanded={searchOpen}
        onClick={() => setOpenSearchScope(searchScope)}>
        <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" aria-hidden="true"><circle cx="10.5" cy="10.5" r="6.5" /><path d="m16 16 5 5" /></svg>
      </button> : null}
      </SessionTimelineTools>
      {searchOpen && state ? <TimelineSearch key={searchScope} state={state} search={actions.searchTimeline} onClose={closeSearch} onClearSelection={() => setSearchSelection(undefined)}
        onSelect={async (match, signal) => {
          if (actions.loadSearchMatch) await scroll.loadOlder(() => actions.loadSearchMatch!(match, { signal }));
          else if (!state.timeline.entries.some(entry => entry.seqStart === match.seq)) throw new Error('Reconnect to load this result.');
          signal.throwIfAborted();
          setSearchSelection(previous => ({ scope: searchScope, key: match.key, request: (previous?.request ?? 0) + 1 }));
        }} /> : null}
      <div className="lab-timeline-scroll" data-testid="timeline" ref={scroll.viewportRef} tabIndex={0} onScroll={scroll.onScroll} onWheel={scroll.onWheel} onPointerDown={scroll.onPointerDown} onKeyDown={scroll.onKeyDown} onFocus={scroll.onFocus} onTouchStart={scroll.onTouchStart} onTouchMove={scroll.onTouchMove}>
        <div className="lab-conversation-content" ref={scroll.contentRef}>
          {hasReplica ? <>
            {agentFailure ? <p className="lab-control-note" role="alert">Agent failed: {agentFailure}</p>
              : connectionFailure ? <p className="lab-control-note" role="alert">Agent connection failed: {connectionFailure.message}</p>
              : sessionStatus === 'disconnected' ? <p className="lab-control-note" role="alert">Timeline synchronization is reconnecting.</p> : null}
            {runtimeNotice ? <p className="lab-control-note" role="status">{runtimeNotice}</p> : null}
            <AgentTimeline
              state={state}
              onEditPrompt={actions.editPrompt}
              onRetryMessage={actions.retryMessage}
              onDeleteMessage={actions.deleteMessage}
              onInspectEntry={onInspectEntry}
              inspectedEntryKey={revealEntry?.key}
              inspectedRequestId={revealEntry?.requestId}
              searchEntryKey={selectedSearchKey}
              searchRequestId={searchSelection?.request}
              showHeader={false}
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
              onResourceRequest={actions.requestResource}
              onResourceResolve={actions.resolveResource}
              questionDrafts={questionDrafts}
              onQuestionDraftChange={onQuestionDraftChange}
            />
          </> : nativeTakeover ? null : isAttaching ? <div className="lab-empty-state">
            <span className="lab-empty-icon" aria-hidden="true">↗</span>
            <h3>{sessionStatus === 'catching_up' ? 'Loading conversation' : 'Opening session'} {attachingAgentId}</h3>
            <p>The Timeline will appear when the Agent Snapshot is available.</p>
          </div> : <div className="lab-empty-state">
            <span className="lab-empty-icon" aria-hidden="true">↗</span>
            <h3>Start with a Provider</h3>
            <p>Open a registered Agent to observe its Timeline, interactions, and durable resources.</p>
          </div>}
        </div>
      </div>
      {scroll.showLatest ? <button className="lab-back-to-latest" type="button" onClick={scroll.scrollToLatest}>Back to latest <span aria-hidden="true">↓</span></button> : null}
    </div>;
});
