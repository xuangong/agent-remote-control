import { sessionOperationAvailability } from '@orchardworks/agent-remote-protocol';
import { SessionControlNotice } from './SessionControlNotice.js';
import { SessionViewFrame } from './SessionViewFrame.js';
import { useFeedbackToast, useToastAnchor } from './Toast.js';
import type { ImageUploadReceipt, MessagePart, ResourceResponseState } from '@orchardworks/agent-remote-protocol';
import type { AgentCommand, AgentCommandResult, AgentMessageOptions } from '@orchardworks/agent-remote-protocol';
import { memo, useContext, useEffect, useId, useLayoutEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import type {
  AgentInteractionResponse,
  ResourceBinding,
} from '@orchardworks/agent-remote-protocol';
import type { AgentReplicaState, RemoteSessionStatus, SessionHandoffState } from '@orchardworks/agent-remote-web';
import { AgentCommandDetails, AgentTimeline, PreviewDock, TimelineDisplay, type AgentChildSessionView, type QuestionDraft, type SessionLinkResolver } from '@orchardworks/agent-remote-web/react';

import { sessionActivity } from '../session-activity.js';

import { AgentComposer as DraftComposer, type SessionViewActions, type TimelineReadingPositions } from '@orchardworks/agent-remote-web/react';

import { PlanningControl } from './PlanningControl.js';

import { useTimelineScroll } from '../hooks/useTimelineScroll.js';
import { useRecoveryNotice } from '../hooks/useRecoveryNotice.js';


import type { TraceEntryRequest } from '../trace-model.js';

export type LabWorkbenchActions = SessionViewActions;

export function SessionWorkbench({ handoff, workspaceLink, readingPositions: suppliedReadingPositions, draftScope, isAuthenticationError = noAuthenticationError, authenticationNotice, renderSessionSettingError, readOnly: recordingReadOnly = false, compact = false, onInspectEntry, revealEntry, state, sessionStatus: connectionStatus, attachingAgentId, actions: suppliedActions, visible = true, questionDrafts, onQuestionDraftChange, messageDraft, draftSessionKey, onMessageDraftChange, onOpenChildSession, childrenFor, resolveSessionLink, conversationPath, sessionManager, composerContext, composerNotice, nativeTakeover, consoleCommands, onExecuteConsoleCommand }: { handoff?: SessionHandoffState; readOnly?: boolean; workspaceLink?: ReactNode; readingPositions?: TimelineReadingPositions; draftScope?: string; isAuthenticationError?(error: unknown): boolean; authenticationNotice?: ReactNode; renderSessionSettingError?(error: unknown): ReactNode; compact?: boolean; onInspectEntry?: (key: string) => void; revealEntry?: TraceEntryRequest; composerContext?: ReactNode; composerNotice?: ReactNode; nativeTakeover?: ReactNode; consoleCommands?: readonly (AgentCommand & { aliases?: readonly string[] })[]; onExecuteConsoleCommand?(id: string, args: string): Promise<AgentCommandResult>; state?: AgentReplicaState; sessionStatus: RemoteSessionStatus; attachingAgentId?: string; actions: LabWorkbenchActions; conversationPath?: ReactNode; sessionManager?: ReactNode; resolveSessionLink?: SessionLinkResolver; childrenFor?: (nativeSessionId: string) => readonly AgentChildSessionView[]; onOpenChildSession?: (child: AgentChildSessionView) => void | Promise<void>; visible?: boolean; draftSessionKey?: string; messageDraft?: string; onMessageDraftChange?(text: string): void; questionDrafts?: Readonly<Record<string, QuestionDraft>>; onQuestionDraftChange?: (requestId: string, draft: QuestionDraft) => void }) {
  const controlChecking = state?.sessionControl?.access === 'checking';
  const sessionStatus = controlChecking && connectionStatus === 'ready' ? 'catching_up' : connectionStatus;
  const controlReadOnly = !!nativeTakeover || !controlChecking && state?.sessionControl !== undefined && state.sessionControl.access !== 'control';
  const readOnly = recordingReadOnly || controlReadOnly;
  const { actions: suppliedFeedbackActions, reauthenticate } = useActionFeedback(suppliedActions, state?.agent?.id, isAuthenticationError);
  const actions: LabWorkbenchActions = readOnly ? { loadOlder: suppliedFeedbackActions.loadOlder, requestResource: suppliedFeedbackActions.requestResource, resolveResource: suppliedFeedbackActions.resolveResource, deleteMessage: suppliedFeedbackActions.deleteMessage } : sessionStatus === 'ready' ? suppliedFeedbackActions : { deleteMessage: suppliedFeedbackActions.deleteMessage };
  const localPositions = useMemo(() => new Map(), []);
  const readingPositions = suppliedReadingPositions ?? localPositions;
  const [composerHidden, setComposerHidden] = useState(false);
  const composerId = useId();
  const toastAnchor = useToastAnchor(visible && !!state?.agent && !composerHidden);
  const toastToggleAnchor = useToastAnchor<HTMLButtonElement>(visible && !!state?.agent && !compact);
  const [inspected, setInspected] = useState<{ agentId: string; command: AgentCommand }>();
  const selectedCommand = inspected?.agentId === state?.agent?.id ? inspected?.command : undefined;
  const hasReplica = state !== undefined;
  const isAttaching = !hasReplica && attachingAgentId !== undefined;
  const loadingLabel = sessionStatus === 'catching_up' ? 'Loading conversation' : 'Opening session';
  const connectionFailure = sessionStatus === 'connecting'
    ? state?.diagnostics.find((diagnostic) => !diagnostic.recoverable)
    : undefined;
  const agentFailure = state?.agent?.status === 'failed'
    ? state.agent.lastError?.trim() || 'The Agent did not provide a failure reason.'
    : undefined;
  const runtimeConnection = state?.agent?.runtimeInfo.connection;
  const runtimeMutationDisabled = !sessionOperationAvailability(state?.agent ?? null, 'interaction_response', { synchronized: sessionStatus === 'ready', control: state?.sessionControl?.access }).allowed;
  const runtimeNotice = runtimeConnection?.state === 'reconnecting'
    ? 'Native runtime is reconnecting. Changes are temporarily unavailable.'
    : runtimeConnection?.state === 'restoring'
      ? 'Native runtime is restoring this session. Changes are temporarily unavailable.'
      : runtimeConnection?.state === 'unavailable'
        ? 'Native runtime is unavailable. Changes are unavailable.'
        : undefined;
  const runtimeError = agentFailure ?? connectionFailure?.message
    ?? (runtimeConnection?.state === 'unavailable' ? runtimeNotice : undefined);
  const recoveryNoticeDue = useRecoveryNotice(
    draftSessionKey ?? attachingAgentId ?? state?.agent?.id ?? '', sessionStatus,
    runtimeConnection?.state === 'reconnecting' || runtimeConnection?.state === 'restoring',
    visible && !readOnly && !runtimeError,
  );
  useFeedbackToast('Session runtime', visible && !readOnly ? runtimeError
    ?? (recoveryNoticeDue ? runtimeNotice ?? 'Timeline synchronization is reconnecting.' : undefined) : undefined,
    runtimeError ? 'error' : 'info');
  const activity = sessionActivity(state);
  const activityLabel = state?.sessionControl?.nativeOwner ? (state.sessionControl.nativeOwner.kind === 'native_cli' ? 'Native CLI has control' : 'Native control transferred')
    : agentFailure ? 'Agent failed'
    : connectionFailure ? 'Connection failed'
    : sessionStatus === 'disconnected' ? 'Reconnecting'
    : sessionStatus === 'connecting' ? 'Opening session'
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
  return <SessionViewFrame className={`${compact ? ' lab-workbench-compact' : ''}${selectedCommand ? ' lab-command-details-open' : ''}`}>
    <header className="lab-workbench-heading">
      <div>
        {conversationPath}
        <h2 hidden={compact} className="agent-session-title" data-session-status={activity}>{hasReplica ? 'Conversation' : isAttaching ? `${sessionStatus === 'catching_up' ? 'Loading conversation' : 'Opening session'} ${attachingAgentId}` : 'Ready for a session'}</h2>
      </div>
      {sessionManager}
      {!compact ? workspaceLink : null}
      <span className="lab-conversation-status">{hasReplica ? activityLabel : isAttaching ? loadingLabel : 'Awaiting Agent'}</span>
    </header>
    <PreviewDock sessionId={state?.agent?.id ?? attachingAgentId} />
    <WorkbenchTimeline nativeTakeover={!!nativeTakeover} readOnly={readOnly} state={state} sessionStatus={sessionStatus} attachingAgentId={attachingAgentId}
      visible={visible} readingPositions={readingPositions} actions={actions} revealEntry={revealEntry}
      agentFailure={agentFailure} connectionFailure={connectionFailure} runtimeNotice={runtimeNotice} runtimeMutationDisabled={runtimeMutationDisabled}
      onInspectEntry={onInspectEntry} onOpenChildSession={onOpenChildSession} childrenFor={childrenFor} resolveSessionLink={resolveSessionLink}
      questionDrafts={questionDrafts} onQuestionDraftChange={onQuestionDraftChange} />
    <div ref={toastAnchor} className="lab-composer-dock" hidden={!state?.agent && !nativeTakeover} data-collapsed={composerHidden || undefined}>
      <div hidden={composerHidden}>
        {composerContext}
        {composerNotice}
        {reauthenticate ? authenticationNotice : null}
      </div>
      <div className="lab-composer-input-shell">
        <button ref={toastToggleAnchor} hidden={compact} type="button" className="lab-composer-toggle" aria-controls={composerId} aria-expanded={!composerHidden}
          aria-label={composerHidden ? 'Show message input' : 'Hide message input'} title={composerHidden ? 'Show message input' : 'Hide message input'}
          onClick={() => setComposerHidden(hidden => !hidden)}>
          <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
            <path d={composerHidden ? 'm7 14 5-5 5 5' : 'm7 10 5 5 5-5'} />
          </svg>
        </button>
        <div id={composerId} className="lab-composer-body" hidden={composerHidden && !controlReadOnly}>
          <DraftComposer
            compact={compact}
            readOnly={readOnly}
            readOnlyCollapsed={composerHidden}
            readOnlyLabel={controlReadOnly && !recordingReadOnly ? 'Read only' : undefined}
            readOnlyNotice={nativeTakeover ?? (!recordingReadOnly && controlReadOnly && state?.sessionControl ? <SessionControlNotice handoff={handoff} control={state.sessionControl} connected={sessionStatus === 'ready'} onTakeControl={suppliedActions.takeControl} /> : undefined)}
            consoleCommands={!readOnly && sessionStatus === 'ready' ? consoleCommands : []}
            onExecuteConsoleCommand={!readOnly && sessionStatus === 'ready' ? onExecuteConsoleCommand : undefined}
            sessionControls={state?.agent ? <PlanningControl key={state.agent.id} state={state} sessionStatus={sessionStatus} onSetPlanning={actions.setPlanning} /> : null}
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
            recovering={!readOnly && !runtimeError && (sessionStatus === 'disconnected' || sessionStatus === 'connecting' || sessionStatus === 'catching_up' || runtimeConnection?.state === 'reconnecting' || runtimeConnection?.state === 'restoring')}
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
  </SessionViewFrame>;
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
  questionDrafts, onQuestionDraftChange }: Pick<Parameters<typeof SessionWorkbench>[0], 'readOnly' | 'state' | 'sessionStatus' | 'attachingAgentId' | 'visible' | 'actions' | 'revealEntry' | 'onInspectEntry' | 'onOpenChildSession' | 'childrenFor' | 'resolveSessionLink' | 'questionDrafts' | 'onQuestionDraftChange'> & {
    readingPositions: NonNullable<Parameters<typeof useTimelineScroll>[2]>; agentFailure?: string;
    connectionFailure?: { message: string }; runtimeNotice?: string; runtimeMutationDisabled: boolean; nativeTakeover?: boolean;
  }) {
  const display = useContext(TimelineDisplay);
  const contentRevision = useMemo(() => ({}), [state, display, agentFailure, connectionFailure, runtimeNotice, questionDrafts, childrenFor]);
  const scroll = useTimelineScroll(JSON.stringify([state?.agent?.id, state?.timeline.epoch]), visible, readingPositions, undefined,
    actions.loadOlder ? { hasOlder: state?.timeline.hasOlder === true, cursor: state?.timeline.entries[0]?.seqStart.toString(), load: actions.loadOlder } : undefined, contentRevision, 'bottom');
  const consumedReveal = useRef<string>();
  useLayoutEffect(() => {
    if (!visible || !revealEntry) return;
    const request = JSON.stringify([state?.agent?.id, state?.timeline.epoch, revealEntry.requestId]);
    if (consumedReveal.current !== request && scroll.revealEntry(revealEntry.key)) consumedReveal.current = request;
  }, [visible, revealEntry, state?.agent?.id, state?.timeline.epoch, state?.timeline.entries]);
  const hasReplica = state !== undefined;
  const isAttaching = !hasReplica && attachingAgentId !== undefined;
  return <div className="lab-timeline-stage">
      <div className="lab-timeline-scroll" data-testid="timeline" ref={scroll.viewportRef} tabIndex={0} onScroll={scroll.onScroll} onWheel={scroll.onWheel} onPointerDown={scroll.onPointerDown} onKeyDown={scroll.onKeyDown} onFocus={scroll.onFocus} onTouchStart={scroll.onTouchStart} onTouchMove={scroll.onTouchMove}>
        <div className="lab-conversation-content" ref={scroll.contentRef}>
          {hasReplica ? <>
            {agentFailure ? <p className="lab-control-note" role="alert">Agent failed: {agentFailure}</p>
              : connectionFailure ? <p className="lab-control-note" role="alert">Agent connection failed: {connectionFailure.message}</p>
              : sessionStatus === 'disconnected' ? <p className="lab-control-note" role="alert">Timeline synchronization is reconnecting.</p> : null}
            {runtimeNotice ? <p className="lab-control-note" role="status">{runtimeNotice}</p> : null}
            <AgentTimeline
              state={state}
              onEditPrompt={runtimeMutationDisabled ? undefined : actions.editPrompt}
              onRetryMessage={runtimeMutationDisabled ? undefined : actions.retryMessage}
              onDeleteMessage={actions.deleteMessage}
              onInspectEntry={onInspectEntry}
              inspectedEntryKey={revealEntry?.key}
              showHeader={false}
              historyLoading={scroll.historyLoading}
              historyError={scroll.historyError}
              onOpenChildSession={onOpenChildSession}
              childrenFor={childrenFor}
              resolveSessionLink={resolveSessionLink}
              onLoadOlder={actions.loadOlder ? () => scroll.loadOlder(actions.loadOlder!) : undefined}
              onInteractionResponse={actions.respondToInteraction}
              interactionsReadOnly={readOnly}
              interactionsWaitingForConnection={!readOnly && sessionStatus !== 'ready'}
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
