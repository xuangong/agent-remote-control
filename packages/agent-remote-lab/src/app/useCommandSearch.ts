// The command palette items and its queued mode steps.
import { isPersonalGroup } from '../kernel/assistant-groups.js';
import { isBotView } from '@orchardworks/agent-remote-protocol';
import { drainModeSteps } from '../features/windows/mode-steps.js';
import { paletteActions } from '../state/palette-actions.js';
import { windowSummary } from '../features/windows/window-summary.js';
import { windowCatalog } from '../features/windows/useWindowActions.js';
import { byRecentUse } from '../features/windows/window-recency.js';
import { useEffect, useMemo } from 'react';
import { useTranslate } from '@orchardworks/agent-client-web/react';
import { sessionKey } from '../kernel/session-tree.js';
import type { CommandItem } from '../shell/command-search.js';
import { appearanceItems, commandSessions, sessionSubtitle } from '../shell/command-items.js';
import { currentAppearance } from '../kernel/device-choices.js';
import { applePlatform } from '../kernel/platform.js';
import { useShellShortcuts } from '../shell/useShellShortcuts.js';
import type { SessionSuccessionBindingSlice } from './useSessionSuccessionBinding.js';
import type { PanelsAndShortcutsSlice } from './usePanelsAndShortcuts.js';
import type { WorkbenchShellSlice } from './useWorkbenchShell.js';
import type { WindowModeActionsSlice } from './useWindowModeActions.js';
import type { ActiveSessionSlice } from './useActiveSession.js';
import type { RequestedSessionSlice } from './useRequestedSession.js';
import type { RemoteHostStateSlice } from './useRemoteHostState.js';
import type { ProviderStateSlice } from './useProviderState.js';
import type { SharedFeedsSlice } from './useSharedFeeds.js';
import type { WindowViewActionsSlice } from './useWindowViewActions.js';
import type { AttentionAndRosterSlice } from './useAttentionAndRoster.js';
import type { AppInputs } from './types.js';

