// Focus, letters, view navigation and forks, as one hook per concern in the order of the original function.
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
import { usePrimaryFocus } from './usePrimaryFocus.js';
import { useLetterNavigation } from './useLetterNavigation.js';
import { useViewNavigation } from './useViewNavigation.js';
import { useForks } from './useForks.js';

export function useCommunicationsAndForks(scope: Pick<AppInputs & WorkbenchShellSlice & SessionSuccessionBindingSlice & ViewSessionStateSlice & FocusedAskSlice & HostAndStackSlice & SideSelectionSlice & PanelsAndShortcutsSlice & ViewTargetsSlice & ActiveSessionSlice & SideNavigationSlice & ConversationConnectionsSlice & RequestedSessionSlice & WorkbenchRecordsSlice & ProviderCreationSlice & WindowViewActionsSlice & SessionOpeningSlice & RemoteHostStateSlice & WindowModeActionsSlice, 'accessReady' | 'activeView' | 'ask' | 'askView' | 'assertSourceCurrent' | 'baseUrl' | 'compactLayout' | 'compactLayoutRef' | 'compositionProtected' | 'connections' | 'directory' | 'draftBindingFor' | 'editWindow' | 'favorites' | 'forkBusy' | 'forkReservation' | 'forkStore' | 'letterRequest' | 'letterReveals' | 'navigationGeneration' | 'nextSideRequest' | 'openChildSession' | 'openSession' | 'openWindows' | 'openedSessionsRef' | 'primaryExpanded' | 'refreshRelations' | 'rememberSession' | 'remoteHosts' | 'replicaFor' | 'replicas' | 'retryHosts' | 'selectSide' | 'selectedHost' | 'sessionEntries' | 'sessionWindows' | 'setDirectoryRevision' | 'setFailure' | 'setForkInputStatus' | 'setLetterReveals' | 'setSideAnchor' | 'setSideFocus' | 'sharedSlots' | 'sharedViewForSlot' | 'sharedWindow' | 'showView' | 'sideFocus' | 'sideRequestKey' | 'sideRequests' | 'sourceCurrent' | 'stackPath' | 'stackRange' | 'stackRoot' | 'state' | 'status' | 'succession' | 'traceRequestCounter' | 'transitioning' | 'transport' | 'viewSession' | 'windowMode' | 'windowWorkspace' | 'workbenchPanelRef'>) {
  const part1 = usePrimaryFocus({ ...scope });
  const part2 = useLetterNavigation({ ...scope, ...part1 });
  const part3 = useViewNavigation({ ...scope, ...part1, ...part2 });
  const part4 = useForks({ ...scope, ...part1, ...part2, ...part3 });
  return { ...part1, ...part2, ...part3, ...part4 };
}

export type CommunicationsAndForksSlice = ReturnType<typeof useCommunicationsAndForks>;
