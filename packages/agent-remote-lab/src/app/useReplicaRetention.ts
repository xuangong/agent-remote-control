import { useEffect } from 'react';
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
import type { AskActivitySlice } from './useAskActivity.js';

// Keeping the replicas of every session the page watches.
export function useReplicaRetention(scope: Pick<AppInputs & WorkbenchRecordsSlice & FocusedAskSlice & SessionOpeningSlice & SideSelectionSlice & SessionSuccessionBindingSlice & ViewSessionStateSlice & WindowModeActionsSlice & HostAndStackSlice & WorkbenchShellSlice & ConversationConnectionsSlice & ActiveSessionSlice & PanelsAndShortcutsSlice & DocksAndBotSelectionSlice & WindowViewActionsSlice & RequestedSessionSlice & ViewTargetsSlice & ProviderCreationSlice & AskActivitySlice, 'addressSession' | 'connections' | 'primaryBinding' | 'replicas' | 'sideSessions' | 'askActivitySessions'>) {
  const { addressSession, connections, primaryBinding, replicas, sideSessions, askActivitySessions } = scope;

  useEffect(() => {
    replicas.retain([
      ...connections.agentIds,
      ...(primaryBinding.current?.agentId ? [primaryBinding.current.agentId] : []),
      ...sideSessions.map(session => session.agentId),
      ...askActivitySessions.filter(item => item.visible).map(item => item.session.agentId),
      ...(addressSession ? [addressSession.agentId] : []),
    ]);
  });
}
