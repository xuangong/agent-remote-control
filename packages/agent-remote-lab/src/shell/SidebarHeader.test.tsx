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
