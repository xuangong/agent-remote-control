// Attention, tracking and the bot roster.
import { attentionDestination, attentionSets, botDirectorySources as botDirectorySourcesOf, keySignature, readableSessions as readableSessionsOf } from '../state/attention-targets.js';
import { windowPrimaryViewId } from '@orchardworks/agent-remote-protocol';
import { useOtherSessions, type OtherSessionSource } from '../hooks/useOtherSessions.js';
import { botActivityLabel, projectBotRoster } from '../bot-roster.js';
import { sharedReminders } from '../bot-attention.js';
import { useSharedFeedOf, type SharedFeedsSnapshot } from '../shared-feeds.js';
import { sessionActivity } from '../session-activity-status.js';
import type { SessionStateRef } from '@orchardworks/agent-client';
import { type SessionEntry, sessionKey } from '../session-tree.js';
import { useSessionAttention } from '../hooks/useSessionAttention.js';
import { useSessionTracking } from '../hooks/useSessionTracking.js';
import { sessionConnectionFailure } from '../components/SessionConnectionNotice.js';
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef } from 'react';
import { useTranslate } from '@orchardworks/agent-client-web/react';
import { compositionSelection } from '../session-composition.js';
import { SessionDirectoryClient } from '../directory-client.js';
import { viewKey } from './helpers.js';
import type { WorkbenchShellSlice } from './useWorkbenchShell.js';
import type { SideNavigationSlice } from './useSideNavigation.js';
import type { SessionSuccessionBindingSlice } from './useSessionSuccessionBinding.js';
import type { WindowModeActionsSlice } from './useWindowModeActions.js';
import type { PanelsAndShortcutsSlice } from './usePanelsAndShortcuts.js';
import type { SideSelectionSlice } from './useSideSelection.js';
import type { FocusedAskSlice } from './useFocusedAsk.js';
import type { SessionOpeningSlice } from './useSessionOpening.js';
import type { ConversationConnectionsSlice } from './useConversationConnections.js';
import type { RequestedSessionSlice } from './useRequestedSession.js';
import type { WindowViewActionsSlice } from './useWindowViewActions.js';
import type { ProviderCreationSlice } from './useProviderCreation.js';
import type { ViewSessionStateSlice } from './useViewSessionState.js';
import type { WorkbenchRecordsSlice } from './useWorkbenchRecords.js';
import type { ViewTargetsSlice } from './useViewTargets.js';
import type { SharedFeedsAndTpmSlice } from './useSharedFeedsAndTpm.js';
import type { ProviderStateSlice } from './useProviderState.js';
import type { RemoteHostStateSlice } from './useRemoteHostState.js';
import type { DocksAndBotSelectionSlice } from './useDocksAndBotSelection.js';
import type { AppInputs } from './types.js';
import type { AppLate } from './types.js';

