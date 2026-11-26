// The succession model and the Window workspace bound to it.
import { errorWords } from '@orchardworks/agent-client';
import { useWindowWorkspace } from '../features/windows/useWindowWorkspace.js';
import { useWindowSessionRetention } from '../features/windows/useWindowSessionRetention.js';
import { useWindowActions } from '../features/windows/useWindowActions.js';
import type { Team, WindowGroupOperation } from '@orchardworks/agent-remote-protocol';
import { DraftStore } from '../kernel/draft-store.js';
import { useSessionSuccession } from '../hooks/useSessionSuccession.js';
import { sessionConnectionFailure } from '../kernel/SessionConnectionNotice.js';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useTranslate } from '@orchardworks/agent-client-web/react';
import { accountNames, withAssistantNames } from '../kernel/assistant-names.js';
import { DirectoryError, nativeSessionMissing, SessionDirectoryClient } from '../kernel/directory-client.js';
import { unavailableSessions } from '../kernel/unavailable-sessions.js';
import { sessionKey } from '../kernel/session-tree.js';
import { viewKey } from './helpers.js';
import type { ProviderStateSlice } from './useProviderState.js';
import type { WorkbenchShellSlice } from './useWorkbenchShell.js';
import type { RequestedSessionSlice } from './useRequestedSession.js';
import type { ConversationConnectionsSlice } from './useConversationConnections.js';
import type { WorkbenchRecordsSlice } from './useWorkbenchRecords.js';
import type { AppInputs } from './types.js';
import type { AppLate } from './types.js';

