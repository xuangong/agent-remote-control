import { act, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { render } from '../test/setup.js';
import type { CommandItem } from './command-search.js';
import { CommandPalette } from './CommandPalette.js';

// jsdom has no modal dialogs. Like browsers, the stub ignores closing a closed dialog and queues the close event as a task.
// The stubs are removed after each test.
const dialogMethods = ['showModal', 'close'] as const;
const originalDialog = Object.fromEntries(dialogMethods.map(name => [name, Object.getOwnPropertyDescriptor(HTMLDialogElement.prototype, name)]));
const showModal = vi.fn(function (this: HTMLDialogElement) { this.setAttribute('open', ''); });
const close = vi.fn(function (this: HTMLDialogElement) {
  if (!this.open) return;
  this.removeAttribute('open');
  setTimeout(() => this.dispatchEvent(new Event('close')));
});
beforeEach(() => {
  showModal.mockClear();
  close.mockClear();
  Object.defineProperty(HTMLDialogElement.prototype, 'showModal', { configurable: true, value: showModal });
  Object.defineProperty(HTMLDialogElement.prototype, 'close', { configurable: true, value: close });
});
afterEach(async () => {
  // The shared setup unmounts after this hook: close the palette while close() is still stubbed.
  await act(async () => setOpen(false));
  for (const name of dialogMethods) {
    const original = originalDialog[name];
    if (original) Object.defineProperty(HTMLDialogElement.prototype, name, original); else delete (HTMLDialogElement.prototype as Partial<HTMLDialogElement>)[name];
  }
});

const log: string[] = [];
const item = (id: string, title: string, kind: CommandItem['kind'], extra: Partial<CommandItem> = {}): CommandItem =>
  ({ id, kind, title, run: () => { log.push(`run ${id}`); }, ...extra });
const allKinds = [
  item('new-session', 'New session', 'action', { shortcut: '⌘N', keyShortcuts: 'Meta+N' }),
  item('new-window', 'New Window', 'action'),
  item('research', 'Research', 'window', { subtitle: '3 session views' }),
  item('helper', 'Helper', 'bot'),
  item('parser', 'Fix the parser', 'session'),
];

let setOpen: (open: boolean) => void = () => {};
let setItems: (items: readonly CommandItem[]) => void = () => {};
function Harness({ items: initialItems, initiallyOpen = true }: { items: readonly CommandItem[]; initiallyOpen?: boolean }) {
  const [open, set] = useState(initiallyOpen);
  const [items, changeItems] = useState(initialItems);
  setOpen = set;
  setItems = changeItems;
  return <><button type="button" className="opener" onClick={() => set(true)}>Search</button>
    <CommandPalette open={open} items={items} onClose={() => { log.push('close'); set(false); }} /></>;
}

async function palette(items: readonly CommandItem[] = allKinds, initiallyOpen = true) {
  log.length = 0;
  const container = await render(<Harness items={items} initiallyOpen={initiallyOpen} />);
  return { container, dialog: container.querySelector<HTMLDialogElement>('dialog[aria-label="Search"]')! };
}
const combobox = () => document.querySelector<HTMLInputElement>('input[role="combobox"]')!;
const options = () => [...document.querySelectorAll<HTMLElement>('[role="option"]')];
const titles = () => options().map(option => option.querySelector('.lab-command-title')!.textContent);
const active = () => document.getElementById(combobox().getAttribute('aria-activedescendant') ?? '');
const selected = () => options().filter(option => option.getAttribute('aria-selected') === 'true');
const press = (key: string, init: KeyboardEventInit = {}) => act(async () => {
  combobox().dispatchEvent(new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true, ...init }));
});
const type = (text: string) => act(async () => {
  Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(combobox(), text);
  combobox().dispatchEvent(new Event('input', { bubbles: true }));
});

