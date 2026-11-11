import { act, useState, type ComponentProps } from 'react';
import { expect, it, vi } from 'vitest';
import { render } from '../test/setup.js';
import { WindowToolbar } from './WindowToolbar.js';

type Props = ComponentProps<typeof WindowToolbar>;

async function toolbar(overrides: Partial<Props> = {}) {
  const props: Props = {
    windowId: 'research', title: 'Research', viewCount: 3, onRename: vi.fn(), onNewView: vi.fn(), onOpenSession: vi.fn(),
    hasDocks: true, docksHidden: false, onToggleDocks: vi.fn(), canShowAsSection: true, onShowAsSection: vi.fn(),
    onCopyLink: vi.fn(), onAgentControl: vi.fn(), onDelete: vi.fn(), ...overrides,
  };
  const container = await render(<WindowToolbar {...props} />);
  return { container, props, bar: container.querySelector<HTMLElement>('header.ui-toolbar.lab-window-toolbar')! };
}

const titleButton = (bar: HTMLElement) => bar.querySelector<HTMLButtonElement>('h2 > button.lab-window-toolbar-title')!;
const input = () => document.querySelector<HTMLInputElement>('input[aria-label="Window title"]');
const press = (target: Element, key: string) => act(async () => {
  target.dispatchEvent(new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true }));
});
const type = (field: HTMLInputElement, text: string) => act(async () => {
  Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(field, text);
  field.dispatchEvent(new Event('input', { bubbles: true }));
});
async function startRename(bar: HTMLElement) {
  await act(async () => titleButton(bar).click());
  return input()!;
}
async function openMenu(bar: HTMLElement, label: string) {
  await act(async () => bar.querySelector<HTMLButtonElement>(`button[aria-label="${label}"]`)!.click());
  return document.querySelector<HTMLElement>(`[role="menu"][aria-label="${label}"]`)!;
}
const items = (menu: HTMLElement) => [...menu.querySelectorAll<HTMLButtonElement>('[role="menuitem"]')];
const item = (menu: HTMLElement, label: string) => items(menu).find(entry => entry.textContent === label)!;

it('shows the Window name as the heading, with its view count', async () => {
  const { bar } = await toolbar();
  expect(bar).not.toBeNull();
  const heading = bar.querySelector('h2')!;
  expect(heading.textContent).toBe('Research');
  expect(titleButton(bar).textContent).toBe('Research');
  expect(bar.querySelector('.ui-toolbar-subtitle')?.textContent).toBe('3 session views');
  const single = await toolbar({ viewCount: 1 });
  expect(single.bar.querySelector('.ui-toolbar-subtitle')?.textContent).toBe('1 session view');
});

it('names the title button by the Window name, so the heading reads as it, and describes renaming', async () => {
  const { bar } = await toolbar();
  const button = titleButton(bar);
  // Nothing in the heading overrides its text: no aria-label or aria-labelledby on it or inside it.
  const heading = bar.querySelector('h2')!;
  expect(heading.querySelectorAll('[aria-label], [aria-labelledby]')).toHaveLength(0);
  expect(heading.hasAttribute('aria-label') || heading.hasAttribute('aria-labelledby')).toBe(false);
  expect(heading.textContent).toBe('Research');
  expect(button.textContent).toBe('Research');
  expect([button.title, button.getAttribute('aria-description')]).toEqual(['Rename this Window', 'Rename this Window']);
});

it('renames in place with the whole title selected, saving on Enter and returning focus', async () => {
  const { bar, props } = await toolbar();
  const field = await startRename(bar);
  expect(titleButton(bar)).toBeNull();
  expect(bar.querySelector('h2')?.contains(field)).toBe(true);
  expect(document.activeElement).toBe(field);
  expect(field.value).toBe('Research');
  expect([field.selectionStart, field.selectionEnd]).toEqual([0, 'Research'.length]);
  await type(field, '  New name ');
  await press(field, 'Enter');
  expect(props.onRename).toHaveBeenCalledTimes(1);
  expect(props.onRename).toHaveBeenCalledWith('New name');
  expect(input()).toBeNull();
  expect(document.activeElement).toBe(titleButton(bar));
});

it('cancels on Escape without saving, and keeps Escape from enclosing handlers', async () => {
  const outer = vi.fn();
  document.addEventListener('keydown', outer);
  try {
    const { bar, props } = await toolbar();
    const field = await startRename(bar);
    await type(field, 'Changed');
    const escape = new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true });
    await act(async () => { field.dispatchEvent(escape); });
    expect(escape.defaultPrevented).toBe(true);
    expect(outer).not.toHaveBeenCalled();
    expect(props.onRename).not.toHaveBeenCalled();
    expect(input()).toBeNull();
    expect(document.activeElement).toBe(titleButton(bar));
  } finally { document.removeEventListener('keydown', outer); }
});

it('saves on blur, once', async () => {
  const { bar, props } = await toolbar();
  const field = await startRename(bar);
  await type(field, 'Blurred');
  await act(async () => field.blur());
  expect(props.onRename).toHaveBeenCalledTimes(1);
  expect(props.onRename).toHaveBeenCalledWith('Blurred');
  expect(input()).toBeNull();
});

