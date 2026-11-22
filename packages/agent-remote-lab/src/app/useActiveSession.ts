// The active session, its entries and the presented view.
import { contextVisible as contextVisibleOf, supportingRailOpen as supportingRailOpenOf, windowStageVisible as windowStageVisibleOf } from '../features/windows/panels.js';
import { parseWindowFeature } from '../kernel/window-feature-views.js';
import { windowPrimaryViewId } from '@orchardworks/agent-remote-protocol';
import { useSessionWindows } from '../kernel/useSessionWindows.js';
import { useAskVisibility } from '../kernel/useAskVisibility.js';
import { isAskSelected } from '../features/team/ask-presentation.js';
import { useEffect, useMemo, useState } from 'react';
import type { OpenedSession } from '../kernel/directory-client.js';
import { useSessionEntries } from '../features/sessions/useSessionEntries.js';
import { sessionKey } from '../kernel/session-tree.js';
import type { PanelsAndShortcutsSlice } from './usePanelsAndShortcuts.js';
import type { WorkbenchShellSlice } from './useWorkbenchShell.js';
import type { SessionSuccessionBindingSlice } from './useSessionSuccessionBinding.js';
import type { ViewSessionStateSlice } from './useViewSessionState.js';
import type { WorkbenchRecordsSlice } from './useWorkbenchRecords.js';
import type { RequestedSessionSlice } from './useRequestedSession.js';
import type { SideSelectionSlice } from './useSideSelection.js';
import type { AppInputs } from './types.js';

