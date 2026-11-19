// Opening, creating and binding sessions, as one hook per concern in the order of the original function.
import type { HostAndStackSlice } from './useHostAndStack.js';
import type { ViewSessionStateSlice } from './useViewSessionState.js';
import type { SideSelectionSlice } from './useSideSelection.js';
import type { SessionSuccessionBindingSlice } from './useSessionSuccessionBinding.js';
import type { PanelsAndShortcutsSlice } from './usePanelsAndShortcuts.js';
import type { ActiveSessionSlice } from './useActiveSession.js';
import type { WorkbenchRecordsSlice } from './useWorkbenchRecords.js';
import type { RequestedSessionSlice } from './useRequestedSession.js';
import type { ConversationConnectionsSlice } from './useConversationConnections.js';
import type { WorkbenchShellSlice } from './useWorkbenchShell.js';
import type { ViewTargetsSlice } from './useViewTargets.js';
import type { WindowViewActionsSlice } from './useWindowViewActions.js';
import type { RemoteHostStateSlice } from './useRemoteHostState.js';
import type { ProviderCreationSlice } from './useProviderCreation.js';
import type { ProviderStateSlice } from './useProviderState.js';
import type { SharedFeedsAndTpmSlice } from './useSharedFeedsAndTpm.js';
import type { AppInputs } from './types.js';
import type { AppLate } from './types.js';
import { useStackSelection } from './useStackSelection.js';
import { useSessionBinding } from './useSessionBinding.js';
import { useAgentCreation } from './useAgentCreation.js';
import { useTeamOpening } from './useTeamOpening.js';
import { useTpmMainOpening } from './useTpmMainOpening.js';

export function useSessionOpening(scope: Pick<AppInputs & HostAndStackSlice & ViewSessionStateSlice & SideSelectionSlice & SessionSuccessionBindingSlice & PanelsAndShortcutsSlice & ActiveSessionSlice & WorkbenchRecordsSlice & RequestedSessionSlice & ConversationConnectionsSlice & WorkbenchShellSlice & ViewTargetsSlice & WindowViewActionsSlice & RemoteHostStateSlice & ProviderCreationSlice & ProviderStateSlice & SharedFeedsAndTpmSlice, 'accessReadyRef' | 'activeAgentId' | 'ancestors' | 'attach' | 'baseUrl' | 'closeContext' | 'closeInspector' | 'compactLayout' | 'compactLayoutRef' | 'createPlanning' | 'creationReservation' | 'creationUnavailableReason' | 'directory' | 'directoryDestination' | 'dispatchPanels' | 'editWindow' | 'letterRequest' | 'mountedTransport' | 'navigation' | 'openedSessions' | 'pendingViewRestore' | 'presentedSelection' | 'providerConnectionName' | 'providerId' | 'rememberSession' | 'replicaFor' | 'retryHosts' | 'selectedHost' | 'sessionEntries' | 'sessionOptions' | 'sessionWindows' | 'setCreationLocked' | 'setDetachedSideRoot' | 'setDirectoryRevision' | 'setFailure' | 'setNativeTakeover' | 'setNewBot' | 'setProviderName' | 'setSessionNotice' | 'setSideAnchor' | 'setSideFocus' | 'setTransitioning' | 'sharedViewForSlot' | 'sharedWindow' | 'showView' | 'sideAnchor' | 'sideFocus' | 'sideSelections' | 'sideSessions' | 'sideTitle' | 'stackPath' | 'succession' | 'tpm' | 'tpmMainRequest' | 'tpmMainState' | 'trackedViews' | 'transitionRef' | 'transport' | 'visibleStackRoot' | 'windowSession' | 'windowWorkspace'>, late: AppLate) {
  const part1 = useStackSelection(scope, late);
  const part2 = useSessionBinding({ ...scope, ...part1 });
  const part3 = useAgentCreation({ ...scope, ...part1, ...part2 });
  const part4 = useTeamOpening({ ...scope, ...part1, ...part2, ...part3 });
  const part5 = useTpmMainOpening({ ...scope, ...part1, ...part2, ...part3, ...part4 });
  return { ...part1, ...part2, ...part3, ...part4, ...part5 };
}

export type SessionOpeningSlice = ReturnType<typeof useSessionOpening>;
