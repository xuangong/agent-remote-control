import { act } from 'react';
import { expect, it, vi } from 'vitest';
import { render } from '../test/setup.js';
import { LocaleContext } from '@orchardworks/agent-client-web/react';
import { HttpPreviewClient } from '@orchardworks/agent-client';
import { DirectoryError } from '../directory-client.js';
import type { RemoteHost } from '../components/HostPairing.js';
import { ComputerSettings, type ComputerServices } from './ComputerSettings.js';

const owned: RemoteHost = { id: 'studio', name: 'Studio Mac', online: true, managed: true, credentialRotation: true, providers: [{ providerId: 'codex', displayName: 'Codex' }, { providerId: 'claude', displayName: 'Claude Code' }],
  controller: { version: '0.3.0', platform: 'darwin', arch: 'arm64', nodeMajor: 22 } as RemoteHost['controller'] };
const shared: RemoteHost = { id: 'shared', name: 'Shared Studio', online: true, managed: true, access: 'shared', providers: [{ providerId: 'codex', displayName: 'Codex' }] };
const services = (hosts: RemoteHost[], extra: Partial<ComputerServices['service']> = {}): ComputerServices => ({
  hosts, loaded: true, previewClient: new HttpPreviewClient('http://localhost/'), tunnelService: { status: async () => { throw new Error('unused'); }, start: async () => { throw new Error('unused'); }, stop: async () => { throw new Error('unused'); } },
  service: { hosts: async () => ({ hosts }), pair: async () => { throw new Error('unused'); }, ...extra }, openPreviewSource: () => undefined, onRevoked: () => undefined });
const button = (root: ParentNode, label: string) => [...root.querySelectorAll('button')].find(item => item.textContent === label || item.getAttribute('aria-label') === label)!;
const settle = () => act(async () => { await new Promise(resolve => setTimeout(resolve, 0)); });
const openHost = async (container: HTMLElement, name: string) => act(async () => (container.querySelector(`.lab-host-card[data-host-id] .lab-host-open`) as HTMLButtonElement | null ?? button(container, name)).click());

it('leads with how many computers are online and opens a computer as a page that Back leaves', async () => {
  const container = await render(<ComputerSettings services={services([owned, { ...shared, online: false }])} visible />);
  expect(container.querySelector('.lab-host-lead')?.textContent).toBe('1 of 2 online');
  await openHost(container, 'Studio Mac');
  expect(container.querySelector('.lab-host-page h2')?.textContent).toBe('Studio Mac');
  expect(container.querySelector('.lab-host-page-head p')?.textContent).toContain('Online · darwin · arm64 · Controller 0.3.0');
  await act(async () => button(container, 'Computers').click());
  await vi.waitFor(() => expect(container.querySelector('.lab-host-page')).toBeNull());
});

it('shows an owned computer its smart reading switch per agent and PUTs the choice', async () => {
  const smartReading = vi.fn(async () => ({ providers: ['claude'] }));
  const setSmartReading = vi.fn(async (_host: string, _provider: string, enabled: boolean) => ({ providers: enabled ? ['claude', 'codex'] : ['claude'] }));
  const container = await render(<ComputerSettings services={services([owned], { smartReading, setSmartReading })} visible />);
  await openHost(container, 'Studio Mac');
  await settle();
  const toggle = (agent: string) => [...container.querySelectorAll<HTMLButtonElement>('[role="switch"]')].find(item => item.textContent === `Smart reading for ${agent}`)!;
  expect([toggle('Codex').getAttribute('aria-checked'), toggle('Claude Code').getAttribute('aria-checked')]).toEqual(['false', 'true']);
  await act(async () => toggle('Codex').click());
  expect(setSmartReading).toHaveBeenCalledWith('studio', 'codex', true);
  expect(toggle('Codex').getAttribute('aria-checked')).toBe('true');
});

