// Side requests, selecting and revealing sessions, and opening child sessions.
import { windowPrimaryViewId } from '@orchardworks/agent-remote-protocol';
import { windowSessionBinding } from '../window-workspace.js';
import { projectBotRoster } from '../bot-roster.js';
import { sideWindowOperation } from '../window-side-navigation.js';
import { resolveAskPresentation } from '../ask-presentation.js';
import { unlinkSideView } from '../tracked-session-views.js';
import { sessionConnectionFailure } from '../components/SessionConnectionNotice.js';
import { useEffect, useLayoutEffect, useMemo, useRef } from 'react';
import type { AgentReplicaState } from '@orchardworks/agent-client';
import { compositionSession } from '../session-composition.js';
import { SessionDirectoryClient, type OpenedSession } from '../directory-client.js';
import { sessionKey } from '../session-tree.js';
import type { AgentChildSessionView } from '@orchardworks/agent-client-web/react';
import { sideNavigationSource, sideNavigationTarget, sideLinkVisible } from '../session-forks.js';
import { sidePath } from '../side-tree.js';
import { message, viewKey } from './helpers.js';
import type { WorkbenchRecordsSlice } from './useWorkbenchRecords.js';
import type { FocusedAskSlice } from './useFocusedAsk.js';
import type { SessionOpeningSlice } from './useSessionOpening.js';
import type { SideSelectionSlice } from './useSideSelection.js';
import type { SessionSuccessionBindingSlice } from './useSessionSuccessionBinding.js';
import type { ViewSessionStateSlice } from './useViewSessionState.js';
import type { WindowModeActionsSlice } from './useWindowModeActions.js';
import type { HostAndStackSlice } from './useHostAndStack.js';
import type { WorkbenchShellSlice } from './useWorkbenchShell.js';
import type { ConversationConnectionsSlice } from './useConversationConnections.js';
import type { ActiveSessionSlice } from './useActiveSession.js';
import type { PanelsAndShortcutsSlice } from './usePanelsAndShortcuts.js';
import type { DocksAndBotSelectionSlice } from './useDocksAndBotSelection.js';
import type { WindowViewActionsSlice } from './useWindowViewActions.js';
import type { RequestedSessionSlice } from './useRequestedSession.js';
import type { ViewTargetsSlice } from './useViewTargets.js';
import type { ProviderCreationSlice } from './useProviderCreation.js';
import type { AppInputs } from './types.js';

