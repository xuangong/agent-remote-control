import { act, useState, type ComponentProps } from 'react';
import { expect, it, vi } from 'vitest';
import { LocaleContext } from '@orchardworks/agent-client-web/react';
import { render } from '../test/setup.js';
import { WindowToolbar } from './WindowToolbar.js';

type Props = ComponentProps<typeof WindowToolbar>;

async function toolbar(overrides: Partial<Props> = {}) {
  const props: Props = {
    windowId: 'research', title: 'Research', summary: '3 bots · 1 open', onRename: vi.fn(), onNewView: vi.fn(), onOpenSession: vi.fn(),
    botAppearance: true, onBotAppearance: vi.fn(),
    onCopyLink: vi.fn(), onAgentControl: vi.fn(), onDelete: vi.fn(), ...overrides,
  };
  const container = await render(<WindowToolbar {...props} />);
  return { container, props, bar: container.querySelector<HTMLElement>('header.ui-toolbar.lab-window-toolbar')! };
}

const titleButton = (bar: HTMLElement) => bar.querySelector<HTMLButtonElement>('h2 > button.lab-window-toolbar-title')!;
const input = () => document.querySelector<HTMLInputElement>('input[aria-label="Group name"]');
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

it('shows the Window name as the heading, with what it holds beside it', async () => {
  const { bar } = await toolbar();
  expect(bar).not.toBeNull();
  const heading = bar.querySelector('h2')!;
  expect(heading.textContent).toBe('Research');
  expect(titleButton(bar).textContent).toBe('Research');
  expect(bar.querySelector('.ui-toolbar-subtitle')?.textContent).toBe('3 bots · 1 open');
  const single = await toolbar({ summary: '1 bot' });
  expect(single.bar.querySelector('.ui-toolbar-subtitle')?.textContent).toBe('1 bot');
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
  expect([button.title, button.getAttribute('aria-description')]).toEqual(['Rename this group', 'Rename this group']);
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

it('lists the Group actions and runs each', async () => {
  const { bar, props } = await toolbar();
  let menu = await openMenu(bar, 'Group actions');
  expect(items(menu).map(entry => entry.textContent)).toEqual(['Hide in Bot mode', 'Copy link', 'Agent control…', 'Delete group…']);
  expect(menu.querySelectorAll('[role="separator"]')).toHaveLength(1);
  expect(item(menu, 'Delete group…').dataset.destructive).toBe('true');
  await press(menu, 'Escape');
  for (const [label, callback] of [['Hide in Bot mode', props.onBotAppearance], ['Copy link', props.onCopyLink],
    ['Agent control…', props.onAgentControl!], ['Delete group…', props.onDelete]] as const) {
    menu = await openMenu(bar, 'Group actions');
    await act(async () => item(menu, label).click());
    expect(callback).toHaveBeenCalledTimes(1);
  }
  expect(props.onBotAppearance).toHaveBeenCalledWith(false);
});

it('shows a group hidden in Bot mode there again, and leaves out what does not apply', async () => {
  const hidden = await toolbar({ botAppearance: false });
  const hiddenMenu = await openMenu(hidden.bar, 'Group actions');
  await act(async () => item(hiddenMenu, 'Show in Bot mode').click());
  expect(hidden.props.onBotAppearance).toHaveBeenCalledWith(true);
  const { bar } = await toolbar({ botAppearance: undefined, onAgentControl: undefined });
  const menu = await openMenu(bar, 'Group actions');
  expect(items(menu).map(entry => entry.textContent)).toEqual(['Copy link', 'Delete group…']);
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
    return <WindowToolbar windowId={window.id} title={window.title} summary="1 bot" onRename={onRename} onNewView={vi.fn()} onOpenSession={vi.fn()}
      botAppearance onBotAppearance={vi.fn()} onCopyLink={vi.fn()} onDelete={vi.fn()} />;
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

it('offers only safe actions while read-only: no rename, no adding views, no hiding in Bot mode nor deletion', async () => {
  const { bar, props } = await toolbar({ readOnly: true });
  expect(titleButton(bar).disabled).toBe(true);
  await act(async () => titleButton(bar).click());
  expect(input()).toBeNull();
  const disabled = (menu: HTMLElement) => items(menu).filter(entry => entry.getAttribute('aria-disabled') === 'true').map(entry => entry.textContent);
  let menu = await openMenu(bar, 'Add');
  expect(disabled(menu)).toEqual(['New session view', 'Open session…']);
  await act(async () => item(menu, 'New session view').click());
  expect(props.onNewView).not.toHaveBeenCalled();
  await press(menu, 'Escape');
  menu = await openMenu(bar, 'Group actions');
  expect(disabled(menu)).toEqual(['Hide in Bot mode', 'Delete group…']);
  await act(async () => item(menu, 'Copy link').click());
  expect(props.onCopyLink).toHaveBeenCalledTimes(1);
});

it('disables Delete group while another Window action runs', async () => {
  const { bar } = await toolbar({ deleteDisabled: true });
  const menu = await openMenu(bar, 'Group actions');
  expect(item(menu, 'Delete group…').getAttribute('aria-disabled')).toBe('true');
  expect(item(menu, 'Copy link').getAttribute('aria-disabled')).toBeNull();
});

it('ignores Enter while an input method is composing, so a candidate is not saved as the title', async () => {
  const { bar, props } = await toolbar();
  const field = await startRename(bar);
  await type(field, 'Draft');
  await act(async () => { field.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true, isComposing: true })); });
  expect(props.onRename).not.toHaveBeenCalled();
  expect(input()).not.toBeNull();
});


it('speaks Chinese: the title description and the Group actions', async () => {
  const container = await render(<LocaleContext.Provider value="zh"><WindowToolbar windowId="research" title="Research" summary="3" onRename={vi.fn()} onNewView={vi.fn()} onOpenSession={vi.fn()}
    botAppearance onBotAppearance={vi.fn()} onCopyLink={vi.fn()} onDelete={vi.fn()} /></LocaleContext.Provider>);
  expect(container.querySelector('.lab-window-toolbar-title')!.getAttribute('title')).toBe('重命名这个分组');
  expect(container.querySelector('button[aria-label="分组操作"]')).not.toBeNull();
  expect(container.querySelector('button[aria-label="添加"]')).not.toBeNull();
});

it('offers Bind to a bot on a free workbench and Unbind from the bot on a bot workbench', async () => {
  const onBind = vi.fn(), onUnbind = vi.fn();
  const free = await toolbar({ workbench: { onBind, onUnbind } });
  const freeMenu = await openMenu(free.bar, 'Group actions');
  expect(items(freeMenu).map(entry => entry.textContent)).toContain('Bind to a bot…');
  await act(async () => item(freeMenu, 'Bind to a bot…').click());
  expect(onBind).toHaveBeenCalledTimes(1);
  const bound = await toolbar({ workbench: { boundName: 'Dango', onBind, onUnbind } });
  const boundMenu = await openMenu(bound.bar, 'Group actions');
  expect(items(boundMenu).map(entry => entry.textContent)).not.toContain('Bind to a bot…');
  await act(async () => item(boundMenu, 'Unbind from Dango').click());
  expect(onUnbind).toHaveBeenCalledTimes(1);
});
