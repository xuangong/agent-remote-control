// Quoting, references and the earlier conversation.
import { quoteTargets as quoteTargetsOf } from '../state/quote-targets.js';
import { selectedKeys } from '../state/quote-selection.js';
import { createWindowView, type Team, createSessionExcerpt } from '@orchardworks/agent-remote-protocol';
import { windowSessionBinding } from '../window-workspace.js';
import { type SessionEntry, sessionKey } from '../session-tree.js';
import { EarlierConversation } from '../components/EarlierConversation.js';
import { useCallback, useRef } from 'react';
import { errorWords, keyedError, timelineEntryKey, type AgentReplicaState } from '@orchardworks/agent-client';
import { SessionDirectoryClient, type OpenedSession } from '../directory-client.js';
import type { LabWorkbenchActions } from '../components/LabWorkbench.js';
import { SessionAsk } from '../components/SessionAsk.js';
import { withSessionReferences } from '../session-references.js';
import type { TimelineEntrySelection } from '@orchardworks/agent-client-web/react';
import { addQuote, withViewQuotes } from '../session-quotes.js';
import { NEW_SESSION_TARGET, type QuoteTargetWindow } from '../components/SessionQuotes.js';
import { message, viewKey } from './helpers.js';
import type { RequestedSessionSlice } from './useRequestedSession.js';
import type { WorkbenchShellSlice } from './useWorkbenchShell.js';
import type { FocusedAskSlice } from './useFocusedAsk.js';
import type { ViewSessionStateSlice } from './useViewSessionState.js';
import type { RemoteHostStateSlice } from './useRemoteHostState.js';
import type { SessionSuccessionBindingSlice } from './useSessionSuccessionBinding.js';
import type { SideSelectionSlice } from './useSideSelection.js';
import type { ConversationConnectionsSlice } from './useConversationConnections.js';
import type { PanelsAndShortcutsSlice } from './usePanelsAndShortcuts.js';
import type { ActiveSessionSlice } from './useActiveSession.js';
import type { SharedFeedsAndTpmSlice } from './useSharedFeedsAndTpm.js';
import type { CommunicationsAndForksSlice } from './useCommunicationsAndForks.js';
import type { ProviderCreationSlice } from './useProviderCreation.js';
import type { WorkbenchRecordsSlice } from './useWorkbenchRecords.js';
import type { WindowViewActionsSlice } from './useWindowViewActions.js';
import type { TraceNavigationSlice } from './useTraceNavigation.js';
import type { AppInputs } from './types.js';

import { sessionQuotaReached } from '../state/agent-creation.js';
import { quoteCreationId, quoteLanding, quoteSessionOptions, quoteStart, reloadedConversationMessage } from '../state/quote-flow.js';
import { askRestoreAllowed } from '../state/ask-visibility.js';
import { useTranslate } from '@orchardworks/agent-client-web/react';