export function useSessionSuccessionBinding(scope: Pick<AppInputs & ProviderStateSlice & WorkbenchShellSlice & RequestedSessionSlice & ConversationConnectionsSlice & WorkbenchRecordsSlice, 'accessReady' | 'canRead' | 'activated' | 'asleepSlot' | 'baseUrl' | 'cachedState' | 'clientRef' | 'connections' | 'directory' | 'draftStores' | 'initialLayout' | 'initialSession' | 'initialState' | 'liveConnections' | 'markSessionMissing' | 'navigation' | 'navigationGeneration' | 'openedSessionsRef' | 'pendingViewRestore' | 'primaryBinding' | 'replicaFor' | 'replicaRef' | 'replicas' | 'selectedHost' | 'setProviderName' | 'teamRoster' | 'teamRosterRef' | 'transport' | 'unsubscribeReplicaRef' | 'userScoped'>, late: AppLate) {
  const t = useTranslate();
  const { accessReady, canRead, activated, asleepSlot, baseUrl, cachedState, clientRef, connections, directory, draftStores, initialLayout, initialSession, initialState, liveConnections, markSessionMissing, navigation, navigationGeneration, openedSessionsRef, pendingViewRestore, primaryBinding, replicaFor, replicaRef, replicas, selectedHost, setProviderName, teamRoster, teamRosterRef, transport, unsubscribeReplicaRef, userScoped } = scope;

  const succession = useSessionSuccession({
    // A slot the live budget has not met yet counts as live, so a sleeping bot is checked here too: attaching it would
    // resume its native session before its conversation says it is folded.
    attachmentAllowed: (slotId, document) => liveConnections.live(slotId) && !asleepSlot.current(slotId, document),
    scope: baseUrl, transport, enabled: activated && accessReady,
    initial: initialSession, initialDisplayState: cachedState, initialLayout: initialSession ? initialLayout : undefined,
    connections, replicaFor, directory: hostId => hostId === selectedHost.id && directory ? directory : new SessionDirectoryClient(baseUrl, undefined, hostId),
    cachedReplicaFor: target => {
      const saved = openedSessionsRef.current.find(item => sessionKey(item) === sessionKey(target));
      return saved ? replicas.get(saved.agentId) : undefined;
    },
    layout: () => ({ path: late.stackPath, selections: late.sideSelections, focus: late.sideFocus, anchor: late.sideAnchor, address: late.addressSession ? viewKey(late.addressSession) : undefined, collapsed: late.stackPath.filter(session => !late.expandedKeys.has(viewKey(session))).map(viewKey) }),
    textStore: scope => { let store = draftStores.get(scope); if (!store) { store = new DraftStore(scope); draftStores.set(scope, store); } return store; },
    tracking: () => late.tracking, ask: () => late.ask,
    retireNative: () => {
      navigationGeneration.current++;
      unsubscribeReplicaRef.current?.(); unsubscribeReplicaRef.current = undefined;
      clientRef.current = undefined; replicaRef.current = undefined; primaryBinding.current = undefined;
    },
    bindNative: binding => {
      clientRef.current = binding.client; replicaRef.current = binding.replica;
      primaryBinding.current = { baseUrl, transport, agentId: binding.session.agentId };
    },
    confirmed: session => {
      late.rememberSession(session); late.setAttachingAgentId(undefined); late.setSessionNotice(undefined);
      const pending = pendingViewRestore.current; pendingViewRestore.current = undefined;
      const view = pending?.scope === baseUrl && pending.transport === transport && pending.slotId === session.viewId ? pending.read() : undefined;
      if (view) { late.setSideSelections(current => ({ ...current, ...view.selections })); late.setSideFocus(view.focus); late.setSideAnchor(view.anchor); }
      setProviderName(late.providerConnectionName(session.hostId ?? 'local', session.providerId));
    },
    failed: (error, selection, retrying = false) => {
      if (!retrying && nativeSessionMissing(error)) { markSessionMissing(selection); unavailableSessions(transport).remember(selection, error); }
      late.setSessionNotice({ ...sessionConnectionFailure(error, retrying, t), successionError: errorWords(error, t, 'sessions.connection.openFailed') });
      if (error instanceof DirectoryError && error.nativeOwner) late.setNativeTakeover({ item: selection, owner: error.nativeOwner, message: error.message });
    },
  });

  const [nativeBootstrap] = useState(() => !initialSession?.nativeSessionId && !!initialSession?.agentId);

  const [bootstrapComplete, setBootstrapComplete] = useState(!nativeBootstrap);

  useEffect(() => { if (nativeBootstrap && succession.binding) setBootstrapComplete(true); }, [nativeBootstrap, succession.binding]);

  // A supplied snapshot is a standalone rendering input; it does not require a Window controller.
  const workspaceController = useWindowWorkspace(baseUrl, userScoped, accessReady, succession.document, !initialState && bootstrapComplete, { mode: navigation.mode, onSectionRoute: navigation.acceptSectionRoute }, canRead);

  const sharedWindow = initialState ? undefined : workspaceController.window;

  // Window retention keeps a view's connection only while the live budget keeps the view's conversation live.
  const retainedView = useCallback((windowId: string, viewId: string) => {
    const slotId = succession.document.windowBindings?.find(entry => entry.windowId === windowId && entry.viewId === viewId)?.slotId;
    return !slotId || liveConnections.live(slotId);
  }, [liveConnections.version, succession.document]);

  const windowRetention = useWindowSessionRetention(connections, sharedWindow, undefined, retainedView);

  useEffect(() => {
    for (const id of workspaceController.deletedWindowIds) windowRetention.forgetWindow(id);
  }, [workspaceController.deletedWindowIds, windowRetention]);

  // Every assistant of the account is called by one name on every device; a bot's first edit stores the generated one.
  const assistantNames = useMemo(() => accountNames(workspaceController.groups, t), [workspaceController.groups, t]);
  const names = useRef(assistantNames); names.current = assistantNames;
  // As stable as the workspace's own, so what depends on it does not run again on every render.
  const { operateGroup: operate, readGroup } = workspaceController;
  const operateGroup = useCallback((id: string, operation: WindowGroupOperation) => operate(id, withAssistantNames(readGroup(id), operation, names.current)), [operate, readGroup]);
  const windowWorkspace = { ...workspaceController, operateGroup,
    ...(initialState ? { window: undefined, authority: undefined, sessionBridge: undefined, unavailable: false, provisional: false } : {}),
  };

  asleepSlot.current = (slotId, document) => {
    const placed = document.windowBindings?.find(entry => entry.slotId === slotId);
    return !!placed && !!workspaceController.readGroup(placed.windowId)?.bots?.members[placed.viewId]?.asleep;
  };

  // One set of Window actions for the sidebar's Windows list and the Window toolbar: one busy state, one notice, shown as a toast.
  const windowActions = useWindowActions(windowWorkspace, baseUrl);
  return { succession, sharedWindow, windowWorkspace, windowActions, assistantNames };
}

export type SessionSuccessionBindingSlice = ReturnType<typeof useSessionSuccessionBinding>;
