// The command palette items and its queued mode steps.
import { drainModeSteps } from '../state/mode-steps.js';
import { paletteActions } from '../state/palette-actions.js';
import { windowSummary } from '../window-summary.js';
import { botDisplayName } from '../components/BotRoster.js';
import { windowCatalog } from '../hooks/useWindowActions.js';
import { byRecentUse } from '../window-recency.js';
import { useEffect, useMemo } from 'react';
import { sessionKey } from '../session-tree.js';
import type { CommandItem } from '../shell/command-search.js';
import { commandSessions, sessionSubtitle } from '../shell/command-items.js';
import { applePlatform } from '../platform.js';
import type { SessionSuccessionBindingSlice } from './useSessionSuccessionBinding.js';
import type { PanelsAndShortcutsSlice } from './usePanelsAndShortcuts.js';
import type { WorkbenchShellSlice } from './useWorkbenchShell.js';
import type { WindowModeActionsSlice } from './useWindowModeActions.js';
import type { ActiveSessionSlice } from './useActiveSession.js';
import type { RequestedSessionSlice } from './useRequestedSession.js';
import type { RemoteHostStateSlice } from './useRemoteHostState.js';
import type { ProviderStateSlice } from './useProviderState.js';
import type { SharedFeedsAndTpmSlice } from './useSharedFeedsAndTpm.js';
import type { WindowViewActionsSlice } from './useWindowViewActions.js';
import type { AttentionAndRosterSlice } from './useAttentionAndRoster.js';
import type { AppInputs } from './types.js';

export function useCommandSearch(scope: Pick<AppInputs & SessionSuccessionBindingSlice & PanelsAndShortcutsSlice & WorkbenchShellSlice & WindowModeActionsSlice & ActiveSessionSlice & RequestedSessionSlice & RemoteHostStateSlice & ProviderStateSlice & SharedFeedsAndTpmSlice & WindowViewActionsSlice & AttentionAndRosterSlice, 'baseUrl' | 'botRoster' | 'botRosterCollapsed' | 'closePage' | 'desktopContextVisible' | 'directory' | 'favorites' | 'inMode' | 'initialState' | 'modeSteps' | 'navigation' | 'openNewBot' | 'openNewSessionPanel' | 'providers' | 'queuedModeSteps' | 'remoteHosts' | 'searchOpen' | 'searchRuns' | 'sessionEntries' | 'setWindowOverviewOpen' | 'sharedWindow' | 'showPanel' | 'switchMode' | 'toggleSidebar' | 'userScoped' | 'windowMode' | 'windowOverviewSupported' | 'windowWorkspace'>) {
  const { baseUrl, botRoster, botRosterCollapsed, closePage, desktopContextVisible, directory, favorites, inMode, initialState, modeSteps, navigation, openNewBot, openNewSessionPanel, providers, queuedModeSteps, remoteHosts, searchOpen, searchRuns, sessionEntries, setWindowOverviewOpen, sharedWindow, showPanel, switchMode, toggleSidebar, userScoped, windowMode, windowOverviewSupported, windowWorkspace } = scope;

  const windowConfirmed = !!initialState || windowWorkspace.unavailable || windowWorkspace.hasActiveWindow && !windowWorkspace.provisional;

  useEffect(() => {
    if (!modeSteps.current.length) return;
    const { run, waiting } = drainModeSteps(modeSteps.current, { mode: navigation.mode, windowMode: 'window', windowConfirmed });
    modeSteps.current = [...waiting];
    for (const step of run) step.run();
  }, [navigation.mode, queuedModeSteps, windowConfirmed]);

  // The palette's Windows and sessions are built only while it is open, and again only when their sources change.
  const searchCatalog = useMemo(() => searchOpen ? windowCatalog(windowWorkspace) : [],
    [searchOpen, windowWorkspace.windows, windowWorkspace.window, windowWorkspace.readGroup]);

  const windowItems = useMemo(() => byRecentUse(baseUrl, searchCatalog).map((window): CommandItem => ({ id: `window:${window.id}`, kind: 'window', title: window.title,
    subtitle: windowSummary(window.views, viewId => !!windowWorkspace.readGroup(window.id)?.bots?.members[viewId]?.asleep),
    run: () => { const runs = searchRuns.current; runs.switchMode('window'); runs.inMode('window', () => void searchRuns.current.openWindowFromSearch(window.id)); } })),
  [baseUrl, searchCatalog, windowWorkspace.readGroup]);

  const sessionItems = useMemo(() => !searchOpen ? [] : commandSessions(sessionEntries, favorites.stars, searchCatalog.flatMap(window => window.views.flatMap(view => view.binding ? [view.binding] : [])))
    .map((session): CommandItem => { const subtitle = sessionSubtitle(session, remoteHosts, providers);
      return { id: `session:${sessionKey(session)}`, kind: 'session', title: session.title, ...(subtitle ? { subtitle } : {}),
        run: () => { const runs = searchRuns.current; runs.switchMode('window'); runs.inMode('window', () => void searchRuns.current.openSessionFromSearch(session), true); } }; }),
  [searchOpen, sessionEntries, favorites.stars, searchCatalog, remoteHosts, providers]);

  /** The palette's items, built from what the page already knows, and only while it is open. */
  function commandItems(): CommandItem[] {
    const toWindow = () => switchMode('window');
    const actions = paletteActions({ windowMode, hasDirectory: !!directory, userScoped, windowEditable: !!sharedWindow && !windowWorkspace.unavailable,
      sidebarShown: windowMode ? desktopContextVisible : !botRosterCollapsed, canToggleSidebar: !!toggleSidebar, windowOverviewSupported, apple: applePlatform() }, {
      toWindow, switchMode, newBot: openNewBot, newSessionPanel: openNewSessionPanel, showPanel, toggleSidebar: () => toggleSidebar?.(),
      inWindow: (step, confirmed = false) => () => { toWindow(); inMode('window', step, confirmed); },
      createWindow: () => searchRuns.current.createWindowFromMenu(),
      addSessionView: () => { closePage(); searchRuns.current.addSessionView(); },
      openWindowOverview: () => setWindowOverviewOpen(true) });
    // Each session is one item: a bot in Bot mode, a session (opened in Window mode) otherwise.
    const bots = windowMode ? [] : botRoster.sections.flatMap(section => section.rows.map((row): CommandItem => ({ id: `bot:${row.groupId}/${row.viewId}`, kind: 'bot',
      title: botDisplayName(row.binding), subtitle: section.title, ...(row.details.label ? { keywords: [row.details.label] } : {}),
      run: () => {
        const switching = windowMode;
        navigation.select({ kind: 'bot', groupId: row.groupId, viewId: row.viewId });
        if (switching) inMode('bot', () => searchRuns.current.focusShownMode('bot'));
      } })));
    const botSessions = new Set(windowMode ? [] : botRoster.sections.flatMap(section => section.rows.map(row => `session:${sessionKey(row.binding)}`)));
    return [...actions, ...windowItems, ...bots, ...sessionItems.filter(item => !botSessions.has(item.id))];
  }
  return { commandItems };
}

export type CommandSearchSlice = ReturnType<typeof useCommandSearch>;
