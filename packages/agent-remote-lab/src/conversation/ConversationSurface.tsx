// The conversation surface both views draw: the frame that composes a session's heading, timeline, composer, command
// details and the assistant's details, from the session's state and the actions its operations allow.
import { useCallback, useContext, useId, useMemo, useState } from 'react';
import { createPortal } from 'react-dom';
import { remoteSessionState, sessionActivityLabel, sessionNotice, sessionNoticeWords, type SessionFacts } from '@orchardworks/agent-client';
import type { AgentCommand } from '@orchardworks/agent-remote-protocol';
import { AgentCommandDetails, LocaleContext, PreviewDock, ProcessModeContext, SessionAttributions, TimelineLettersVisible, useTranslate } from '@orchardworks/agent-client-web/react';
import { SessionViewFrame } from './SessionViewFrame.js';
import { SessionViewOptions } from './SessionViewOptions.js';
import { SessionHeadingActionsPresentationContext } from './SessionHeadingActions.js';
import { AssistantDetailsHostContext, type AssistantDetailsHost } from './assistant/details-host.js';
import { usePhoneLayout } from '../kernel/usePhoneLayout.js';
import { useLettersVisible, useProcessMode } from './useProcessMode.js';
import { ConversationComposer } from './ConversationComposer.js';
import { ConversationDetails } from './ConversationDetails.js';
import { ConversationHeading, TileDetailsPanel, type TileDetails } from './ConversationHeading.js';
import { ConversationTimeline } from './ConversationTimeline.js';
import { sessionActions } from './session-actions.js';
import { useActionFeedback } from './useActionFeedback.js';
import type { SessionWorkbenchProps } from './session-workbench-props.js';

export type { LabWorkbenchActions, SessionWorkbenchProps } from './session-workbench-props.js';

const noAuthenticationError = () => false;

