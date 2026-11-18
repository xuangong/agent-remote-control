// How a view presents its session, bot actions and folding.
import { awakeDetails, closeOperation, foldsOnClose as foldsOnCloseOf, isAsleep, restorePlan } from '../state/pane-folding.js';
import { isBotView, type WindowView, type AgentCommandResult, type WindowSessionBinding, type SessionExcerpt } from '@orchardworks/agent-remote-protocol';
import { windowSessionBinding } from '../window-workspace.js';
import { botActivityLabel, botRole } from '../bot-roster.js';
import { SessionOutboxMessages } from '../components/OutboxMessages.js';
import { BotPicture, botDisplayName } from '../components/BotRoster.js';
import { sessionActivity } from '../session-activity-status.js';
import type { SessionAttribution, AgentReplicaState } from '@orchardworks/agent-client';
import { labSessionSuccessionDirectory } from '../session-succession-directory.js';
import type { FamilySessionPresentationContext } from '../components/SessionFamily.js';
import { SessionSuccessionHistory } from '../components/SessionSuccessionHistory.js';
import { handoffCommand, handoffProvider } from '../handoff-command.js';
import { SessionTitle } from '../components/SessionTitle.js';
import { StarButton } from '../components/SessionFavorites.js';
import { sessionConnectionFailure } from '../components/SessionConnectionNotice.js';
import { SessionLink } from '../components/SessionLink.js';
import { SessionHeadingActions } from '../components/SessionHeadingActions.js';
import { useCallback, useRef } from 'react';
import { SessionDirectoryClient } from '../directory-client.js';
import { sessionKey } from '../session-tree.js';
import { ChatSessionManager } from '../components/ChatSessionManager.js';
import { ForkEntries, ForkReference } from '../components/ForkReference.js';
import { refCommand, SessionReferences } from '../components/SessionReferences.js';
import { loadSessionRefs, sessionRefsEntry } from '../session-references.js';
import { sideNavigationSource, forkDisplayState } from '../session-forks.js';
import type { FoldedBot } from '../components/SessionDock.js';
import { TypingBubble } from '../components/TypingBubble.js';
import { forkActions, forkCommands } from '../fork-actions.js';
import { restoreQuotes } from '../session-quotes.js';
import { QuoteAttachments, QuoteMessagesButton, QuoteNotice, QuoteSelectionBar } from '../components/SessionQuotes.js';
import type { QuestionDraft } from '@orchardworks/agent-client-web/react';
import { IconButton } from '../ui/IconButton.js';
import { message, viewKey } from './helpers.js';
import type { SessionSuccessionBindingSlice } from './useSessionSuccessionBinding.js';
import type { ViewSessionStateSlice } from './useViewSessionState.js';
import type { ProviderStateSlice } from './useProviderState.js';
import type { RequestedSessionSlice } from './useRequestedSession.js';
import type { WorkbenchRecordsSlice } from './useWorkbenchRecords.js';
import type { WorkbenchShellSlice } from './useWorkbenchShell.js';
import type { SendingAndSuccessionSlice } from './useSendingAndSuccession.js';
import type { RemoteHostStateSlice } from './useRemoteHostState.js';
import type { FocusedAskSlice } from './useFocusedAsk.js';
import type { SideNavigationSlice } from './useSideNavigation.js';
import type { PanelsAndShortcutsSlice } from './usePanelsAndShortcuts.js';
import type { TraceNavigationSlice } from './useTraceNavigation.js';
import type { QuotesAndReferencesSlice } from './useQuotesAndReferences.js';
import type { CommunicationsAndForksSlice } from './useCommunicationsAndForks.js';
import type { SessionOpeningSlice } from './useSessionOpening.js';
import type { SideSelectionSlice } from './useSideSelection.js';
import type { ActiveSessionSlice } from './useActiveSession.js';
import type { AttentionAndRosterSlice } from './useAttentionAndRoster.js';
import type { WindowModeActionsSlice } from './useWindowModeActions.js';
import type { AppInputs } from './types.js';

