import { act, useState } from 'react';
import { afterEach, expect, it, vi } from 'vitest';
import type { HostStatus } from '@orchardworks/agent-remote-protocol';
import { render } from '../test/setup.js';
import { HostOverview, formatBytes } from './HostOverview.js';
import type { HostPairingService, RemoteHost } from './HostPairing.js';

const GiB = 2 ** 30;
const status: HostStatus = {
  sampledAt: 1, sessions: { running: 2, waiting: 1, idle: 3, failed: 0 }, cpu: { cores: 12, usage: 0.38 },
  memory: { total: 24 * GiB, used: 14.2 * GiB },
  disks: [{ kind: 'home', path: '/Users/xian', total: 460 * GiB, used: 442 * GiB }, { kind: 'workspace', path: '/Volumes/Projects', total: 1907 * GiB, used: 432 * GiB }],
};
const environment = { detectedAt: 1, os: { platform: 'darwin', name: 'macOS', arch: 'arm64', release: '25.0.0' }, wsl: false, container: false,
  shell: { source: 'account' as const }, shells: [], browsers: [], vscode: { status: 'found' as const } };
const homelab: RemoteHost = { id: 'homelab', name: 'homelab', online: true, hostStatus: true, environment, access: 'owner',
  controller: { version: '0.2.80', revision: 'a'.repeat(40), platform: 'darwin', arch: 'arm64', nodeMajor: 22, remoteUpdate: true } };
const outdated: RemoteHost = { id: 'windows', name: 'Windows test', online: true, access: 'owner' };
const offline: RemoteHost = { id: 'ci', name: 'linux-ci', online: false, hostStatus: true, access: 'owner' };
const shared: RemoteHost = { id: 'shared', name: 'Shared server', online: true, hostStatus: true, access: 'shared' };
const invitation = { key: 'pairing-key', expiresAt: '2099-01-01T00:00:00.000Z', serverUrl: 'https://relay.example' };

const service = (hostStatus: NonNullable<HostPairingService['hostStatus']>): HostPairingService => ({ hosts: async () => ({ hosts: [] }), pair: async () => invitation, hostStatus });
const card = (container: HTMLElement, id: string) => container.querySelector<HTMLElement>(`[data-host-id="${id}"]`)!;

afterEach(() => { vi.useRealTimers(); });

it('formats sizes in binary units as the operating system tools show them', () => {
  expect(formatBytes(14.2 * GiB)).toBe('14.2 GB');
  expect(formatBytes(1907 * GiB)).toBe('1.9 TB');
  expect(formatBytes(512 * 2 ** 20)).toBe('0.5 GB');
});

it('shows each Host with its sessions and machine figures, warning above 90%', async () => {
  const container = await render(<HostOverview hosts={[homelab]} service={service(async () => status)} visible onOpenHost={() => {}} />);
  await act(async () => {});
  const homelabCard = card(container, 'homelab');
  expect(homelabCard.textContent).toContain('macOS · arm64 · Controller 0.2.80');
  const sessions = homelabCard.querySelector('.lab-host-sessions')!;
  expect(sessions.textContent).toBe('6 sessions 2 working · 1 needs you · 3 idle');
  expect(sessions.querySelector('strong')?.textContent).toBe('6');
  expect(sessions.querySelector('em')?.textContent).toBe('1 needs you');
  expect(homelabCard.querySelector('[aria-label="CPU"]')?.getAttribute('aria-valuenow')).toBe('38');
  expect(homelabCard.textContent).toContain('38% · 12 cores');
  expect(homelabCard.textContent).toContain('14.2 / 24.0 GB');
  const home = homelabCard.querySelector<HTMLElement>('[aria-label="Home disk"]')!;
  expect(home.dataset.warning).toBe('true');
  expect(home.textContent).toContain('442.0 / 460.0 GB');
  const workspace = homelabCard.querySelector<HTMLElement>('[aria-label="Projects disk"]')!;
  expect(workspace.textContent).toContain('432.0 GB / 1.9 TB');
  expect(workspace.title).toBe('/Volumes/Projects');
  expect(workspace.dataset.warning).toBeUndefined();
});