export function useQuotesAndReferences(scope: Pick<AppInputs & RequestedSessionSlice & WorkbenchShellSlice & FocusedAskSlice & ViewSessionStateSlice & RemoteHostStateSlice & SessionSuccessionBindingSlice & SideSelectionSlice & ConversationConnectionsSlice & PanelsAndShortcutsSlice & ActiveSessionSlice & SharedFeedsAndTpmSlice & CommunicationsAndForksSlice & ProviderCreationSlice & WorkbenchRecordsSlice & WindowViewActionsSlice & TraceNavigationSlice, 'accessReady' | 'ask' | 'askSurfaceVisible' | 'askTriggerRef' | 'askView' | 'baseUrl' | 'compactLayout' | 'compositionProtected' | 'connections' | 'directory' | 'dispatchQuote' | 'earlierConversations' | 'earlierDirectory' | 'editWindow' | 'navigateAttributionRef' | 'openAsk' | 'pageOpen' | 'quote' | 'quoteSelection' | 'refreshRelations' | 'rememberSession' | 'remoteHosts' | 'replicaFor' | 'retryHosts' | 'selectedHost' | 'setDirectoryRevision' | 'sharedWindow' | 'sideSessions' | 'sourceCurrent' | 'succession' | 'transitioning' | 'transport' | 'viewNavigation' | 'windowWorkspace'>) {
  const t = useTranslate();
  const { accessReady, ask, askSurfaceVisible, askTriggerRef, askView, baseUrl, compactLayout, compositionProtected, connections, directory, dispatchQuote, earlierConversations, earlierDirectory, editWindow, navigateAttributionRef, openAsk, pageOpen, quote, quoteSelection, refreshRelations, rememberSession, remoteHosts, replicaFor, retryHosts, selectedHost, setDirectoryRevision, sharedWindow, sideSessions, sourceCurrent, succession, transitioning, transport, viewNavigation, windowWorkspace } = scope;

  function renderAsk(source: OpenedSession, sourceState?: AgentReplicaState) {
    if (!directory) return null;
    const available = accessReady && sourceCurrent(source) && !transitioning && remoteHosts.find(host => host.id === source.hostId)?.online !== false;
    const associationOwner = succession.ownerFor(viewKey(source)), target = ask.entryFor(source, associationOwner).record?.target;
    const native = connections.find(source)?.client.getSessionState(), agent = sourceState?.agent;
    const independentRestore = succession.active && !succession.discovering && succession.result?.status === 'applied' && !!target
      && viewKey(source) !== succession.desired?.slot.id
      && sideSessions.some(side => sessionKey(side) === sessionKey(source)) && agent?.id === source.agentId
      && agent.providerId === source.providerId && agent.runtimeInfo.providerId === source.providerId && agent.runtimeInfo.sessionId === source.nativeSessionId
      && !!sourceState?.timeline.initialized && !!sourceState.timeline.epoch && !!native?.synchronized && native.runtime?.state === 'connected' && !native.controlChecking && !native.recovering;
    return <SessionAsk compact={compactLayout} key={associationOwner} associationOwner={associationOwner} imageRecipient={target ? succession.recipientFor(target, associationOwner) : undefined} source={source} ask={ask} storageScope={baseUrl}
      visible={askSurfaceVisible} covered={pageOpen} triggerRef={askTriggerRef} onToggleEnabled={() => askView.setVisible(!askView.visible)}
      canRestore={askRestoreAllowed({ accessReady, hasTarget: !!target, compositionProtected, sourceAvailable: !!available, independentRestore })} synchronizing={compositionProtected} synchronize={refreshRelations}
      onOpen={clean => openAsk(source, sourceState, clean)} replicaFor={replicaFor} transport={transport}
      navigation={viewNavigation} />;
  }

  /** Session views of every Window that can receive a quote from `sourceViewId`, located by Window and session. */
  function quoteTargets(sourceViewId: string, source: OpenedSession): QuoteTargetWindow[] {
    return quoteTargetsOf(windowWorkspace.windows ?? [], windowWorkspace.readWindow() ?? sharedWindow, { viewId: sourceViewId, session: source }, t);
  }

  /** A new session in the source's workspace, with its provider and model, opened as a dock of the current Window. */
  async function createQuoteSession(source: OpenedSession, sourceState: AgentReplicaState, operationId: string): Promise<string> {
    const agent = sourceState.agent;
    if (!directory || !agent) throw new Error(t('sessions.quoteFlow.cannotCreate'));
    const target = (source.hostId ?? 'local') === selectedHost.id ? directory : new SessionDirectoryClient(baseUrl, undefined, source.hostId);
    if (sessionQuotaReached(remoteHosts.find(host => host.id === source.hostId)?.sessionQuota)) throw keyedError('client.creation.quotaReached');
    const options = quoteSessionOptions(agent, source.providerId);
    let created: { agentId: string; nativeSessionId?: string };
    try { created = await target.create(source.providerId, operationId, options); }
    finally { if (source.hostId && source.hostId !== 'local') retryHosts(); }
    const session = { agentId: created.agentId, nativeSessionId: created.nativeSessionId ?? created.agentId, providerId: source.providerId, hostId: source.hostId ?? 'local', title: 'New session' };
    rememberSession(session); setDirectoryRevision(value => value + 1);
    const view = createWindowView(crypto.randomUUID(), windowSessionBinding(session), 'dock');
    editWindow({ type: 'batch', operations: [{ type: 'view.create', view }] });
    return view.id;
  }

  function revealQuoteTarget(viewId: string): void {
    void windowWorkspace.operate({ type: 'view.select', viewId }).catch(() => {});
    const id = viewId.replace(/["\\]/g, '\\$&');
    requestAnimationFrame(() => document.querySelector<HTMLElement>(`[data-view-id="${id}"] [data-testid="prompt-input"], [data-primary-group-id="${id}"] [data-testid="prompt-input"]`)?.focus({ preventScroll: true }));
  }

  async function quoteSelected(viewId: string, source: OpenedSession, sourceState: AgentReplicaState, target: { windowId: string; viewId: string }): Promise<void> {
    const selection = quoteSelection;
    const start = quoteStart(selection, viewId, sourceState.timeline.epoch);
    if (start === 'ignore' || !selection) return;
    try {
      if (start === 'reloaded') throw new Error(reloadedConversationMessage);
      const excerpt = createSessionExcerpt({ id: crypto.randomUUID(), capturedAt: new Date().toISOString(), entries: sourceState.timeline.entries,
        source: { hostId: source.hostId ?? 'local', providerId: source.providerId, nativeSessionId: source.nativeSessionId, title: source.title },
        selected: entry => selection.keys.has(timelineEntryKey(entry)) });
      let destination = target.viewId;
      if (destination === NEW_SESSION_TARGET) {
        const creationId = quoteCreationId(selection, () => crypto.randomUUID());
        dispatchQuote({ type: 'creating', viewId, creationId });
        destination = await createQuoteSession(source, sourceState, creationId);
      }
      addQuote(baseUrl, destination, excerpt);
      dispatchQuote({ type: 'quoted', viewId });
      const landing = quoteLanding(quoteTargets(viewId, source), target, destination, t);
      if (landing.kind === 'reveal') { revealQuoteTarget(destination); return; }
      dispatchQuote({ type: 'quoted', viewId, notice: { viewId, message: landing.message, async open() {
        await windowWorkspace.open(landing.windowId); revealQuoteTarget(destination);
      } } });
    } catch (error) {
      dispatchQuote({ type: 'failed', viewId, error: errorWords(error, t, 'sessions.quoteFlow.failed') });
    }
  }

  const openExcerptSource = useCallback((source: { hostId?: string; providerId: string; nativeSessionId: string; title: string }) =>
    navigateAttributionRef.current({ id: 'excerpt-source', kind: 'quote', label: t('sessions.quoteFlow.quotedFrom'), value: source.title,
      target: { kind: 'session', hostId: source.hostId, providerId: source.providerId, nativeSessionId: source.nativeSessionId } }).catch(() => undefined), [t]);

  // Stable wrappers keep memoized timelines from rendering again on unrelated changes.
  const quotedActionCache = useRef(new WeakMap<LabWorkbenchActions, Map<string, LabWorkbenchActions>>());

  function quotedActions(base: LabWorkbenchActions, viewId: string): LabWorkbenchActions {
    let byView = quotedActionCache.current.get(base);
    if (!byView) quotedActionCache.current.set(base, byView = new Map());
    const key = JSON.stringify([baseUrl, viewId]);
    let wrapped = byView.get(key);
    if (!wrapped) byView.set(key, wrapped = withViewQuotes(base, baseUrl, viewId));
    return wrapped;
  }

  const referencedActionCache = useRef(new WeakMap<LabWorkbenchActions, Map<string, LabWorkbenchActions>>());

  const referencedStates = useRef(new Map<string, AgentReplicaState | undefined>());

  /** The next message of a view carries the session's changed references; the wrapper stays stable while its session does. */
  function referencedActions(base: LabWorkbenchActions, session: OpenedSession, state: AgentReplicaState | undefined): LabWorkbenchActions {
    const holder = { hostId: session.hostId, providerId: session.providerId, nativeSessionId: session.nativeSessionId };
    const key = JSON.stringify([baseUrl, holder.hostId ?? 'local', holder.providerId, holder.nativeSessionId]);
    referencedStates.current.set(key, state);
    let byHolder = referencedActionCache.current.get(base);
    if (!byHolder) referencedActionCache.current.set(base, byHolder = new Map());
    let wrapped = byHolder.get(key);
    if (!wrapped) byHolder.set(key, wrapped = withSessionReferences(base, baseUrl, holder, () => referencedStates.current.get(key)));
    return wrapped;
  }

  /** Starting a selection in another view replaces the one in progress. */
  function quoteEntrySelection(viewId: string, epoch: string | null): TimelineEntrySelection {
    return { label: t('sessions.quotes.quote'), selected: selectedKeys(quote, viewId, epoch), select(keys, value) { dispatchQuote({ type: 'select', viewId, epoch, keys, value }); } };
  }

  /** team: a Team Leader or Member view, which shows the member's name and offers Handoff like a primary view. */
  /**
   * A bot's earlier sessions, read above its current conversation in Bot mode after handoffs. The element is kept per chain so
   * the memoized timeline does not re-render, and the chain comes from the validated succession history.
   */
  function earlierConversationFor(navigation: ReturnType<typeof succession.historyNavigationFor>) {
    if (!navigation?.predecessor || navigation.history) return undefined;
    const sessions = [navigation.predecessor, ...navigation.ancestors];
    const key = JSON.stringify([baseUrl, sessions.map(sessionKey)]);
    let element = earlierConversations.current.get(key);
    if (!element) {
      element = <EarlierConversation baseUrl={baseUrl} transport={transport} directory={hostId => earlierDirectory.current(hostId)} sessions={sessions} />;
      earlierConversations.current.set(key, element);
      if (earlierConversations.current.size > 32) earlierConversations.current.delete(earlierConversations.current.keys().next().value!);
    }
    return element;
  }

  /**
   * Shows one of a Window bot's earlier sessions, read above its conversation in its own pane: the bot keeps its view and
   * session, so nothing is rebound. A session not revealed yet scrolls to the start of the earlier conversation, where
   * "Show earlier conversation" reveals more.
   */
  function revealEarlier(viewId: string, session: SessionEntry): boolean {
    const key = sessionKey(session);
    const panes = [...document.querySelectorAll<HTMLElement>('[data-primary-group-id], [data-view-id]')]
      .filter(node => node.dataset.primaryGroupId === viewId || node.dataset.viewId === viewId);
    for (const pane of panes) {
      const target = [...pane.querySelectorAll<HTMLElement>('.lab-earlier-session')].find(section => section.dataset.session === key)
        ?? pane.querySelector<HTMLElement>('.lab-earlier-conversation');
      if (!target) continue;
      target.scrollIntoView({ block: 'start', behavior: window.matchMedia?.('(prefers-reduced-motion: reduce)').matches ? 'auto' : 'smooth' });
      return true;
    }
    return false;
  }
  return { renderAsk, quoteTargets, quoteSelected, openExcerptSource, quotedActions, referencedActions, quoteEntrySelection, earlierConversationFor, revealEarlier };
}

export type QuotesAndReferencesSlice = ReturnType<typeof useQuotesAndReferences>;