export function SessionWorkbench({ assistant, details, conversationTitle: _conversationTitle, nativeSession, sessionDescription, onNavigateAttribution, processAssistant, sessionState: suppliedSessionState, handoff, workspaceLink, readingPositions: suppliedReadingPositions, draftScope, imageDraftBinding, imageRecipient, isAuthenticationError = noAuthenticationError, authenticationNotice, renderSessionSettingError, renderCommandError, readOnly: recordingReadOnly = false, draftOnly = false, opening = false, openFailed = false, mutationBlocked = false, pendingFirstInputContext, onPendingInputChange, onInspectEntry, revealEntry, state, sessionStatus: connectionStatus, attachingAgentId, actions: suppliedActions, visible = true, questionDrafts, onQuestionDraftChange, messageDraft, draftSessionKey, onMessageDraftChange, onOpenChildSession, childrenFor, resolveSessionLink, conversationPath, headingStart, headingMode = 'inline', sessionManager, headingContext, composerContext, composerNotice, composerStatus, nativeTakeover, consoleCommands, onExecuteConsoleCommand, entrySelection, timelineStart, timelineEnd, sendLater, loadingNotice, host }: SessionWorkbenchProps) {
  const displayScope = draftSessionKey ?? state?.agent?.runtimeInfo.sessionId ?? attachingAgentId;
  const providedHost = useContext(AssistantDetailsHostContext);
  const assistantChrome = headingMode === 'assistant', tileChrome = headingMode === 'tile';
  // A tile opens its assistant's details over the window, or as a sheet on a phone.
  const phone = usePhoneLayout();
  const [tileDetailsOpen, setTileDetailsOpen] = useState(false);
  const [tileDetailsSlot, setTileDetailsSlot] = useState<HTMLElement | null>(null);
  const tileDetailsId = useId();
  const tileDetails: TileDetails = { open: tileDetailsOpen, id: tileDetailsId, setOpen: setTileDetailsOpen };
  const detailsHost: AssistantDetailsHost | undefined = providedHost ?? (tileChrome ? { surface: phone ? 'sheet' : 'panel', slot: tileDetailsSlot, open: tileDetailsOpen,
    setOpen: setTileDetailsOpen } : undefined);
  const process = useProcessMode(processAssistant);
  const mission = processAssistant ? { text: processAssistant.details?.mission ?? '', save: (text: string) => {
    const { mission: _previous, ...rest } = processAssistant.details ?? {};
    processAssistant.update(text ? { ...rest, mission: text } : rest);
  } } : undefined;
  const [lettersVisible] = useLettersVisible();
  const session = suppliedSessionState ?? remoteSessionState(state, connectionStatus);
  const sessionStatus = session.connection;
  const controlReadOnly = !!nativeTakeover || (!draftOnly && session.readOnly);
  const readOnly = recordingReadOnly || controlReadOnly;
  // The composer presents failures of its own setting and command controls where they happen.
  const { actions: suppliedFeedbackActions, reauthenticate } = useActionFeedback(suppliedActions, state?.agent?.id, isAuthenticationError,
    renderCommandError ? ['composer.action.setting', 'composer.action.command'] : ['composer.action.setting']);
  const actions = sessionActions({ draftOnly, readOnly, mutationBlocked, session }, suppliedFeedbackActions);
  const localPositions = useMemo(() => new Map(), []);
  const readingPositions = suppliedReadingPositions ?? localPositions;
  const [timelineToolsTarget, setTimelineToolsTarget] = useState<HTMLDivElement | null>(null);
  const [headingSearchTarget, setHeadingSearchTarget] = useState<HTMLSpanElement | null>(null);
  const [inspected, setInspected] = useState<{ agentId: string; command: AgentCommand }>();
  const selectedCommand = inspected?.agentId === state?.agent?.id ? inspected?.command : undefined;
  const hasReplica = state !== undefined;
  const nativeFailure = state?.agent?.runtimeInfo.failure;
  const failureInTimeline = !!nativeFailure?.turnId && state?.timeline.entries.some(entry =>
    entry.turnId === nativeFailure.turnId && entry.item.type === 'error' && entry.item.message === nativeFailure.message);
  const runtimeMutationDisabled = mutationBlocked || !session.operations.interaction_response.allowed;
  // A message quoted from the timeline's menu goes into this conversation's composer, when the composer takes text.
  const [quote, setQuote] = useState<{ id: number; text: string }>();
  const quoteMessage = useCallback((text: string) => setQuote(previous => ({ id: (previous?.id ?? 0) + 1, text })), []);
  const quotable = !readOnly && !mutationBlocked && !nativeTakeover && (hasReplica || draftOnly);
  // The one business notice of the session (target T5), said once: above the timeline for a refused, failed or unavailable
  // session, in the composer's context for an offline Host or a usage limit, and by the composer's control notice for a read-only lease.
  const facts: SessionFacts = { session, host, replica: state, now: Date.now() };
  const locale = useContext(LocaleContext);
  const notice = sessionNotice(facts);
  const activity = session.activity;
  const t = useTranslate();
  const activityLabel = sessionActivityLabel(facts, false, t) ?? '';
  const timelineNotice = notice && (notice.kind === 'unavailable' || notice.kind === 'agent_unavailable' || notice.kind === 'failed' && !failureInTimeline) ? notice : undefined;
  const hasTarget = (draftSessionKey ?? attachingAgentId) !== undefined;
  const hostNotice = notice?.kind === 'host_offline' && !(state === undefined && loadingNotice) || notice?.kind === 'usage_limited' ? sessionNoticeWords(notice, t, locale) : undefined;
  const viewOptions = <SessionViewOptions key={displayScope} process={process} />;
  const layoutClass = [selectedCommand ? 'lab-command-details-open' : '', headingMode !== 'inline' ? 'lab-workbench-toolbar-heading' : ''].filter(Boolean).join(' ');
  return <ProcessModeContext.Provider value={process.mode}><TimelineLettersVisible.Provider value={lettersVisible}>
    <SessionAttributions description={sessionDescription} onNavigate={onNavigateAttribution}>{({ toggle, details: attributionDetails }) => <SessionViewFrame className={layoutClass} nativeSession={nativeSession}>
    <ConversationHeading mode={headingMode} assistant={assistant} conversationPath={conversationPath} sessionManager={sessionManager} headingStart={headingStart} workspaceLink={workspaceLink}
      viewOptions={viewOptions} headingContext={headingContext} attributionToggle={toggle} attributionDetails={attributionDetails} activity={activity} activityLabel={activityLabel}
      host={host} notice={notice} titled={hasReplica || hasTarget} displayScope={displayScope} tileDetails={tileDetails} searchSlotRef={setHeadingSearchTarget} />
    <PreviewDock sessionId={state?.agent?.id ?? attachingAgentId} />
    <ConversationTimeline toolsTargetRef={setTimelineToolsTarget} toolsCollapsible={headingMode === 'toolbar'} toolsScope={displayScope}
      searchTriggerTarget={headingMode === 'inline' || tileChrome ? headingSearchTarget : assistantChrome ? detailsHost?.tools ?? null : undefined} nativeTakeover={!!nativeTakeover} readOnly={readOnly} state={state} sessionStatus={sessionStatus} attachingAgentId={attachingAgentId}
      visible={visible} readingPositions={readingPositions} actions={actions} revealEntry={revealEntry}
      notice={timelineNotice} hasTarget={hasTarget} runtimeMutationDisabled={runtimeMutationDisabled}
      onInspectEntry={onInspectEntry} onOpenChildSession={onOpenChildSession} childrenFor={childrenFor} resolveSessionLink={resolveSessionLink}
      questionDrafts={questionDrafts} onQuestionDraftChange={onQuestionDraftChange} entrySelection={entrySelection} timelineStart={timelineStart} timelineEnd={timelineEnd} loadingNotice={loadingNotice} assistant={assistant}
      onQuote={quotable ? quoteMessage : undefined} />
    {headingMode === 'toolbar' && timelineToolsTarget ? createPortal(<SessionHeadingActionsPresentationContext.Provider value="inline">{workspaceLink}{sessionManager}{viewOptions}{toggle}</SessionHeadingActionsPresentationContext.Provider>, timelineToolsTarget) : null}
    <ConversationComposer composerStatus={composerStatus} composerContext={composerContext} composerNotice={composerNotice} authenticationNotice={authenticationNotice} reauthenticate={reauthenticate}
      hostNotice={hostNotice} nativeTakeover={nativeTakeover} host={host} opening={opening} openFailed={openFailed} onPendingInputChange={onPendingInputChange}
      pendingFirstInputContext={pendingFirstInputContext} consoleCommands={consoleCommands} onExecuteConsoleCommand={onExecuteConsoleCommand} draftSessionKey={draftSessionKey}
      draftScope={draftScope} imageDraftBinding={imageDraftBinding} imageRecipient={imageRecipient} messageDraft={messageDraft} onMessageDraftChange={onMessageDraftChange}
      sendLater={sendLater} renderSessionSettingError={renderSessionSettingError} renderCommandError={renderCommandError} handoff={handoff} state={state} session={session}
      sessionStatus={sessionStatus} visible={visible} draftOnly={draftOnly} hasTarget={hasTarget} readOnly={readOnly} controlReadOnly={controlReadOnly} recordingReadOnly={recordingReadOnly}
      mutationBlocked={mutationBlocked} chromeless={assistantChrome || tileChrome} recipient={assistant?.name} actions={actions} feedbackActions={suppliedFeedbackActions}
      takeControl={suppliedActions.takeControl} onInspectCommand={command => { if (state?.agent) setInspected({ agentId: state.agent.id, command }); }} quote={quote} />
    {selectedCommand && state ? <AgentCommandDetails key={`${state.agent?.id}:${selectedCommand.id}`} command={selectedCommand} resources={state.resources}
      onRequestResource={actions.requestResource} onResolveResource={actions.resolveResource}
      resourceScopeKey={JSON.stringify([state.agent?.id, selectedCommand.id])}
      onClose={() => setInspected(undefined)} /> : null}
    {tileChrome && !phone ? <TileDetailsPanel tileDetails={tileDetails} slotRef={setTileDetailsSlot} /> : null}
    <ConversationDetails host={detailsHost} visible={visible} state={state} details={details} assistant={assistant} displayScope={displayScope} process={process} {...(mission ? { mission } : {})} {...(processAssistant?.details?.botId ? { botId: processAssistant.details.botId } : {})} session={session}
      sessionStatus={sessionStatus} readOnly={readOnly} mutationBlocked={mutationBlocked} draftOnly={draftOnly} actions={actions} renderSessionSettingError={renderSessionSettingError}
      childrenFor={childrenFor} onOpenChildSession={onOpenChildSession} workspaceLink={workspaceLink} {...(nativeSession ? { nativeSession } : {})} />
  </SessionViewFrame>}</SessionAttributions></TimelineLettersVisible.Provider></ProcessModeContext.Provider>;
}
