import { act, useState } from 'react';
import { expect, it, vi } from 'vitest';
import type { VscodeTunnelSnapshot } from '@orchardworks/agent-remote-protocol';
import { render } from '../test/setup.js';
import { VscodeTunnelScope, type VscodeTunnelService } from '../vscode-tunnel.js';
import { HostVscodeTunnel, WorkspaceVscodeLink } from './HostVscodeTunnel.js';

const host = { id: 'host-one', name: 'Desktop', online: true, access: 'owner' as const };
const stopped: VscodeTunnelSnapshot = { status: 'stopped', processAlive: false, revision: 0 };
function fixture(initial = stopped) {
  let state = initial;
  const service: VscodeTunnelService = {
    status: vi.fn(async () => state),
    start: vi.fn(async () => state = { status: 'awaiting_auth', processAlive: true, revision: 1,
      authorization: { url: 'https://github.com/login/device', code: '9491-B98B' } }),
    stop: vi.fn(async () => state = stopped),
  };
  return { service, setState: (next: VscodeTunnelSnapshot) => { state = next; } };
}
async function click(container: HTMLElement, text: string) {
  await act(async () => [...container.querySelectorAll('button')].find(button => button.textContent === text)?.click());
}
it('starts at Host level, shows device authorization and reacts to external exit', async () => {
  const { service, setState } = fixture();
  const container = await render(<VscodeTunnelScope host={host} service={service}>
    <HostVscodeTunnel /><WorkspaceVscodeLink workspace="/Users/me/My project#1" />
  </VscodeTunnelScope>);
  await click(container, 'Start tunnel');
  expect(service.start).not.toHaveBeenCalled();
  await act(async () => container.querySelector<HTMLInputElement>('input[type=checkbox]')?.click());
  await click(container, 'Start tunnel');
  expect(service.start).toHaveBeenCalledWith('host-one');
  expect(container.textContent).toContain('9491-B98B');
  expect(container.querySelector<HTMLAnchorElement>('a[data-vscode-workspace]')).toBeNull();
  setState({ status: 'connected', processAlive: true, revision: 2, tunnelName: 'desktop' });
  await click(container, 'Refresh');
  expect(container.querySelector<HTMLAnchorElement>('a[data-vscode-workspace]')?.getAttribute('href'))
    .toBe('https://vscode.dev/tunnel/desktop/Users/me/My%20project%231');
  expect(container.textContent).not.toContain('9491-B98B');
  setState({ status: 'exited', processAlive: false, exitCode: 7, revision: 3 });
  await click(container, 'Refresh');
  expect(container.textContent).toContain('Exited');
  expect(container.querySelector('a[data-vscode-workspace]')).toBeNull();
});

it('does not expose controls or fetch authorization for shared Hosts', async () => {
  const { service } = fixture();
  const container = await render(<VscodeTunnelScope host={{ ...host, access: 'shared' }} service={service}>
    <HostVscodeTunnel /><WorkspaceVscodeLink workspace="/work" />
  </VscodeTunnelScope>);
  expect(service.status).not.toHaveBeenCalled();
  expect(container.textContent).toBe('');
});

it('disables stale workspace links when the Host is offline', async () => {
  const { service } = fixture({ status: 'connected', processAlive: true, tunnelName: 'desktop', revision: 1 });
  const container = await render(<VscodeTunnelScope host={{ ...host, online: false }} service={service}>
    <HostVscodeTunnel /><WorkspaceVscodeLink workspace="/work" />
  </VscodeTunnelScope>);
  expect(service.status).not.toHaveBeenCalled();
  expect(container.textContent).toContain('Host offline');
  expect(container.querySelector('a[data-vscode-workspace]')).toBeNull();
});

it('starts during a background refresh and ignores its stale response', async () => {
  const { service } = fixture();
  let finish!: (state: VscodeTunnelSnapshot) => void;
  vi.mocked(service.status).mockResolvedValueOnce(stopped).mockImplementationOnce(() => new Promise(resolve => { finish = resolve; }));
  const container = await render(<VscodeTunnelScope host={host} service={service}><HostVscodeTunnel /></VscodeTunnelScope>);
  await act(async () => container.querySelector<HTMLInputElement>('input[type=checkbox]')?.click());
  await click(container, 'Refresh');
  await click(container, 'Start tunnel');
  expect(service.start).toHaveBeenCalledTimes(1);
  expect(container.textContent).toContain('9491-B98B');
  await act(async () => finish(stopped));
  expect(container.textContent).toContain('9491-B98B');
});

it('automatically removes workspace links after the process exits', async () => {
  vi.useFakeTimers();
  try {
    const { service, setState } = fixture({ status: 'connected', processAlive: true, tunnelName: 'desktop', revision: 1 });
    const container = await render(<VscodeTunnelScope host={host} service={service}><WorkspaceVscodeLink workspace="/work" /></VscodeTunnelScope>);
    expect(container.querySelector('a[data-vscode-workspace]')).not.toBeNull();
    setState({ status: 'exited', processAlive: false, revision: 2 });
    await act(async () => vi.advanceTimersByTimeAsync(2000));
    expect(container.querySelector('a[data-vscode-workspace]')).toBeNull();
  } finally { vi.useRealTimers(); }
});

it('disables starting and workspace links when this Host lacks code tunnel', async () => {
  const { service } = fixture({ status: 'unavailable', processAlive: false, revision: 1, message: 'Install VS Code CLI.' });
  const container = await render(<VscodeTunnelScope host={host} service={service}><HostVscodeTunnel /><WorkspaceVscodeLink workspace="/work" /></VscodeTunnelScope>);
  expect(container.textContent).toContain('Unavailable on this Host');
  expect(container.textContent).toContain('Install VS Code CLI.');
  expect(container.querySelector<HTMLInputElement>('input[type=checkbox]')).toBeNull();
  await click(container, 'Start tunnel');
  expect(service.start).not.toHaveBeenCalled();
  expect(container.querySelector('a[data-vscode-workspace]')).toBeNull();
});

it('refreshes a closed Host panel slowly and immediately catches up when opened', async () => {
  vi.useFakeTimers();
  const { service } = fixture();
  let reveal!: () => void;
  function Harness() {
    const [polling, setPolling] = useState(false); reveal = () => setPolling(true);
    return <VscodeTunnelScope host={host} service={service} polling={polling}><WorkspaceVscodeLink workspace="/work" /></VscodeTunnelScope>;
  }
  try {
    await render(<Harness />);
    await act(async () => { await vi.advanceTimersByTimeAsync(29_000); });
    expect(service.status).toHaveBeenCalledTimes(1);
    await act(async () => reveal());
    expect(service.status).toHaveBeenCalledTimes(2);
    await act(async () => { await vi.advanceTimersByTimeAsync(2_000); });
    expect(service.status).toHaveBeenCalledTimes(3);
  } finally { vi.useRealTimers(); }
});
