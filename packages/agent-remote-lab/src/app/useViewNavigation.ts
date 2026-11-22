import { sessionViewNavigation, type SessionViewNavigationActions } from '../kernel/session-view-navigation.js';
import type { AgentReplicaState } from '@orchardworks/agent-client';
import { type OpenedSession } from '../kernel/directory-client.js';
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
import type { LetterNavigationSlice } from './useLetterNavigation.js';

// The navigation a session view offers: history, children and letters.
export function useViewNavigation(scope: Pick<AppInputs & WorkbenchShellSlice & SessionSuccessionBindingSlice & ViewSessionStateSlice & FocusedAskSlice & HostAndStackSlice & SideSelectionSlice & PanelsAndShortcutsSlice & ViewTargetsSlice & ActiveSessionSlice & SideNavigationSlice & ConversationConnectionsSlice & RequestedSessionSlice & WorkbenchRecordsSlice & ProviderCreationSlice & WindowViewActionsSlice & SessionOpeningSlice & RemoteHostStateSlice & WindowModeActionsSlice & LetterNavigationSlice, 'accessReady' | 'directory' | 'letterReveals' | 'openChildSession' | 'openSession' | 'remoteHosts' | 'sessionEntries' | 'sourceCurrent' | 'transitioning' | 'viewSession' | 'letterNavigation'>) {
  const { accessReady, directory, letterReveals, openChildSession, openSession, remoteHosts, sessionEntries, sourceCurrent, transitioning, viewSession, letterNavigation } = scope;

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
  return { viewNavigation };
}

export type ViewNavigationSlice = ReturnType<typeof useViewNavigation>;