export function useSideNavigation(scope: Pick<AppInputs & WorkbenchRecordsSlice & FocusedAskSlice & SessionOpeningSlice & SideSelectionSlice & SessionSuccessionBindingSlice & ViewSessionStateSlice & WindowModeActionsSlice & HostAndStackSlice & WorkbenchShellSlice & ConversationConnectionsSlice & ActiveSessionSlice & PanelsAndShortcutsSlice & DocksAndBotSelectionSlice & WindowViewActionsSlice & RequestedSessionSlice & ViewTargetsSlice & ProviderCreationSlice, 'accessReady' | 'activated' | 'activeOpened' | 'addressSession' | 'appliedUnlinks' | 'ask' | 'askWindowsVisible' | 'assertSourceCurrent' | 'baseUrl' | 'compactLayout' | 'compactLayoutRef' | 'connections' | 'currentBotSession' | 'directory' | 'editWindow' | 'expandedKeys' | 'familyPath' | 'focusCatchUp' | 'forkRevision' | 'forkStore' | 'initialState' | 'isViewVisible' | 'letterRequest' | 'mountedViewSessions' | 'navigateSide' | 'navigation' | 'navigationGeneration' | 'nextSideRequest' | 'openSession' | 'pendingSideSources' | 'primaryBinding' | 'rememberSession' | 'replicas' | 'selectedBot' | 'selectedHost' | 'sessionEntries' | 'setDetachedSideRoot' | 'setFailure' | 'setSessionNotice' | 'setSideAnchor' | 'setSideFocus' | 'setSideSelections' | 'setSideSessions' | 'setTransitioning' | 'sharedSlots' | 'sharedViewForSlot' | 'sharedWindow' | 'sideAnchor' | 'sideFocus' | 'sideRequestKey' | 'sideRequests' | 'sideSelections' | 'sideSessions' | 'stackPath' | 'stackRoot' | 'state' | 'succession' | 'trackedViews' | 'transitionRef' | 'transport' | 'viewSession' | 'visibleStackRoot' | 'windowMode' | 'windowSession' | 'windowStageVisible' | 'windowWorkspace'>) {
  const { accessReady, activated, activeOpened, addressSession, appliedUnlinks, ask, askWindowsVisible, assertSourceCurrent, baseUrl, compactLayout, compactLayoutRef, connections, currentBotSession, directory, editWindow, expandedKeys, familyPath, focusCatchUp, forkRevision, forkStore, initialState, isViewVisible, letterRequest, mountedViewSessions, navigateSide, navigation, navigationGeneration, nextSideRequest, openSession, pendingSideSources, primaryBinding, rememberSession, replicas, selectedBot, selectedHost, sessionEntries, setDetachedSideRoot, setFailure, setSessionNotice, setSideAnchor, setSideFocus, setSideSelections, setSideSessions, setTransitioning, sharedSlots, sharedViewForSlot, sharedWindow, sideAnchor, sideFocus, sideRequestKey, sideRequests, sideSelections, sideSessions, stackPath, stackRoot, state, succession, trackedViews, transitionRef, transport, viewSession, visibleStackRoot, windowMode, windowSession, windowStageVisible, windowWorkspace } = scope;

  useLayoutEffect(() => {
    for (const record of forkStore.all()) {
      if (record.navigationSource) pendingSideSources.current.set(record.id,record.navigationSource);
      if (sideLinkVisible(record) || !record.target || appliedUnlinks.get(record.id) === (record.revision ?? 0)) continue;
      const navigationSource = pendingSideSources.current.get(record.id) ?? sideNavigationSource(record);
      pendingSideSources.current.delete(record.id);
      const navigationTarget = sideNavigationTarget(record)!;
      const sourceView = familyPath.find(session => sessionKey(session) === sessionKey(navigationSource)), targetView = sideSessions.find(session => sessionKey(session) === sessionKey(navigationTarget));
      if (!sourceView || !targetView) continue;
      appliedUnlinks.set(record.id, record.revision ?? 0);
      if (sharedWindow) {
        const target = sharedViewForSlot(viewKey(targetView));
        if (!target?.attachedTo) continue;
        const { schemaVersion: _, id: __, revision: ___, ...layout } = sharedWindow;
        windowWorkspace.authority?.operate({ type: 'layout.apply', layout: { ...layout, selectedViewId: target.id,
          views: sharedWindow.views.map(view => {
            if (view.id !== target.id) return view;
            const { attachedTo: ____, ...independent } = view;
            return { ...independent, placement: 'dock', collapsed: false };
          }) } });
        nextSideRequest(navigationSource);
        letterRequest.current?.abort();
        continue;
      }
      trackedViews.unlink(viewKey(sourceView), viewKey(targetView));
      nextSideRequest(navigationSource);
      if (!visibleStackRoot) continue;
      const sourceKey = viewKey(sourceView), targetKey = viewKey(targetView);
      const current = { primary: visibleStackRoot, primarySlot: viewKey(visibleStackRoot), selections: sideSelections, focus: sideFocus, anchor: sideAnchor };
      const next = unlinkSideView(current, sourceKey, targetKey);
      if (next === current) continue;
        letterRequest.current?.abort();
      setSideSelections(values => values[sourceKey] === targetKey ? { ...values, [sourceKey]: null } : values);
      if (next.focus !== sideFocus) {
        setDetachedSideRoot(targetKey);
        const branch = sidePath(targetView, sideSessions, sideSelections, viewKey);
        if (!branch.some(session => viewKey(session) === sideAnchor)) setSideAnchor(sideFocus ?? targetKey);
      } else {
        setSideFocus(next.focus);
        setSideAnchor(next.anchor);
      }
    }
  }, [forkStore, forkRevision, appliedUnlinks, trackedViews, visibleStackRoot, sideSessions, sideSelections, sideFocus, sideAnchor, sharedWindow]);


  useEffect(() => {
    if (!windowMode || succession.active && !succession.binding) return;
    focusCatchUp(addressSession ? replicas.get(addressSession.agentId) : undefined);
  }, [addressSession?.agentId, succession.active, succession.binding, replicas, focusCatchUp, windowMode]);

  const primaryIsBound = succession.active ? succession.isCurrent() : initialState?.agent?.id === stackRoot?.agentId || (primaryBinding.current?.baseUrl === baseUrl
    && primaryBinding.current.transport === transport && primaryBinding.current.agentId === stackRoot?.agentId);

  const openWindows = useMemo(() => sharedWindow ? sharedWindow.views.flatMap(view => {
    if (!view.binding || !windowPrimaryViewId(sharedWindow, view.id) && !mountedViewSessions[view.id]) return [];
    const mounted = mountedViewSessions[view.id], slot = sharedSlots?.get(view.id);
    const session = mounted && sessionKey(mounted) === sessionKey(view.binding) ? mounted : slot && compositionSession(slot);
    return session && sessionKey(session) === sessionKey(view.binding) ? [{ ...session, title: view.binding.title }] : [];
  }) : [...(stackRoot && primaryIsBound ? [stackRoot] : []), ...sideSessions], [sharedWindow, mountedViewSessions, sharedSlots, stackRoot, primaryIsBound, sideSessions]);

  const askSources = useMemo(() => {
    const slots = new Map(succession.document.slots.map(slot => [slot.id, slot]));
    return succession.document.asks.flatMap(owner => {
      const slot = slots.get(owner.sourceSlot), source = slot && compositionSession(slot);
      return source ? [{ owner: owner.id, source }] : [];
    });
  }, [succession.document, succession.document.editRevision]);

  const askActivitySessions = useMemo(() => askSources.flatMap(({ source, owner }) => {
    const entry = ask.entryFor(source, owner);
    const expanded = ask.isOpen(source, owner);
    if (!ask.isEnabled(source, owner) || !entry.record?.target || expanded && !entry.attached) return [];
    return [{ session: entry.record.target,
      visible: resolveAskPresentation({ window: sharedWindow, view: ask.sharedView(owner), visible: askWindowsVisible, expanded, compact: compactLayout }).shown,
      liveAgentId: entry.attached ? entry.record.target.agentId : undefined }];
  }), [askSources, ask.revision, askWindowsVisible, sharedWindow, compactLayout]);

  useEffect(() => {
    replicas.retain([
      ...connections.agentIds,
      ...(primaryBinding.current?.agentId ? [primaryBinding.current.agentId] : []),
      ...sideSessions.map(session => session.agentId),
      ...askActivitySessions.filter(item => item.visible).map(item => item.session.agentId),
      ...(addressSession ? [addressSession.agentId] : []),
    ]);
  });

  // A session under the desktop sessions page is not seen, so it is not acknowledged as read.
  const visibleWindows = openWindows.filter(session => windowStageVisible && isViewVisible(viewKey(session)));

  const botTargets = !windowMode && activated && accessReady
    ? projectBotRoster(windowWorkspace.groups, [], { status: () => 'unknown', current: currentBotSession }).sections.flatMap(section => section.rows.map(({ binding, session }) => {
      const { role: _role, ...entry } = binding;
      return { ...entry, ...session };
    })) : [];

  const botBinding = selectedBot.view?.binding;

  const botConnection = botBinding && connections.find(botBinding);

  const selectedBotSession = botBinding && selectedBot.group && selectedBot.view ? currentBotSession(selectedBot.group.window.id, selectedBot.view.id, botBinding) : undefined;

  const displayedBot = selectedBotSession && botTargets.find(session => sessionKey(session) === sessionKey(selectedBotSession));

  const visibleBots = !windowMode && accessReady && selectedBot.slot && botBinding && displayedBot && botConnection
    && (!compactLayout || !navigation.rosterVisible) && connections.shown(botBinding, botConnection.agentId) ? [displayedBot] : [];

  const latestEligible = useRef(new Set<string>());

  function selectSide(source: OpenedSession, session: OpenedSession): void {
    const sourceSlot = viewKey(viewSession(source));
    // In Bot mode a bot may belong to a group other than the Window shown in Window mode: its Side joins that group,
    // attached beside it, and so becomes a bot of the group (with the Side role).
    const placed = !windowMode && !(sharedWindow && sharedViewForSlot(sourceSlot)) ? succession.document.windowBindings?.find(entry => entry.slotId === sourceSlot) : undefined;
    const group = placed ? windowWorkspace.readGroup(placed.windowId) : undefined;
    if (placed && group) {
      const origin = group.window.views.find(view => view.id === placed.viewId);
      if (!origin?.binding || sessionKey(origin.binding) !== sessionKey(source)) throw new Error('The source view changed. Open the Side session again.');
      const binding = windowSessionBinding(session);
      const { operation, viewId } = sideWindowOperation(group.window, { windowId: group.window.id, viewId: origin.id, binding: origin.binding }, binding, crypto.randomUUID());
      const targetSlot = succession.document.slots.find(slot => slot.id === viewSession(session).viewId)!;
      const slot = operation.type !== 'view.select' && !succession.document.windowBindings?.some(entry => entry.slotId === targetSlot.id)
        ? succession.bindWindowView(group.window.id, viewId, binding, targetSlot.id)
        : succession.ensureWindowView(group.window.id, viewId, binding);
      const opened = { ...session, viewId: slot.id };
      succession.rememberSide(opened);
      setSideSessions(current => [...current.filter(entry => viewKey(entry) !== opened.viewId), opened]);
      nextSideRequest(source);
      void windowWorkspace.operateGroup(group.window.id, operation).then(() => navigation.select({ kind: 'bot', groupId: group.window.id, viewId }))
        .catch(error => setSessionNotice(sessionConnectionFailure(error, false)));
      return;
    }
    if (sharedWindow) {
      const origin = sharedViewForSlot(sourceSlot);
      if (!origin?.binding || sessionKey(origin.binding) !== sessionKey(source)) throw new Error('The source view changed. Open the Side session again.');
      const binding = windowSessionBinding(session);
      const { operation, viewId } = sideWindowOperation(windowWorkspace.readWindow(), { windowId: sharedWindow.id, viewId: origin.id, binding: origin.binding }, binding, crypto.randomUUID());
      const candidate = viewSession(session);
      const targetSlot = succession.document.slots.find(slot => slot.id === candidate.viewId)!;
      const slot = operation.type !== 'view.select' && !succession.document.windowBindings?.some(entry => entry.slotId === targetSlot.id)
        ? succession.bindWindowView(sharedWindow.id, viewId, binding, targetSlot.id)
        : succession.ensureWindowView(sharedWindow.id, viewId, binding);
      const opened = { ...session, viewId: slot.id };
      succession.rememberSide(opened);
      setSideSessions(current => [...current.filter(entry => viewKey(entry) !== opened.viewId), opened]);
      nextSideRequest(source);
      // In Bot mode the new Side is a bot of this group: open it, as for a group that is not the shown Window.
      if (windowMode) editWindow(operation);
      else void windowWorkspace.operate(operation).then(() => navigation.select({ kind: 'bot', groupId: sharedWindow.id, viewId }))
        .catch(error => setSessionNotice(sessionConnectionFailure(error, false)));
      return;
    }
    nextSideRequest(source);
    const opened = viewSession(session), sourceId = viewKey(viewSession(source));
    succession.rememberSide(opened);
    setSideSessions(current => [...current.filter(entry => viewKey(entry) !== opened.viewId), opened]);
    setSideSelections(current => ({ ...current, [sourceId]: opened.viewId }));
    navigateSide(opened.viewId);
  }


  async function openChildSession(child: AgentChildSessionView, source?: OpenedSession, sourceState?: AgentReplicaState): Promise<void> {
    letterRequest.current?.abort();
    const parentState = sourceState ?? state;
    const parentId = parentState?.agent?.runtimeInfo.sessionId;
    const parentAgent = parentState?.agent;
    if (!parentAgent || !parentId || !directory) throw new Error('The parent session is unavailable.');
    let origin: OpenedSession = viewSession(source ?? activeOpened ?? { agentId: parentAgent.id, providerId: parentAgent.providerId, nativeSessionId: parentId, hostId: 'local', title: 'Parent conversation' });
    assertSourceCurrent(origin);
    if (sharedWindow || !compactLayoutRef.current) {
      const knownChild = sessionEntries.find(entry => entry.nativeSessionId === child.nativeSessionId && entry.providerId === origin.providerId && (entry.hostId ?? 'local') === (origin.hostId ?? 'local'));
      if (knownChild?.parentNativeSessionId && knownChild.parentNativeSessionId !== origin.nativeSessionId) {
        const actualParent = openWindows.find(session => session.nativeSessionId === knownChild.parentNativeSessionId && session.providerId === origin.providerId && (session.hostId ?? 'local') === (origin.hostId ?? 'local'));
        if (!actualParent) throw new Error('Open the direct parent session before opening this nested subagent.');
        origin = viewSession(actualParent);
      }
      const cached = connections.find({ ...origin, nativeSessionId: child.nativeSessionId });
      const showChild = async (opened: OpenedSession) => {
        if (!stackPath.some(session => sessionKey(session) === sessionKey(origin)) && !await openSession(origin)) {
          throw new Error('The parent session could not be opened.');
        }
        selectSide(origin, opened);
      };
      if (cached) {
        await showChild({ ...child, agentId: cached.agentId, providerId: origin.providerId, hostId: origin.hostId, parentAgentId: origin.agentId, parentNativeSessionId: origin.nativeSessionId });
        return;
      }
      const generation = navigationGeneration.current;
      const request = nextSideRequest(origin);
      const target = (origin.hostId ?? 'local') === selectedHost.id ? directory : new SessionDirectoryClient(baseUrl, undefined, origin.hostId);
      try {
        const result = await target.attachChild(origin.providerId, origin.nativeSessionId, child.nativeSessionId);
        if (navigationGeneration.current !== generation || sideRequests.current.get(sideRequestKey(origin)) !== request) return;
        assertSourceCurrent(origin);
        const opened = { ...child, agentId: result.agentId, providerId: origin.providerId, hostId: origin.hostId, parentAgentId: origin.agentId, parentNativeSessionId: origin.nativeSessionId };
        rememberSession(origin); rememberSession(opened); setSessionNotice(undefined);
        await showChild(opened);
      } catch (error) { setSessionNotice(sessionConnectionFailure(error, false)); throw error; }
      return;
    }
    const known = sessionEntries.find(entry => entry.nativeSessionId === child.nativeSessionId
      && entry.providerId === origin.providerId && (entry.hostId ?? 'local') === (origin.hostId ?? 'local'));
    const generation = navigationGeneration.current;
    if (transitionRef.current) return;
    transitionRef.current = true;
    setTransitioning(true);
    setFailure(undefined);
    setSessionNotice({ tone: 'status', message: 'Opening the existing child session. Waiting for the Host to confirm it is ready…' });
    try {
      const hostId = origin.hostId ?? 'local';
      const target = hostId === selectedHost.id ? directory : new SessionDirectoryClient(baseUrl, undefined, hostId);
      const parentNativeSessionId = known?.parentNativeSessionId ?? origin.nativeSessionId;
      const result = await target.attachChild(origin.providerId, parentNativeSessionId, child.nativeSessionId);
      if (navigationGeneration.current !== generation) return;
      assertSourceCurrent(origin);
      rememberSession(origin);
      const opened = { agentId: result.agentId, providerId: origin.providerId, nativeSessionId: result.nativeSessionId,
        title: child.title, createdAt: child.createdAt, hostId, parentAgentId: known?.parentAgentId ?? origin.agentId, parentNativeSessionId };
      rememberSession(opened); await windowSession.openAttached(opened);
    } catch (error) {
      if (navigationGeneration.current === generation) setSessionNotice(sessionConnectionFailure(error, false));
      throw error;
    } finally {
      transitionRef.current = false;
      setTransitioning(false);
    }
  }

  function revealSession(session: OpenedSession): void {
    const id = (session as { viewId?: string }).viewId;
    const shared = id && sharedViewForSlot(id);
    if (shared) { windowWorkspace.authority?.operate({ type: 'view.select', viewId: shared.id }); return; }
    const visible = stackPath.find(entry => id ? viewKey(entry) === id : sessionKey(entry) === sessionKey(session));
    if (visible) { setSideFocus(viewKey(visible)); if (!expandedKeys.has(viewKey(visible))) setSideAnchor(viewKey(visible)); }
    else void openSession(session);
  }
  return { primaryIsBound, openWindows, askSources, askActivitySessions, visibleWindows, botTargets, botBinding, visibleBots, latestEligible, selectSide, openChildSession, revealSession };
}

export type SideNavigationSlice = ReturnType<typeof useSideNavigation>;
