/**
 * The desktop's keyboard shortcuts: one table that the shell's key handler, the palette's key labels and the shortcuts sheet
 * read, so a shortcut is defined once. Pure: the caller passes whether the platform is Apple's and the fields of the key event.
 *
 * Matching
 * - The primary modifier is Command on Apple systems and Control elsewhere; the other one must be up.
 * - On Apple systems keys are matched by `code`, since Option changes `key` there.
 * - Elsewhere Control-Alt doubles as AltGr (on Windows, left Control plus Alt acts as AltGr): a press with AltGraph is never a
 *   shortcut, and a digit shortcut also needs `key` to be the digit, so Control-Alt-2 typing `²` on a German layout is left alone.
 * - A letter is matched by `key` on a Latin layout (Dvorak types K elsewhere, Colemak types E at the QWERTY K position), and by
 *   its position (`code`) on a layout that types no Latin letter there.
 * - Repeated, composing and already handled presses are the caller's to skip; this table only names the keys.
 */

/** What the shell does for a key press, wherever the focus is. */
export type ShellShortcut = 'search' | 'newChat' | 'shortcuts' | 'chats' | 'windows' | 'toggleSidebar' | 'nextPanel' | 'previousPanel';
/** Every shortcut the sheet lists: the shell's, and those the composer, the conversation, a menu or a sheet handle themselves. */
export type ListedShortcut = ShellShortcut | 'send' | 'newLine' | 'findInConversation' | 'messageMenu' | 'close';
export type ShortcutGroup = 'general' | 'navigation' | 'conversation';

export interface KeyPress {
  readonly key: string; readonly code: string;
  readonly metaKey: boolean; readonly ctrlKey: boolean; readonly altKey: boolean; readonly shiftKey: boolean;
  /** AltGraph is held (`event.getModifierState('AltGraph')`). */
  readonly altGraph?: boolean;
}

type Trigger =
  | { readonly kind: 'letter'; readonly letter: string }
  | { readonly kind: 'digit'; readonly digit: string }
  | { readonly kind: 'code'; readonly code: string; readonly key?: string }
  | { readonly kind: 'function'; readonly key: string };
interface Chord { readonly trigger: Trigger; readonly primary: boolean; readonly alt: boolean; readonly shift: boolean | 'any' }

const SHELL: Readonly<Record<ShellShortcut, Chord>> = {
  search: { trigger: { kind: 'letter', letter: 'k' }, primary: true, alt: false, shift: false },
  newChat: { trigger: { kind: 'letter', letter: 'o' }, primary: true, alt: false, shift: true },
  // A slash needs Shift on some layouts, so Shift does not matter here.
  shortcuts: { trigger: { kind: 'code', code: 'Slash', key: '/' }, primary: true, alt: false, shift: 'any' },
  chats: { trigger: { kind: 'digit', digit: '2' }, primary: true, alt: true, shift: false },
  windows: { trigger: { kind: 'digit', digit: '1' }, primary: true, alt: true, shift: false },
  toggleSidebar: { trigger: { kind: 'code', code: 'Backslash' }, primary: true, alt: false, shift: false },
  nextPanel: { trigger: { kind: 'function', key: 'F6' }, primary: false, alt: false, shift: false },
  previousPanel: { trigger: { kind: 'function', key: 'F6' }, primary: false, alt: false, shift: true },
};
const ORDER = Object.keys(SHELL) as ShellShortcut[];

function triggered(trigger: Trigger, press: KeyPress, apple: boolean): boolean {
  switch (trigger.kind) {
    case 'letter': {
      const key = press.key.toLowerCase();
      return key === trigger.letter || !/^[a-z]$/.test(key) && press.code === `Key${trigger.letter.toUpperCase()}`;
    }
    case 'digit': return press.code === `Digit${trigger.digit}` && (apple || press.key === trigger.digit);
    case 'code': return press.code === trigger.code || trigger.key !== undefined && press.key === trigger.key;
    case 'function': return press.key === trigger.key;
  }
}

/** A key event's fields as the table reads them. */
export function keyPressOf(event: Pick<KeyboardEvent, 'key' | 'code' | 'metaKey' | 'ctrlKey' | 'altKey' | 'shiftKey'> & { getModifierState?(key: string): boolean }): KeyPress {
  return { key: event.key, code: event.code, metaKey: event.metaKey, ctrlKey: event.ctrlKey, altKey: event.altKey, shiftKey: event.shiftKey,
    altGraph: event.getModifierState?.('AltGraph') === true };
}

