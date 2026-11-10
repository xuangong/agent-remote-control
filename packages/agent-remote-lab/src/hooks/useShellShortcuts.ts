import { useEffect, useRef } from 'react';
import type { WorkbenchMode } from '../workbench-mode.js';
import { applePlatform } from './useSessionViewMouseNavigation.js';

/**
 * Shell shortcuts that browsers leave free: Command-Backslash (Control elsewhere) shows or hides the sidebar, and
 * Option-Command-1 / 2 (Control-Alt elsewhere) choose Window mode and Bot mode in the order of the mode switch.
 * Keys are matched by `code`, since Option changes `key` on Apple keyboards; AltGraph combinations type characters
 * on many layouts and are left alone.
 */
export function useShellShortcuts(actions: { toggleSidebar?(): void; setMode(mode: WorkbenchMode): void }) {
  const current = useRef(actions); current.current = actions;
  useEffect(() => {
    const keydown = (event: KeyboardEvent) => {
      if (event.defaultPrevented || event.isComposing || event.getModifierState?.('AltGraph')) return;
      const primary = applePlatform() ? event.metaKey && !event.ctrlKey : event.ctrlKey && !event.metaKey;
      if (!primary || event.shiftKey) return;
      if (!event.altKey && event.code === 'Backslash' && current.current.toggleSidebar) {
        event.preventDefault(); current.current.toggleSidebar();
      } else if (event.altKey && (event.code === 'Digit1' || event.code === 'Digit2')) {
        event.preventDefault(); current.current.setMode(event.code === 'Digit1' ? 'window' : 'bot');
      }
    };
    window.addEventListener('keydown', keydown);
    return () => window.removeEventListener('keydown', keydown);
  }, []);
}