export function useSessionViewPresentation(scope: Pick<AppInputs & SessionSuccessionBindingSlice & ViewSessionStateSlice & ProviderStateSlice & RequestedSessionSlice & WorkbenchRecordsSlice & WorkbenchShellSlice & SendingAndSuccessionSlice & RemoteHostStateSlice & FocusedAskSlice & SideNavigationSlice & PanelsAndShortcutsSlice & TraceNavigationSlice & QuotesAndReferencesSlice & CommunicationsAndForksSlice & SessionOpeningSlice & SideSelectionSlice & ActiveSessionSlice & AttentionAndRosterSlice & WindowModeActionsSlice, 'accessReady' | 'actions' | 'assertSourceCurrent' | 'baseUrl' | 'bindDirectorySession' | 'botHandoff' | 'compactLayout' | 'conversationHistory' | 'createFork' | 'currentBotSession' | 'directory' | 'dispatchQuote' | 'earlierConversationFor' | 'favorites' | 'forkInputStatus' | 'forkStore' | 'letterReveals' | 'missingSessions' | 'navigation' | 'openExcerptSource' | 'openFork' | 'openLocalView' | 'openSession' | 'openSideKeys' | 'questionDrafts' | 'quoteEntrySelection' | 'quoteNotice' | 'quoteSelected' | 'quoteSelection' | 'quoteTargets' | 'quotedActions' | 'referencePicker' | 'referencedActions' | 'refreshRelations' | 'remoteHosts' | 'removedReference' | 'restoredReference' | 'revealEarlier' | 'revealSession' | 'sessionEntries' | 'setPendingGroupInputs' | 'setQuestionDrafts' | 'setReferencePicker' | 'setRemovingBot' | 'setRenamingSession' | 'setSessionNotice' | 'setSuccessionDialog' | 'setTraceNavigation' | 'sharedWindow' | 'showView' | 'sourceCurrent' | 'sourceStateFor' | 'state' | 'succession' | 'successionDialog' | 'successionGated' | 'successionProgress' | 'supportTeams' | 'traceRequest' | 'traceRequestCounter' | 'tracking' | 'transport' | 'unlinkSide' | 'userScoped' | 'windowWorkspace' | 'withConfirmedTitle'>) {
  const { accessReady, actions, assertSourceCurrent, baseUrl, bindDirectorySession, botHandoff, compactLayout, conversationHistory, createFork, currentBotSession, directory, dispatchQuote, earlierConversationFor, favorites, forkInputStatus, forkStore, letterReveals, missingSessions, navigation, openExcerptSource, openFork, openLocalView, openSession, openSideKeys, questionDrafts, quoteEntrySelection, quoteNotice, quoteSelected, quoteSelection, quoteTargets, quotedActions, referencePicker, referencedActions, refreshRelations, remoteHosts, removedReference, restoredReference, revealEarlier, revealSession, sessionEntries, setPendingGroupInputs, setQuestionDrafts, setReferencePicker, setRemovingBot, setRenamingSession, setSessionNotice, setSuccessionDialog, setTraceNavigation, sharedWindow, showView, sourceCurrent, sourceStateFor, state, succession, successionDialog, successionGated, successionProgress, supportTeams, traceRequest, traceRequestCounter, tracking, transport, unlinkSide, userScoped, windowWorkspace, withConfirmedTitle } = scope;

  /** A bot at work: running a turn, not waiting for the owner, and connected to its agent. */
  function botWorking(state: AgentReplicaState | undefined): boolean {
    const agent = state?.agent;
    return !!agent && (agent.status === 'running' || agent.status === 'starting') && !state!.pendingInteractions.length
      && agent.runtimeInfo.connection?.state !== 'unavailable';
  }

  /** Whether the shown Window's view is a bot put to sleep (stored with its group). */
  function asleepBot(view: { id: string }) {
    return !!sharedWindow && isAsleep(windowWorkspace.readGroup(sharedWindow.id), view.id);
  }

  /** Wakes a sleeping bot for every device, keeping its other details. */
  function wakeBot(groupId: string, viewId: string) {
    const details = awakeDetails(windowWorkspace.readGroup(groupId)?.bots?.members[viewId]);
    void windowWorkspace.operateGroup(groupId, { type: 'bot.update', viewId, details }).catch(error => setSessionNotice(sessionConnectionFailure(error, false)));
  }

  /** A bot of a group shown in Bot mode folds when its pane closes; removing it from the group is a separate, confirmed step. */
  function foldsOnClose(view: WindowView | undefined): view is WindowView & { binding: WindowSessionBinding } {
    return foldsOnCloseOf(view, sharedWindow ? windowWorkspace.readGroup(sharedWindow.id) : undefined, !!view?.binding && missingSessions.has(sessionKey(view.binding)));
  }

  /** The × of a pane in the shown Window: a bot folds where it stands, any other view closes. */
  function closeView(viewId: string) {
    const authority = windowWorkspace.authority, current = authority?.readWindow?.() ?? authority?.window;
    if (!authority || !current) return;
    authority.operate(closeOperation(current, viewId, foldsOnClose(current.views.find(view => view.id === viewId))));
  }

  function sessionViewPresentation(context: FamilySessionPresentationContext, options: { team?: boolean; bot?: { groupId: string; viewId: string }; fallback?: boolean } = {}) {
    const team = options.team === true, botPresentation = !!options.bot || options.fallback === true;
    const source = { ...(team ? context.session : withConfirmedTitle(context.session)), hostId: context.session.hostId ?? 'local', viewId: context.viewId!, ...(options.bot ? { bot: options.bot } : options.fallback ? { fallback: true } : {}) };
    const botGroup = options.bot ? windowWorkspace.readGroup(options.bot.groupId) : undefined;
    const view = options.bot ? botGroup?.window.views.find(view => view.id === options.bot!.viewId) : sharedWindow?.views.find(view => view.id === context.windowViewId);
    // In a group with bot details, a bot's pane in Window mode is the same bot: its conversation goes on into its earlier
    // sessions in place, as in Bot mode, since the group keeps the bot's conversation (rule 1). An ordinary Window opens
    // them in the view instead.
    const windowBot = !botPresentation && !!view && isBotView(view) && !!sharedWindow && !!windowWorkspace.readGroup(sharedWindow.id)?.bots;
    const isPrimary = view?.placement === 'primary';
    const fork = forkStore.find(source);
    // In a Window, a fork view's input belongs to the fork only while that view still shows it.
    const forkTarget = fork?.target;
    const targetsFork = forkTarget && context.windowViewId ? () => {
      const binding = windowWorkspace.readWindow()?.views.find(item => item.id === context.windowViewId)?.binding;
      return !!binding && sessionKey({ ...binding, hostId: binding.hostId ?? 'local' }) === sessionKey({ ...forkTarget, hostId: forkTarget.hostId ?? 'local' });
    } : undefined;
    const commands = botPresentation ? context.actions : forkActions(actions ?? context.actions, forkStore, fork, transport, targetsFork);
    const gated = successionGated && successionDialog?.scope === baseUrl && viewKey(successionDialog.source) === source.viewId;
    const host = remoteHosts.find(host => host.id === source.hostId);
    const available = accessReady && !context.offline && context.status === 'ready' && !context.pending && sourceCurrent(source);
    const handoffAvailable = available && (!botPresentation || context.state?.agent?.status === 'idle') && !successionDialog && userScoped && !!directory && !source.parentNativeSessionId
      && !context.sessionState.readOnly && !context.operationBinding.historical && host?.access !== 'shared' && host?.online === true;
    const mayRename = !team && userScoped && host?.online && host.access !== 'shared' && host.providers?.some(provider => provider.providerId === source.providerId && provider.sessionRename);
    const sourceForks = forkStore.linked().filter(item => item.target && sessionKey(sideNavigationSource(item)) === sessionKey(source));
    // References live on the Host; a shared Host's sessions keep showing only their source.
    const referencing = userScoped && !!directory && host?.access !== 'shared' && !!host?.providers?.some(provider => provider.providerId === source.providerId && provider.sessionReferences);
    const refHolder = { hostId: source.hostId, providerId: source.providerId, nativeSessionId: source.nativeSessionId };
    // A Controller that tells the agent itself needs no note from this page.
    const pageNotes = referencing && !host?.providers?.some(provider => provider.providerId === source.providerId && provider.referenceNotes);
    // A conversation whose Host is offline can still be written to: the message waits for the Host when its Controller delivers from the outbox.
    const outboxTarget = { hostId: source.hostId, providerId: source.providerId, nativeSessionId: source.nativeSessionId };
    const writable = !!context.offline && !!host && host.access !== 'shared' && !source.parentNativeSessionId && !context.operationBinding.historical;
    const laterHost = writable && host!.outbox === 1 && transport.queueMessage ? host : undefined;
    const outdatedOffline = writable && host!.outbox !== 1 && !!transport.queueMessage;
    const forkReference = fork ? <ForkReference fork={fork} onOpen={revealSession} onUnlink={unlinkSide} onRecover={record => refreshRelations.reconcile(record)} /> : null;
    // Quoting happens between the session views of shared Windows.
    const quoteView = !botPresentation && sharedWindow && context.windowViewId && !source.parentNativeSessionId ? context.windowViewId : undefined;
    return {
      headingMode: compactLayout ? 'toolbar' as const : 'inline' as const,
      state: botPresentation ? context.state : forkDisplayState(context.state, fork),
      questionDrafts: questionDrafts[source.agentId] ?? {},
      onQuestionDraftChange: (requestId: string, draft: QuestionDraft) => setQuestionDrafts(current => ({
        ...current, [source.agentId]: { ...current[source.agentId], [requestId]: draft },
      })),
      // A cached Window not yet confirmed by the service shows its sessions without sending to them.
      mutationBlocked: gated || windowWorkspace.provisional,
      onInspectEntry: botPresentation ? undefined : (key: string) => {
        if (view) windowWorkspace.authority?.operate({ type: 'view.select', viewId: view.id });
        setTraceNavigation({ scope: JSON.stringify([context.state?.agent?.id, context.state?.timeline.epoch]), key, view: 'trace', requestId: ++traceRequestCounter.current });
        showView('trace');
      },
      revealEntry: botPresentation ? undefined : letterReveals[source.agentId] ?? (traceRequest?.view === 'workbench' && context.state?.agent?.id === state?.agent?.id ? traceRequest : undefined),
      onNavigateAttribution: botPresentation ? async (attribution: SessionAttribution) => {
        if (!attribution.target) return;
        if (attribution.target.kind === 'group') throw new Error('Open this group in Window mode.');
        navigation.select({ kind: 'session', session: { ...attribution.target, title: attribution.value } });
      } : undefined,
      onPendingInputChange: (count: number) => setPendingGroupInputs(values => values[source.viewId] === count ? values : { ...values, [source.viewId]: count }),
      actions: botPresentation ? commands : forkInputStatus?.pending && forkInputStatus.agentId === source.agentId ? { deleteMessage: commands.deleteMessage }
        : pageNotes ? referencedActions(quoteView ? quotedActions(commands, quoteView) : commands, source, context.state) : quoteView ? quotedActions(commands, quoteView) : commands,
      ...(quoteView && context.state ? { entrySelection: quoteEntrySelection(quoteView, context.state.timeline.epoch) } : {}),
      ...(quoteView ? { receiveQuotes: (excerpts: readonly SessionExcerpt[]) => restoreQuotes(baseUrl, quoteView, excerpts) } : {}),
      // In Bot mode a Side joins the bot's group beside it (a Side is a bot); a fork or an Ask would open elsewhere.
      consoleCommands: [...(available && directory && context.state?.agent?.capabilities.sendMessage && context.state.agent.capabilities.history ? botPresentation ? options.bot ? forkCommands.filter(command => command.id === 'console:side') : [] : forkCommands : []), ...(handoffAvailable ? [handoffCommand] : []),
        ...(!botPresentation && referencing && available ? [refCommand] : [])],
      onExecuteConsoleCommand: async (id: string, args: string): Promise<AgentCommandResult> => {
        if (id === refCommand.id) {
          await loadSessionRefs(baseUrl, refHolder);
          if (sessionRefsEntry(baseUrl, refHolder).unsupported) throw new Error('Referencing sessions needs a newer Controller. Update the Controller in Settings.');
          setReferencePicker(source.viewId);
          return {};
        }
        assertSourceCurrent(source);
        if (id === handoffCommand.id) {
          if (botPresentation && sourceStateFor(source)?.agent?.status !== 'idle') throw new Error('Wait for this conversation to become idle before handing it off.');
          if (!handoffAvailable) throw new Error('Handoff requires a current writable conversation with authorized Host access.');
          setSuccessionDialog({ scope: baseUrl, source, visible: true, initialProvider: handoffProvider(args), directory: labSessionSuccessionDirectory(new SessionDirectoryClient(baseUrl, undefined, source.hostId)) });
          return {};
        }
        // A Side joins a bot's group; a session listed under Other sessions has no group to join.
        if (botPresentation && (id !== 'console:side' || !options.bot)) throw new Error('This command is unavailable in Bot mode.');
        if (!context.state || !available) throw new Error('Wait for this session to finish synchronizing.');
        return createFork(context.state, source, id, args);
      },
      composerStatus: <>{!botHandoff && (gated || successionDialog && viewKey(successionDialog.source) === source.viewId) ? successionProgress : null}
        {quoteView && quoteSelection?.viewId === quoteView && context.state ? <QuoteSelectionBar count={quoteSelection.keys.size} windows={quoteTargets(quoteView, source)}
          busy={!!quoteSelection.busy} error={quoteSelection.error} onCancel={() => dispatchQuote({ type: 'cancel' })}
          onQuote={target => void quoteSelected(quoteView, source, context.state!, target)} /> : null}
        {quoteView && quoteNotice?.viewId === quoteView ? <QuoteNotice message={quoteNotice.message} onDismiss={() => dispatchQuote({ type: 'notice.dismiss' })}
          onOpen={quoteNotice.open ? () => { const open = quoteNotice.open!; dispatchQuote({ type: 'notice.dismiss' }); void open().catch(() => {}); } : undefined} /> : null}</>,
      // Bot mode does not announce a handoff: the conversation continues into the earlier sessions instead of linking to them.
      timelineStart: botPresentation || windowBot ? earlierConversationFor(succession.historyNavigationFor(source)) : undefined,
      // Bot mode shows a bot at work as a chat shows a contact typing, until it finishes, waits for the owner or disconnects.
      timelineEnd: <>{transport.cancelQueuedMessage ? <SessionOutboxMessages session={outboxTarget} hostName={host?.name ?? source.hostId} hostOnline={host?.online === true}
          onCancel={async id => { await transport.cancelQueuedMessage!(id); }} onRetry={async id => { await transport.retryQueuedMessage!(id); }} /> : null}
        {botPresentation && botWorking(context.state) ? <TypingBubble name={source.title || source.nativeSessionId} /> : null}</>,
      ...(laterHost ? { sendLater: { label: `Send when ${laterHost.name} is back`, send: async (text: string) => { await transport.queueMessage!(outboxTarget, text); } } } : {}),
      ...(context.offline && host ? { loadingNotice: { title: `${host.name} is offline`,
        detail: laterHost ? 'The conversation appears here when it is back. Messages you send now wait for it.' : 'The conversation appears here when it is back.' } } : {}),
      // Window mode says where a bot's conversation came from; its links read the earlier session in the bot's own pane.
      headingContext: botPresentation ? undefined : <SessionSuccessionHistory navigation={succession.historyNavigationFor(source)}
        onOpen={(session, intent) => windowBot ? Promise.resolve(revealEarlier(view!.id, session))
          : view && sharedWindow ? bindDirectorySession({ ...session, sessionIntent: intent }, { windowId: sharedWindow.id, viewId: view.id, binding: JSON.stringify(view.binding ?? null) })
          : Promise.resolve(false)} />,
      composerContext: botPresentation ? undefined : <>{referencing ? <SessionReferences scope={baseUrl} holder={refHolder} providers={host?.providers?.map(provider => provider.providerId) ?? [source.providerId]}
          fallback={forkReference} snapshot={fork?.mode === 'reference' ? null : forkReference} picking={referencePicker === source.viewId}
          shown={new Set(sourceForks.flatMap(item => item.target ? [`${item.target.providerId}/${item.target.nativeSessionId}`] : []))} onPickingChange={picking => setReferencePicker(picking ? source.viewId : undefined)}
          onOpen={ref => void openExcerptSource({ hostId: source.hostId, providerId: ref.providerId, nativeSessionId: ref.nativeSessionId, title: ref.title ?? '' })}
          onRemoved={(ref, restore) => removedReference(ref, restore, fork)} onRestore={() => restoredReference(fork)} /> : forkReference}
        {quoteView ? <QuoteAttachments scope={baseUrl} viewId={quoteView} /> : null}</>,
      composerNotice: outdatedOffline ? <p className="agent-composer-note lab-outbox-hint" role="status">Update the Controller on {host!.name} to send while it is offline.</p>
        : botPresentation ? undefined : <ForkEntries forks={sourceForks} openSides={openSideKeys(source.viewId)} onOpen={record => void openFork({ ...record, navigationSource: source })} onUnlink={unlinkSide} onRecover={record => refreshRelations.reconcile(record)} />,
      sessionManager: botPresentation ? undefined : <>{context.controls}{isPrimary ? <IconButton icon="close" data-pane-selection-ignore label={`Close primary group: ${source.title}`}
        title={foldsOnClose(view) ? 'Fold. It stays in this group.' : 'Close this session view. Agent sessions keep running.'}
        onClick={() => closeView(view.id)} /> : null}
        {!compactLayout ? <StarButton session={source} favorites={favorites} /> : null}
        <SessionHeadingActions sessionKey={sessionKey(source)} alwaysCollapsed={!!context.menuActions}>
          {context.menuActions}
          {isPrimary && (!compactLayout || succession.localViews().length > 0) && directory ? <ChatSessionManager current={source} entries={sessionEntries} busy={false}
            localViews={succession.localViews()} activeSlot={context.viewId} onOpenView={view => void openLocalView(view.slotId)}
            onOpen={item => void openSession(item, undefined, undefined, false, undefined, undefined, undefined, undefined, 'primary', view.id)} /> : null}
          {isPrimary && view.id === sharedWindow?.selectedPrimaryViewId ? <nav className="lab-conversation-history" aria-label="Conversation history">
            <button type="button" aria-label="Back to previous conversation" title="Back" disabled={!conversationHistory.canBack} onClick={conversationHistory.back}>←</button>
            <button type="button" aria-label="Forward to next conversation" title="Forward" disabled={!conversationHistory.canForward} onClick={conversationHistory.forward}>→</button>
          </nav> : null}
          <SessionLink session={available ? source : windowSessionBinding(source)} sessionIntent={context.operationBinding.historical ? 'history' : undefined} />
          {quoteView && context.state && quoteSelection?.viewId !== quoteView
            ? <QuoteMessagesButton onClick={() => quoteEntrySelection(quoteView, context.state!.timeline.epoch).select([], true)} /> : null}
        </SessionHeadingActions></>,
      conversationPath: botPresentation ? <span className="lab-bot-session-heading">{options.bot ? <BotPicture picture={botGroup?.bots?.members[options.bot.viewId]?.picture} name={view?.binding ? botDisplayName(view.binding) : source.title} /> : null}<span><strong>{source.title}</strong>{options.bot && botGroup?.bots?.members[options.bot.viewId]?.label ? <small>{botGroup.bots.members[options.bot.viewId]!.label}</small> : null}<small>{context.offline ? 'Host offline' : context.state?.agent?.status === 'waiting' || context.state?.agent?.status === 'starting' ? 'Needs you' : context.state?.agent?.status === 'running' ? 'Working' : context.state?.agent?.status === 'failed' ? 'Failed' : context.status === 'ready' ? 'Idle' : 'Status unavailable'}</small></span></span> : <SessionTitle className={isPrimary ? 'lab-primary-title' : undefined} title={source.title} status={context.state?.agent?.status}
        onRename={mayRename ? () => setRenamingSession({ scope: baseUrl, session: { ...source, hostId: source.hostId ?? 'local' } }) : undefined} />,
    };
  }

  const sessionPresentationRef = useRef(sessionViewPresentation);

  sessionPresentationRef.current = sessionViewPresentation;

  const presentSessionView = useCallback((context: FamilySessionPresentationContext, options?: Parameters<typeof sessionViewPresentation>[1]) => sessionPresentationRef.current(context, options), []);

  /** Removing a view from the shown Window's list: a bot of a group in Bot mode asks first. */
  function confirmBotRemoval(view: WindowView): boolean {
    if (!sharedWindow || !foldsOnClose(view)) return false;
    setRemovingBot({ windowId: sharedWindow.id, viewId: view.id });
    return true;
  }

  /** Restores a folded or sleeping bot's pane and selects it; a sleeping bot wakes for every device. */
  function restoreView(viewId: string) {
    const authority = windowWorkspace.authority, current = authority?.readWindow?.() ?? authority?.window;
    const view = current?.views.find(item => item.id === viewId);
    if (!authority || !current || !view) return;
    const plan = restorePlan(current, view, asleepBot(view));
    if (plan.wake) wakeBot(current.id, viewId);
    if (plan.select) authority.operate(plan.select);
  }

  /** What a folded bot's slim card shows: who it is and how it is doing, from the shared channel, while its conversation is released. */
  function foldedBot(view: WindowView & { binding: WindowSessionBinding }): FoldedBot {
    return { name: botDisplayName(view.binding), picture: sharedWindow ? windowWorkspace.readGroup(sharedWindow.id)?.bots?.members[view.id]?.picture : undefined,
      role: botRole(view, teamId => supportTeams.has(teamId)), asleep: asleepBot(view),
      statusOf: states => botActivityLabel(sessionActivity(sharedWindow ? currentBotSession(sharedWindow.id, view.id, view.binding) : view.binding, tracking.liveObservations, states)) };
  }
  return { asleepBot, wakeBot, foldsOnClose, closeView, presentSessionView, confirmBotRemoval, restoreView, foldedBot };
}

export type SessionViewPresentationSlice = ReturnType<typeof useSessionViewPresentation>;
