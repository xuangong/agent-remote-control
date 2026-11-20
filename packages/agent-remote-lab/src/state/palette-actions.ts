/**
 * Palette actions: which commands the ⌘K palette offers and what each one does first.
 *
 * Contract
 * - Pure. The shell passes what the page knows (`PaletteFacts`) and the steps it can run (`PaletteRuns`); the result is
 *   the ordered action items.
 * - Every action that works on Windows or the sessions panel switches to Window mode first (`toWindow`); a step that edits
 *   the open Window waits for the mode (`inWindow`), and an edit of the open Window also waits for it to be confirmed.
 * - Offered only when they can work: New bot in Bot mode with a directory; New session view with an open, available
 *   Window; Favorites for signed-in people; Hide or Show sidebar where the layout has a sidebar; All Windows when the
 *   overview is supported.
 * - The mode switch offers the other mode, with the platform's own shortcut text.
 */
import type { CommandItem } from '../shell/command-search.js';
import type { SessionPanel } from './panels.js';

export interface PaletteFacts {
  readonly windowMode: boolean;
  readonly hasDirectory: boolean;
  readonly userScoped: boolean;
  /** An open Window that is available for edits. */
  readonly windowEditable: boolean;
  /** The sidebar (Window mode) or roster (Bot mode) is showing. */
  readonly sidebarShown: boolean;
  readonly canToggleSidebar: boolean;
  readonly windowOverviewSupported: boolean;
  readonly apple: boolean;
}

export interface PaletteRuns {
  toWindow(): void;
  /** Runs a step in Window mode, switching to it first; a confirmed step also waits for a confirmed Window. */
  inWindow(step: () => void, confirmed?: boolean): () => void;
  switchMode(mode: 'window' | 'bot'): void;
  newBot(): void;
  newSessionPanel(): void;
  createWindow(): void;
  addSessionView(): void;
  showPanel(panel: SessionPanel): void;
  toggleSidebar(): void;
  openWindowOverview(): void;
}

export function paletteActions(facts: PaletteFacts, runs: PaletteRuns): CommandItem[] {
  const { apple } = facts;
  const action = (id: string, title: string, run: () => void, keys?: { shown: string; aria: string }): CommandItem =>
    ({ id: `action:${id}`, kind: 'action', title, run, ...(keys ? { shortcut: keys.shown, keyShortcuts: keys.aria } : {}) });
  const panel = (id: string, title: string, target: SessionPanel) => action(id, title, () => { runs.toWindow(); runs.showPanel(target); });
  return [
    ...(!facts.windowMode && facts.hasDirectory ? [action('new-bot', 'New assistant', runs.newBot)] : []),
    action('new-session', 'New session', () => { runs.toWindow(); runs.newSessionPanel(); }),
    action('new-window', 'New Window', runs.inWindow(runs.createWindow)),
    ...(facts.windowEditable ? [action('new-session-view', 'New session view', runs.inWindow(runs.addSessionView, true))] : []),
    panel('all-sessions', 'All sessions', 'list'),
    ...(facts.userScoped ? [panel('favorites', 'Favorites', 'favorites')] : []),
    panel('settings', 'Settings', 'settings'),
    ...(facts.canToggleSidebar ? [action('toggle-sidebar', facts.sidebarShown ? 'Hide sidebar' : 'Show sidebar', runs.toggleSidebar,
      apple ? { shown: '⌘\\', aria: 'Meta+\\' } : { shown: 'Ctrl+\\', aria: 'Control+\\' })] : []),
    facts.windowMode ? action('bot-mode', 'Switch to Bot mode', () => runs.switchMode('bot'), apple ? { shown: '⌥⌘2', aria: 'Alt+Meta+2' } : { shown: 'Ctrl+Alt+2', aria: 'Control+Alt+2' })
      : action('window-mode', 'Switch to Window mode', runs.toWindow, apple ? { shown: '⌥⌘1', aria: 'Alt+Meta+1' } : { shown: 'Ctrl+Alt+1', aria: 'Control+Alt+1' }),
    ...(facts.windowOverviewSupported ? [action('all-windows', 'All Windows', () => { runs.toWindow(); runs.openWindowOverview(); })] : []),
  ];
}
