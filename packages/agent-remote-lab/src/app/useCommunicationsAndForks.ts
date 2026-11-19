// Focus, communications and forks.
import { otherEndpoint, participantTitle, stackPlan, windowLetterPlan } from '../state/letter-navigation.js';
import { createWindowView, type WindowEdit, type ProjectedTimelineEntry, type AgentCommandResult } from '@orchardworks/agent-remote-protocol';
import { windowSessionBinding } from '../window-workspace.js';
import { communicationResolver, communicationDirection, loadSessionCommunication, waitForCommunicationSession, type CommunicationSnapshot } from '../session-communication.js';
import type { CommunicationNavigation } from '@orchardworks/agent-client-web/react';
import { type SessionEntry, sessionKey } from '../session-tree.js';
import { sessionViewNavigation, type SessionViewNavigationActions } from '../session-view-navigation.js';
import { ConversationConnections } from '../conversation-connections.js';
import { useEffect } from 'react';
import type { AgentReplicaState } from '@orchardworks/agent-client';
import { SessionDirectoryClient, type OpenedSession } from '../directory-client.js';
import { sideNavigationSource, sideNavigationTarget, sideLinkVisible, referenceForkContext, captureForkContext, type SessionFork } from '../session-forks.js';
import { configureFork, sendForkInput } from '../fork-actions.js';
import { message, viewKey } from './helpers.js';
import type { WorkbenchShellSlice } from './useWorkbenchShell.js';
import type { SessionSuccessionBindingSlice } from './useSessionSuccessionBinding.js';
import type { ViewSessionStateSlice } from './useViewSessionState.js';
import type { FocusedAskSlice } from './useFocusedAsk.js';
import type { HostAndStackSlice } from './useHostAndStack.js';
import type { SideSelectionSlice } from './useSideSelection.js';
import type { PanelsAndShortcutsSlice } from './usePanelsAndShortcuts.js';
import type { ViewTargetsSlice } from './useViewTargets.js';
import type { ActiveSessionSlice } from './useActiveSession.js';
import type { SideNavigationSlice } from './useSideNavigation.js';
import type { ConversationConnectionsSlice } from './useConversationConnections.js';
import type { RequestedSessionSlice } from './useRequestedSession.js';
import type { WorkbenchRecordsSlice } from './useWorkbenchRecords.js';
import type { ProviderCreationSlice } from './useProviderCreation.js';
import type { WindowViewActionsSlice } from './useWindowViewActions.js';
import type { SessionOpeningSlice } from './useSessionOpening.js';
import type { RemoteHostStateSlice } from './useRemoteHostState.js';
import type { WindowModeActionsSlice } from './useWindowModeActions.js';
import type { AppInputs } from './types.js';

import { sessionQuotaMessage, sessionQuotaReached } from '../state/agent-creation.js';
import { copiesConversation, firstInputPending, forkCommandRoute, forkCreateOptions, forkedSession, forkKey, forkSettings, needsWorkspaceLookup, selectsSideAfterFork, withForkContext, workspaceOptions } from '../state/fork-plan.js';