export function useActiveSession(scope: Pick<AppInputs & PanelsAndShortcutsSlice & WorkbenchShellSlice & SessionSuccessionBindingSlice & ViewSessionStateSlice & WorkbenchRecordsSlice & RequestedSessionSlice & SideSelectionSlice, 'activeView' | 'attachingAgentId' | 'baseUrl' | 'compactLayout' | 'confirmedTitles' | 'dispatchPanels' | 'initialState' | 'openedSessions' | 'pageOpen' | 'panels' | 'setOpenedSessions' | 'sharedWindow' | 'sideActivity' | 'sideSessions' | 'state' | 'succession' | 'windowMode' | 'windowSession' | 'windowWorkspace'>) {
  const { activeView, attachingAgentId, baseUrl, compactLayout, confirmedTitles, dispatchPanels, initialState, openedSessions, pageOpen, panels, setOpenedSessions, sharedWindow, sideActivity, sideSessions, state, succession, windowMode, windowSession, windowWorkspace } = scope;


  function openContext(fromSessions = false): void { dispatchPanels({ type: 'context.open', fromSessions }); }

  function openInspector(): void { dispatchPanels({ type: 'inspector.open' }); }


  const contextVisible = contextVisibleOf(panels);

  function toggleContext(): void { dispatchPanels({ type: 'context.toggle' }); }

  function setAllPanelsVisible(visible: boolean): void { dispatchPanels({ type: 'all.setVisible', visible }); }

  const supportingRailOpen = supportingRailOpenOf(panels);

  // The Window's views are on screen: not covered by the Trace view, the desktop sessions page or a compact drawer.
  const windowStageVisible = windowStageVisibleOf(panels, windowMode);

  // Compact layouts keep only the floating Windows list.
  const [windowOverviewOpen, setWindowOverviewOpen] = useState(false);

  // Whether All Windows can show, whatever the mode; the palette offers it from Bot mode too.
  const windowOverviewSupported = !compactLayout && !initialState && !windowWorkspace.unavailable && (windowWorkspace.windows.length > 0 || !!windowWorkspace.window);

  const windowOverviewAvailable = windowMode && windowOverviewSupported;

  const backgroundInert = supportingRailOpen ? { inert: '' } : {};


  const activeAgentId = state?.agent?.id ?? (succession.active ? undefined : attachingAgentId);

  const connectionAgentId = state?.agent?.id ?? attachingAgentId ?? 'standby';

  const activeOpened = windowSession.empty ? undefined : succession.binding?.session ?? openedSessions.find((item) => succession.active
    ? !!succession.selected && sessionKey(item) === sessionKey(succession.selected)
    : item.agentId === activeAgentId);

  const ancestors: OpenedSession[] = [];

  const visited = new Set<string>(activeAgentId ? [activeAgentId] : []);

  let ancestorId = activeOpened?.parentAgentId;

  while (ancestorId && !visited.has(ancestorId)) {
    visited.add(ancestorId);
    const ancestor = openedSessions.find((item) => item.agentId === ancestorId);
    if (!ancestor) break;
    ancestors.unshift(ancestor);
    ancestorId = ancestor.parentAgentId;
  }

  const observedSessionEntries = useSessionEntries(openedSessions, state, confirmedTitles);

  const sessionEntries = useMemo(() => {
    const entries = new Map(observedSessionEntries.map(entry => [sessionKey(entry), entry]));
    for (const session of sideSessions) {
      if (session.agentId === state?.agent?.id) continue;
      const key = sessionKey(session);
      const observed = entries.get(key);
      entries.set(key, { ...observed, ...session, status: sideActivity[session.agentId] ?? observed?.status });
    }
    return [...entries.values()];
  }, [observedSessionEntries, sideSessions, sideActivity, state?.agent?.id]);

  // What the titles below read: a render that rebuilds the same entries neither updates titles nor renders App again (stage 6).
  const sessionTitlesKey = JSON.stringify(sessionEntries.map(item => [sessionKey(item), item.title, item.parentNativeSessionId ?? null]));

  useEffect(() => {
    succession.observeHistoryTitles(sessionEntries);
    succession.updateTitles(sessionEntries.filter(item => !!item.parentNativeSessionId));
    const childTitles = new Map(sessionEntries.filter((item) => item.parentNativeSessionId).map((item) => [sessionKey(item), item.title]));
    setOpenedSessions((current) => {
      const next = current.map((item) => {
        const title = childTitles.get(sessionKey(item));
        return title !== undefined && title !== item.title ? { ...item, title } : item;
      });
      return next.some((item, index) => item !== current[index]) ? next : current;
    });
  }, [sessionTitlesKey]);

  const currentSession = windowSession.empty ? undefined : sessionEntries.find((item) => item.agentId === activeAgentId) ?? succession.selected;

  const askView = useAskVisibility();

  const askSurfaceVisible = windowMode && askView.visible && activeView === 'workbench' && !supportingRailOpen;

  // Expanded Ask windows give way to the desktop sessions page, staying mounted underneath; the Ask entry itself stays in the sidebar.
  const askWindowsVisible = askSurfaceVisible && !pageOpen;

  function presentedSelection(current: typeof sharedWindow) {
    const hiddenAsk = compactLayout && !askView.visible
      ? current?.views.find(view => parseWindowFeature(view.feature)?.kind === 'ask' && isAskSelected(current, view)) : undefined;
    const id = hiddenAsk ? current?.views.find(view => view.id === hiddenAsk.closeWith)?.id ?? current?.selectedPrimaryViewId : current?.selectedViewId;
    return current?.views.find(view => view.id === id);
  }

  const directoryView = presentedSelection(sharedWindow);

  const presentedViewId = directoryView?.id;

  let presentedRootView = directoryView;

  while (presentedRootView?.attachedTo) presentedRootView = sharedWindow?.views.find(view => view.id === presentedRootView!.attachedTo);

  const presentedPrimaryViewId = sharedWindow && presentedViewId && windowPrimaryViewId(sharedWindow, presentedViewId);

  const presentedFeature = parseWindowFeature(presentedRootView?.feature);

  const sessionWindows = useSessionWindows(baseUrl, { document: succession.document, ensureView: succession.ensureView, ensureWindowView: succession.ensureWindowView, save: () => succession.save(true), shared: windowWorkspace.authority });

  const sidebarWindow = sessionWindows.entries.find(entry => entry.id === (sharedWindow ? presentedRootView?.id : sessionWindows.selectedId) && !entry.managed);
  return { openContext, contextVisible, toggleContext, setAllPanelsVisible, supportingRailOpen, windowStageVisible, windowOverviewOpen, setWindowOverviewOpen, windowOverviewSupported, windowOverviewAvailable, backgroundInert, activeAgentId, connectionAgentId, activeOpened, ancestors, sessionEntries, currentSession, askView, askSurfaceVisible, askWindowsVisible, presentedSelection, directoryView, presentedViewId, presentedRootView, presentedPrimaryViewId, presentedFeature, sessionWindows, sidebarWindow };
}

export type ActiveSessionSlice = ReturnType<typeof useActiveSession>;
