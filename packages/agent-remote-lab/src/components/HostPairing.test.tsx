import { act } from 'react';
import { describe, expect, it, vi } from 'vitest';
import { render } from '../test/setup.js';
import { HostPairing } from './HostPairing.js';

describe('HostPairing', () => {
  it('generates a temporary key and exposes the exact plugin configuration', async () => {
    const pair = vi.fn().mockResolvedValue({ key: 'temporary-secret', expiresAt: '2099-09-09T00:00:00Z', serverUrl: 'http://127.0.0.1:5910' });
    const onSelect = vi.fn();
    const host = { id: 'host-1', name: 'Studio Mac', online: true, providerId: 'dsh' };
    const container = await render(<HostPairing service={{ hosts: async () => ({ hosts: [{ id: 'local', name: 'Local runtime', online: true }, host] }), pair }} selectedHostId="local" onSelect={onSelect} hosts={[{ id: 'host-1', name: 'Studio Mac', online: true, providerId: 'dsh' }]} onRetryHosts={() => undefined} />);
    const button = (label: string) => [...container.querySelectorAll('button')].find((element) => element.textContent === label)!;
    await act(async () => button('Pair Agent Host').click());
    await act(async () => button('Generate pairing key').click());
    expect(pair).toHaveBeenCalledOnce();
    expect(container.querySelector<HTMLTextAreaElement>('#pairing-configuration')?.value).toContain('remoteKey: temporary-secret');
    const select = container.querySelector<HTMLSelectElement>('#remote-host')!;
    await act(async () => { select.value = 'host-1'; select.dispatchEvent(new Event('change', { bubbles: true })); });
    expect(onSelect).toHaveBeenCalledWith(host);
  });

  it('shows an expired key and prevents copying it', async () => {
    const container = await render(<HostPairing service={{ hosts: async () => ({ hosts: [] }), pair: async () => ({ key: 'expired', expiresAt: '2020-01-01T00:00:00Z', serverUrl: 'http://localhost' }) }} selectedHostId="local" onSelect={() => undefined} hosts={[{ id: 'host-1', name: 'Studio Mac', online: true, providerId: 'dsh' }]} onRetryHosts={() => undefined} />);
    const button = (label: string) => [...container.querySelectorAll('button')].find((element) => element.textContent === label)!;
    await act(async () => button('Pair Agent Host').click());
    await act(async () => button('Generate pairing key').click());
    expect(container.textContent).toContain('This key expired');
    expect(button('Copy configuration').disabled).toBe(true);
  });

  it('guides both generic Agent Host and DSH pairing with a reachable broker address', async () => {
    const container = await render(<HostPairing service={{ hosts: async () => ({ hosts: [] }), pair: async () => ({ key: 'key', expiresAt: '2099-01-01T00:00:00Z', serverUrl: 'http://127.0.0.1:5910' }) }} selectedHostId="local" onSelect={() => undefined} hosts={[]} onRetryHosts={() => undefined} />);
    const toggle = [...container.querySelectorAll('button')].find((button) => button.textContent === 'Pair Agent Host')!;
    await act(async () => toggle.click());
    expect(container.textContent).toContain('pnpm agent-host start');
    expect(container.textContent).toContain('already-running Host daemon');
    expect(container.textContent).toContain('DSH Host plugin');
    expect(container.textContent).toContain('reachable broker address');
  });
});
