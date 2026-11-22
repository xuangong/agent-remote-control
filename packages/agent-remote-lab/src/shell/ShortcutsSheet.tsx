import { useEffect, useId } from 'react';
import type { MessageKey } from '@orchardworks/agent-client';
import { Sheet } from '@orchardworks/agent-client-web/primitives';
import { useTranslate } from '@orchardworks/agent-client-web/react';
import { keyPressOf, shellShortcut, shortcutKeys, shortcutSheet, type ListedShortcut, type ShortcutGroup } from '../kernel/shortcuts.js';
import { applePlatform } from '../kernel/platform.js';
import './shell.css';

const GROUPS: Readonly<Record<ShortcutGroup, MessageKey>> = {
  general: 'navigation.shortcutsSheet.general', navigation: 'navigation.shortcutsSheet.navigation', conversation: 'navigation.shortcutsSheet.conversation',
};

/** A row's words; a new chat is a new assistant in Bot mode and a new session in Window mode, as the palette says. */
function rowWords(id: ListedShortcut, windowMode: boolean): MessageKey {
  if (id === 'newChat') return windowMode ? 'navigation.newSession' : 'navigation.palette.newAssistant';
  return `navigation.shortcutsSheet.${id}`;
}

/**
 * ⌘/ (Ctrl+/ elsewhere): every keyboard shortcut of the mode on screen, grouped, with the keys as the platform writes them. A sheet,
 * so Escape, a press on the backdrop and Close dismiss it; ⌘/ pressed again closes it too, as ⌘K closes the palette.
 */
export function ShortcutsSheet({ windowMode, onClose }: { windowMode: boolean; onClose(): void }) {
  const t = useTranslate();
  const apple = applePlatform();
  const id = useId();
  useEffect(() => {
    const keydown = (event: KeyboardEvent) => {
      if (event.isComposing || shellShortcut(keyPressOf(event), apple) !== 'shortcuts') return;
      event.preventDefault(); onClose();
    };
    window.addEventListener('keydown', keydown);
    return () => window.removeEventListener('keydown', keydown);
  }, [apple, onClose]);
  return <Sheet open title={t('navigation.shortcutsSheet.title')} detent="content" onClose={onClose}>
    <div className="lab-shortcuts">
      {shortcutSheet({ windowMode }).map(group => <section key={group.group} className="lab-shortcuts-group" aria-labelledby={`${id}-${group.group}`}>
        <h3 id={`${id}-${group.group}`}>{t(GROUPS[group.group])}</h3>
        <dl>{group.rows.map(row => { const keys = shortcutKeys(row, apple);
          return <div key={row} className="lab-shortcuts-row"><dt>{t(rowWords(row, windowMode))}</dt><dd><kbd>{keys.shown}</kbd></dd></div>; })}</dl>
      </section>)}
    </div>
  </Sheet>;
}
