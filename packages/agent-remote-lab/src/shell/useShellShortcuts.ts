import { useEffect, useRef } from 'react';
import type { WorkbenchMode } from '../kernel/workbench-mode.js';
import { applePlatform } from '../kernel/platform.js';
import { keyPressOf, shellShortcut, type ShellShortcut } from '../kernel/shortcuts.js';
import { focusNextPanel } from './panel-focus.js';

/** What the shell runs for its shortcuts; an absent action leaves its keys to the browser. */
export interface ShellShortcutActions {
  setMode(mode: WorkbenchMode): void;
  toggleSidebar?(): void;
  openSearch?(): void;
  /** A new chat: New assistant in Bot mode, New session in Window mode. */
  newChat?(): void;
  openShortcuts?(): void;
}

/**
 * The shell's keyboard shortcuts (kernel/shortcuts.ts names the keys): search, a new chat, the shortcuts sheet, the modes, the
 * sidebar and the panels. They are global, so they also work while the focus is in a text field or the composer, whose keymaps
 * leave these keys alone. Repeated keydowns from a held key, presses an input method is composing, presses already handled and
 * presses while a dialog or modal sheet is open are ignored: an open palette or sheet closes on its own keys itself. Browser
 * extensions such as password managers may claim a key before the page sees it.
 */
export function useShellShortcuts(actions: ShellShortcutActions) {
  const current = useRef(actions); current.current = actions;
  useEffect(() => {
    const keydown = (event: KeyboardEvent) => {
      if (event.defaultPrevented || event.repeat || event.isComposing) return;
      if (document.querySelector('dialog[open], [role="dialog"][aria-modal="true"]')) return;
      const shortcut = shellShortcut(keyPressOf(event), applePlatform());
      if (shortcut && run(shortcut, current.current)) event.preventDefault();
    };
    window.addEventListener('keydown', keydown);
    return () => window.removeEventListener('keydown', keydown);
  }, []);
}

/** Runs a shortcut's action; false when the page has none for it, so the browser keeps the key. */
function run(shortcut: ShellShortcut, actions: ShellShortcutActions): boolean {
  if (shortcut === 'nextPanel' || shortcut === 'previousPanel') return focusNextPanel(document, shortcut === 'previousPanel');
  const action = shortcut === 'search' ? actions.openSearch : shortcut === 'newChat' ? actions.newChat : shortcut === 'shortcuts' ? actions.openShortcuts
    : shortcut === 'toggleSidebar' ? actions.toggleSidebar : shortcut === 'chats' ? () => actions.setMode('bot') : () => actions.setMode('window');
  if (!action) return false;
  action();
  return true;
}
