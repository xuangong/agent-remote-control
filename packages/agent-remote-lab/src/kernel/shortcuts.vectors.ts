import type { KeyPress, ShellShortcut } from './shortcuts.js';

export interface ShortcutVector { readonly name: string; readonly apple: boolean; readonly press: Partial<KeyPress> & Pick<KeyPress, 'key' | 'code'>; readonly shortcut: ShellShortcut | undefined }

const mac = true, windows = false;
/** One table for the shell's keys on both platforms: what each press is, and the presses that are no shortcut. */
export const shortcutVectors: readonly ShortcutVector[] = [
  { name: 'Command-K searches on a Mac', apple: mac, press: { key: 'k', code: 'KeyK', metaKey: true }, shortcut: 'search' },
  { name: 'Control-K searches elsewhere', apple: windows, press: { key: 'k', code: 'KeyK', ctrlKey: true }, shortcut: 'search' },
  { name: 'Control-K is no shortcut on a Mac', apple: mac, press: { key: 'k', code: 'KeyK', ctrlKey: true }, shortcut: undefined },
  { name: 'Command and Control together are no shortcut', apple: mac, press: { key: 'k', code: 'KeyK', metaKey: true, ctrlKey: true }, shortcut: undefined },
  { name: 'Dvorak types K at another key: the key decides', apple: mac, press: { key: 'k', code: 'KeyV', metaKey: true }, shortcut: 'search' },
  { name: 'Colemak types E at the QWERTY K: no search', apple: mac, press: { key: 'e', code: 'KeyK', metaKey: true }, shortcut: undefined },
  { name: 'a Cyrillic layout falls back to the K position', apple: windows, press: { key: 'л', code: 'KeyK', ctrlKey: true }, shortcut: 'search' },
  { name: 'Shift-Command-O is a new chat', apple: mac, press: { key: 'O', code: 'KeyO', metaKey: true, shiftKey: true }, shortcut: 'newChat' },
  { name: 'Control-Shift-O is a new chat elsewhere', apple: windows, press: { key: 'O', code: 'KeyO', ctrlKey: true, shiftKey: true }, shortcut: 'newChat' },
  { name: 'Command-O without Shift is the browser’s', apple: mac, press: { key: 'o', code: 'KeyO', metaKey: true }, shortcut: undefined },
  { name: 'Command-slash shows the shortcuts', apple: mac, press: { key: '/', code: 'Slash', metaKey: true }, shortcut: 'shortcuts' },
  { name: 'Control-slash typed with Shift on a German layout', apple: windows, press: { key: '/', code: 'Digit7', ctrlKey: true, shiftKey: true }, shortcut: 'shortcuts' },
  { name: 'Option-Command-2 opens Chats on a Mac, whatever Option types', apple: mac, press: { key: '™', code: 'Digit2', metaKey: true, altKey: true }, shortcut: 'chats' },
  { name: 'Option-Command-1 opens Windows on a Mac', apple: mac, press: { key: '¡', code: 'Digit1', metaKey: true, altKey: true }, shortcut: 'windows' },
  { name: 'Control-Alt-1 opens Windows elsewhere', apple: windows, press: { key: '1', code: 'Digit1', ctrlKey: true, altKey: true }, shortcut: 'windows' },
  { name: 'Control-Alt-2 typing ² on a German layout is left alone', apple: windows, press: { key: '²', code: 'Digit2', ctrlKey: true, altKey: true }, shortcut: undefined },
  { name: 'AltGraph is never a shortcut elsewhere', apple: windows, press: { key: '2', code: 'Digit2', ctrlKey: true, altKey: true, altGraph: true }, shortcut: undefined },
  { name: 'Command-2 without Option is the browser’s tab', apple: mac, press: { key: '2', code: 'Digit2', metaKey: true }, shortcut: undefined },
  { name: 'Command-backslash shows or hides the sidebar', apple: mac, press: { key: '\\', code: 'Backslash', metaKey: true }, shortcut: 'toggleSidebar' },
  { name: 'Control-backslash on a Mac is no shortcut', apple: mac, press: { key: '\\', code: 'Backslash', ctrlKey: true }, shortcut: undefined },
  { name: 'F6 moves to the next panel', apple: mac, press: { key: 'F6', code: 'F6' }, shortcut: 'nextPanel' },
  { name: 'Shift-F6 moves to the previous panel', apple: windows, press: { key: 'F6', code: 'F6', shiftKey: true }, shortcut: 'previousPanel' },
  { name: 'Control-F6 is no panel move', apple: windows, press: { key: 'F6', code: 'F6', ctrlKey: true }, shortcut: undefined },
  { name: 'a letter alone is no shortcut', apple: mac, press: { key: 'k', code: 'KeyK' }, shortcut: undefined },
  { name: 'Shift-Command-K is not search', apple: mac, press: { key: 'K', code: 'KeyK', metaKey: true, shiftKey: true }, shortcut: undefined },
];
