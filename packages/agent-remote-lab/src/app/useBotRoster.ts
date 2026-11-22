import { projectBotRoster } from '../kernel/bot-roster.js';
import { useRef } from 'react';
import { sessionKey } from '../kernel/session-tree.js';
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

// The bots Bot mode lists and shows.
export function useBotRoster(scope: Pick<AppInputs & WorkbenchRecordsSlice & FocusedAskSlice & SessionOpeningSlice & SideSelectionSlice & SessionSuccessionBindingSlice & ViewSessionStateSlice & WindowModeActionsSlice & HostAndStackSlice & WorkbenchShellSlice & ConversationConnectionsSlice & ActiveSessionSlice & PanelsAndShortcutsSlice & DocksAndBotSelectionSlice & WindowViewActionsSlice & RequestedSessionSlice & ViewTargetsSlice & ProviderCreationSlice, 'accessReady' | 'activated' | 'compactLayout' | 'connections' | 'currentBotSession' | 'navigation' | 'selectedBot' | 'windowMode' | 'windowWorkspace'>) {
  const { accessReady, activated, compactLayout, connections, currentBotSession, navigation, selectedBot, windowMode, windowWorkspace } = scope;

  const botTargets = !windowMode && activated && accessReady
    ? projectBotRoster(windowWorkspace.groups, [], { status: () => 'unknown', current: currentBotSession }).sections.flatMap(section => section.rows.map(({ binding, session }) => {
      const { role: _role, ...entry } = binding;
      return { ...entry, ...session };
    })) : [];

  const botBinding = selectedBot.view?.binding;

  const botConnection = botBinding && connections.find(botBinding);

  const selectedBotSession = botBinding && selectedBot.group && selectedBot.view ? currentBotSession(selectedBot.group.window.id, selectedBot.view.id, botBinding) : undefined;

  const displayedBot = selectedBotSession && botTargets.find(session => sessionKey(session) === sessionKey(selectedBotSession));

  const visibleBots = !windowMode && accessReady && selectedBot.slot && botBinding && displayedBot && botConnection
    && (!compactLayout || !navigation.rosterVisible) && connections.shown(botBinding, botConnection.agentId) ? [displayedBot] : [];

  const latestEligible = useRef(new Set<string>());
  return { botTargets, botBinding, visibleBots, latestEligible };
}

export type BotRosterSlice = ReturnType<typeof useBotRoster>;
