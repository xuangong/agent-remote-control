import { act } from 'react';
import { expect, it, vi } from 'vitest';
import { render } from '../test/setup.js';
import { SidebarFooter, hostSummary } from './SidebarFooter.js';

it('summarizes Hosts', () => {
  expect(hostSummary([], true)).toBe('No Hosts paired');
  expect(hostSummary([], false)).toBe('Checking Hosts…');
  expect(hostSummary([{ online: true }, { online: false }], true)).toBe('1 of 2 Hosts online');
  expect(hostSummary([{ online: true }], true)).toBe('1 Host online');
  expect(hostSummary([{ online: true }, { online: true }], true)).toBe('2 Hosts online');
  expect(hostSummary([{ online: false }], true)).toBe('All Hosts offline');
  expect(hostSummary([{ online: false }, { online: false }], true)).toBe('All Hosts offline');
});

it('opens the Hosts and Settings pages', async () => {
  const onHosts = vi.fn(), onSettings = vi.fn();
  const container = await render(<SidebarFooter hosts={[{ online: false }]} loaded onHosts={onHosts} onSettings={onSettings} settingsCurrent={false} />);
  const footer = container.querySelector('footer.lab-sidebar-footer')!;
  expect(footer.querySelector('[data-host-state]')?.getAttribute('data-host-state')).toBe('offline');
  const hosts = footer.querySelector<HTMLButtonElement>('.lab-sidebar-hosts')!;
  expect([hosts.title, hosts.getAttribute('aria-description')]).toEqual(['Open All sessions to choose a Host', 'Open All sessions to choose a Host']);
  expect(footer.querySelector('button[aria-label="Sidebar settings"]')?.hasAttribute('aria-current')).toBe(false);
  expect(footer.querySelector('button[aria-label="Sidebar settings"]')?.hasAttribute('aria-pressed')).toBe(false);
  await act(async () => (footer.querySelector('.lab-sidebar-hosts') as HTMLButtonElement).click());
  await act(async () => (footer.querySelector('button[aria-label="Sidebar settings"]') as HTMLButtonElement).click());
  expect(onHosts).toHaveBeenCalledOnce(); expect(onSettings).toHaveBeenCalledOnce();
});

it('marks Settings as the current page while it is open', async () => {
  const container = await render(<SidebarFooter hosts={[]} loaded onHosts={() => {}} onSettings={() => {}} settingsCurrent />);
  expect(container.querySelector('button[aria-label="Sidebar settings"]')?.getAttribute('aria-current')).toBe('page');
});