it('asks for a Controller update, marks offline Hosts and shows shared Hosts as session counts only', async () => {
  const hostStatus = vi.fn(async (id: string) => id === 'shared' ? { sampledAt: 1, sessions: { running: 1, waiting: 0, idle: 0, failed: 0 } } : status);
  const opened: string[] = [];
  const container = await render(<HostOverview hosts={[outdated, offline, shared]} service={service(hostStatus)} visible onOpenHost={id => opened.push(id)} />);
  await act(async () => {});
  expect(hostStatus.mock.calls.map(([id]) => id)).toEqual(['shared']);
  expect(card(container, 'windows').textContent).toContain('Update the Controller to see CPU, memory and disks.');
  await act(async () => card(container, 'windows').querySelector<HTMLButtonElement>('.lab-host-update')!.click());
  expect(opened).toEqual(['windows']);
  expect(card(container, 'ci').textContent).toContain('Offline');
  expect(card(container, 'shared').querySelector('.lab-host-sessions')?.textContent).toBe('1 session 1 working');
  expect(card(container, 'shared').textContent).toContain('Shared with you: sessions only.');
  expect(card(container, 'shared').querySelector('[aria-label="CPU"]')).toBeNull();
});

it('refreshes every five seconds only while visible and keeps the last figures when a read fails', async () => {
  vi.useFakeTimers();
  let fail = false;
  const hostStatus = vi.fn(async () => { if (fail) throw new Error('Host disconnected'); return status; });
  let setVisible!: (visible: boolean) => void;
  function Page() {
    const [visible, set] = useState(true);
    setVisible = set;
    return <HostOverview hosts={[homelab]} service={service(hostStatus)} visible={visible} onOpenHost={() => {}} />;
  }
  const container = await render(<Page />);
  await act(async () => {});
  expect(hostStatus).toHaveBeenCalledTimes(1);
  fail = true;
  await act(async () => { await vi.advanceTimersByTimeAsync(5_000); });
  expect(hostStatus).toHaveBeenCalledTimes(2);
  expect(card(container, 'homelab').textContent).toContain('38% · 12 cores');
  expect(card(container, 'homelab').querySelector('[role="status"]')?.textContent).toContain('Host disconnected');
  await act(async () => setVisible(false));
  await act(async () => { await vi.advanceTimersByTimeAsync(20_000); });
  expect(hostStatus).toHaveBeenCalledTimes(2);
});

it('opens a Host from its card', async () => {
  const opened: string[] = [];
  const container = await render(<HostOverview hosts={[homelab]} service={service(async () => status)} visible onOpenHost={id => opened.push(id)} />);
  await act(async () => card(container, 'homelab').querySelector<HTMLButtonElement>('.lab-host-open')!.click());
  expect(opened).toEqual(['homelab']);
});

it('pairs a new Host from the page toolbar on desktop', async () => {
  const toolbar = document.createElement('div');
  document.body.append(toolbar);
  const container = await render(<HostOverview hosts={[homelab]} service={service(async () => status)} visible onOpenHost={() => {}} actionsTarget={toolbar} />);
  const pair = toolbar.querySelector<HTMLButtonElement>('button.lab-host-pair')!;
  expect(pair.textContent).toBe('Pair a Host');
  expect(container.querySelector('.lab-directory-heading')).toBeNull();
  expect(container.querySelector('.lab-pairing-details')).toBeNull();
  await act(async () => pair.click());
  expect(pair.getAttribute('aria-expanded')).toBe('true');
  expect(container.querySelector('.lab-pairing-details')).not.toBeNull();
  toolbar.remove();
});

it('stacks the cards with two-column figures on a phone, with pairing in the heading', async () => {
  const container = await render(<HostOverview hosts={[homelab]} service={service(async () => status)} visible compact onOpenHost={() => {}} />);
  expect(container.querySelector('.lab-directory-heading h2')?.textContent).toBe('Hosts');
  expect(container.querySelector('.lab-directory-heading button.lab-host-pair')).not.toBeNull();
  expect(container.querySelector<HTMLElement>('.lab-host-grid')?.dataset.compact).toBe('true');
});

it('offers pairing when no Host is paired yet', async () => {
  const container = await render(<HostOverview hosts={[]} service={service(async () => status)} visible onOpenHost={() => {}} />);
  expect(container.querySelector('.lab-host-empty')?.textContent).toBe('No Hosts paired yet. Pair a Host to see it here.');
  expect(container.querySelector('button.lab-host-pair')).not.toBeNull();
});
