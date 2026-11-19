import { windowPrimaryViewId } from '@orchardworks/agent-remote-protocol';
import { useEffect, useMemo } from 'react';
import { compositionSession } from '../session-composition.js';
import { sessionKey } from '../session-tree.js';
import { viewKey } from './helpers.js';
import type { AppInputs } from './types.js';
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

// The sessions open in the shown Window, and the ones a person can see.
export function useOpenWindows(scope: Pick<AppInputs & WorkbenchRecordsSlice & FocusedAskSlice & SessionOpeningSlice & SideSelectionSlice & SessionSuccessionBindingSlice & ViewSessionStateSlice & WindowModeActionsSlice & HostAndStackSlice & WorkbenchShellSlice & ConversationConnectionsSlice & ActiveSessionSlice & PanelsAndShortcutsSlice & DocksAndBotSelectionSlice & WindowViewActionsSlice & RequestedSessionSlice & ViewTargetsSlice & ProviderCreationSlice, 'addressSession' | 'baseUrl' | 'focusCatchUp' | 'initialState' | 'isViewVisible' | 'mountedViewSessions' | 'primaryBinding' | 'replicas' | 'sharedSlots' | 'sharedWindow' | 'sideSessions' | 'stackRoot' | 'succession' | 'transport' | 'windowMode' | 'windowStageVisible'>) {
  const { addressSession, baseUrl, focusCatchUp, initialState, isViewVisible, mountedViewSessions, primaryBinding, replicas, sharedSlots, sharedWindow, sideSessions, stackRoot, succession, transport, windowMode, windowStageVisible } = scope;

  useEffect(() => {
    if (!windowMode || succession.active && !succession.binding) return;
    focusCatchUp(addressSession ? replicas.get(addressSession.agentId) : undefined);
  }, [addressSession?.agentId, succession.active, succession.binding, replicas, focusCatchUp, windowMode]);

  const primaryIsBound = succession.active ? succession.isCurrent() : initialState?.agent?.id === stackRoot?.agentId || (primaryBinding.current?.baseUrl === baseUrl
    && primaryBinding.current.transport === transport && primaryBinding.current.agentId === stackRoot?.agentId);

  const openWindows = useMemo(() => sharedWindow ? sharedWindow.views.flatMap(view => {
    if (!view.binding || !windowPrimaryViewId(sharedWindow, view.id) && !mountedViewSessions[view.id]) return [];
    const mounted = mountedViewSessions[view.id], slot = sharedSlots?.get(view.id);
    const session = mounted && sessionKey(mounted) === sessionKey(view.binding) ? mounted : slot && compositionSession(slot);
    return session && sessionKey(session) === sessionKey(view.binding) ? [{ ...session, title: view.binding.title }] : [];
  }) : [...(stackRoot && primaryIsBound ? [stackRoot] : []), ...sideSessions], [sharedWindow, mountedViewSessions, sharedSlots, stackRoot, primaryIsBound, sideSessions]);
  // A session under the desktop sessions page is not seen, so it is not acknowledged as read.
  const visibleWindows = openWindows.filter(session => windowStageVisible && isViewVisible(viewKey(session)));
  return { primaryIsBound, openWindows, visibleWindows };
}

export type OpenWindowsSlice = ReturnType<typeof useOpenWindows>;
