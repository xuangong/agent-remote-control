import { act } from 'react';
import { expect, it, vi } from 'vitest';
import { render } from '../test/setup.js';
import { HostPairing } from './HostPairing.js';

it('does not visually select a managed Host when the active selection is absent from the list', async () => {
  const host = { id: 'managed-1', name: 'Studio Mac', online: true, managed: true };
  const container = await render(<HostPairing selectedHostId="local" hosts={[host]} onSelect={() => undefined} onRetryHosts={() => undefined} />);
  const select = container.querySelector<HTMLSelectElement>('#remote-host')!;
  expect(select.value).toBe('local');
  expect(select.selectedOptions[0]?.textContent).toBe('Select a Host');
});

it('labels shared Host access and cumulative usage without exposing owner revocation', async () => {
  const host = { id: 'shared', name: 'Shared Studio', online: true, managed: true, access: 'shared' as const, sessionQuota: { used: 2, limit: 2 } };
  const container = await render(<HostPairing selectedHostId={host.id} hosts={[host]} onSelect={() => undefined} onRetryHosts={() => undefined} onNewSession={() => undefined} />);
  expect(container.querySelector<HTMLSelectElement>('#remote-host')?.selectedOptions[0]?.textContent).toContain('Shared');
  expect(container.textContent).toContain('Shared with you');
  expect(container.textContent).toContain('Session creation allowance used: 2 / 2');
  expect(container.textContent).toContain('Existing sessions remain available');
  expect([...container.querySelectorAll('button')].some((button) => button.textContent === 'Revoke Host')).toBe(false);
  expect([...container.querySelectorAll('button')].find((button) => button.textContent === 'New session')?.disabled).toBe(true);
});

it('filters Hosts by installed environment attributes without changing the selected Host', async () => {
  const environment = { detectedAt: 1234, os: { platform: 'linux', name: 'Ubuntu', release: '6.8', arch: 'arm64' },
    wsl: false, container: true, shell: { name: 'bash', source: 'account' as const }, shells: [],
    browsers: [{ id: 'chromium', name: 'Chromium', status: 'found' as const }, { id: 'firefox', name: 'Firefox', status: 'not-found' as const }], vscode: { status: 'not-found' as const } };
  const hosts = [{ id: 'one', name: 'Worker', online: true, environment }, { id: 'two', name: 'Worker', online: true }];
  const onSelect = vi.fn();
  const view = await render(<HostPairing hosts={hosts} selectedHostId="two" onSelect={onSelect} onRetryHosts={() => undefined} />);
  const input = view.querySelector<HTMLInputElement>('input[type="search"]')!;
  expect(input).not.toBeNull();
  const search = async (value: string) => act(async () => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(input, value);
    input.dispatchEvent(new Event('input', { bubbles: true }));
  });
  await search('linux chromium');
  const select = view.querySelector<HTMLSelectElement>('#remote-host')!;
  expect(select.value).toBe('two');
  expect([...select.options].filter(option => !option.disabled).map(option => option.value)).toEqual(['one']);
  expect(onSelect).not.toHaveBeenCalled();
  await search('firefox');
  expect(view.textContent).toContain('No matching Hosts');
  await search('');
  await act(async () => { select.value = 'one'; select.dispatchEvent(new Event('change', { bubbles: true })); });
  expect(onSelect).toHaveBeenCalledWith(hosts[0]);
});
