// The active Host, the conversation stack, the page title and renaming.
import { remoteSessionState, RemoteOperationError, sessionActivityLabel } from '@orchardworks/agent-client';
import { useEffect } from 'react';
import { compositionSession } from '../session-composition.js';
import type { OpenedSession } from '../directory-client.js';
import { sessionKey } from '../session-tree.js';
import { sidePath } from '../side-tree.js';
import { viewKey } from './helpers.js';
import type { ActiveSessionSlice } from './useActiveSession.js';
import type { RemoteHostStateSlice } from './useRemoteHostState.js';
import type { RequestedSessionSlice } from './useRequestedSession.js';
import type { ProviderStateSlice } from './useProviderState.js';
import type { ViewSessionStateSlice } from './useViewSessionState.js';
import type { SessionSuccessionBindingSlice } from './useSessionSuccessionBinding.js';
import type { ProviderCreationSlice } from './useProviderCreation.js';
import type { ConversationConnectionsSlice } from './useConversationConnections.js';
import type { WorkbenchRecordsSlice } from './useWorkbenchRecords.js';
import type { SideSelectionSlice } from './useSideSelection.js';
import type { WorkbenchShellSlice } from './useWorkbenchShell.js';
import type { DocksAndBotSelectionSlice } from './useDocksAndBotSelection.js';
import type { AppInputs } from './types.js';
import type { AppLate } from './types.js';

