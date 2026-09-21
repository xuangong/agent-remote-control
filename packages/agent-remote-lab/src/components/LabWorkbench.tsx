import { useFeedbackToast, useToastAnchor } from './Toast.js';
import type { ImageUploadReceipt, MessagePart, ResourceResponseState } from '@orchardworks/agent-remote-protocol';
import type { AgentCommand, AgentCommandResult, AgentMessageOptions } from '@orchardworks/agent-remote-protocol';
import { useContext, useEffect, useId, useLayoutEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import type {
  AgentInteractionResponse,
  ResourceBinding,
} from '@orchardworks/agent-remote-protocol';
import type { AgentReplicaState, RemoteSessionStatus } from '@orchardworks/agent-remote-web';
import { AgentCommandDetails, AgentTimeline, PreviewDock, type AgentChildSessionView, type QuestionDraft, type SessionLinkResolver } from '@orchardworks/agent-remote-web/react';

import { sessionActivity } from '../session-activity.js';
import { RecoveryScope } from '../conversation-recovery.js';
import { LiveControlPanel } from './LiveControlPanel.js';
import { PlanningControl } from './PlanningControl.js';
import { WorkspaceVscodeLink } from './HostVscodeTunnel.js';
import { useTimelineScroll } from '../hooks/useTimelineScroll.js';
import { useRecoveryNotice } from '../hooks/useRecoveryNotice.js';
import type { TraceEntryRequest } from '../trace-model.js';

export interface LabWorkbenchActions {
  loadOlder?(): void | Promise<void>;
  retryMessage?(id: string): Promise<void>;
  deleteMessage?(id: string): void;
  sendMessage?(text: string, options?: AgentMessageOptions): Promise<void>;
  sendMessageContent?(content: readonly MessagePart[], options?: AgentMessageOptions & { imageDigests?: Readonly<Record<string, string>> }): Promise<void>;
  uploadImage?(file: Blob, uploadId: string, options?: { signal?: AbortSignal; onProgress?(loaded: number, total: number): void }): Promise<NonNullable<ImageUploadReceipt['attachment']>>;
  steer?(text: string): Promise<void>;
  cancel?(): Promise<void>;
  respondToInteraction?(requestId: string, response: AgentInteractionResponse): Promise<void>;
  requestResource?(binding: ResourceBinding): Promise<void | ResourceResponseState>;
  resolveResource?(locator: string, sourceLocator?: string): Promise<ResourceBinding>;
  setPlanning?(active: boolean): Promise<void>;
  setSessionSetting?(id: string, value: string): Promise<void>;
  listCommands?(): Promise<AgentCommand[]>;
  executeCommand?(id: string, args: string): Promise<AgentCommandResult>;
}

export function LabWorkbench({ compact = false, onInspectEntry, revealEntry, state, sessionStatus, attachingAgentId, actions: suppliedActions, visible = true, questionDrafts, onQuestionDraftChange, messageDraft, draftSessionKey, onMessageDraftChange, onOpenChildSession, childrenFor, resolveSessionLink, conversationPath, sessionManager, composerContext, composerNotice, consoleCommands, onExecuteConsoleCommand }: { compact?: boolean; onInspectEntry?: (key: string) => void; revealEntry?: TraceEntryRequest; composerContext?: ReactNode; composerNotice?: ReactNode; consoleCommands?: readonly (AgentCommand & { aliases?: readonly string[] })[]; onExecuteConsoleCommand?(id: string, args: string): Promise<AgentCommandResult>; state?: AgentReplicaState; sessionStatus: RemoteSessionStatus; attachingAgentId?: string; actions: LabWorkbenchActions; conversationPath?: ReactNode; sessionManager?: ReactNode; resolveSessionLink?: SessionLinkResolver; childrenFor?: (nativeSessionId: string) => readonly AgentChildSessionView[]; onOpenChildSession?: (child: AgentChildSessionView) => void | Promise<void>; visible?: boolean; draftSessionKey?: string; messageDraft?: string; onMessageDraftChange?(text: string): void; questionDrafts?: Readonly<Record<string, QuestionDraft>>; onQuestionDraftChange?: (requestId: string, draft: QuestionDraft) => void }) {
  const suppliedFeedbackActions = useActionFeedback(suppliedActions, state?.agent?.id);
  const actions = sessionStatus === 'ready' ? suppliedFeedbackActions : { deleteMessage: suppliedFeedbackActions.deleteMessage };
  const recoveryPositions = useContext(RecoveryScope);
  const localPositions = useMemo(() => new Map(), []);
  const readingPositions = recoveryPositions ?? localPositions;
  const [composerHidden, setComposerHidden] = useState(false);
  const composerId = useId();
  const toastAnchor = useToastAnchor(visible && !!state?.agent && !composerHidden);
  const toastToggleAnchor = useToastAnchor<HTMLButtonElement>(visible && !!state?.agent && !compact);
  const [inspected, setInspected] = useState<{ agentId: string; command: AgentCommand }>();
  const selectedCommand = inspected?.agentId === state?.agent?.id ? inspected?.command : undefined;
  const scroll = useTimelineScroll(JSON.stringify([state?.agent?.id, state?.timeline.epoch]), visible, readingPositions, undefined,
    actions.loadOlder ? { hasOlder: state?.timeline.hasOlder === true, cursor: state?.timeline.entries[0]?.seqStart.toString(), load: actions.loadOlder } : undefined);
  const consumedReveal = useRef<string>();
  useLayoutEffect(() => {
    if (!visible || !revealEntry) return;
    const request = JSON.stringify([state?.agent?.id, state?.timeline.epoch, revealEntry.requestId]);
    if (consumedReveal.current !== request && scroll.revealEntry(revealEntry.key)) consumedReveal.current = request;
  }, [visible, revealEntry, state?.agent?.id, state?.timeline.epoch, state?.timeline.entries]);
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
  const runtimeMutationDisabled = runtimeConnection !== undefined && runtimeConnection.state !== 'connected';
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
    visible && !runtimeError,
  );
  useFeedbackToast('Session runtime', visible ? runtimeError
    ?? (recoveryNoticeDue ? runtimeNotice ?? 'Timeline synchronization is reconnecting.' : undefined) : undefined,
    runtimeError ? 'error' : 'info');
  const activity = sessionActivity(state);
  const activityLabel = agentFailure ? 'Agent failed'
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
  return <div className={`lab-workbench-layout${compact ? ' lab-workbench-compact' : ''}${selectedCommand ? ' lab-command-details-open' : ''}`}>
    <header className="lab-workbench-heading">
      <div>
        {conversationPath}
        <h2 hidden={compact} className="agent-session-title" data-session-status={activity}>{hasReplica ? 'Conversation' : isAttaching ? `${sessionStatus === 'catching_up' ? 'Loading conversation' : 'Opening session'} ${attachingAgentId}` : 'Ready for a session'}</h2>
      </div>
      {sessionManager}
      {!compact ? <WorkspaceVscodeLink workspace={state?.agent?.cwd} /> : null}
      <span className="lab-conversation-status">{hasReplica ? activityLabel : isAttaching ? loadingLabel : 'Awaiting Agent'}</span>
    </header>
    <PreviewDock sessionId={state?.agent?.id ?? attachingAgentId} />
    <div className="lab-timeline-stage">
      <div className="lab-timeline-scroll" data-testid="timeline" ref={scroll.viewportRef} tabIndex={0} onScroll={scroll.onScroll} onWheel={scroll.onWheel} onPointerDown={scroll.onPointerDown} onKeyDown={scroll.onKeyDown} onFocus={scroll.onFocus} onTouchStart={scroll.onTouchStart} onTouchMove={scroll.onTouchMove}>
        <div className="lab-conversation-content" ref={scroll.contentRef}>
          {hasReplica ? <>
            {agentFailure ? <p className="lab-control-note" role="alert">Agent failed: {agentFailure}</p>
              : connectionFailure ? <p className="lab-control-note" role="alert">Agent connection failed: {connectionFailure.message}</p>
              : sessionStatus === 'disconnected' ? <p className="lab-control-note" role="alert">Timeline synchronization is reconnecting.</p> : null}
            {runtimeNotice ? <p className="lab-control-note" role="status">{runtimeNotice}</p> : null}
            <AgentTimeline
              state={state}
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
              interactionDisabled={sessionStatus !== 'ready' || runtimeMutationDisabled}
              onResourceRequest={actions.requestResource}
              onResourceResolve={actions.resolveResource}
              questionDrafts={questionDrafts}
              onQuestionDraftChange={onQuestionDraftChange}
            />
          </> : isAttaching ? <div className="lab-empty-state">
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
    </div>
    <div ref={toastAnchor} className="lab-composer-dock" hidden={!state?.agent} data-collapsed={composerHidden || undefined}>
      <div hidden={composerHidden}>
        {composerContext}
        {composerNotice}
      </div>
      <div className="lab-composer-input-shell">
        <button ref={toastToggleAnchor} hidden={compact} type="button" className="lab-composer-toggle" aria-controls={composerId} aria-expanded={!composerHidden}
          aria-label={composerHidden ? 'Show message input' : 'Hide message input'} title={composerHidden ? 'Show message input' : 'Hide message input'}
          onClick={() => setComposerHidden(hidden => !hidden)}>
          <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
            <path d={composerHidden ? 'm7 14 5-5 5 5' : 'm7 10 5 5 5-5'} />
          </svg>
        </button>
        <div id={composerId} className="lab-composer-body" hidden={composerHidden}>
          <LiveControlPanel
            compact={compact}
            consoleCommands={sessionStatus === 'ready' ? consoleCommands : []}
            onExecuteConsoleCommand={sessionStatus === 'ready' ? onExecuteConsoleCommand : undefined}
            sessionControls={state?.agent ? <PlanningControl key={state.agent.id} state={state} sessionStatus={sessionStatus} onSetPlanning={actions.setPlanning} /> : null}
            state={state}
            sessionKey={draftSessionKey ?? state?.agent?.id}
            draftScope={recoveryPositions?.scope}
            visible={visible}
            onSendMessageContent={suppliedFeedbackActions.sendMessageContent}
            onUploadImage={visible ? actions.uploadImage : undefined}
            draft={messageDraft}
            onDraftChange={onMessageDraftChange}
            disabled={sessionStatus !== 'ready'}
            recovering={!runtimeError && (sessionStatus === 'disconnected' || sessionStatus === 'connecting' || sessionStatus === 'catching_up' || runtimeConnection?.state === 'reconnecting' || runtimeConnection?.state === 'restoring')}
            onSendMessage={suppliedFeedbackActions.sendMessage}
            onCancel={actions.cancel}
            onSetSessionSetting={actions.setSessionSetting}
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
  </div>;
}


function useActionFeedback(actions: LabWorkbenchActions, sessionId?: string): LabWorkbenchActions {
  const activeSession = useRef(sessionId);
  activeSession.current = sessionId;
  const [failure, setFailure] = useState<{ title: string; message: string }>();
  useFeedbackToast(failure?.title ?? 'Session action', failure?.message);
  useEffect(() => setFailure(undefined), [sessionId]);
  function report<Args extends unknown[], Result>(title: string, action: ((...args: Args) => Result) | undefined) {
    return action ? async (...args: Args): Promise<Awaited<Result>> => {
      setFailure(undefined);
      try { return await action(...args); }
      catch (error) {
        if (activeSession.current === sessionId) setFailure({ title, message: error instanceof Error ? error.message : 'The action could not be confirmed. Check its status before retrying.' });
        throw error;
      }
    } : undefined;
  }
  return useMemo(() => ({ ...actions,
    sendMessage: report('Send message', actions.sendMessage), sendMessageContent: report('Send message', actions.sendMessageContent), retryMessage: report('Retry message', actions.retryMessage),
    steer: report('Steer session', actions.steer), cancel: report('Stop work', actions.cancel),
    respondToInteraction: report('Submit response', actions.respondToInteraction),
    setPlanning: report('Change session mode', actions.setPlanning), setSessionSetting: report('Change session setting', actions.setSessionSetting),
    listCommands: report('Load commands', actions.listCommands), executeCommand: report('Run command', actions.executeCommand),
    loadOlder: report('Load conversation history', actions.loadOlder),
  }), [actions, sessionId]);
}
