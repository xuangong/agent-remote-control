import { act, useState } from 'react';
import { expect, it, vi } from 'vitest';
import { render } from '../test/setup.js';
import { Menu, placeMenu, type MenuEntry } from './Menu.js';

/** Presses a key where focus is, as a keyboard does. */
const key = (name: string) => act(async () => {
  (document.activeElement ?? document.body).dispatchEvent(new KeyboardEvent('keydown', { key: name, bubbles: true }));
});
const menuOf = () => document.querySelector<HTMLElement>('[role="menu"]');

async function open() {
  const rename = vi.fn(), remove = vi.fn();
  const container = await render(<Menu label="Bot actions" items={[
    { label: 'Rename', icon: 'gear', onSelect: rename },
    { label: 'Pin', disabled: true, onSelect: vi.fn() },
    { kind: 'separator' },
    { label: 'Remove bot', destructive: true, onSelect: remove },
  ]} />);
  const trigger = container.querySelector('button')!;
  await act(async () => trigger.click());
  return { trigger, rename, remove, menu: menuOf()! };
}

it('opens a named menu and focuses its first enabled item', async () => {
  const { trigger, menu } = await open();
  expect(trigger.getAttribute('aria-haspopup')).toBe('menu');
  expect(trigger.getAttribute('aria-expanded')).toBe('true');
  expect(menu.getAttribute('aria-label')).toBe('Bot actions');
  expect([...menu.querySelectorAll('[role="menuitem"]')].map(item => item.textContent)).toEqual(['Rename', 'Pin', 'Remove bot']);
  expect(menu.querySelectorAll('.ui-menu-item-spacer')).toHaveLength(2);
  expect(document.activeElement?.textContent).toBe('Rename');
});

it('moves with the arrow keys past disabled items and selects with a click', async () => {
  const { menu, remove } = await open();
  await key('ArrowDown');
  expect(document.activeElement?.textContent).toBe('Remove bot');
  expect((document.activeElement as HTMLElement).dataset.destructive).toBe('true');
  await key('ArrowDown');
  expect(document.activeElement?.textContent).toBe('Rename');
  await key('End');
  expect(document.activeElement?.textContent).toBe('Remove bot');
  await key('Home');
  expect(document.activeElement?.textContent).toBe('Rename');
  await act(async () => (menu.querySelectorAll('[role="menuitem"]')[2] as HTMLElement).click());
  expect(remove).toHaveBeenCalledOnce();
  expect(menuOf()).toBeNull();
});

it('closes on Escape and returns focus to its button, without selecting', async () => {
  const { trigger, rename } = await open();
  await key('Escape');
  expect(menuOf()).toBeNull();
  expect(document.activeElement).toBe(trigger);
  expect(trigger.getAttribute('aria-expanded')).toBe('false');
  expect(rename).not.toHaveBeenCalled();
});

it('ignores a disabled item and closes on a press outside', async () => {
  const { menu } = await open();
  await act(async () => (menu.querySelectorAll('[role="menuitem"]')[1] as HTMLElement).click());
  expect(menuOf()).not.toBeNull();
  await act(async () => { document.body.dispatchEvent(new MouseEvent('pointerdown', { bubbles: true })); });
  expect(menuOf()).toBeNull();
});

it('returns focus to its button before running the chosen action', async () => {
  let focused: Element | null = null;
  const container = await render(<Menu label="Bot actions" items={[{ label: 'Rename', onSelect: () => { focused = document.activeElement; } }]} />);
  const trigger = container.querySelector('button')!;
  await act(async () => trigger.click());
  await act(async () => (document.activeElement as HTMLElement).click());
  expect(focused).toBe(trigger);
});

it('opens from a pointer click without highlighting an item; ArrowUp then reaches the last item', async () => {
  const container = await render(<Menu label="Bot actions" items={[{ label: 'Rename', onSelect: vi.fn() }, { label: 'Remove bot', onSelect: vi.fn() }]} />);
  await act(async () => { container.querySelector('button')!.dispatchEvent(new MouseEvent('click', { bubbles: true, detail: 1 })); });
  const menu = menuOf()!;
  expect(document.activeElement).toBe(menu);
  expect(menu.querySelector('.ui-menu-item-spacer')).toBeNull();
  await key('ArrowUp');
  expect(document.activeElement?.textContent).toBe('Remove bot');
});

it('opens from the arrow keys on its button: ArrowDown at the first item, ArrowUp at the last', async () => {
  const container = await render(<Menu label="Bot actions" items={[{ label: 'Rename', onSelect: vi.fn() }, { label: 'Remove bot', onSelect: vi.fn() }]} />);
  const trigger = container.querySelector('button')!;
  trigger.focus();
  await key('ArrowDown');
  expect(document.activeElement?.textContent).toBe('Rename');
  await key('Escape');
  expect(document.activeElement).toBe(trigger);
  await key('ArrowUp');
  expect(document.activeElement?.textContent).toBe('Remove bot');
});