it('says why a refusal happened and puts the switch back', async () => {
  for (const [error, words] of [[new DirectoryError('no journals', 'journals_unavailable', 409), 'needs session journals'], [new DirectoryError('forbidden', undefined, 403), 'Only the owner'], [new Error('boom'), 'could not be changed']] as const) {
    history.replaceState(null, '', '/');
    const setSmartReading = vi.fn(async () => { throw error; });
    const container = await render(<ComputerSettings services={services([owned], { smartReading: async () => ({ providers: [] }), setSmartReading })} visible />);
    await openHost(container, 'Studio Mac');
    await settle();
    const codex = () => [...container.querySelectorAll<HTMLButtonElement>('[role="switch"]')].find(item => item.textContent === 'Smart reading for Codex')!;
    await act(async () => codex().click());
    expect(container.querySelector('[role="alert"]')?.textContent).toContain(words);
    expect(codex().getAttribute('aria-checked')).toBe('false');
  }
});

it('shows a computer shared with the reader no smart reading, Controller update, keys or revoke', async () => {
  const container = await render(<ComputerSettings services={services([shared], { smartReading: async () => ({ providers: [] }), setSmartReading: vi.fn(), rotate: vi.fn(), stop: vi.fn(), revoke: vi.fn() })} visible />);
  await openHost(container, 'Shared Studio');
  const labels = [...container.querySelectorAll('button')].map(item => item.textContent);
  expect(container.querySelector('[role="switch"]')).toBeNull();
  for (const word of ['Revoke Host', 'Stop work', 'Rotate credential']) expect(labels).not.toContain(word);
  expect(container.textContent).not.toContain('Smart reading');
  expect(container.textContent).toContain('Shared with you');
});

it('revokes an owned computer after a confirmation, then returns to the list', async () => {
  const revoke = vi.fn(async () => undefined), onRevoked = vi.fn();
  const container = await render(<ComputerSettings services={{ ...services([owned], { revoke }), onRevoked }} visible />);
  await openHost(container, 'Studio Mac');
  await act(async () => button(container, 'Revoke Host').click());
  expect(revoke).not.toHaveBeenCalled();
  await act(async () => button(container, 'Confirm revoke').click());
  expect(revoke).toHaveBeenCalledWith('studio');
  expect(onRevoked).toHaveBeenCalledOnce();
});

it('rotates a credential and stops work only after a confirmation, and reports a pending rotation truthfully', async () => {
  const rotate = vi.fn(async () => ({ ok: true as const, status: 'pending' as const }));
  const stop = vi.fn(async () => ({ results: [{ agentId: 'one', status: 'cancelled' as const }] }));
  const container = await render(<ComputerSettings services={services([owned], { rotate, stop })} visible />);
  await openHost(container, 'Studio Mac');
  await act(async () => button(container, 'Rotate credential').click());
  expect(rotate).not.toHaveBeenCalled();
  await act(async () => button(container, 'Confirm rotation').click());
  expect(container.textContent).toContain('Rotation pending');
  await act(async () => button(container, 'Stop work').click());
  await act(async () => button(container, 'Confirm stop').click());
  expect(stop).toHaveBeenCalledWith('studio');
  expect(container.textContent).toContain('Host stays paired');
});

it('opens the pairing keys from Pair a computer', async () => {
  const pair = vi.fn().mockResolvedValue({ key: 'temporary-secret', expiresAt: '2099-09-09T00:00:00Z', serverUrl: 'http://127.0.0.1:5910' });
  const container = await render(<ComputerSettings services={services([], { pair })} visible />);
  expect(container.querySelector('.lab-host-lead')?.textContent).toBe('No computers paired');
  await act(async () => button(container, 'Pair a computer').click());
  await act(async () => button(container, 'Generate pairing key').click());
  expect(pair).toHaveBeenCalledOnce();
  expect(container.querySelector<HTMLTextAreaElement>('#pairing-configuration')?.value).toContain('remoteKey: temporary-secret');
});

it('speaks Chinese when the device does', async () => {
  const container = await render(<LocaleContext.Provider value="zh"><ComputerSettings services={services([owned, shared])} visible /></LocaleContext.Provider>);
  expect(container.querySelector('.lab-host-lead')?.textContent).toBe('2 台电脑在线');
  expect(button(container, '添加电脑')).toBeDefined();
});
