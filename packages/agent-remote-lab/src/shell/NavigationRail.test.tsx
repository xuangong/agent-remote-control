import { act } from 'react';
import { expect, it, vi } from 'vitest';
import { render } from '../test/setup.js';
import { LocaleContext } from '@orchardworks/agent-client-web/react';
import { NavigationRail } from './NavigationRail.js';
import type { DeviceLinkNotice } from '../kernel/device-link.js';

const noop = () => {};
const offline: DeviceLinkNotice = { state: 'offline', signIn: { href: '/auth/login', onClick: noop }, retry: vi.fn() };
const signedOut: DeviceLinkNotice = { state: 'sign_in', signIn: { href: '/auth/login', onClick: vi.fn() }, retry: noop };
const rail = (props: Partial<Parameters<typeof NavigationRail>[0]> = {}) => <NavigationRail current={{ destination: 'chats' }} onGo={noop} onSearch={noop} searchKeys="⌘K" {...props} />;

it('marks the current destination and leaves the others unmarked', async () => {
  for (const [current, label] of [[{ destination: 'chats' }, 'Chats'], [{ destination: 'assistants' }, 'Assistants'], [{ destination: 'windows' }, 'Windows'], [{ destination: 'settings', group: 'computers' }, 'Settings']] as const) {
    const container = await render(rail({ current }));
    expect([...container.querySelectorAll('[aria-current="page"]')].map(item => item.getAttribute('aria-label'))).toEqual([label]);
  }
});

it('goes to a destination when its button is pressed and opens search with its shortcut named', async () => {
  const onGo = vi.fn(), onSearch = vi.fn();
  const container = await render(rail({ onGo, onSearch }));
  const button = (label: string) => container.querySelector<HTMLButtonElement>(`button[aria-label="${label}"]`)!;
  for (const [label, destination] of [['Chats', 'chats'], ['Assistants', 'assistants'], ['Windows', 'windows'], ['Settings', 'settings']] as const) {
    await act(async () => button(label).click());
    expect(onGo).toHaveBeenLastCalledWith({ destination });
  }
  expect(button('Search').title).toBe('Search (⌘K)');
  await act(async () => button('Search').click());
  expect(onSearch).toHaveBeenCalledOnce();
});

it('shows the account initial with the link dot, and says what the link needs in a popover', async () => {
  let container = await render(rail({ accountName: 'xian' }));
  const avatar = () => container.querySelector<HTMLButtonElement>('.lab-rail-avatar')!;
  expect(avatar().textContent).toBe('X');
  expect(avatar().getAttribute('aria-label')).toBe('Account: xian. Connected');
  expect(avatar().querySelector('.lab-link-dot')?.getAttribute('data-link')).toBe('online');
  container = await render(rail({ accountName: 'xian', notice: offline }));
  expect(avatar().querySelector('.lab-link-dot')?.getAttribute('data-link')).toBe('offline');
  await act(async () => avatar().click());
  const popover = container.querySelector('.lab-rail-popover')!;
  expect(popover.textContent).toContain('Offline. Messages will be sent when this device is back online.');
  await act(async () => (popover.querySelector('.lab-device-link button') as HTMLButtonElement).click());
  expect(offline.retry).toHaveBeenCalledOnce();
  container = await render(rail({ notice: signedOut }));
  await act(async () => avatar().click());
  expect(container.querySelector('.lab-rail-popover a')?.getAttribute('href')).toBe('/auth/login');
});

it('opens the account page from the popover', async () => {
  const onGo = vi.fn();
  const container = await render(rail({ onGo, accountName: 'xian' }));
  await act(async () => (container.querySelector('.lab-rail-avatar') as HTMLButtonElement).click());
  await act(async () => (container.querySelector('.lab-rail-popover-action') as HTMLButtonElement).click());
  expect(onGo).toHaveBeenCalledWith({ destination: 'settings', group: 'account' });
});

it('speaks Chinese when the device does', async () => {
  const container = await render(<LocaleContext.Provider value="zh">{rail()}</LocaleContext.Provider>);
  expect(container.querySelector('button[aria-label="聊天"]')).not.toBeNull();
  expect(container.querySelector('button[aria-label="设置"]')).not.toBeNull();
  expect(container.querySelector('button[aria-label="搜索"]')?.getAttribute('title')).toBe('搜索（⌘K）');
});
