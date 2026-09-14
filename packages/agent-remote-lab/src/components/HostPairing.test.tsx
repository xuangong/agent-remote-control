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
    expect(container.textContent).toContain('agent-remote-controller start');
    expect(container.textContent).toContain('already-running Host daemon');
    expect(container.textContent).toContain('DSH Host plugin');
    expect(container.textContent).toContain('reachable broker address');
  });
});

it('requires an explicit confirmation to revoke a managed Host and refreshes the list', async () => {
  const removed: string[] = [];
  let refreshes = 0;
  const host = { id: 'managed-1', name: 'Studio Mac', online: false, managed: true };
  const container = await render(<HostPairing service={{ hosts: async () => ({ hosts: [host] }), pair: async () => { throw new Error('unused'); }, revoke: async id => { removed.push(id); } }} selectedHostId={host.id} hosts={[host]} onSelect={() => undefined} onRetryHosts={() => { refreshes++; }} />);
  const button = (label: string) => [...container.querySelectorAll('button')].find(element => element.textContent === label);
  expect(button('Revoke Host')).toBeDefined();
  await act(async () => button('Revoke Host')!.click());
  expect(removed).toEqual([]);
  expect(container.textContent).toContain('Studio Mac');
  await act(async () => button('Confirm revoke')!.click());
  expect(removed).toEqual(['managed-1']);
  expect(refreshes).toBe(1);
});

it('does not visually select a managed Host when the active selection is absent from the list', async () => {
  const host = { id: 'managed-1', name: 'Studio Mac', online: true, managed: true };
  const container = await render(<HostPairing service={{ hosts: async () => ({ hosts: [host] }), pair: async () => { throw new Error('unused'); }, revoke: async () => undefined }} selectedHostId="local" hosts={[host]} onSelect={() => undefined} onRetryHosts={() => undefined} />);
  const select = container.querySelector<HTMLSelectElement>('#remote-host')!;
  expect(select.value).toBe('local');
  expect(select.selectedOptions[0]?.textContent).toBe('Select a Host');
});

it('labels shared Host access and cumulative usage without exposing owner revocation', async () => {
  const host = { id: 'shared', name: 'Shared Studio', online: true, managed: true, access: 'shared' as const, sessionQuota: { used: 2, limit: 2 } };
  const container = await render(<HostPairing service={{ hosts: async () => ({ hosts: [host] }), pair: async () => { throw new Error('unused'); }, revoke: async () => undefined }} selectedHostId={host.id} hosts={[host]} onSelect={() => undefined} onRetryHosts={() => undefined} onNewSession={() => undefined} />);
  expect(container.querySelector<HTMLSelectElement>('#remote-host')?.selectedOptions[0]?.textContent).toContain('Shared');
  expect(container.textContent).toContain('Shared with you');
  expect(container.textContent).toContain('Session creation allowance used: 2 / 2');
  expect(container.textContent).toContain('Existing sessions remain available');
  expect([...container.querySelectorAll('button')].some((button) => button.textContent === 'Revoke Host')).toBe(false);
  expect([...container.querySelectorAll('button')].find((button) => button.textContent === 'New session')?.disabled).toBe(true);
});

it('requires fresh authentication for rotation without trusting a server redirect or replaying the action', async () => {
  window.history.replaceState(null, '', '/?host=studio&provider=codex&session=native-1&redirect=https://evil.example');
  const rotate = vi.fn(async () => { throw Object.assign(new Error('Recent sign-in required.'), { code: 'reauthentication_required', loginUrl: 'https://evil.example' }); });
  const host = { id: 'studio', name: 'Studio', online: true, managed: true, credentialRotation: true };
  const view = await render(<HostPairing service={{ hosts: async () => ({ hosts: [host] }), pair: async () => { throw Error(); }, rotate }} selectedHostId={host.id} hosts={[host]} onSelect={() => undefined} onRetryHosts={() => undefined} />);
  const button = (label: string) => [...view.querySelectorAll('button')].find(value => value.textContent === label)!;
  expect(button('Rotate credential')).toBeDefined();
  await act(async () => button('Rotate credential').click());
  await act(async () => button('Confirm rotation').click());
  expect(view.querySelector('a')?.getAttribute('href')).toBe('/auth/login?reauthenticate=1&host=studio&provider=codex&session=native-1');
  expect(rotate).toHaveBeenCalledOnce();
  expect(view.textContent).toContain('Try the action again after signing in');
});

it('reports partial stop outcomes without claiming a Host was revoked or processes were terminated', async () => {
  const stop = vi.fn(async () => ({ results: [{ agentId: 'one', status: 'cancelled' as const }, { agentId: 'two', status: 'unsupported' as const }, { agentId: 'three', status: 'failed' as const, message: 'Host unavailable' }] }));
  const host = { id: 'studio', name: 'Studio', online: true, managed: true };
  const view = await render(<HostPairing service={{ hosts: async () => ({ hosts: [host] }), pair: async () => { throw Error(); }, stop }} selectedHostId={host.id} hosts={[host]} onSelect={() => undefined} onRetryHosts={() => undefined} />);
  const button = (label: string) => [...view.querySelectorAll('button')].find(value => value.textContent === label)!;
  expect(button('Stop work')).toBeDefined();
  await act(async () => button('Stop work').click());
  await act(async () => button('Confirm stop').click());
  expect(stop).toHaveBeenCalledWith('studio');
  expect(view.textContent).toContain('Cancellation requested');
  expect(view.textContent).toContain('Cancellation unsupported');
  expect(view.textContent).toContain('Cancellation failed');
  expect(view.textContent).toContain('Host stays paired');
});

it('does not offer stop or rotation to a shared Host', async () => {
  const host = { id: 'shared', name: 'Shared', online: true, managed: true, credentialRotation: true, access: 'shared' as const };
  const view = await render(<HostPairing service={{ hosts: async () => ({ hosts: [host] }), pair: async () => { throw Error(); }, stop: vi.fn(), rotate: vi.fn() }} selectedHostId={host.id} hosts={[host]} onSelect={() => undefined} onRetryHosts={() => undefined} />);
  expect([...view.querySelectorAll('button')].map(value => value.textContent)).not.toContain('Stop work');
  expect([...view.querySelectorAll('button')].map(value => value.textContent)).not.toContain('Rotate credential');
});
it('shows pending rotation truthfully and does not expose a device credential', async () => {
  const host = { id: 'studio', name: 'Studio', online: true, managed: true, credentialRotation: true };
  const view = await render(<HostPairing service={{ hosts: async () => ({ hosts: [host] }), pair: async () => { throw Error(); }, rotate: async () => ({ ok: true, status: 'pending' }) }} selectedHostId={host.id} hosts={[host]} onSelect={() => undefined} onRetryHosts={() => undefined} />);
  const button = (label: string) => [...view.querySelectorAll('button')].find(value => value.textContent === label)!;
  await act(async () => button('Rotate credential').click());
  await act(async () => button('Confirm rotation').click());
  expect(view.textContent).toContain('Rotation pending');
  expect(view.textContent).not.toContain('Credential rotated');
});
