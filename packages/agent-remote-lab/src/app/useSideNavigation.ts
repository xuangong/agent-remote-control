// Sides, open Windows, Ask activity and bots, as one hook per concern in the order of the original function.
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
import { useSideUnlinking } from './useSideUnlinking.js';
import { useOpenWindows } from './useOpenWindows.js';
import { useAskActivity } from './useAskActivity.js';
import { useReplicaRetention } from './useReplicaRetention.js';
import { useBotRoster } from './useBotRoster.js';
import { useSideSessions } from './useSideSessions.js';
import { useChildSessions } from './useChildSessions.js';

export function useSideNavigation(scope: Pick<AppInputs & WorkbenchRecordsSlice & FocusedAskSlice & SessionOpeningSlice & SideSelectionSlice & SessionSuccessionBindingSlice & ViewSessionStateSlice & WindowModeActionsSlice & HostAndStackSlice & WorkbenchShellSlice & ConversationConnectionsSlice & ActiveSessionSlice & PanelsAndShortcutsSlice & DocksAndBotSelectionSlice & WindowViewActionsSlice & RequestedSessionSlice & ViewTargetsSlice & ProviderCreationSlice, 'accessReady' | 'canRead' | 'activated' | 'activeOpened' | 'addressSession' | 'appliedUnlinks' | 'ask' | 'askWindowsVisible' | 'assertSourceCurrent' | 'baseUrl' | 'compactLayout' | 'compactLayoutRef' | 'connections' | 'currentBotSession' | 'directory' | 'editWindow' | 'expandedKeys' | 'familyPath' | 'focusCatchUp' | 'forkRevision' | 'forkStore' | 'initialState' | 'isViewVisible' | 'letterRequest' | 'mountedViewSessions' | 'navigateSide' | 'navigation' | 'navigationGeneration' | 'nextSideRequest' | 'openSession' | 'pendingSideSources' | 'primaryBinding' | 'rememberSession' | 'replicas' | 'selectedBot' | 'selectedHost' | 'sessionEntries' | 'setDetachedSideRoot' | 'setFailure' | 'setSessionNotice' | 'setSideAnchor' | 'setSideFocus' | 'setSideSelections' | 'setSideSessions' | 'setTransitioning' | 'sharedSlots' | 'sharedViewForSlot' | 'sharedWindow' | 'sideAnchor' | 'sideFocus' | 'sideRequestKey' | 'sideRequests' | 'sideSelections' | 'sideSessions' | 'stackPath' | 'stackRoot' | 'state' | 'succession' | 'trackedViews' | 'transitionRef' | 'transport' | 'viewSession' | 'visibleStackRoot' | 'windowMode' | 'windowSession' | 'windowStageVisible' | 'windowWorkspace'>) {
  useSideUnlinking({ ...scope });
  const part2 = useOpenWindows({ ...scope });
  const part3 = useAskActivity({ ...scope, ...part2 });
  useReplicaRetention({ ...scope, ...part2, ...part3 });
  const part5 = useBotRoster({ ...scope, ...part2, ...part3 });
  const part6 = useSideSessions({ ...scope, ...part2, ...part3, ...part5 });
  const part7 = useChildSessions({ ...scope, ...part2, ...part3, ...part5, ...part6 });
  return { ...part2, ...part3, ...part5, ...part6, ...part7 };
}

export type SideNavigationSlice = ReturnType<typeof useSideNavigation>;
