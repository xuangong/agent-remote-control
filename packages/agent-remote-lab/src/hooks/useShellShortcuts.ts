import { useEffect, useRef } from 'react';
import type { WorkbenchMode } from '../workbench-mode.js';
import { applePlatform } from '../platform.js';

/**
 * Shell shortcuts that browsers leave free: Command-Backslash (Control elsewhere) shows or hides the sidebar, and
 * Option-Command-1 / 2 (Control-Alt elsewhere) choose Window mode and Bot mode in the order of the mode switch, and
 * Command-K (Control-K elsewhere) opens search, matched by key, or by position where the layout types no Latin letter
 * there (see isSearchKey);
 * the open palette closes on the same keys itself. Search is global, so it also works while focus is in a text field or the
 * composer, whose keymaps leave Mod-K alone. Browser extensions such as password managers may claim Command-Backslash before the page sees it.
 *
 * On Apple systems keys are matched by `code`, since Option changes `key` there. Elsewhere Control-Alt doubles as
 * AltGr (on Windows, left Control plus Alt acts as AltGr), so Control-Alt-2 types `²` on a German layout; the mode
 * shortcuts therefore also require `key` to be the digit, and AltGraph presses are left alone. Repeated keydowns
 * from a held key, and presses while a dialog or modal sheet is open, are ignored.
 */
export function useShellShortcuts(actions: { toggleSidebar?(): void; setMode(mode: WorkbenchMode): void; openSearch?(): void }) {
  const current = useRef(actions); current.current = actions;
  useEffect(() => {
    const keydown = (event: KeyboardEvent) => {
      if (event.defaultPrevented || event.repeat || event.isComposing) return;
      const apple = applePlatform();
      if (!apple && event.getModifierState('AltGraph')) return;
      if (document.querySelector('dialog[open], [role="dialog"][aria-modal="true"]')) return;
      const primary = apple ? event.metaKey && !event.ctrlKey : event.ctrlKey && !event.metaKey;
      if (!primary || event.shiftKey) return;
      if (!event.altKey && event.code === 'Backslash' && current.current.toggleSidebar) {
        event.preventDefault(); current.current.toggleSidebar();
      } else if (!event.altKey && isSearchKey(event) && current.current.openSearch) {
        event.preventDefault(); current.current.openSearch();
      } else if (event.altKey && (event.code === 'Digit1' || event.code === 'Digit2')) {
        const digit = event.code === 'Digit1' ? '1' : '2';
        if (!apple && event.key !== digit) return;
        event.preventDefault(); current.current.setMode(digit === '1' ? 'window' : 'bot');
      }
    };
    window.addEventListener('keydown', keydown);
    return () => window.removeEventListener('keydown', keydown);
  }, []);
}

/**
 * Whether a key press is the K of the search shortcut: `key` decides on Latin layouts (Dvorak types K elsewhere, and
 * Colemak types E at the QWERTY K position, which stays Command-E); a non-Latin layout falls back to the K position.
 */
export function isSearchKey(event: Pick<KeyboardEvent, 'key' | 'code'>): boolean {
  const key = event.key.toLowerCase();
  return key === 'k' || !/^[a-z]$/.test(key) && event.code === 'KeyK';
}
