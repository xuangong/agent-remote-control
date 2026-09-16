import type { AgentCommand, AgentCommandResult, AgentMessageOptions } from '@agent-remote-controller/agent-remote-protocol';
import { useContext, useId, useMemo, useState, type ReactNode } from 'react';
import type {
  AgentInteractionResponse,
  ResourceBinding,
} from '@agent-remote-controller/agent-remote-protocol';
import type { AgentReplicaState, RemoteSessionStatus } from '@agent-remote-controller/agent-remote-web';
import { AgentCommandDetails, AgentTimeline, type AgentChildSessionView, type QuestionDraft, type SessionLinkResolver } from '@agent-remote-controller/agent-remote-web/react';

import { RecoveryScope } from '../conversation-recovery.js';
import { LiveControlPanel } from './LiveControlPanel.js';
import { PlanningControl } from './PlanningControl.js';
import { useTimelineScroll } from '../hooks/useTimelineScroll.js';

export interface LabWorkbenchActions {
  loadOlder?(): void | Promise<void>;
  sendMessage?(text: string, options?: AgentMessageOptions): Promise<void>;
  steer?(text: string): Promise<void>;
  cancel?(): Promise<void>;
  respondToInteraction?(requestId: string, response: AgentInteractionResponse): Promise<void>;
  requestResource?(binding: ResourceBinding): Promise<void>;
  setPlanning?(active: boolean): Promise<void>;
  setSessionSetting?(id: string, value: string): Promise<void>;
  listCommands?(): Promise<AgentCommand[]>;
  executeCommand?(id: string, args: string): Promise<AgentCommandResult>;
}

