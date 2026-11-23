// Panels, sidebar, shortcuts and the queue of mode steps.
import { usePanels } from '../features/windows/usePanels.js';
import { pageOpen as pageOpenOf, type MainView } from '../features/windows/panels.js';
import type { Team } from '@orchardworks/agent-remote-protocol';
import { useCallback, useLayoutEffect, useRef, useState } from 'react';
import { focusableElements } from '../features/windows/SupportingRail.js';
import { useMovableHost } from '../shell/movable-host.js';
import { useSidebarWidth } from '../features/windows/SidebarResize.js';
import { focusWithinContext } from './helpers.js';
import type { ModeStep } from './types.js';
import type { RequestedSessionSlice } from './useRequestedSession.js';
import type { ViewTargetsSlice } from './useViewTargets.js';
import type { WorkbenchShellSlice } from './useWorkbenchShell.js';
import type { AppInputs } from './types.js';

export function usePanelsAndShortcuts(scope: Pick<AppInputs & RequestedSessionSlice & ViewTargetsSlice & WorkbenchShellSlice, 'cachedState' | 'compactLayoutRef' | 'favorites' | 'initialState' | 'requested' | 'viewTriggerRef' | 'windowMode'>) {
  const { cachedState, compactLayoutRef, favorites, initialState, requested, viewTriggerRef, windowMode } = scope;

  const [traceNavigation, setTraceNavigation] = useState<{ scope: string; key: string; requestId: number; view: 'workbench' | 'trace' }>();

  const traceRequestCounter = useRef(0);

  const [scanOpen, setScanOpen] = useState(false);

  const opensSession = !!(initialState || cachedState || requested.target?.nativeSessionId || requested.target?.agentId);

  const pageFocusReturn = useRef(false);

  const [panels, dispatchPanels] = usePanels({ compact: compactLayoutRef.current, opensSession, windowMode }, effect => {
    if (effect.type === 'page-focus-return') pageFocusReturn.current = true;
    else void favorites.refresh();
  });

  const { activeView, contextOpen, inspectorOpen, headerHidden, desktopContextVisible, compact: compactLayout, sessionPanel, contextFromSessions } = panels;

  const showView = useCallback((view: MainView) => dispatchPanels({ type: 'view.show', view }), [dispatchPanels]);

  const closeInspector = useCallback(() => dispatchPanels({ type: 'inspector.close' }), [dispatchPanels]);

  const sidebar = useSidebarWidth(inspectorOpen);

  // The Track, Team, Window and Ask entries render once and move between the sidebar's Shortcuts, the compact launcher bar
  // and their floating places, so hiding or showing the sidebar or resizing the page never remounts them (Team would lose an open panel or a pending creation).
  const shortcutHost = useMovableHost(), askHost = useMovableHost();

  const shortcutSidebarSlot = useRef<HTMLDivElement>(null), shortcutFloatingSlot = useRef<HTMLDivElement>(null), shortcutBarSlot = useRef<HTMLDivElement>(null), shortcutToolbarSlot = useRef<HTMLDivElement>(null);

  const askSidebarSlot = useRef<HTMLDivElement>(null), askFloatingSlot = useRef<HTMLDivElement>(null), askBarSlot = useRef<HTMLDivElement>(null), askToolbarSlot = useRef<HTMLDivElement>(null);

  const pageOpen = pageOpenOf(panels, windowMode);

  // Leaving the page hides it under the focus; focus then returns to the Window (see the layout effect below).
  const sessionsPageTitleRef = useRef<HTMLHeadingElement>(null);

  const closePage = useCallback(() => dispatchPanels({ type: 'page.close', focusInPage: !!document.activeElement?.closest('#lab-sessions-page') }), [dispatchPanels]);

  // Every path that returns to the Window (opening, creating or resuming a session) closes the compact drawer and the desktop page; the desktop sidebar stays.
  const closeContext = useCallback(() => dispatchPanels({ type: 'context.close', focusInPage: !!document.activeElement?.closest('#lab-sessions-page') }), [dispatchPanels]);

  const sidebarShown = useRef(desktopContextVisible);

  // ⌘\ toggles Window mode's desktop sidebar; compact layouts have none to collapse, and Bot mode's panels stay.
  const toggleSidebar = compactLayout || !windowMode ? undefined : () => dispatchPanels({ type: 'desktopSidebar.toggle' });

  // ⌘K opens the command palette, which serves both modes; ⌘/ the shortcuts sheet. The shell's keys are bound with the
  // actions they run, in useCommandSearch.
  const [searchOpen, setSearchOpen] = useState(false);

  const openSearch = useCallback(() => setSearchOpen(true), []);

  const [shortcutsOpen, setShortcutsOpen] = useState(false);

  const openShortcuts = useCallback(() => setShortcutsOpen(true), []);

  // Steps that search runs once a mode has taken over (see inMode); they run after the Window workspace's own effects.
  const modeSteps = useRef<ModeStep[]>([]);

  const [queuedModeSteps, setQueuedModeSteps] = useState(0);

  // Focus inside a sidebar that hides would fall to the page; it goes to the View trigger, else into the main stage. The
  // check runs when the sidebar hides, not when it is toggled: the palette's Hide sidebar returns focus to the sidebar's
  // Search button only as it closes, in the same commit.
  useLayoutEffect(() => {
    const hidden = sidebarShown.current && !desktopContextVisible;
    sidebarShown.current = desktopContextVisible;
    if (!hidden || !(document.activeElement === document.body || focusWithinContext())) return;
    const trigger = viewTriggerRef.current;
    if (trigger?.isConnected && !trigger.closest('[hidden], [inert]')) trigger.focus({ preventScroll: true });
    if (document.activeElement !== trigger) focusableElements(document.querySelector<HTMLElement>('.lab-main-stage'))[0]?.focus({ preventScroll: true });
  }, [desktopContextVisible]);
  return { traceNavigation, setTraceNavigation, traceRequestCounter, scanOpen, setScanOpen, pageFocusReturn, panels, dispatchPanels, activeView, contextOpen, inspectorOpen, headerHidden, desktopContextVisible, compactLayout, sessionPanel, contextFromSessions, showView, closeInspector, sidebar, shortcutHost, askHost, shortcutSidebarSlot, shortcutFloatingSlot, shortcutBarSlot, shortcutToolbarSlot, askSidebarSlot, askFloatingSlot, askBarSlot, askToolbarSlot, pageOpen, sessionsPageTitleRef, closePage, closeContext, toggleSidebar, searchOpen, setSearchOpen, openSearch, shortcutsOpen, setShortcutsOpen, openShortcuts, modeSteps, queuedModeSteps, setQueuedModeSteps };
}

export type PanelsAndShortcutsSlice = ReturnType<typeof usePanelsAndShortcuts>;