export function useAttentionAndRoster(scope: Pick<AppInputs & WorkbenchShellSlice & SideNavigationSlice & SessionSuccessionBindingSlice & WindowModeActionsSlice & PanelsAndShortcutsSlice & SideSelectionSlice & FocusedAskSlice & SessionOpeningSlice & ConversationConnectionsSlice & RequestedSessionSlice & WindowViewActionsSlice & ProviderCreationSlice & ViewSessionStateSlice & WorkbenchRecordsSlice & ViewTargetsSlice & SharedFeedsAndTpmSlice & ProviderStateSlice & RemoteHostStateSlice & DocksAndBotSelectionSlice, 'accessReady' | 'activated' | 'addressSession' | 'ask' | 'askActivitySessions' | 'baseUrl' | 'beginCatchUp' | 'bindDirectorySession' | 'botBinding' | 'botTargets' | 'closeContext' | 'closeInspector' | 'compactLayoutRef' | 'connections' | 'currentBotSession' | 'directory' | 'directoryDestination' | 'earlierBotSessions' | 'latestEligible' | 'letterRequest' | 'navigation' | 'openAsk' | 'openSession' | 'openWindows' | 'pageVisible' | 'providers' | 'rememberTrackedView' | 'remoteHosts' | 'replicaFor' | 'revealSession' | 'selectedBot' | 'selectedHost' | 'setDetachedSideRoot' | 'setFailure' | 'setNativeTakeover' | 'setSessionNotice' | 'sharedFeeds' | 'showView' | 'sourceStateFor' | 'succession' | 'teamRoster' | 'trackEntryId' | 'trackedViews' | 'transitionRef' | 'transport' | 'userScoped' | 'visibleBots' | 'visibleWindows' | 'windowMode' | 'windowModeRef' | 'windowWorkspace'>, late: AppLate) {
  const { accessReady, activated, addressSession, ask, askActivitySessions, baseUrl, beginCatchUp, bindDirectorySession, botBinding, botTargets, closeContext, closeInspector, compactLayoutRef, connections, currentBotSession, directory, directoryDestination, earlierBotSessions, latestEligible, letterRequest, navigation, openAsk, openSession, openWindows, pageVisible, providers, rememberTrackedView, remoteHosts, replicaFor, revealSession, selectedBot, selectedHost, setDetachedSideRoot, setFailure, setNativeTakeover, setSessionNotice, sharedFeeds, showView, sourceStateFor, succession, teamRoster, trackEntryId, trackedViews, transitionRef, transport, userScoped, visibleBots, visibleWindows, windowMode, windowModeRef, windowWorkspace } = scope;

  const attention = useSessionAttention(baseUrl, userScoped && accessReady, item => {
    const destination = attentionDestination(sessionKey(item), {
      windowMode, eligibleKeys: latestEligible.current, openWindows, keyOf: sessionKey,
      askTargetKey: session => { const target = ask.entryFor(session, succession.ownerFor(viewKey(session))).record?.target; return target ? sessionKey(target) : undefined; },
    });
    if (destination.kind === 'ignore') return;
    if (destination.kind === 'bot-row') {
      const row = projectBotRoster(windowWorkspace.groups, [], { status: () => 'unknown', current: currentBotSession }).sections
        .flatMap(section => section.rows).find(row => sessionKey(row.session) === sessionKey(item));
      if (row) navigation.select({ kind: 'bot', groupId: row.groupId, viewId: row.viewId });
      return;
    }
    showView('workbench'); closeContext(); closeInspector();
    if (destination.kind === 'reveal') revealSession(destination.session);
    else if (destination.kind === 'ask') { revealSession(destination.source); openAsk(destination.source, sourceStateFor(destination.source)); }
    else void openSession(item, undefined, undefined, false, undefined, 'history');
  }, navigation.mode);

  // Bot mode reminds from the shared channel (below), so only Window mode's observations notify.
  const observeAttention = useCallback((session: SessionEntry, value: import('../tracking-state.js').SessionObservation) => {
    if (windowModeRef.current && latestEligible.current.has(sessionKey(session))) attention.observe(session, value);
  }, [attention.observe]);

  // Bot mode follows its bots through the states the Relay shares, not a stream each (decision 11).
  const tracking = useSessionTracking(baseUrl, transport, windowMode && addressSession ? sessionKey(addressSession) : undefined,
    windowMode ? openWindows : [], windowMode ? askActivitySessions : [], connections, accessReady && succession.observerReady,
    windowMode ? visibleWindows : visibleBots, observeAttention, !windowMode ? { includeTracked: false, additionalSessions: [] } : undefined);

  async function openTrackedSession(item: SessionEntry): Promise<void> {
    if (!directory || transitionRef.current) return;
    try {
      const destination = directoryDestination();
      if (destination && windowWorkspace.readWindow()?.views.find(view => view.id === destination.viewId)?.placement !== 'primary') {
        await bindDirectorySession(item, destination);
        showView('workbench'); closeContext();
        return;
      }
      rememberTrackedView();
      const entryId = trackEntryId(item), slot = succession.document.slots.find(slot => slot.id === trackedViews.entry(entryId)?.slotId) ?? succession.ensureView(item);
      trackedViews.bind(entryId, slot.id);
      const view = tracking.observations[sessionKey(item)]?.changed ? undefined : trackedViews.get(entryId);
      const primary = view?.primary ?? compositionSelection(slot);
      const observation = tracking.observations[sessionKey(primary)];
      if (observation?.agentId && observation.connection === 'ready') beginCatchUp(replicaFor(observation.agentId), observation.cursor);
      if (!destination) {
        if (await openSession(primary, undefined, undefined, false, view ? () => trackedViews.get(entryId) : undefined, undefined, undefined, view?.primarySlot ?? slot.id)) trackedViews.select(entryId);
        return;
      }
      // The session lands in the destination, or beside it when the destination is a bot (rule 6): the selected primary group shows it.
      const selectedDestination = () => {
        const current = windowWorkspace.readWindow(), viewId = current?.selectedPrimaryViewId, binding = current?.views.find(view => view.id === viewId)?.binding;
        return current?.id === destination.windowId && !!viewId && windowPrimaryViewId(current, current.selectedViewId) === viewId
          && binding && sessionKey(binding) === sessionKey(primary) && binding.parentNativeSessionId === primary.parentNativeSessionId && !binding.sessionIntent;
      };
      letterRequest.current?.abort(); trackedViews.select();
      setDetachedSideRoot(undefined); setNativeTakeover(undefined);
      showView('workbench'); setFailure(undefined); setSessionNotice(undefined); closeContext();
      if (compactLayoutRef.current) closeInspector();
      const opened = await bindDirectorySession(primary, destination, { primarySlot: view?.primarySlot ?? slot.id,
        read: view ? () => selectedDestination() && windowWorkspace.readWindow()?.selectedViewId === windowWorkspace.readWindow()?.selectedPrimaryViewId ? trackedViews.get(entryId) : undefined : undefined });
      if (opened && selectedDestination()) trackedViews.select(entryId);
    } catch (error) { setSessionNotice(sessionConnectionFailure(error, false)); }
  }

  const { eligible, displayed } = attentionSets({ enabled: attention.enabled, windowMode, tracked: tracking.sessions, openWindows, askSessions: askActivitySessions.map(entry => entry.session), botTargets });

  latestEligible.current = new Set(eligible.map(sessionKey));

  const eligibleKeys = keySignature(eligible, sessionKey);

  const displayedKeys = keySignature(displayed, sessionKey);

  useLayoutEffect(() => {
    attention.notifier.setEligible(eligible);
    attention.notifier.setDisplayed(displayed);
  }, [attention.notifier, eligibleKeys, displayedKeys, attention.enabled, navigation.mode]);

  // Reads the latest shared states; components that show statuses render again when they change (useSharedStates).
  const windowSessionStatus = useCallback((session: SessionStateRef) => sessionActivity(session, tracking.liveObservations, sharedFeeds.get().states), [tracking.liveObservations, sharedFeeds]);

  // Bot mode's reminders: a bot that starts waiting or finishes, unless its conversation is on screen.
  const sharedAttention = useRef(new Map<string, 'running' | 'waiting' | 'idle' | 'failed'>());

  const botTargetKeys = JSON.stringify(botTargets.map(sessionKey).sort());

  const onScreenBots = visibleBots.map(sessionKey).join('\n');

  useEffect(() => {
    if (windowMode || !attention.enabled) { sharedAttention.current = new Map(); return; }
    // Follows the shared states as they arrive, without rendering App for them.
    let seen: SharedFeedsSnapshot['states'] | null = null;
    const remind = () => {
      const states = sharedFeeds.get().states;
      if (states === seen) return;
      seen = states;
      const { next, reminders } = sharedReminders(sharedAttention.current, botTargets, states);
      sharedAttention.current = next;
      const onScreen = new Set(document.visibilityState === 'hidden' ? [] : onScreenBots.split('\n'));
      for (const { session, reminder, identity } of reminders) if (!onScreen.has(sessionKey(session))) void attention.notifier.remind(session, reminder, identity);
    };
    remind();
    return sharedFeeds.subscribe(remind);
  }, [sharedFeeds, windowMode, attention.enabled, attention.notifier, botTargetKeys, onScreenBots]);

  const botDirectorySources = useMemo<OtherSessionSource[]>(() => botDirectorySourcesOf({
    localProviders: providers, selectedHostId: selectedHost.id, selectedDirectory: directory, hosts: remoteHosts,
    directoryFor: hostId => new SessionDirectoryClient(baseUrl, undefined, hostId),
  }), [baseUrl, providers, remoteHosts, directory, selectedHost.id]);

  const otherSessions = useOtherSessions(botDirectorySources, !windowMode && activated && accessReady);

  const supportTeams = new Set(teamRoster?.baseUrl === baseUrl ? teamRoster.teams.filter(team => team.callForSupport).map(team => team.id) : []);

  // Who the bots are, for App's own use (search, the selected bot); the roster on screen adds the shared IM state itself.
  const botRoster = projectBotRoster(windowWorkspace.groups, otherSessions.sessions, { status: () => 'unknown', supportTeam: teamId => supportTeams.has(teamId),
    current: currentBotSession, earlier: earlierBotSessions });

  const t = useTranslate();
  /** A Host as the Relay last said, named as the Hosts list names it. */
  const hostFacts = (shared: SharedFeedsSnapshot) => (hostId: string) => {
    const online = shared.states?.host(hostId)?.online ?? remoteHosts.find(host => host.id === hostId)?.online;
    const name = remoteHosts.find(host => host.id === hostId)?.name;
    return online === undefined ? undefined : { online, ...(name ? { name } : {}) };
  };
  const projectSharedRoster = (shared: SharedFeedsSnapshot) => projectBotRoster(windowWorkspace.groups, otherSessions.sessions, {
    status: session => sessionActivity(session, tracking.liveObservations, shared.states), supportTeam: teamId => supportTeams.has(teamId), host: hostFacts(shared), t,
    current: currentBotSession, earlier: earlierBotSessions, reply: session => shared.states?.reply(session), unread: (session, replyAt) => !!shared.reads?.unread(session, replyAt),
    draft: session => shared.drafts?.draft(session)?.text, waiting: session => (shared.outbox?.entries(session).length ?? 0) > 0 });

  // A conversation on screen, with the page visible, is read up to its latest reply on every device. In Bot mode it
  // continues into the session before a handoff, whose last reply may still be the latest.
  const readableSessions: Array<Pick<SessionEntry, 'hostId' | 'providerId' | 'nativeSessionId'>> = readableSessionsOf({
    windowMode, visibleWindows, visibleBots, botSession: selectedBot.group && selectedBot.view ? botBinding : undefined,
    earlier: () => earlierBotSessions(selectedBot.group!.window.id, selectedBot.view!.id, botBinding!),
  });

  const readableKeys = readableSessions.map(sessionKey).join('\n');

  useEffect(() => {
    if (!pageVisible || !transport.markSessionRead) return;
    // Marks as the shared states and read positions arrive, without rendering App for them.
    const mark = () => {
      const { states, reads } = sharedFeeds.get();
      if (!reads) return;
      for (const session of readableSessions) {
        const ref = { hostId: session.hostId ?? 'local', providerId: session.providerId, nativeSessionId: session.nativeSessionId };
        const reply = states?.reply(ref);
        if (reply && reads.unread(ref, reply.replyAt)) transport.markSessionRead!(ref, reply.replyAt);
      }
    };
    mark();
    return sharedFeeds.subscribe(mark);
  }, [pageVisible, readableKeys, sharedFeeds, transport]);

  const botPlace = navigation.place?.kind === 'bot' ? navigation.place : undefined;

  /** The selected bot's activity: a finished turn may have named its session. */
  const selectedBotSessionRef = botPlace ? botRoster.sections.find(section => section.groupId === botPlace.groupId)?.rows.find(row => row.viewId === botPlace.viewId)?.session : undefined;

  const selectedBotStatus = useSharedFeedOf(sharedFeeds, shared => selectedBotSessionRef ? botActivityLabel(sessionActivity(selectedBotSessionRef, tracking.liveObservations, shared.states)) : undefined);
  late.tracking = tracking;
  return { attention, tracking, openTrackedSession, windowSessionStatus, otherSessions, supportTeams, botRoster, projectSharedRoster, selectedBotStatus };
}

export type AttentionAndRosterSlice = ReturnType<typeof useAttentionAndRoster>;