it('does not save twice when the field blurs after Enter, nor after Escape', async () => {
  const { bar, props } = await toolbar();
  let field = await startRename(bar);
  await type(field, 'Once');
  await act(async () => {
    field.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true }));
    field.dispatchEvent(new FocusEvent('focusout', { bubbles: true }));
  });
  expect(props.onRename).toHaveBeenCalledTimes(1);
  field = await startRename(bar);
  await type(field, 'Never');
  await act(async () => {
    field.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }));
    field.dispatchEvent(new FocusEvent('focusout', { bubbles: true }));
  });
  expect(props.onRename).toHaveBeenCalledTimes(1);
});

it('does not save an empty or unchanged title', async () => {
  const { bar, props } = await toolbar();
  let field = await startRename(bar);
  await type(field, '   ');
  await press(field, 'Enter');
  field = await startRename(bar);
  expect(field.value).toBe('Research');
  await press(field, 'Enter');
  expect(props.onRename).not.toHaveBeenCalled();
  expect(document.activeElement).toBe(titleButton(bar));
});

it('does not start a rename while disabled', async () => {
  const { bar } = await toolbar({ disabled: true });
  expect(titleButton(bar).disabled).toBe(true);
  await act(async () => titleButton(bar).click());
  expect(input()).toBeNull();
});

it('adds a new session view or opens a session from the Add menu', async () => {
  const { bar, props } = await toolbar();
  let menu = await openMenu(bar, 'Add');
  expect(items(menu).map(entry => entry.textContent)).toEqual(['New session view', 'Open session…']);
  await act(async () => item(menu, 'New session view').click());
  expect(props.onNewView).toHaveBeenCalledTimes(1);
  menu = await openMenu(bar, 'Add');
  await act(async () => item(menu, 'Open session…').click());
  expect(props.onOpenSession).toHaveBeenCalledTimes(1);
});

it('toggles the docks, showing whether they are hidden', async () => {
  const shown = await toolbar();
  const hide = shown.bar.querySelector<HTMLButtonElement>('button[aria-label="Hide docks"]')!;
  expect(hide.getAttribute('aria-pressed')).toBe('false');
  await act(async () => hide.click());
  expect(shown.props.onToggleDocks).toHaveBeenCalledTimes(1);
  const hidden = await toolbar({ docksHidden: true });
  expect(hidden.bar.querySelector('button[aria-label="Show docks"]')?.getAttribute('aria-pressed')).toBe('true');
  expect(hidden.bar.querySelector('button[aria-label="Hide docks"]')).toBeNull();
  const none = await toolbar({ hasDocks: false });
  expect(none.bar.querySelector('button[aria-label$=" docks"]')).toBeNull();
});

it('lists the Window actions and runs each', async () => {
  const { bar, props } = await toolbar();
  let menu = await openMenu(bar, 'Window actions');
  expect(items(menu).map(entry => entry.textContent)).toEqual(['Show as section', 'Copy link', 'Agent control…', 'Delete Window…']);
  expect(menu.querySelectorAll('[role="separator"]')).toHaveLength(1);
  expect(item(menu, 'Delete Window…').dataset.destructive).toBe('true');
  await press(menu, 'Escape');
  for (const [label, callback] of [['Show as section', props.onShowAsSection], ['Copy link', props.onCopyLink],
    ['Agent control…', props.onAgentControl!], ['Delete Window…', props.onDelete]] as const) {
    menu = await openMenu(bar, 'Window actions');
    await act(async () => item(menu, label).click());
    expect(callback).toHaveBeenCalledTimes(1);
  }
});

it('leaves out Show as section and Agent control when they do not apply', async () => {
  const { bar } = await toolbar({ canShowAsSection: false, onAgentControl: undefined });
  const menu = await openMenu(bar, 'Window actions');
  expect(items(menu).map(entry => entry.textContent)).toEqual(['Copy link', 'Delete Window…']);
});

it('renders the leading slot before the title', async () => {
  const { bar } = await toolbar({ leading: <div data-testid="view-options" /> });
  expect([...bar.children].map(child => child.className)).toEqual(['ui-toolbar-leading', 'ui-toolbar-heading', 'ui-toolbar-trailing']);
  expect(bar.querySelector('.ui-toolbar-leading [data-testid="view-options"]')).not.toBeNull();
});

it('ends an open rename without saving when another Window takes the toolbar, and returns focus to its title', async () => {
  const onRename = vi.fn();
  let show!: (window: { id: string; title: string }) => void;
  function Harness() {
    const [window, setWindow] = useState({ id: 'research', title: 'Research' }); show = setWindow;
    return <WindowToolbar windowId={window.id} title={window.title} viewCount={1} onRename={onRename} onNewView={vi.fn()} onOpenSession={vi.fn()}
      hasDocks={false} docksHidden={false} onToggleDocks={vi.fn()} canShowAsSection onShowAsSection={vi.fn()} onCopyLink={vi.fn()} onDelete={vi.fn()} />;
  }
  const container = await render(<Harness />);
  const bar = container.querySelector<HTMLElement>('header.lab-window-toolbar')!;
  const field = await startRename(bar);
  await type(field, 'Draft for Research');
  await act(async () => show({ id: 'notes', title: 'Notes' }));
  expect(input()).toBeNull();
  expect(titleButton(bar).textContent).toBe('Notes');
  expect(document.activeElement).toBe(titleButton(bar));
  field.dispatchEvent(new FocusEvent('blur'));
  await act(async () => titleButton(bar).click());
  await press(input()!, 'Escape');
  expect(onRename).not.toHaveBeenCalled();
});