export function useCommunicationsAndForks(scope: Pick<AppInputs & WorkbenchShellSlice & SessionSuccessionBindingSlice & ViewSessionStateSlice & FocusedAskSlice & HostAndStackSlice & SideSelectionSlice & PanelsAndShortcutsSlice & ViewTargetsSlice & ActiveSessionSlice & SideNavigationSlice & ConversationConnectionsSlice & RequestedSessionSlice & WorkbenchRecordsSlice & ProviderCreationSlice & WindowViewActionsSlice & SessionOpeningSlice & RemoteHostStateSlice & WindowModeActionsSlice, 'accessReady' | 'activeView' | 'ask' | 'askView' | 'assertSourceCurrent' | 'baseUrl' | 'compactLayout' | 'compactLayoutRef' | 'compositionProtected' | 'connections' | 'directory' | 'draftBindingFor' | 'editWindow' | 'favorites' | 'forkBusy' | 'forkReservation' | 'forkStore' | 'letterRequest' | 'letterReveals' | 'navigationGeneration' | 'nextSideRequest' | 'openChildSession' | 'openSession' | 'openWindows' | 'openedSessionsRef' | 'primaryExpanded' | 'refreshRelations' | 'rememberSession' | 'remoteHosts' | 'replicaFor' | 'replicas' | 'retryHosts' | 'selectSide' | 'selectedHost' | 'sessionEntries' | 'sessionWindows' | 'setDirectoryRevision' | 'setFailure' | 'setForkInputStatus' | 'setLetterReveals' | 'setSideAnchor' | 'setSideFocus' | 'sharedSlots' | 'sharedViewForSlot' | 'sharedWindow' | 'showView' | 'sideFocus' | 'sideRequestKey' | 'sideRequests' | 'sourceCurrent' | 'stackPath' | 'stackRange' | 'stackRoot' | 'state' | 'status' | 'succession' | 'traceRequestCounter' | 'transitioning' | 'transport' | 'viewSession' | 'windowMode' | 'windowWorkspace' | 'workbenchPanelRef'>) {
  const { accessReady, activeView, ask, askView, assertSourceCurrent, baseUrl, compactLayout, compactLayoutRef, compositionProtected, connections, directory, draftBindingFor, editWindow, favorites, forkBusy, forkReservation, forkStore, letterRequest, letterReveals, navigationGeneration, nextSideRequest, openChildSession, openSession, openWindows, openedSessionsRef, primaryExpanded, refreshRelations, rememberSession, remoteHosts, replicaFor, replicas, retryHosts, selectSide, selectedHost, sessionEntries, sessionWindows, setDirectoryRevision, setFailure, setForkInputStatus, setLetterReveals, setSideAnchor, setSideFocus, sharedSlots, sharedViewForSlot, sharedWindow, showView, sideFocus, sideRequestKey, sideRequests, sourceCurrent, stackPath, stackRange, stackRoot, state, status, succession, traceRequestCounter, transitioning, transport, viewSession, windowMode, windowWorkspace, workbenchPanelRef } = scope;

  useEffect(() => {
    if (windowMode && !sharedWindow && !compositionProtected && primaryExpanded && stackRoot && sideFocus === viewKey(stackRoot) && activeView === 'workbench') {
      const primary = workbenchPanelRef.current?.querySelector('.lab-primary-conversation');
      if (primary?.contains(document.activeElement)) return;
      primary?.querySelector<HTMLTextAreaElement>('textarea')?.focus({ preventScroll: true });
    }
  }, [compositionProtected, sideFocus, primaryExpanded, stackRoot?.agentId, activeView]);

  function focusSession(session: OpenedSession): void {
    sessionWindows.focus();
    setSideFocus(viewKey(session));
  }

  function focusPrimaryContent(target: EventTarget): void {
    if (!windowMode) return;
    // Navigation and layout controls must not create a visit before performing their action.
    if (target instanceof Element && target.closest('.lab-conversation-history, .lab-session-heading-actions-trigger, .lab-timeline-tools-toggle, .lab-session-main-minimize')) return;
    sessionWindows.focus();
    if (stackRoot) focusSession(stackRoot);
  }


  function communicationSnapshots(source: OpenedSession, sourceState?: AgentReplicaState): CommunicationSnapshot[] {
    const snapshots = openWindows.map(session => ({ session, state: session.agentId === state?.agent?.id ? state : replicas.get(session.agentId)?.getState() }));
    return [...snapshots.filter(snapshot => sessionKey(snapshot.session) !== sessionKey(source)), { session: source, state: sourceState }];
  }

  function communicationFamily(source: OpenedSession) {
    if (!sharedWindow) return [];
    let root = sharedViewForSlot(viewKey(source));
    while (root?.attachedTo) root = sharedWindow.views.find(view => view.id === root!.attachedTo);
    if (!root) return [];
    // Attached views follow their source in Window order, including several per source.
    const family = [root], ids = new Set([root.id]);
    for (const view of sharedWindow.views) if (view.attachedTo && ids.has(view.attachedTo)) { ids.add(view.id); family.push(view); }
    return family;
  }

  async function openCommunication(entry: ProjectedTimelineEntry, source: OpenedSession, sourceState?: AgentReplicaState): Promise<void> {
    if (!directory || entry.item.type !== 'agent_communication') throw new Error('Session navigation is unavailable in this view.');
    letterRequest.current?.abort();
    const controller = new AbortController(); letterRequest.current = controller;
    const deadline = setTimeout(() => controller.abort(new Error('Opening the letter timed out. Retry when the Host is connected.')), 60000);
    assertSourceCurrent(source);
    const originView = sharedViewForSlot(viewKey(source));
    const originWindowId = sharedWindow?.id;
    const generation = navigationGeneration.current;
    const check = () => { assertSourceCurrent(source); controller.signal.throwIfAborted(); if (generation !== navigationGeneration.current) throw new Error('The workspace changed. Open the letter again.'); };
    const leases = new Map<string, ReturnType<ConversationConnections['acquire']>>();
    const snapshots = communicationSnapshots(source, sourceState);
    const attachParticipant = async (identity: SessionEntry): Promise<OpenedSession> => {
      check();
      const known = [...openWindows, ...openedSessionsRef.current].find(session => sessionKey(session) === sessionKey(identity));
      // Native agent addresses identify letter endpoints; they must not rename a saved conversation.
      const title = participantTitle({ favorite: favorites.stars.find(session => sessionKey(session) === sessionKey(identity))?.title, known: known?.title, identity: identity.title });
      const active = connections.find(identity);
      if (active) return { ...known, ...identity, title, agentId: active.agentId };
      if (known && known.agentId === state?.agent?.id && status === 'ready') return { ...known, title };
      const target = (identity.hostId ?? 'local') === selectedHost.id ? directory : new SessionDirectoryClient(baseUrl, undefined, identity.hostId);
      const result = identity.parentNativeSessionId
        ? await target.attachChild(identity.providerId, identity.parentNativeSessionId, identity.nativeSessionId, controller.signal)
        : await target.attach(identity.providerId, identity.nativeSessionId, controller.signal);
      check();
      const opened = { ...known, ...identity, title, agentId: result.agentId };
      rememberSession(opened); return opened;
    };
    const observe = async (session: OpenedSession) => {
      let lease = leases.get(session.agentId);
      if (!lease) { lease = connections.acquire(session.agentId, replicaFor(session.agentId), session); leases.set(session.agentId, lease); }
      await waitForCommunicationSession(lease.client, controller.signal); check(); return lease;
    };
    try {
      let pair = communicationResolver(source, snapshots)(entry);
      // A child opened directly may not have its parent's native reference in view yet.
      if ((!pair.sender || !pair.recipient) && source.parentNativeSessionId) {
        const parent = await attachParticipant({ hostId: source.hostId, providerId: source.providerId, nativeSessionId: source.parentNativeSessionId, title: 'Parent conversation' });
        const lease = await observe(parent);
        for (;;) {
          check();
          const parentState = lease.replica.getState();
          pair = communicationResolver(source, [...snapshots, { session: parent, state: parentState }])(entry);
          if (pair.sender && pair.recipient || !parentState.timeline.hasOlder) break;
          const before = parentState.timeline.entries[0]?.seqStart;
          await lease.client.loadOlder();
          if (before === lease.replica.getState().timeline.entries[0]?.seqStart) break;
        }
      }
      if (!pair.sender || !pair.recipient || sessionKey(pair.sender) === sessionKey(pair.recipient)) {
        throw new Error('This history does not identify both sessions unambiguously. Load their agent activity and retry.');
      }
      if (originView && originWindowId) {
        const sourceKey = sessionKey(source);
        const endpoint = otherEndpoint(sourceKey, sessionKey(pair.sender), sessionKey(pair.recipient));
        if (!endpoint) throw new Error('This conversation is not an endpoint of the letter.');
        const destination = await attachParticipant(endpoint === 'sender' ? pair.sender : pair.recipient);
        const recipient = endpoint === 'sender' ? source : destination;
        const revealSession = compactLayoutRef.current ? destination : recipient;
        const observation = await observe(revealSession);
        const target = await loadSessionCommunication(observation, entry, controller.signal, compactLayoutRef.current ? endpoint : 'recipient');
        check();
        const current = windowWorkspace.readWindow();
        const origin = current?.views.find(view => view.id === originView.id);
        if (current?.id !== originWindowId || !origin?.binding || sessionKey(origin.binding) !== sourceKey) throw new Error('The source view changed. Open the letter again.');
        const family = communicationFamily(source);
        const existing = family.find(view => view.binding && sessionKey(view.binding) === sessionKey(destination));
        const operations: WindowEdit[] = [];
        const letterPlan = windowLetterPlan({ existingDestinationId: existing?.id, endpoint, compact: !!compactLayoutRef.current });
        let destinationId = existing?.id;
        if (letterPlan.create) {
          const child = { ...createWindowView(crypto.randomUUID(), windowSessionBinding(destination), 'attached'), attachedTo: origin.id };
          destinationId = child.id;
          operations.push({ type: 'view.create', view: child });
        }
        operations.push({ type: 'view.select', viewId: letterPlan.select === 'destination' ? destinationId! : origin.id });
        editWindow({ type: 'batch', operations });
        setLetterReveals(values => ({ ...values, [revealSession.agentId]: { ...target, align: 'start', requestId: ++traceRequestCounter.current } }));
        return;
      }
      if (compactLayoutRef.current) {
        const sourceKey = sessionKey(source);
        const endpoint = otherEndpoint(sourceKey, sessionKey(pair.sender), sessionKey(pair.recipient));
        if (!endpoint) throw new Error('This conversation is not an endpoint of the letter.');
        const destination = await attachParticipant(endpoint === 'sender' ? pair.sender : pair.recipient);
        const observation = await observe(destination);
        const target = await loadSessionCommunication(observation, entry, controller.signal, endpoint);
        check();
        if (!await openSession(destination, undefined, undefined, true)) throw new Error('The linked session could not be opened.');
        // Opening the other endpoint intentionally advances the navigation generation.
        controller.signal.throwIfAborted();
        setLetterReveals(values => ({ ...values, [destination.agentId]: { ...target, align: 'start', requestId: ++traceRequestCounter.current } }));
        await new Promise(resolve => setTimeout(resolve, 0));
        return;
      }
      const recipient = await attachParticipant(pair.recipient);
      const receiver = await observe(recipient);
      const sender = await attachParticipant(pair.sender);
      const target = await loadSessionCommunication(receiver, entry, controller.signal);
      check();
      const plan = stackPlan({ senderKey: sessionKey(sender), recipientKey: sessionKey(recipient), sourceKey: sessionKey(source), rootKey: stackRoot ? sessionKey(stackRoot) : undefined,
        path: stackPath.map(sessionKey), expanded: stackRange });
      const participant = (key: string) => sessionKey(sender) === key ? sender : recipient;
      if (plan.kind === 'select-side') selectSide(participant(plan.from), participant(plan.to));
      else if (plan.kind === 'anchor') setSideAnchor(viewKey(stackPath[plan.index]!));
      else if (plan.kind === 'open-origin') {
        const origin = participant(plan.from);
        if (!await openSession(origin, undefined, undefined, true)) throw new Error('The sending session could not be opened.');
        selectSide(origin, participant(plan.to));
      }
      setSideFocus(viewKey(viewSession(recipient))); showView('workbench');
      setLetterReveals(values => ({ ...values, [recipient.agentId]: { ...target, align: 'start', requestId: ++traceRequestCounter.current } }));
      // Mounted panes acquire their own leases before this temporary navigation lease is released.
      await new Promise(resolve => setTimeout(resolve, 0));
    } finally {
      clearTimeout(deadline); for (const lease of leases.values()) lease.release();
      if (letterRequest.current === controller) letterRequest.current = undefined;
    }
  }

  function letterNavigation(source: OpenedSession, sourceState?: AgentReplicaState): CommunicationNavigation {
    const participants = communicationResolver(source, communicationSnapshots(source, sourceState));
    const visible = compactLayout ? [] : sharedWindow ? communicationFamily(source).flatMap(view => {
      if (!view.binding || view.collapsed) return [];
      return [{ ...view.binding, agentId: connections.find(view.binding)?.agentId ?? '', viewId: sharedSlots?.get(view.id)?.id }];
    }) : stackPath.slice(stackRange.start, stackRange.end + 1);
    return {
      direction: entry => communicationDirection(participants(entry).recipient, source, visible),
      open: entry => openCommunication(entry, source, sourceState),
    };
  }


  function viewNavigation(rawSource: OpenedSession, sourceState?: AgentReplicaState, actions?: SessionViewNavigationActions) {
    const source = actions ? rawSource : viewSession(rawSource);
    const available = directory && accessReady && sourceCurrent(source) && !transitioning && remoteHosts.find(host => host.id === source.hostId)?.online !== false;
    return sessionViewNavigation({ source, state: sourceState, entries: sessionEntries,
      openSession: actions?.openSession ?? (available ? (session, intent) => openSession(session, undefined, undefined, false, undefined, intent) : undefined),
      openChildSession: actions?.openChildSession ?? (available ? child => openChildSession(child, source, sourceState) : undefined),
      communication: available ? letterNavigation(source, sourceState) : undefined,
      revealEntry: letterReveals[source.agentId],
    });
  }


  async function openFork(record: SessionFork): Promise<void> {
    letterRequest.current?.abort();
    if (!record.target || !directory || !sideLinkVisible(forkStore.get(record.id))) return;
    const saved = sideNavigationTarget(record)!;
    const source = sideNavigationSource(record);
    const request = nextSideRequest(source);
    const target = (saved.hostId ?? 'local') === selectedHost.id ? directory : new SessionDirectoryClient(baseUrl, undefined, saved.hostId);
    try {
      const result = await target.attach(saved.providerId, saved.nativeSessionId);
      const session = { ...saved, agentId: result.agentId };
      if (sessionKey(saved) === sessionKey(record.target)) {
        forkStore.bind(record.id, session);
        await configureFork(transport, forkStore, forkStore.get(record.id));
      } else forkStore.followEditedSide(record.id, saved, session);
      rememberSession(session);
      if (sideRequests.current.get(sideRequestKey(source)) === request && sideLinkVisible(forkStore.get(record.id)) && sessionKey(session) !== sessionKey(source)) selectSide(source, session);
    } catch (error) {
      if (sideRequests.current.get(sideRequestKey(source)) === request) setFailure(message(error, 'Forked session could not be opened.'));
    }
  }


  async function createFork(sourceState: AgentReplicaState, saved: OpenedSession | undefined, id: string, args: string): Promise<AgentCommandResult> {
    letterRequest.current?.abort();
    const agent = sourceState.agent;
    if (!directory || !agent?.runtimeInfo.sessionId) throw new Error('This session cannot be forked.');
    const source = viewSession(saved ?? { agentId: agent.id, nativeSessionId: agent.runtimeInfo.sessionId, providerId: agent.providerId, title: 'Conversation', hostId: 'local' });
    assertSourceCurrent(source);
    const associationOwner = succession.ownerFor(viewKey(source));
    const route = forkCommandRoute(id, args);
    if (route === 'ask-setting') return askView.execute(args);
    if (route === 'ask-open') {
      askView.setVisible(true);
      return ask.open(sourceState, source, args, false, { associationOwner, synchronize: async () => { assertSourceCurrent(source); await refreshRelations(); assertSourceCurrent(source); } });
    }
    if (forkBusy.current) throw new Error('A session fork is already being created.');
    forkBusy.current = true;
    try {
      const target = (source.hostId ?? 'local') === selectedHost.id ? directory : new SessionDirectoryClient(baseUrl, undefined, source.hostId);
      const key = forkKey(sessionKey(source), id, args);
      let record = forkReservation.current?.key === key ? forkStore.get(forkReservation.current.record.id) : forkStore.all().find((fork) => fork.creationKey === key);
      if (!record) {
        if (sessionQuotaReached(remoteHosts.find((host) => host.id === source.hostId)?.sessionQuota)) throw new Error(sessionQuotaMessage);
        const context = copiesConversation(id) ? await captureForkContext(transport, source) : referenceForkContext(source);
        const settings = forkSettings(agent.runtimeInfo.settings ?? []);
        const placed = needsWorkspaceLookup(source) ? workspaceOptions(agent.cwd, (await target.workspaces(source.providerId)).workspaces)
          : forkCreateOptions({ cwd: agent.cwd, model: agent.model, capabilities: agent.capabilities, planningActive: agent.runtimeInfo.planning?.active === true }, source.providerId);
        record = forkStore.prepare(context, withForkContext(placed, context.mode, source), settings, key);
        forkReservation.current = { key, record };
      }
      assertSourceCurrent(source);
      let result: { agentId: string; nativeSessionId?: string };
      if (record.target) result = await target.attach(record.target.providerId, record.target.nativeSessionId);
      else {
        try { result = await target.create(source.providerId, record.id, record.options); }
        finally { if (source.hostId && source.hostId !== 'local') retryHosts(); }
      }
      const session = viewSession(forkedSession(source, result, record.capturedAt));
      forkStore.bind(record.id, session);
      assertSourceCurrent(source);
      await configureFork(transport, forkStore, forkStore.get(record.id));
      assertSourceCurrent(source);
      rememberSession(source); rememberSession(session);
      setDirectoryRevision((value) => value + 1);
      const draft = draftBindingFor(session);
      if (args.trim()) draft.store.set(draft.key, args.trim());
      if (selectsSideAfterFork(id, sideLinkVisible(forkStore.get(record.id)))) selectSide(source, session);
      assertSourceCurrent(source);
      if (firstInputPending(args, forkStore.get(record.id).delivery)) {
        setForkInputStatus({ agentId: session.agentId, pending: true });
        try { await sendForkInput(transport, forkStore, forkStore.get(record.id), args.trim()); }
        catch (error) { setForkInputStatus({ agentId: session.agentId, pending: false, error: message(error, 'The first fork input failed.') }); throw error; }
        setForkInputStatus(undefined);
        if (draft.store.get(draft.key) === args.trim()) draft.store.set(draft.key, '');
      }
      forkStore.finishCreation(record.id);
      forkReservation.current = undefined;
      return {};
    } finally { forkBusy.current = false; }
  }
  return { focusSession, focusPrimaryContent, viewNavigation, openFork, createFork };
}

export type CommunicationsAndForksSlice = ReturnType<typeof useCommunicationsAndForks>;