export function LabWorkbench({ state, sessionStatus, attachingAgentId, actions, visible = true, questionDrafts, onQuestionDraftChange, messageDraft, onMessageDraftChange, onOpenChildSession, childrenFor, resolveSessionLink, conversationPath, sessionManager, composerContext, composerNotice, consoleCommands, onExecuteConsoleCommand }: { composerContext?: ReactNode; composerNotice?: ReactNode; consoleCommands?: readonly (AgentCommand & { aliases?: readonly string[] })[]; onExecuteConsoleCommand?(id: string, args: string): Promise<AgentCommandResult>; state?: AgentReplicaState; sessionStatus: RemoteSessionStatus; attachingAgentId?: string; actions: LabWorkbenchActions; conversationPath?: ReactNode; sessionManager?: ReactNode; resolveSessionLink?: SessionLinkResolver; childrenFor?: (nativeSessionId: string) => readonly AgentChildSessionView[]; onOpenChildSession?: (child: AgentChildSessionView) => void | Promise<void>; visible?: boolean; messageDraft?: string; onMessageDraftChange?(text: string): void; questionDrafts?: Readonly<Record<string, QuestionDraft>>; onQuestionDraftChange?: (requestId: string, draft: QuestionDraft) => void }) {
  const recoveryPositions = useContext(RecoveryScope);
  const localPositions = useMemo(() => new Map(), []);
  const readingPositions = recoveryPositions ?? localPositions;
  const [composerHidden, setComposerHidden] = useState(false);
  const composerId = useId();
  const [inspected, setInspected] = useState<{ agentId: string; command: AgentCommand }>();
  const selectedCommand = inspected?.agentId === state?.agent?.id ? inspected?.command : undefined;
  const scroll = useTimelineScroll(JSON.stringify([state?.agent?.id, state?.timeline.epoch]), visible, readingPositions, undefined,
    actions.loadOlder ? { hasOlder: state?.timeline.hasOlder === true, cursor: state?.timeline.entries[0]?.seqStart.toString(), load: actions.loadOlder } : undefined);
  const hasReplica = state !== undefined;
  const isAttaching = !hasReplica && attachingAgentId !== undefined;
  const connectionFailure = sessionStatus === 'connecting'
    ? state?.diagnostics.find((diagnostic) => !diagnostic.recoverable)
    : undefined;
  const agentFailure = state?.agent?.status === 'failed'
    ? state.agent.lastError?.trim() || 'The Agent did not provide a failure reason.'
    : undefined;
  const activityLabel = agentFailure ? 'Agent failed'
    : connectionFailure ? 'Connection failed'
    : sessionStatus === 'disconnected' ? 'Reconnecting'
    : sessionStatus === 'connecting' ? 'Connecting'
    : sessionStatus === 'catching_up' ? 'Synchronizing'
    : sessionStatus === 'idle' ? 'Disconnected'
    : !state?.agent ? 'Connecting'
    : state.agent.status === 'closed' ? 'Closed'
    : state.agent.status === 'starting' ? 'Starting'
    : state.pendingInteractions.length > 0 || state.agent.status === 'waiting' ? 'Waiting for response'
    : state.agent.activeTurn || state.agent.status === 'running' ? 'Working'
    : 'Ready';
  return <div className={`lab-workbench-layout${selectedCommand ? ' lab-command-details-open' : ''}`}>
    <header className="lab-workbench-heading">
      <div>
        {conversationPath}
        <h2>{hasReplica ? 'Conversation' : isAttaching ? `Connecting to ${attachingAgentId}` : 'Ready for a session'}</h2>
      </div>
      {sessionManager}
      <span className="lab-conversation-status">{hasReplica ? activityLabel : isAttaching ? 'Connecting' : 'Awaiting Agent'}</span>
    </header>
    <div className="lab-timeline-stage">
      <div className="lab-timeline-scroll" data-testid="timeline" ref={scroll.viewportRef} tabIndex={0} onScroll={scroll.onScroll} onWheel={scroll.onWheel} onPointerDown={scroll.onPointerDown} onKeyDown={scroll.onKeyDown} onFocus={scroll.onFocus} onTouchStart={scroll.onTouchStart} onTouchMove={scroll.onTouchMove}>
        <div className="lab-conversation-content" ref={scroll.contentRef}>
          {hasReplica ? <>
            {agentFailure ? <p className="lab-control-note" role="alert">Agent failed: {agentFailure}</p>
              : connectionFailure ? <p className="lab-control-note" role="alert">Agent connection failed: {connectionFailure.message}</p>
              : sessionStatus === 'disconnected' ? <p className="lab-control-note" role="alert">Timeline synchronization is reconnecting.</p> : null}
            <AgentTimeline
              state={state}
              showHeader={false}
              historyLoading={scroll.historyLoading}
              historyError={scroll.historyError}
              onOpenChildSession={onOpenChildSession}
              childrenFor={childrenFor}
              resolveSessionLink={resolveSessionLink}
              onLoadOlder={actions.loadOlder ? () => scroll.loadOlder(actions.loadOlder!) : undefined}
              onInteractionResponse={actions.respondToInteraction}
              onResourceRequest={actions.requestResource}
              questionDrafts={questionDrafts}
              onQuestionDraftChange={onQuestionDraftChange}
            />
          </> : isAttaching ? <div className="lab-empty-state">
            <span className="lab-empty-icon" aria-hidden="true">↗</span>
            <h3>Connecting to {attachingAgentId}</h3>
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
    <div className="lab-composer-dock" hidden={!state?.agent} data-collapsed={composerHidden || undefined}>
      <button type="button" className="lab-composer-toggle" aria-controls={composerId} aria-expanded={!composerHidden}
        aria-label={composerHidden ? 'Show message input' : 'Hide message input'} title={composerHidden ? 'Show message input' : 'Hide message input'}
        onClick={() => setComposerHidden(hidden => !hidden)}>
        <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
          <path d={composerHidden ? 'm7 14 5-5 5 5' : 'm7 10 5 5 5-5'} />
        </svg>
      </button>
      <div id={composerId} className="lab-composer-body" hidden={composerHidden}>
        {composerContext}
        {composerNotice}
        <LiveControlPanel
          consoleCommands={consoleCommands}
          onExecuteConsoleCommand={onExecuteConsoleCommand}
          sessionControls={state?.agent ? <PlanningControl key={state.agent.id} state={state} sessionStatus={sessionStatus} onSetPlanning={actions.setPlanning} /> : null}
          state={state}
          sessionKey={state?.agent?.id}
          draft={messageDraft}
          onDraftChange={onMessageDraftChange}
          disabled={sessionStatus !== 'ready'}
          onSendMessage={actions.sendMessage}
          onCancel={actions.cancel}
          onSetSessionSetting={actions.setSessionSetting}
          onListCommands={actions.listCommands}
          onExecuteCommand={actions.executeCommand}
          onInspectCommand={(command) => { if (state?.agent) setInspected({ agentId: state.agent.id, command }); }}
        />
      </div>
    </div>
    {selectedCommand && state ? <AgentCommandDetails key={`${state.agent?.id}:${selectedCommand.id}`} command={selectedCommand} resources={state.resources}
      onRequestResource={actions.requestResource} onClose={() => setInspected(undefined)} /> : null}
  </div>;
}