it('opens as a modal dialog with a focused combobox that controls a grouped listbox', async () => {
  const { dialog } = await palette();
  expect(showModal).toHaveBeenCalledTimes(1);
  expect(dialog.open).toBe(true);
  const input = combobox();
  expect(document.activeElement).toBe(input);
  expect(input.getAttribute('aria-expanded')).toBe('true');
  const listbox = document.getElementById(input.getAttribute('aria-controls')!)!;
  expect(listbox.getAttribute('role')).toBe('listbox');
  expect([...listbox.querySelectorAll('[role="group"]')].map(group => group.getAttribute('aria-label'))).toEqual(['Actions', 'Windows', 'Bots', 'Sessions']);
  expect(listbox.querySelectorAll('[role="group"] > [role="option"]')).toHaveLength(5);
  expect(titles()).toEqual(['New session', 'New Window', 'Research', 'Helper', 'Fix the parser']);
  expect(input.getAttribute('aria-label')).toBe('Search Windows, Bots, sessions and actions');
  expect(options()[0]!.querySelector('kbd')!.textContent).toBe('⌘N');
  expect(options()[0]!.querySelector('kbd')!.getAttribute('aria-hidden')).toBe('true');
  expect(options()[0]!.getAttribute('aria-keyshortcuts')).toBe('Meta+N');
  expect(options()[1]!.hasAttribute('aria-keyshortcuts')).toBe(false);
  expect(options()[2]!.textContent).toContain('3 session views');
  expect(active()).toBe(options()[0]);
  expect(selected()).toEqual([options()[0]]);
});

it('filters the results as the query changes', async () => {
  await palette();
  await type('new');
  expect(titles()).toEqual(['New session', 'New Window']);
  expect(document.querySelectorAll('[role="group"]')).toHaveLength(1);
  await type('views');
  expect(titles()).toEqual(['Research']);
});

it('moves the active option with the arrow keys, wrapping, and with Home and End', async () => {
  await palette();
  await press('ArrowDown');
  expect(active()).toBe(options()[1]);
  expect(selected()).toEqual([options()[1]]);
  await press('ArrowUp');
  await press('ArrowUp');
  expect(active()).toBe(options()[4]);
  await press('ArrowDown');
  expect(active()).toBe(options()[0]);
  await press('End');
  expect(active()).toBe(options()[4]);
  await press('Home');
  expect(active()).toBe(options()[0]);
});

it('follows the order shown on screen, not the ranking, when the best match is in a later group', async () => {
  // "deploy" is a title prefix of the session (3) but only a word prefix of the action (2): the session ranks first,
  // yet the Actions group is shown first.
  await palette([item('session', 'Deploy notes', 'session'), item('action', 'Run deploy', 'action'), item('window', 'Main', 'window', { keywords: ['deploy'] })]);
  await type('deploy');
  expect(titles()).toEqual(['Run deploy', 'Main', 'Deploy notes']);
  expect(active()).toBe(options()[0]);
  await press('ArrowDown');
  expect(active()!.textContent).toBe('Main');
  await press('ArrowDown');
  expect(active()!.textContent).toBe('Deploy notes');
  await press('Enter');
  expect(log).toEqual(['close', 'run session']);
});

it('runs the active item on Enter, closing first', async () => {
  const { dialog } = await palette();
  await press('ArrowDown');
  await press('Enter');
  expect(log).toEqual(['close', 'run new-window']);
  expect(close).toHaveBeenCalledTimes(1);
  expect(dialog.open).toBe(false);
});

it('leaves every key to an input method that is composing', async () => {
  await palette();
  for (const key of ['ArrowDown', 'End', 'Enter']) {
    const event = new KeyboardEvent('keydown', { key, isComposing: true, bubbles: true, cancelable: true });
    await act(async () => { combobox().dispatchEvent(event); });
    expect(event.defaultPrevented).toBe(false);
  }
  expect(log).toEqual([]);
  expect(active()).toBe(options()[0]);
});

it('closes on Command-K or Control-K, by key as well as by position, so the shortcut toggles it', async () => {
  const platform = Object.getOwnPropertyDescriptor(Navigator.prototype, 'platform');
  try {
    Object.defineProperty(Navigator.prototype, 'platform', { configurable: true, get: () => 'MacIntel' });
    await palette();
    const shortcut = (init: KeyboardEventInit) => act(async () => {
      const event = new KeyboardEvent('keydown', { bubbles: true, cancelable: true, ...init });
      combobox().dispatchEvent(event); return event;
    });
    // Control-K on an Apple system is the text field's own (kill to end of line).
    expect((await shortcut({ key: 'k', code: 'KeyK', ctrlKey: true })).defaultPrevented).toBe(false);
    expect(log).toEqual([]);
    // Dvorak types K from the QWERTY V position.
    expect((await shortcut({ key: 'k', code: 'KeyV', metaKey: true })).defaultPrevented).toBe(true);
    expect(log).toEqual(['close']);
    await act(async () => setOpen(true)); log.length = 0;
    expect((await shortcut({ key: 'k', code: 'KeyK', metaKey: true, shiftKey: true })).defaultPrevented).toBe(false);
    expect((await shortcut({ key: 'k', code: 'KeyK', metaKey: true })).defaultPrevented).toBe(true);
    expect(log).toEqual(['close']);
  } finally { if (platform) Object.defineProperty(Navigator.prototype, 'platform', platform); }
});

