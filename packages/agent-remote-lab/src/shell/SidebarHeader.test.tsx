import { act } from 'react';
import { expect, it, vi } from 'vitest';
import { render } from '../test/setup.js';
import { SidebarHeader } from './SidebarHeader.js';

it('puts the mode switch first and the actions after it', async () => {
  const onModeChange = vi.fn();
  const container = await render(<SidebarHeader mode="window" onModeChange={onModeChange} actions={<button type="button">New section</button>} />);
  const header = container.querySelector('.lab-sidebar-header')!;
  expect([...header.children].map(child => child.className)).toEqual(['ui-segmented lab-workbench-mode', 'lab-sidebar-header-actions']);
  expect(header.querySelector('nav[aria-label="Workbench mode"] [aria-pressed="true"]')?.textContent).toBe('Window mode');
  await act(async () => (header.querySelector('nav [aria-pressed="false"]') as HTMLButtonElement).click());
  expect(onModeChange).toHaveBeenCalledWith('bot');
  expect(header.querySelector('.lab-sidebar-header-actions button')?.textContent).toBe('New section');
});

it('puts a Search button before the actions when it searches, named with the platform shortcut', async () => {
  const platform = Object.getOwnPropertyDescriptor(Navigator.prototype, 'platform');
  const onSearch = vi.fn();
  try {
    Object.defineProperty(Navigator.prototype, 'platform', { configurable: true, get: () => 'MacIntel' });
    let container = await render(<SidebarHeader mode="bot" onModeChange={() => {}} onSearch={onSearch} actions={<button type="button">New section</button>} />);
    const buttons = () => [...container.querySelectorAll<HTMLButtonElement>('.lab-sidebar-header-actions button')];
    expect(buttons().map(button => button.getAttribute('aria-label') ?? button.textContent)).toEqual(['Search', 'New section']);
    expect(buttons()[0]!.title).toBe('Search (⌘K)');
    expect(buttons()[0]!.getAttribute('aria-keyshortcuts')).toBe('Meta+K');
    expect(buttons()[0]!.querySelector('svg')).not.toBeNull();
    await act(async () => buttons()[0]!.click());
    expect(onSearch).toHaveBeenCalledOnce();

    Object.defineProperty(Navigator.prototype, 'platform', { configurable: true, get: () => 'Win32' });
    container = await render(<SidebarHeader mode="bot" onModeChange={() => {}} onSearch={onSearch} />);
    expect(buttons()[0]!.title).toBe('Search (Ctrl+K)');
    expect(buttons()[0]!.getAttribute('aria-keyshortcuts')).toBe('Control+K');

    container = await render(<SidebarHeader mode="bot" onModeChange={() => {}} />);
    expect(container.querySelector('button[aria-label="Search"]')).toBeNull();
  } finally { if (platform) Object.defineProperty(Navigator.prototype, 'platform', platform); }
});
