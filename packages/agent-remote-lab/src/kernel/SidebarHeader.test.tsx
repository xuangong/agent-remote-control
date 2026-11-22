import { expect, it } from 'vitest';
import { render } from '../test/setup.js';
import { SidebarHeader } from './SidebarHeader.js';

it('puts a title first and the actions after it, with no mode switch and no Search', async () => {
  const container = await render(<SidebarHeader title="Windows" actions={<button type="button">New section</button>} />);
  const header = container.querySelector('.lab-sidebar-header')!;
  expect([...header.children].map(child => child.className)).toEqual(['lab-sidebar-title', 'lab-sidebar-header-actions']);
  expect(header.querySelector('.lab-sidebar-title')?.textContent).toBe('Windows');
  expect(header.querySelector('.lab-sidebar-header-actions button')?.textContent).toBe('New section');
  expect(container.querySelector('nav, [aria-label="Search"]')).toBeNull();
});

it('shows the Orchard wordmark in place of the title with brand', async () => {
  const container = await render(<SidebarHeader brand actions={<button type="button">New</button>} />);
  expect(container.querySelector('.lab-sidebar-brand')).not.toBeNull();
  expect(container.querySelector('.lab-sidebar-title')).toBeNull();
});
