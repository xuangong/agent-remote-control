import { useEffect } from 'react';
import { type OpenedSession } from '../kernel/directory-client.js';
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

// Keeping the focus on the primary conversation of a Window.
export function usePrimaryFocus(scope: Pick<AppInputs & WorkbenchShellSlice & SessionSuccessionBindingSlice & ViewSessionStateSlice & FocusedAskSlice & HostAndStackSlice & SideSelectionSlice & PanelsAndShortcutsSlice & ViewTargetsSlice & ActiveSessionSlice & SideNavigationSlice & ConversationConnectionsSlice & RequestedSessionSlice & WorkbenchRecordsSlice & ProviderCreationSlice & WindowViewActionsSlice & SessionOpeningSlice & RemoteHostStateSlice & WindowModeActionsSlice, 'activeView' | 'compositionProtected' | 'primaryExpanded' | 'sessionWindows' | 'setSideFocus' | 'sharedWindow' | 'sideFocus' | 'stackRoot' | 'windowMode' | 'workbenchPanelRef'>) {
  const { activeView, compositionProtected, primaryExpanded, sessionWindows, setSideFocus, sharedWindow, sideFocus, stackRoot, windowMode, workbenchPanelRef } = scope;


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
  return { focusSession, focusPrimaryContent };
}

export type PrimaryFocusSlice = ReturnType<typeof usePrimaryFocus>;