export function useCommandSearch(scope: Pick<AppInputs & SessionSuccessionBindingSlice & PanelsAndShortcutsSlice & WorkbenchShellSlice & WindowModeActionsSlice & ActiveSessionSlice & RequestedSessionSlice & RemoteHostStateSlice & ProviderStateSlice & SharedFeedsSlice & WindowViewActionsSlice & AttentionAndRosterSlice, 'baseUrl' | 'botRoster' | 'closePage' | 'desktopContextVisible' | 'directory' | 'favorites' | 'inMode' | 'initialState' | 'modeSteps' | 'navigation' | 'openNewBot' | 'openNewSessionPanel' | 'openSearch' | 'openShortcuts' | 'providers' | 'queuedModeSteps' | 'remoteHosts' | 'searchOpen' | 'searchRuns' | 'sessionEntries' | 'setWindowOverviewOpen' | 'sharedFeeds' | 'sharedWindow' | 'showPanel' | 'switchMode' | 'toggleSidebar' | 'userScoped' | 'windowMode' | 'windowOverviewSupported' | 'windowWorkspace' | 'openInBotMode' | 'pinToWindow'>) {
  const { baseUrl, botRoster, closePage, desktopContextVisible, directory, favorites, inMode, initialState, modeSteps, navigation, openNewBot, openNewSessionPanel, openSearch, openShortcuts, providers, queuedModeSteps, remoteHosts, searchOpen, searchRuns, sessionEntries, setWindowOverviewOpen, sharedFeeds, sharedWindow, showPanel, switchMode, toggleSidebar, userScoped, windowMode, windowOverviewSupported, windowWorkspace, openInBotMode, pinToWindow } = scope;

  const t = useTranslate();

  const windowConfirmed = !!initialState || windowWorkspace.unavailable || windowWorkspace.hasActiveWindow && !windowWorkspace.provisional;

  // A new chat, as the palette offers it: New assistant in Bot mode, New session in Window mode.
  const newChat = () => { if (!windowMode && directory) openNewBot(); else { switchMode('window'); openNewSessionPanel(); } };
  // The shell's keys (kernel/shortcuts.ts): ⌘K, ⇧⌘O, ⌘/, ⌥⌘1 and 2, ⌘\ in Window mode, F6 and ⇧F6.
  useShellShortcuts({ setMode: navigation.setMode, toggleSidebar, openSearch, newChat, openShortcuts });

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
    subtitle: windowSummary(window.views, viewId => !!windowWorkspace.readGroup(window.id)?.bots?.members[viewId]?.asleep, t),
    run: () => { const runs = searchRuns.current; runs.switchMode('window'); runs.inMode('window', () => void searchRuns.current.openWindowFromSearch(window.id)); } })),
  [baseUrl, searchCatalog, windowWorkspace.readGroup, t]);

  const sessionItems = useMemo(() => !searchOpen ? [] : commandSessions(sessionEntries, favorites.stars, searchCatalog.flatMap(window => window.views.flatMap(view => view.binding ? [view.binding] : [])))
    .map((session): CommandItem => { const subtitle = sessionSubtitle(session, remoteHosts, providers, t);
      return { id: `session:${sessionKey(session)}`, kind: 'session', title: session.title, ...(subtitle ? { subtitle } : {}),
        run: () => { const runs = searchRuns.current; runs.switchMode('window'); runs.inMode('window', () => void searchRuns.current.openSessionFromSearch(session), true); } }; }),
  [searchOpen, sessionEntries, favorites.stars, searchCatalog, remoteHosts, providers, t]);

  /** The palette's items, built from what the page already knows, and only while it is open. */
  function commandItems(): CommandItem[] {
    const toWindow = () => switchMode('window');
    const selectedTile = sharedWindow?.views.find(view => view.id === sharedWindow.selectedViewId);
    const botPlace = navigation.place?.kind === 'bot' ? navigation.place : undefined;
    const actions = paletteActions({ windowMode, hasDirectory: !!directory, userScoped, windowEditable: !!sharedWindow && !windowWorkspace.unavailable,
      sidebarShown: desktopContextVisible, canToggleSidebar: !!toggleSidebar, windowOverviewSupported, apple: applePlatform(), t,
      canOpenInBotMode: !!sharedWindow && !!selectedTile && isBotView(selectedTile), canPinToWindow: !!botPlace }, {
      openInBotMode: () => { if (sharedWindow && selectedTile) void openInBotMode(sharedWindow.id, selectedTile.id); },
      pinToWindow: () => { if (botPlace) void pinToWindow(botPlace.groupId, botPlace.viewId); },
      toWindow, go: destination => { if (destination === 'chats') switchMode('bot'); else if (destination === 'windows') switchMode('window'); else navigation.open({ destination }, navigation.page ? 'replace' : 'push'); }, newBot: openNewBot, newSessionPanel: openNewSessionPanel, showPanel, toggleSidebar: () => toggleSidebar?.(),
      openShortcuts,
      inWindow: (step, confirmed = false) => () => { toWindow(); inMode('window', step, confirmed); },
      createWindow: () => searchRuns.current.createWindowFromMenu(),
      addSessionView: () => { closePage(); searchRuns.current.addSessionView(); },
      openWindowOverview: () => setWindowOverviewOpen(true) });
    // An assistant is found by its name, its group, its label, its session's title, its latest reply and the draft waiting for
    // it: search across chats and their latest messages. Each session is one item: an assistant in Bot mode; in Window mode a
    // session, which the same words find.
    const shared = sharedFeeds.get();
    const assistants = botRoster.sections.flatMap(section => {
      const group = windowWorkspace.readGroup(section.groupId);
      const groupTitle = group && isPersonalGroup(group) ? t('navigation.groups.default') : section.title;
      return section.rows.map(row => {
        const reply = shared.states?.reply(row.session)?.preview, draft = shared.drafts?.draft(row.session)?.text;
        return { row, groupTitle, words: [row.name, groupTitle, row.details.label, row.binding.title, reply, draft].filter((word): word is string => !!word?.trim()) };
      });
    });
    const bots = windowMode ? [] : assistants.map(({ row, groupTitle, words }): CommandItem => ({ id: `bot:${row.groupId}/${row.viewId}`, kind: 'bot', title: row.name, subtitle: groupTitle,
      keywords: words.slice(2), run: () => navigation.select({ kind: 'bot', groupId: row.groupId, viewId: row.viewId }) }));
    const wordsOf = new Map(assistants.map(({ row, words }) => [`session:${sessionKey(row.binding)}`, words]));
    const sessions = sessionItems.map(item => { const words = wordsOf.get(item.id); return words ? { ...item, keywords: [...item.keywords ?? [], ...words] } : item; });
    const botSessions = new Set(windowMode ? [] : botRoster.sections.flatMap(section => section.rows.map(row => `session:${sessionKey(row.binding)}`)));
    const appearance = currentAppearance();
    const appearances = appearance ? appearanceItems(appearance.appearance, next => appearance.set(next), t) : [];
    return [...actions, ...appearances, ...windowItems, ...bots, ...sessions.filter(item => !botSessions.has(item.id))];
  }
  return { commandItems };
}

export type CommandSearchSlice = ReturnType<typeof useCommandSearch>;