it('runs an option that is clicked', async () => {
  await palette();
  await act(async () => options()[3]!.click());
  expect(log).toEqual(['close', 'run helper']);
});

it('asks to close on Escape and on a press on the backdrop', async () => {
  const { dialog } = await palette();
  const cancel = new Event('cancel', { cancelable: true });
  await act(async () => { dialog.dispatchEvent(cancel); });
  expect(cancel.defaultPrevented).toBe(true);
  expect(log).toEqual(['close']);
  await act(async () => setOpen(true));
  log.length = 0;
  const pressOn = (down: Element, up: Element) => act(async () => {
    down.dispatchEvent(new Event('pointerdown', { bubbles: true }));
    up.dispatchEvent(new MouseEvent('click', { bubbles: true }));
  });
  await pressOn(dialog, dialog);
  expect(log).toEqual(['close']);
  await act(async () => setOpen(true));
  log.length = 0;
  await pressOn(combobox(), combobox());
  // A drag that starts in the field (selecting its text) and ends on the backdrop does not close.
  await pressOn(combobox(), dialog);
  expect(log).toEqual([]);
  await pressOn(dialog, dialog);
  expect(log).toEqual(['close']);
});

it('says when nothing matches', async () => {
  await palette();
  const status = document.querySelector('[role="status"]')!;
  expect(status.textContent).toBe('');
  await type('zzz');
  expect(options()).toHaveLength(0);
  expect(status.textContent).toBe('No results');
  expect(combobox().getAttribute('aria-expanded')).toBe('false');
  expect(combobox().hasAttribute('aria-activedescendant')).toBe(false);
  await press('Enter');
  expect(log).toEqual([]);
});

it('starts over each time it opens', async () => {
  const { dialog } = await palette();
  await type('res');
  await act(async () => setOpen(false));
  expect(close).toHaveBeenCalledTimes(1);
  expect(dialog.open).toBe(false);
  await act(async () => setOpen(true));
  expect(showModal).toHaveBeenCalledTimes(2);
  expect(combobox().value).toBe('');
  expect(titles()).toHaveLength(5);
  expect(active()).toBe(options()[0]);
  expect(document.activeElement).toBe(combobox());
});

it('keeps the active option on the list when the items shrink', async () => {
  await palette();
  await press('End');
  await act(async () => setItems(allKinds.slice(0, 2)));
  expect(active()).toBe(options()[1]);
  expect(selected()).toEqual([options()[1]]);
});

it('closes the modal itself, also when it unmounts open, so the browser returns focus to the opener', async () => {
  // jsdom implements neither showModal nor the focus return of a closed modal: the test checks the part the palette owns,
  // that it opens with showModal and calls close() itself, which is when browsers restore focus.
  const { dialog } = await palette(allKinds, false);
  expect(dialog.open).toBe(false);
  expect(dialog.childElementCount).toBe(0);
  await act(async () => document.querySelector<HTMLButtonElement>('.opener')!.click());
  expect(showModal).toHaveBeenCalledTimes(1);
  await press('Enter');
  expect(close).toHaveBeenCalledTimes(1);

  const host = document.createElement('div');
  document.body.append(host);
  const root = createRoot(host);
  await act(async () => root.render(<CommandPalette open items={allKinds} onClose={() => {}} />));
  const mounted = host.querySelector('dialog')!;
  expect(mounted.open).toBe(true);
  await act(async () => root.unmount());
  expect(close).toHaveBeenCalledTimes(2);
  expect(mounted.open).toBe(false);
  host.remove();
});

it('scrolls the active option into view only when it changes, not when the page renders again', async () => {
  const scroll = vi.fn();
  Object.defineProperty(Element.prototype, 'scrollIntoView', { configurable: true, value: scroll });
  try {
    await palette();
    scroll.mockClear();
    await act(async () => setItems([...allKinds]));
    expect(scroll).not.toHaveBeenCalled();
    await press('ArrowDown');
    expect(scroll).toHaveBeenCalledOnce();
    expect(scroll.mock.contexts[0]).toBe(options()[1]);
    await type('pars');
    expect(scroll).toHaveBeenCalledTimes(2);
  } finally { delete (Element.prototype as Partial<Element>).scrollIntoView; }
});
