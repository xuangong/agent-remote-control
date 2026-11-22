import { unlinkSideView } from '../kernel/tracked-session-views.js';
import { useLayoutEffect } from 'react';
import { sessionKey } from '../kernel/session-tree.js';
import { sideNavigationSource, sideNavigationTarget, sideLinkVisible } from '../kernel/session-forks.js';
import { sidePath } from '../kernel/side-tree.js';
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

// Applying an unlinked Side to the layout once its link is gone.
export function useSideUnlinking(scope: Pick<AppInputs & WorkbenchRecordsSlice & FocusedAskSlice & SessionOpeningSlice & SideSelectionSlice & SessionSuccessionBindingSlice & ViewSessionStateSlice & WindowModeActionsSlice & HostAndStackSlice & WorkbenchShellSlice & ConversationConnectionsSlice & ActiveSessionSlice & PanelsAndShortcutsSlice & DocksAndBotSelectionSlice & WindowViewActionsSlice & RequestedSessionSlice & ViewTargetsSlice & ProviderCreationSlice, 'appliedUnlinks' | 'familyPath' | 'forkRevision' | 'forkStore' | 'letterRequest' | 'nextSideRequest' | 'pendingSideSources' | 'setDetachedSideRoot' | 'setSideAnchor' | 'setSideFocus' | 'setSideSelections' | 'sharedViewForSlot' | 'sharedWindow' | 'sideAnchor' | 'sideFocus' | 'sideSelections' | 'sideSessions' | 'trackedViews' | 'visibleStackRoot' | 'windowWorkspace'>) {
  const { appliedUnlinks, familyPath, forkRevision, forkStore, letterRequest, nextSideRequest, pendingSideSources, setDetachedSideRoot, setSideAnchor, setSideFocus, setSideSelections, sharedViewForSlot, sharedWindow, sideAnchor, sideFocus, sideSelections, sideSessions, trackedViews, visibleStackRoot, windowWorkspace } = scope;


  useLayoutEffect(() => {
    for (const record of forkStore.all()) {
      if (record.navigationSource) pendingSideSources.current.set(record.id,record.navigationSource);
      if (sideLinkVisible(record) || !record.target || appliedUnlinks.get(record.id) === (record.revision ?? 0)) continue;
      const navigationSource = pendingSideSources.current.get(record.id) ?? sideNavigationSource(record);
      pendingSideSources.current.delete(record.id);
      const navigationTarget = sideNavigationTarget(record)!;
      const sourceView = familyPath.find(session => sessionKey(session) === sessionKey(navigationSource)), targetView = sideSessions.find(session => sessionKey(session) === sessionKey(navigationTarget));
      if (!sourceView || !targetView) continue;
      appliedUnlinks.set(record.id, record.revision ?? 0);
      if (sharedWindow) {
        const target = sharedViewForSlot(viewKey(targetView));
        if (!target?.attachedTo) continue;
        const { schemaVersion: _, id: __, revision: ___, ...layout } = sharedWindow;
        windowWorkspace.authority?.operate({ type: 'layout.apply', layout: { ...layout, selectedViewId: target.id,
          views: sharedWindow.views.map(view => {
            if (view.id !== target.id) return view;
            const { attachedTo: ____, ...independent } = view;
            return { ...independent, placement: 'dock', collapsed: false };
          }) } });
        nextSideRequest(navigationSource);
        letterRequest.current?.abort();
        continue;
      }
      trackedViews.unlink(viewKey(sourceView), viewKey(targetView));
      nextSideRequest(navigationSource);
      if (!visibleStackRoot) continue;
      const sourceKey = viewKey(sourceView), targetKey = viewKey(targetView);
      const current = { primary: visibleStackRoot, primarySlot: viewKey(visibleStackRoot), selections: sideSelections, focus: sideFocus, anchor: sideAnchor };
      const next = unlinkSideView(current, sourceKey, targetKey);
      if (next === current) continue;
        letterRequest.current?.abort();
      setSideSelections(values => values[sourceKey] === targetKey ? { ...values, [sourceKey]: null } : values);
      if (next.focus !== sideFocus) {
        setDetachedSideRoot(targetKey);
        const branch = sidePath(targetView, sideSessions, sideSelections, viewKey);
        if (!branch.some(session => viewKey(session) === sideAnchor)) setSideAnchor(sideFocus ?? targetKey);
      } else {
        setSideFocus(next.focus);
        setSideAnchor(next.anchor);
      }
    }
  }, [forkStore, forkRevision, appliedUnlinks, trackedViews, visibleStackRoot, sideSessions, sideSelections, sideFocus, sideAnchor, sharedWindow]);
}