/** The shell shortcut a key press is, if any. */
export function shellShortcut(press: KeyPress, apple: boolean): ShellShortcut | undefined {
  if (!apple && press.altGraph) return undefined;
  const primary = apple ? press.metaKey && !press.ctrlKey : press.ctrlKey && !press.metaKey;
  const none = !press.metaKey && !press.ctrlKey;
  return ORDER.find(id => {
    const chord = SHELL[id];
    if (chord.primary ? !primary : !none) return false;
    if (chord.alt !== press.altKey) return false;
    if (chord.shift !== 'any' && chord.shift !== press.shiftKey) return false;
    return triggered(chord.trigger, press, apple);
  });
}

/** The keys of a shortcut as the reader's platform writes them (`shown`), and in `aria-keyshortcuts` form (`aria`). */
export interface ShortcutKeys { readonly shown: string; readonly aria: string }

const LISTED: Readonly<Record<ListedShortcut, { readonly apple: ShortcutKeys; readonly other: ShortcutKeys }>> = {
  search: { apple: { shown: '⌘K', aria: 'Meta+K' }, other: { shown: 'Ctrl+K', aria: 'Control+K' } },
  newChat: { apple: { shown: '⇧⌘O', aria: 'Shift+Meta+O' }, other: { shown: 'Ctrl+Shift+O', aria: 'Control+Shift+O' } },
  shortcuts: { apple: { shown: '⌘/', aria: 'Meta+/' }, other: { shown: 'Ctrl+/', aria: 'Control+/' } },
  chats: { apple: { shown: '⌥⌘2', aria: 'Alt+Meta+2' }, other: { shown: 'Ctrl+Alt+2', aria: 'Control+Alt+2' } },
  windows: { apple: { shown: '⌥⌘1', aria: 'Alt+Meta+1' }, other: { shown: 'Ctrl+Alt+1', aria: 'Control+Alt+1' } },
  toggleSidebar: { apple: { shown: '⌘\\', aria: 'Meta+\\' }, other: { shown: 'Ctrl+\\', aria: 'Control+\\' } },
  nextPanel: { apple: { shown: 'F6', aria: 'F6' }, other: { shown: 'F6', aria: 'F6' } },
  previousPanel: { apple: { shown: '⇧F6', aria: 'Shift+F6' }, other: { shown: 'Shift+F6', aria: 'Shift+F6' } },
  send: { apple: { shown: '↩', aria: 'Enter' }, other: { shown: 'Enter', aria: 'Enter' } },
  newLine: { apple: { shown: '⇧↩', aria: 'Shift+Enter' }, other: { shown: 'Shift+Enter', aria: 'Shift+Enter' } },
  findInConversation: { apple: { shown: '⌘F', aria: 'Meta+F' }, other: { shown: 'Ctrl+F', aria: 'Control+F' } },
  messageMenu: { apple: { shown: '⇧F10', aria: 'Shift+F10' }, other: { shown: 'Shift+F10', aria: 'Shift+F10' } },
  close: { apple: { shown: 'Esc', aria: 'Escape' }, other: { shown: 'Esc', aria: 'Escape' } },
};

export function shortcutKeys(id: ListedShortcut, apple: boolean): ShortcutKeys {
  return LISTED[id][apple ? 'apple' : 'other'];
}

/** What the sheet knows of the page: Window mode has a sidebar to hide and makes a new session where Bot mode makes an assistant. */
export interface ShortcutSheetFacts { readonly windowMode: boolean }
export interface ShortcutSheetGroup { readonly group: ShortcutGroup; readonly rows: readonly ListedShortcut[] }

/** The shortcuts sheet: its groups in order, each with the shortcuts that work in the mode on screen. */
export function shortcutSheet({ windowMode }: ShortcutSheetFacts): readonly ShortcutSheetGroup[] {
  return [
    { group: 'general', rows: ['search', 'newChat', 'shortcuts', 'close'] },
    { group: 'navigation', rows: ['chats', 'windows', 'nextPanel', 'previousPanel', ...(windowMode ? ['toggleSidebar' as const] : [])] },
    { group: 'conversation', rows: ['send', 'newLine', 'findInConversation', 'messageMenu'] },
  ];
}
