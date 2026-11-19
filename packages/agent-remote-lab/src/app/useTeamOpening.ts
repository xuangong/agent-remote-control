import { parseWindowFeature } from '../window-feature-views.js';
import { createWindowView, type Team } from '@orchardworks/agent-remote-protocol';
import { windowSessionBinding } from '../window-workspace.js';
import { teamLayoutTargets } from '../team-layout.js';
import { sessionKey } from '../session-tree.js';
import type { AppInputs } from './types.js';
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
import type { SessionBindingSlice } from './useSessionBinding.js';

// Opening a Team: its leader view and the dock of its members.
export function useTeamOpening(scope: Pick<AppInputs & HostAndStackSlice & ViewSessionStateSlice & SideSelectionSlice & SessionSuccessionBindingSlice & PanelsAndShortcutsSlice & ActiveSessionSlice & WorkbenchRecordsSlice & RequestedSessionSlice & ConversationConnectionsSlice & WorkbenchShellSlice & ViewTargetsSlice & WindowViewActionsSlice & RemoteHostStateSlice & ProviderCreationSlice & ProviderStateSlice & SharedFeedsAndTpmSlice & SessionBindingSlice, 'editWindow' | 'presentedSelection' | 'sessionWindows' | 'windowWorkspace' | 'openSession' | 'bindDirectorySession'>) {
  const { editWindow, presentedSelection, sessionWindows, windowWorkspace, openSession, bindDirectorySession } = scope;

  async function openTeamLayout(team: Team, sourceViewAddress?: string): Promise<boolean> {
    const layout = teamLayoutTargets(team, false);
    const current = windowWorkspace.readWindow();
    const captured = sourceViewAddress?.split('/');
    if (captured && current?.id !== captured[0]) return false;
    const existing = current?.views.find(view => { const feature = parseWindowFeature(view.feature); return feature?.kind === 'team' && feature.id === team.id && feature.role === 'leader'; });
    if (existing) {
      editWindow({ type: 'view.select', viewId: existing.id });
      const latest = windowWorkspace.readWindow();
      const leader = latest?.views.find(view => view.id === existing.id);
      const feature = parseWindowFeature(leader?.feature);
      if (latest?.id !== current?.id || feature?.kind !== 'team' || feature.id !== team.id || feature.role !== 'leader') return false;
      sessionWindows.open(layout.dock, layout.groupRoot, team.id); return true;
    }
    if (current) {
      const destination = current.views.find(view => view.id === (captured?.[1] ?? presentedSelection(current)?.id));
      if (captured && !destination) return false;
      const sameSource = destination?.binding && sessionKey(destination.binding) === sessionKey(layout.main);
      if (captured && !sameSource) return false;
      if (!sameSource) {
        if (!destination || destination.bindingPolicy === 'managed') {
          const source = createWindowView(crypto.randomUUID(), windowSessionBinding(layout.main));
          editWindow({ type: 'batch', operations: [{ type: 'view.create', view: source }, { type: 'view.select', viewId: source.id }] });
        } else if (!await bindDirectorySession(layout.main, { windowId: current.id, viewId: destination.id, binding: JSON.stringify(destination.binding ?? null) })) return false;
      }
      if (windowWorkspace.readWindow()?.id !== current.id) return false;
    } else if (!await openSession(layout.main, undefined, undefined, false, undefined, undefined, undefined, undefined, 'primary')) return false;
    sessionWindows.open(layout.dock, layout.groupRoot, team.id);
    return true;
  }
  return { openTeamLayout };
}

export type TeamOpeningSlice = ReturnType<typeof useTeamOpening>;
