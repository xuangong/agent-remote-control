import { expandedSideRange } from '../kernel/side-tree.js';
import { viewKey } from './helpers.js';
import type { AppInputs } from './types.js';
import type { AppLate } from './types.js';
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

// Which sessions of the stack are expanded, and the layout the opened view is remembered by.
export function useStackSelection(scope: Pick<AppInputs & HostAndStackSlice & ViewSessionStateSlice & SideSelectionSlice & SessionSuccessionBindingSlice & PanelsAndShortcutsSlice & ActiveSessionSlice & WorkbenchRecordsSlice & RequestedSessionSlice & ConversationConnectionsSlice & WorkbenchShellSlice & ViewTargetsSlice & WindowViewActionsSlice & RemoteHostStateSlice & ProviderCreationSlice & ProviderStateSlice & SharedFeedsAndTpmSlice, 'compactLayout' | 'sharedViewForSlot' | 'sharedWindow' | 'sideAnchor' | 'sideFocus' | 'sideSelections' | 'sideSessions' | 'sideTitle' | 'stackPath' | 'trackedViews' | 'visibleStackRoot'>, late: AppLate) {
  const { compactLayout, sharedViewForSlot, sharedWindow, sideAnchor, sideFocus, sideSelections, sideSessions, sideTitle, stackPath, trackedViews, visibleStackRoot } = scope;

  function rememberTrackedView(): void {
    if (!visibleStackRoot) return;
    trackedViews.remember({ primarySlot: viewKey(visibleStackRoot), focus: sideFocus, anchor: sideAnchor,
      selections: Object.fromEntries(stackPath.map(session => [viewKey(session), sideSelections[viewKey(session)] ?? null])) });
  }

  // A shared source can show several Sides, so its family is wider than the selected path.
  const familyPath = sharedWindow ? (visibleStackRoot ? [visibleStackRoot, ...sideSessions] : []).map(sideTitle) : stackPath;

  const selectedPathIndex = stackPath.findIndex(session => viewKey(session) === sideFocus);

  const sharedDesktopAnchor = sharedWindow && !compactLayout && selectedPathIndex >= 0
    ? stackPath[Math.min(stackPath.length - 1, selectedPathIndex + 1)] : undefined;

  const stackRange = expandedSideRange(stackPath, compactLayout ? sideFocus : sharedDesktopAnchor ? viewKey(sharedDesktopAnchor) : sideAnchor, compactLayout ? 1 : 2, viewKey);

  const expandedKeys = new Set(stackPath.slice(stackRange.start, stackRange.end + 1).filter(session => !sharedViewForSlot(viewKey(session))?.collapsed).map(viewKey));
  late.expandedKeys = expandedKeys;
  return { rememberTrackedView, familyPath, stackRange, expandedKeys };
}

export type StackSelectionSlice = ReturnType<typeof useStackSelection>;