export function useHostAndStack(scope: Pick<AppInputs & ActiveSessionSlice & RemoteHostStateSlice & RequestedSessionSlice & ProviderStateSlice & ViewSessionStateSlice & SessionSuccessionBindingSlice & ProviderCreationSlice & ConversationConnectionsSlice & WorkbenchRecordsSlice & SideSelectionSlice & WorkbenchShellSlice & DocksAndBotSelectionSlice, 'accessReady' | 'activeAgentId' | 'activeOpened' | 'baseUrl' | 'confirmedTitles' | 'currentSession' | 'detachedSideRoot' | 'directoryView' | 'forkStore' | 'initialState' | 'primaryGroups' | 'providerConnectionName' | 'providerName' | 'remoteHosts' | 'selectedHost' | 'setRenamingSession' | 'setUncertainMutation' | 'sharedWindow' | 'sideSelections' | 'sideSessions' | 'state' | 'status' | 'succession' | 'userScoped' | 'viewSession' | 'windowMode'>, late: AppLate) {
  const { accessReady, activeAgentId, activeOpened, baseUrl, confirmedTitles, currentSession, detachedSideRoot, directoryView, forkStore, initialState, primaryGroups, providerConnectionName, providerName, remoteHosts, selectedHost, setRenamingSession, setUncertainMutation, sharedWindow, sideSelections, sideSessions, state, status, succession, userScoped, viewSession, windowMode } = scope;

  const activeRemoteSession = activeOpened?.hostId !== undefined && activeOpened.hostId !== 'local';

  const activeHost = remoteHosts.find((host) => host.id === activeOpened?.hostId);

  const selectedRemoteHost = selectedHost.id !== 'local' ? remoteHosts.find((host) => host.id === selectedHost.id) : undefined;

  const previewHost = activeHost ?? selectedRemoteHost;

  const hostOffline = activeHost?.online === false;

  const connectionProviderName = providerName ?? state?.agent?.providerId ?? (succession.selected ? providerConnectionName(succession.selected.hostId ?? 'local', succession.selected.providerId) : 'No active Agent');

  // The session's activity, never its connection phase (target T5). Its notice is said once, by the conversation itself.
  const connectionStatusLabel = sessionActivityLabel({ session: remoteSessionState(state, status), replica: state }) ?? '';



  async function runMutation<T>(operation: () => Promise<T>): Promise<T> {
    setUncertainMutation(false);
    try { return await operation(); } catch (error) {
      if (error instanceof RemoteOperationError && ['connection_disconnected', 'operation_timeout'].includes(error.code)) setUncertainMutation(true);
      throw error;
    }
  }


  const activeFork = forkStore.find(activeOpened ?? (state?.agent?.runtimeInfo.sessionId ? {
    providerId: state.agent.providerId, nativeSessionId: state.agent.runtimeInfo.sessionId, hostId: 'local',
  } : undefined));

  const boundFork = activeFork && activeAgentId ? { ...activeFork, target: { ...activeFork.target!, agentId: activeAgentId } } : undefined;


  const rootSession = succession.active ? succession.binding?.session ?? (succession.desired ? compositionSession(succession.desired.slot) : undefined) : activeOpened ?? (state?.agent?.runtimeInfo.sessionId ? {
    agentId: state.agent.id, nativeSessionId: state.agent.runtimeInfo.sessionId, providerId: state.agent.providerId, hostId: 'local', title: 'Conversation',
  } : undefined);

  const stackRoot = rootSession ? viewSession(rootSession) : undefined;

  const primaryDisplaySlot = stackRoot ? succession.document.slots.find(slot => slot.id === viewKey(stackRoot)) : succession.displaySlot;

  useEffect(() => { if (initialState && stackRoot && !succession.active) void succession.save(); }, [stackRoot?.viewId, initialState]);

  const visibleStackRoot = sideSessions.find(session => viewKey(session) === detachedSideRoot) ?? stackRoot;

  const featureBinding = directoryView?.binding;

  const featureSource = sharedWindow ? featureBinding && {
    hostId: featureBinding.hostId, providerId: featureBinding.providerId,
    nativeSessionId: featureBinding.nativeSessionId, title: confirmedTitles?.get(sessionKey(featureBinding)) ?? featureBinding.title,
  } : visibleStackRoot ? { ...visibleStackRoot, hostId: visibleStackRoot.hostId ?? 'local' }
    : currentSession ? { ...currentSession, hostId: currentSession.hostId ?? 'local' } : undefined;

  const renameHost = remoteHosts.find(host => host.id === visibleStackRoot?.hostId);

  const canRenamePrimary = userScoped && accessReady && renameHost?.online === true
    && renameHost.providers?.some(provider => provider.providerId === visibleStackRoot?.providerId && provider.sessionRename === true);

  const renamePrimaryTitle = canRenamePrimary && visibleStackRoot?.hostId ? () => {
    setRenamingSession({ scope: baseUrl, session: { ...visibleStackRoot, hostId: visibleStackRoot.hostId! } });
  } : undefined;

  const pageTitleBinding = (() => {
    if (!sharedWindow) return;
    const roots = [...primaryGroups, ...sharedWindow.views.filter(view => view.placement === 'dock'),
      ...sharedWindow.views.filter(view => view.placement === 'float')];
    return roots.find(view => view.binding)?.binding;
  })();

  const pageTitle = sharedWindow ? (pageTitleBinding && (confirmedTitles?.get(sessionKey(pageTitleBinding)) ?? pageTitleBinding.title)) || sharedWindow.title : featureSource?.title;

  useEffect(() => {
    if (!windowMode) return;
    document.title = pageTitle?.trim() ? `${pageTitle.trim()} · Agent Remote Control` : 'Agent Remote Control';
    return () => { document.title = 'Agent Remote Control'; };
  }, [pageTitle, windowMode]);

  const sideTitle = (session: OpenedSession) => ({ ...session, title: forkStore.find(session)?.firstInput?.trim().slice(0, 72) || session.title });

  const stackPath = sidePath(visibleStackRoot, sideSessions, sideSelections, viewKey).map(sideTitle);
  late.stackPath = stackPath;
  return { activeRemoteSession, selectedRemoteHost, previewHost, hostOffline, connectionProviderName, connectionStatusLabel, runMutation, boundFork, stackRoot, primaryDisplaySlot, visibleStackRoot, featureSource, renamePrimaryTitle, sideTitle, stackPath };
}

export type HostAndStackSlice = ReturnType<typeof useHostAndStack>;
