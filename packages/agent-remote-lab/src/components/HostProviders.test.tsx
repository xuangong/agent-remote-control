import { act } from 'react';
import { expect, it, vi } from 'vitest';
import type { HostProviderSettings } from '@orchardworks/agent-remote-protocol';
import { render } from '../test/setup.js';
import { HostProviders } from './HostProviders.js';
import type { HostPairingService, RemoteHost } from './HostPairing.js';
const host: RemoteHost = { id: 'host', name: 'Desktop', online: true, managed: true, access: 'owner', providerManagement: true };
const initial: HostProviderSettings = { revision: 'one', providers: [
  { providerId: 'codex', displayName: 'Codex', state: 'enabled' },
  { providerId: 'claude', displayName: 'Claude Code', state: 'unavailable', reason: 'Not installed.' },
] };
function fixture() {
  let state = structuredClone(initial);
  const providerSettings = vi.fn<NonNullable<HostPairingService['providerSettings']>>(async (_host, input) => {
    if (input && !('refresh' in input)) state = { revision: 'two', providers: state.providers.map(provider => provider.providerId === input.providerId ? { ...provider, state: input.enabled ? 'enabled' : 'disabled' } : provider) };
    return structuredClone(state);
  });
  return { providerSettings, hosts: async () => ({ hosts: [host] }), pair: vi.fn() };
}
it('shows detection separately from opt-out and sends a revision-checked preference', async () => {
  const service = fixture(); const container = await render(<HostProviders host={host} service={service} visible />);
  const codex = container.querySelector<HTMLInputElement>('[aria-label="Automatically enable Codex"]')!;
  expect(codex.checked).toBe(true);
  expect(container.querySelector<HTMLInputElement>('[aria-label="Automatically enable Claude Code"]')!.checked).toBe(true);
  expect(container.textContent).toContain('Not available');
  await act(async () => codex.click());
  expect(service.providerSettings).toHaveBeenLastCalledWith('host', { providerId: 'codex', enabled: false, revision: 'one' });
  expect(codex.checked).toBe(false);
});
it('reconciles an uncertain write without submitting it twice', async () => {
  const service = fixture(); const container = await render(<HostProviders host={host} service={service} visible />);
  service.providerSettings.mockRejectedValueOnce(new Error('Connection lost'));
  await act(async () => container.querySelector<HTMLInputElement>('input')!.click());
  expect(service.providerSettings.mock.calls.filter(([, input]) => input && !('refresh' in input))).toHaveLength(1);
  expect(service.providerSettings).toHaveBeenLastCalledWith('host');
  expect(container.querySelector('[role="alert"]')?.textContent).toContain('Connection lost');
});
it('does not read hidden settings or expose owner controls to shared users', async () => {
  const service = fixture();
  await render(<HostProviders host={host} service={service} visible={false} />); expect(service.providerSettings).not.toHaveBeenCalled();
  const shared = await render(<HostProviders host={{ ...host, access: 'shared' }} service={service} visible />);
  expect(shared.querySelector('input')).toBeNull(); expect(service.providerSettings).not.toHaveBeenCalled();
});
