// How a view presents its session, bot actions and folding: the facts about a view, and the contributions that merge into its props.
import { awakeDetails, closeOperation, foldsOnClose as foldsOnCloseOf, isAsleep, restorePlan } from '../features/windows/pane-folding.js';
import { isBotView, type WindowView, type WindowSessionBinding } from '@orchardworks/agent-remote-protocol';
import { assistantStatus } from '@orchardworks/agent-client';
import { useCallback, useRef } from 'react';
import { useTranslate } from '@orchardworks/agent-client-web/react';
import { sessionKey } from '../kernel/session-tree.js';
import { sessionActivity } from '../kernel/session-activity-status.js';
import { sessionConnectionFailure } from '../kernel/SessionConnectionNotice.js';
import { botRole } from '../kernel/bot-roster.js';
import type { FoldedBot } from '../kernel/SessionDock.js';
import type { FamilySessionPresentationContext } from '../conversation/SessionFamily.js';
import { mergeSessionViewContributions, type SessionViewContext, type SessionViewOptions, type SessionViewSource } from '../conversation/session-view-contribution.js';
import { forkContribution } from '../features/session-links/fork-contribution.js';
import { quoteContribution } from '../features/session-links/quote-contribution.js';
import { referenceContribution } from '../features/session-links/reference-contribution.js';
import { outboxContribution } from '../features/sessions/outbox-contribution.js';
import { sideNavigationSource } from '../kernel/session-forks.js';
import { earlierSessionsContribution } from './contributions/earlier-sessions.js';
import { handoffContribution } from './contributions/handoff.js';
import { headingActionsContribution } from './contributions/heading-actions.js';
import { identityContribution } from './contributions/identity.js';
import { ownerInputContribution } from './contributions/owner-input.js';
import type { PresentationScope } from './contributions/scope.js';
import { traceContribution } from './contributions/trace.js';

