import { describe, expect, it } from 'vitest';
import { shellShortcut, shortcutKeys, shortcutSheet, type ListedShortcut } from './shortcuts.js';
import { shortcutVectors } from './shortcuts.vectors.js';

describe('shellShortcut', () => {
  it.each(shortcutVectors)('$name', ({ apple, press, shortcut }) => {
    expect(shellShortcut({ metaKey: false, ctrlKey: false, altKey: false, shiftKey: false, ...press }, apple)).toBe(shortcut);
  });
});

describe('the shortcuts sheet', () => {
  it('lists every shell shortcut the mode on screen has, each once, in three groups', () => {
    const listed = (windowMode: boolean) => shortcutSheet({ windowMode }).flatMap(group => group.rows);
    expect(shortcutSheet({ windowMode: false }).map(group => group.group)).toEqual(['general', 'navigation', 'conversation']);
    for (const windowMode of [false, true]) expect(new Set(listed(windowMode)).size).toBe(listed(windowMode).length);
    // The sidebar shows and hides in Window mode only; Bot mode's panels stay.
    expect(listed(true)).toContain('toggleSidebar');
    expect(listed(false)).not.toContain('toggleSidebar');
    for (const id of ['search', 'newChat', 'shortcuts', 'chats', 'windows', 'nextPanel', 'previousPanel', 'send', 'newLine', 'close'] as const) expect(listed(false)).toContain(id);
  });

  it('writes each shortcut as the platform does, and names the same keys for assistive technology', () => {
    const ids: ListedShortcut[] = shortcutSheet({ windowMode: true }).flatMap(group => group.rows);
    for (const id of ids) for (const apple of [true, false]) {
      const keys = shortcutKeys(id, apple);
      expect(keys.shown.trim(), id).not.toBe('');
      expect(keys.aria, id).toMatch(/^((Shift|Alt|Control|Meta)\+)*[^+\s]+$/);
    }
    expect([shortcutKeys('newChat', true).shown, shortcutKeys('newChat', false).shown]).toEqual(['⇧⌘O', 'Ctrl+Shift+O']);
    expect(shortcutKeys('chats', true)).toEqual({ shown: '⌥⌘2', aria: 'Alt+Meta+2' });
    expect(shortcutKeys('send', false)).toEqual({ shown: 'Enter', aria: 'Enter' });
  });

  it('matches what it writes: the keys a shell row names are the keys that run it', () => {
    const press = (aria: string) => {
      const parts = aria.split('+'), key = parts.at(-1)!;
      const code = /^[A-Z]$/.test(key) ? `Key${key}` : /^\d$/.test(key) ? `Digit${key}` : key === '/' ? 'Slash' : key === '\\' ? 'Backslash' : key;
      return { key: /^[A-Z]$/.test(key) && !parts.includes('Shift') ? key.toLowerCase() : key, code,
        metaKey: parts.includes('Meta'), ctrlKey: parts.includes('Control'), altKey: parts.includes('Alt'), shiftKey: parts.includes('Shift') };
    };
    for (const apple of [true, false]) for (const id of ['search', 'newChat', 'shortcuts', 'chats', 'windows', 'toggleSidebar', 'nextPanel', 'previousPanel'] as const) {
      expect(shellShortcut(press(shortcutKeys(id, apple).aria), apple), `${id} on ${apple ? 'a Mac' : 'Windows'}`).toBe(id);
    }
  });
});