it('highlights the item under the pointer by focusing it, and none over a disabled item', async () => {
  const { menu } = await open();
  const [, pin, remove] = menu.querySelectorAll<HTMLElement>('[role="menuitem"]');
  await act(async () => { remove!.dispatchEvent(new MouseEvent('pointermove', { bubbles: true })); });
  expect(document.activeElement).toBe(remove);
  await act(async () => { pin!.dispatchEvent(new MouseEvent('pointermove', { bubbles: true })); });
  expect(document.activeElement).toBe(menu);
});

it('keeps Escape and the arrow keys to itself, and closes on Tab with focus back on its button', async () => {
  const onWindowKey = vi.fn();
  window.addEventListener('keydown', onWindowKey);
  try {
    await open();
    await key('ArrowDown');
    await key('Escape');
    expect(onWindowKey).not.toHaveBeenCalled();
  } finally {
    window.removeEventListener('keydown', onWindowKey);
  }
  const { trigger } = await open();
  await key('Tab');
  expect(menuOf()).toBeNull();
  expect(document.activeElement).toBe(trigger);
});

it('keeps focus in the menu when its items change while it is open', async () => {
  const all: MenuEntry[] = ['Rename', 'Pin', 'Hide', 'Remove bot'].map(label => ({ label, onSelect: vi.fn() }));
  let setCount: (count: number) => void = () => {};
  function Harness() {
    const [count, set] = useState(4);
    setCount = set;
    return <Menu label="Bot actions" items={all.slice(0, count)} />;
  }
  const container = await render(<Harness />);
  container.querySelector('button')!.focus();
  await key('ArrowUp');
  expect(document.activeElement?.textContent).toBe('Remove bot');
  await act(async () => setCount(2));
  expect(document.activeElement).toBe(menuOf());
  await key('ArrowDown');
  expect(document.activeElement?.textContent).toBe('Rename');
});

it('stays open while other content scrolls, and closes with focus back when a scroll moves its button', async () => {
  const container = await render(<><div className="elsewhere" /><div className="scroller"><Menu label="Bot actions" items={[{ label: 'Rename', onSelect: vi.fn() }]} /></div></>);
  const trigger = container.querySelector('button')!;
  await act(async () => trigger.click());
  await act(async () => { container.querySelector('.elsewhere')!.dispatchEvent(new Event('scroll')); });
  await act(async () => { menuOf()!.dispatchEvent(new Event('scroll')); });
  expect(menuOf()).not.toBeNull();
  await act(async () => { container.querySelector('.scroller')!.dispatchEvent(new Event('scroll')); });
  expect(menuOf()).toBeNull();
  expect(document.activeElement).toBe(trigger);
});

it('follows a resize, and closes when the window loses focus', async () => {
  const { menu } = await open();
  await act(async () => { window.dispatchEvent(new Event('resize')); });
  expect(menuOf()).toBe(menu);
  await act(async () => { window.dispatchEvent(new Event('blur')); });
  expect(menuOf()).toBeNull();
});

it('renders inside the dialog that holds its button, so a modal dialog does not make it inert', async () => {
  const container = await render(<dialog open><Menu label="Window actions" items={[{ label: 'Rename', onSelect: vi.fn() }]} /></dialog>);
  await act(async () => container.querySelector('button')!.click());
  expect(container.querySelector('dialog [role="menu"]')).not.toBeNull();
});

it('places a menu below its button, or above it when it fits better there, inside the viewport', () => {
  const viewport = { width: 1000, height: 800 };
  const size = { width: 220, height: 200 };
  expect(placeMenu({ top: 100, bottom: 128, right: 600 }, size, viewport)).toEqual({ top: 132, left: 380, maxHeight: 660, up: false });
  expect(placeMenu({ top: 700, bottom: 728, right: 600 }, size, viewport)).toEqual({ top: 496, left: 380, maxHeight: 688, up: true });
  expect(placeMenu({ top: 300, bottom: 328, right: 600 }, { width: 220, height: 900 }, viewport)).toEqual({ top: 332, left: 380, maxHeight: 460, up: false });
  expect(placeMenu({ top: 780, bottom: 808, right: 600 }, size, viewport)).toEqual({ top: 576, left: 380, maxHeight: 768, up: true });
  expect(placeMenu({ top: 500, bottom: 528, right: 600 }, { width: 220, height: 700 }, viewport)).toEqual({ top: 8, left: 380, maxHeight: 488, up: true });
  expect(placeMenu({ top: 100, bottom: 128, right: 100 }, size, viewport).left).toBe(8);
  expect(placeMenu({ top: 100, bottom: 128, right: 1000 }, size, viewport).left).toBe(772);
});