export function useSessionViewPresentation(scope: Pick<PresentationScope, 'assistantNames' | 'accessReady' | 'actions' | 'assertSourceCurrent' | 'attention' | 'baseUrl' | 'bindDirectorySession' | 'botHandoff' | 'compactLayout' | 'conversationHistory' | 'createFork' | 'currentBotSession' | 'directory' | 'dispatchQuote' | 'earlierConversationFor' | 'favorites' | 'forkInputStatus' | 'forkStore' | 'letterReveals' | 'missingSessions' | 'navigation' | 'openExcerptSource' | 'openFork' | 'openLocalView' | 'openSession' | 'openSideKeys' | 'questionDrafts' | 'quoteEntrySelection' | 'quoteNotice' | 'quoteSelected' | 'quoteSelection' | 'quoteTargets' | 'quotedActions' | 'referencePicker' | 'referencedActions' | 'refreshRelations' | 'remoteHosts' | 'removedReference' | 'restoredReference' | 'revealEarlier' | 'revealSession' | 'sessionEntries' | 'setPendingGroupInputs' | 'setQuestionDrafts' | 'setReferencePicker' | 'setRemovingBot' | 'setRenamingSession' | 'setSessionNotice' | 'setSuccessionDialog' | 'setTraceNavigation' | 'sharedWindow' | 'showView' | 'sourceCurrent' | 'sourceStateFor' | 'state' | 'succession' | 'successionDialog' | 'successionGated' | 'successionProgress' | 'traceRequest' | 'traceRequestCounter' | 'tracking' | 'transport' | 'unlinkSide' | 'userScoped' | 'windowWorkspace' | 'withConfirmedTitle' | 'openInBotMode'>) {
  const { assistantNames, accessReady, actions, assertSourceCurrent, attention, baseUrl, bindDirectorySession, botHandoff, compactLayout, conversationHistory, createFork, currentBotSession, directory, dispatchQuote, earlierConversationFor, favorites, forkInputStatus, forkStore, letterReveals, missingSessions, navigation, openExcerptSource, openFork, openLocalView, openSession, openSideKeys, questionDrafts, quoteEntrySelection, quoteNotice, quoteSelected, quoteSelection, quoteTargets, quotedActions, referencePicker, referencedActions, refreshRelations, remoteHosts, removedReference, restoredReference, revealEarlier, revealSession, sessionEntries, setPendingGroupInputs, setQuestionDrafts, setReferencePicker, setRemovingBot, setRenamingSession, setSessionNotice, setSuccessionDialog, setTraceNavigation, sharedWindow, showView, sourceCurrent, sourceStateFor, state, succession, successionDialog, successionGated, successionProgress, traceRequest, traceRequestCounter, tracking, transport, unlinkSide, userScoped, windowWorkspace, withConfirmedTitle, openInBotMode } = scope;
  const t = useTranslate();

  /** Whether the shown Window's view is a bot put to sleep (stored with its group). */
  function asleepBot(view: { id: string }) {
    return !!sharedWindow && isAsleep(windowWorkspace.readGroup(sharedWindow.id), view.id);
  }


  /** Wakes a sleeping bot for every device, keeping its other details. */
  function wakeBot(groupId: string, viewId: string) {
    const details = awakeDetails(windowWorkspace.readGroup(groupId)?.bots?.members[viewId]);
    void windowWorkspace.operateGroup(groupId, { type: 'bot.update', viewId, details }).catch(error => setSessionNotice(sessionConnectionFailure(error, false, t)));
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

  /** The facts every contribution reads about one view. */
  function sessionViewContext(context: FamilySessionPresentationContext, options: SessionViewOptions): SessionViewContext {
    const botPresentation = !!options.bot || options.fallback === true;
    const source: SessionViewSource = { ...withConfirmedTitle(context.session), hostId: context.session.hostId ?? 'local', viewId: context.viewId!, ...(options.bot ? { bot: options.bot } : options.fallback ? { fallback: true as const } : {}) };
    const botGroup = options.bot ? windowWorkspace.readGroup(options.bot.groupId) : undefined;
    const view = options.bot ? botGroup?.window.views.find(item => item.id === options.bot!.viewId) : sharedWindow?.views.find(item => item.id === context.windowViewId);
    // In a group with bot details, a bot's pane in Window mode is the same bot: its conversation goes on into its earlier
    // sessions in place, as in Bot mode, since the group keeps the bot's conversation (rule 1). An ordinary Window opens
    // them in the view instead.
    const windowBot = !botPresentation && !!view && isBotView(view) && !!sharedWindow && !!windowWorkspace.readGroup(sharedWindow.id)?.bots;
    const host = remoteHosts.find(item => item.id === source.hostId);
    return {
      context, options, botPresentation, source, view, windowBot, host,
      isPrimary: view?.placement === 'primary',
      fork: forkStore.find(source),
      sourceForks: forkStore.linked().filter(item => item.target && sessionKey(sideNavigationSource(item)) === sessionKey(source)),
      available: accessReady && !context.offline && context.status === 'ready' && !context.pending && sourceCurrent(source),
      // Quoting happens between the session views of shared Windows.
      quoteView: !botPresentation && sharedWindow && context.windowViewId && !source.parentNativeSessionId ? context.windowViewId : undefined,
      openBot: !botPresentation && sharedWindow && view && isBotView(view) ? () => void openInBotMode(sharedWindow.id, view.id) : undefined,
      provisional: windowWorkspace.provisional,
      assertCurrent: () => assertSourceCurrent(source),
    };
  }

  /** Each feature contributes what it says about the view; the merge states the order of the props they share. */
  function sessionViewPresentation(context: FamilySessionPresentationContext, options: SessionViewOptions = {}) {
    const view = sessionViewContext(context, options);
    const reconcile = (record: Parameters<typeof refreshRelations.reconcile>[0]) => refreshRelations.reconcile(record);
    const quoteInputs = { baseUrl, quoteSelection, quoteNotice, dispatchQuote, quoteTargets, quoteSelected, quotedActions, quoteEntrySelection };
    return mergeSessionViewContributions(view, {
      forks: forkContribution({ forkStore, actions, transport, readWindowViews: () => windowWorkspace.readWindow()?.views, forkInputStatus, directory, createFork, openFork, openSideKeys, unlinkSide, reconcile, t })(view),
      handoff: handoffContribution({ baseUrl, botHandoff, directory, setSuccessionDialog, sourceStateFor, successionDialog, successionGated, successionProgress, userScoped, t })(view),
      quotes: quoteContribution(quoteInputs)(view),
      references: referenceContribution({ baseUrl, userScoped, directory, referencePicker, setReferencePicker, referencedActions, openExcerptSource, removedReference, restoredReference, revealSession, unlinkSide, reconcile, t })(view),
      outbox: outboxContribution({ transport, t })(view),
      plain: [
        identityContribution({ assistantNames, bindDirectorySession, favorites, navigation, openSession, remoteHosts, revealEarlier, setSessionNotice, sharedWindow, succession, windowWorkspace, t })(view),
        ownerInputContribution({ questionDrafts, setPendingGroupInputs, setQuestionDrafts })(view),
        traceContribution({ letterReveals, setTraceNavigation, showView, state, traceRequest, traceRequestCounter, windowWorkspace })(view),
        earlierSessionsContribution({ earlierConversationFor, navigation, succession, t })(view),
        headingActionsContribution({ baseUrl, compactLayout, conversationHistory, directory, favorites, openLocalView, openSession, sessionEntries, setRenamingSession, sharedWindow, succession, userScoped, quoteSelection, quoteEntrySelection, t, foldsOnClose, closeView })(view),
      ],
    });
  }

  const sessionPresentationRef = useRef(sessionViewPresentation);

  sessionPresentationRef.current = sessionViewPresentation;

  const presentSessionView = useCallback((context: FamilySessionPresentationContext, options?: SessionViewOptions) => sessionPresentationRef.current(context, options), []);

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
    return { id: view.id, name: sharedWindow ? assistantNames.view(sharedWindow.id, view.id) : assistantNames.session(view.binding), picture: sharedWindow ? windowWorkspace.readGroup(sharedWindow.id)?.bots?.members[view.id]?.picture : undefined,
      role: botRole(view, t), asleep: asleepBot(view),
      statusOf: states => assistantStatus({ activity: sessionActivity(sharedWindow ? currentBotSession(sharedWindow.id, view.id, view.binding) : view.binding, tracking.liveObservations, states),
        asleep: asleepBot(view), waitingToSend: false }, t) };
  }
  return { asleepBot, wakeBot, foldsOnClose, closeView, presentSessionView, confirmBotRemoval, restoreView, foldedBot };
}

export type SessionViewPresentationSlice = ReturnType<typeof useSessionViewPresentation>;
