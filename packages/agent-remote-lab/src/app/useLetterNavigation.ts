import { otherEndpoint, participantTitle, stackPlan, windowLetterPlan } from '../features/session-links/letter-navigation.js';
import { createWindowView, type WindowEdit, type ProjectedTimelineEntry } from '@orchardworks/agent-remote-protocol';
import { windowSessionBinding } from '../kernel/window-workspace.js';
import { communicationResolver, communicationDirection, loadSessionCommunication, waitForCommunicationSession, type CommunicationSnapshot } from '../features/session-links/session-communication.js';
import type { CommunicationNavigation } from '@orchardworks/agent-client-web/react';
import { type SessionEntry, sessionKey } from '../kernel/session-tree.js';
import { ConversationConnections } from '../conversation/conversation-connections.js';
import type { AgentReplicaState } from '@orchardworks/agent-client';
import { SessionDirectoryClient, type OpenedSession } from '../kernel/directory-client.js';
import { viewKey } from './helpers.js';
import type { AppInputs } from './types.js';
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
import { useTranslate } from '@orchardworks/agent-client-web/react';

// Opening the other endpoint of a letter between sessions.
export function useLetterNavigation(scope: Pick<AppInputs & WorkbenchShellSlice & SessionSuccessionBindingSlice & ViewSessionStateSlice & FocusedAskSlice & HostAndStackSlice & SideSelectionSlice & PanelsAndShortcutsSlice & ViewTargetsSlice & ActiveSessionSlice & SideNavigationSlice & ConversationConnectionsSlice & RequestedSessionSlice & WorkbenchRecordsSlice & ProviderCreationSlice & WindowViewActionsSlice & SessionOpeningSlice & RemoteHostStateSlice & WindowModeActionsSlice, 'assertSourceCurrent' | 'baseUrl' | 'compactLayout' | 'compactLayoutRef' | 'connections' | 'directory' | 'editWindow' | 'favorites' | 'letterRequest' | 'navigationGeneration' | 'openSession' | 'openWindows' | 'openedSessionsRef' | 'rememberSession' | 'replicaFor' | 'replicas' | 'selectSide' | 'selectedHost' | 'setLetterReveals' | 'setSideAnchor' | 'setSideFocus' | 'sharedSlots' | 'sharedViewForSlot' | 'sharedWindow' | 'showView' | 'stackPath' | 'stackRange' | 'stackRoot' | 'state' | 'status' | 'traceRequestCounter' | 'viewSession' | 'windowWorkspace'>) {
  const t = useTranslate();
  const { assertSourceCurrent, baseUrl, compactLayout, compactLayoutRef, connections, directory, editWindow, favorites, letterRequest, navigationGeneration, openSession, openWindows, openedSessionsRef, rememberSession, replicaFor, replicas, selectSide, selectedHost, setLetterReveals, setSideAnchor, setSideFocus, sharedSlots, sharedViewForSlot, sharedWindow, showView, stackPath, stackRange, stackRoot, state, status, traceRequestCounter, viewSession, windowWorkspace } = scope;

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
    if (!directory || entry.item.type !== 'agent_communication') throw new Error(t('sessions.letter.unavailable'));
    letterRequest.current?.abort();
    const controller = new AbortController(); letterRequest.current = controller;
    const deadline = setTimeout(() => controller.abort(new Error(t('sessions.letter.timedOut'))), 60000);
    assertSourceCurrent(source);
    const originView = sharedViewForSlot(viewKey(source));
    const originWindowId = sharedWindow?.id;
    const generation = navigationGeneration.current;
    const check = () => { assertSourceCurrent(source); controller.signal.throwIfAborted(); if (generation !== navigationGeneration.current) throw new Error(t('sessions.letter.workspaceChanged')); };
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
        const parent = await attachParticipant({ hostId: source.hostId, providerId: source.providerId, nativeSessionId: source.parentNativeSessionId, title: t('sessions.fallbackTitle.parent') });
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
        throw new Error(t('sessions.letter.ambiguous'));
      }
      if (originView && originWindowId) {
        const sourceKey = sessionKey(source);
        const endpoint = otherEndpoint(sourceKey, sessionKey(pair.sender), sessionKey(pair.recipient));
        if (!endpoint) throw new Error(t('sessions.letter.notEndpoint'));
        const destination = await attachParticipant(endpoint === 'sender' ? pair.sender : pair.recipient);
        const recipient = endpoint === 'sender' ? source : destination;
        const revealSession = compactLayoutRef.current ? destination : recipient;
        const observation = await observe(revealSession);
        const target = await loadSessionCommunication(observation, entry, controller.signal, compactLayoutRef.current ? endpoint : 'recipient');
        check();
        const current = windowWorkspace.readWindow();
        const origin = current?.views.find(view => view.id === originView.id);
        if (current?.id !== originWindowId || !origin?.binding || sessionKey(origin.binding) !== sourceKey) throw new Error(t('sessions.letter.sourceChanged'));
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
        if (!endpoint) throw new Error(t('sessions.letter.notEndpoint'));
        const destination = await attachParticipant(endpoint === 'sender' ? pair.sender : pair.recipient);
        const observation = await observe(destination);
        const target = await loadSessionCommunication(observation, entry, controller.signal, endpoint);
        check();
        if (!await openSession(destination, undefined, undefined, true)) throw new Error(t('sessions.letter.linkedOpenFailed'));
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
        if (!await openSession(origin, undefined, undefined, true)) throw new Error(t('sessions.letter.senderOpenFailed'));
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
  return { letterNavigation };
}

export type LetterNavigationSlice = ReturnType<typeof useLetterNavigation>;
