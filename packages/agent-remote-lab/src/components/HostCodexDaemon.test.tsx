import { act, useState } from 'react';
import { afterEach, expect, it, vi } from 'vitest';
import type { CodexDaemonStatus } from '@orchardworks/agent-remote-protocol';
import { render } from '../test/setup.js';
import { HostSecurityActions } from './HostSecurityActions.js';
import type { HostPairingService, RemoteHost } from './HostPairing.js';

const host: RemoteHost = { id: 'host-one', name: 'Desktop', online: true, managed: true, access: 'owner',
  providers: [{ providerId: 'codex', displayName: 'Codex', daemonControl: true }] };
const revision = '00000000-0000-4000-8000-000000000001';
function fixture() {
  let current: CodexDaemonStatus = { phase: 'idle', revision, updatedAt: 0 };
  const service: HostPairingService = { hosts: async () => ({ hosts: [host] }), pair: vi.fn(),
    codexDaemon: vi.fn(async (_id, input) => input ? current = { ...current, revision: crypto.randomUUID(), operationId: input.operationId, phase: 'restarting' } : current) };
  return { service, setState: (state: CodexDaemonStatus) => { current = state; } };
}
async function click(container: HTMLElement, text: string) {
  const button = [...container.querySelectorAll('button')].find(value => value.textContent === text);
  expect(button, text).toBeDefined();
  await act(async () => button!.click());
}
it('requires confirmation, identifies all affected sessions, and disables duplicate restart', async () => {
  const f = fixture(); const container = await render(<HostSecurityActions host={host} service={f.service} />);
  await click(container, 'Restart Codex daemon');
  expect(container.textContent).toContain('Desktop');
  expect(container.textContent).toContain('Running tasks will be interrupted');
  expect(vi.mocked(f.service.codexDaemon!).mock.calls.every(call => call[1] === undefined)).toBe(true);
  await click(container, 'Confirm restart');
  const writes = vi.mocked(f.service.codexDaemon!).mock.calls.filter(call => call[1]);
  expect(writes).toHaveLength(1); expect(writes[0]).toEqual(['host-one', { revision, operationId: expect.any(String) }]);
  expect(container.textContent).toContain('Restarting Codex daemon');
  expect([...container.querySelectorAll('button')].find(value => value.textContent === 'Restart Codex daemon')?.disabled).toBe(true);
  f.setState({ revision: crypto.randomUUID(), operationId: writes[0]![1]!.operationId, phase: 'ready', updatedAt: 1 });
  await click(container, 'Check status');
  expect(container.textContent).toContain('Restart completed');
});
it('queries after a lost acknowledgement without replaying restart', async () => {
  const f = fixture(); const command = f.service.codexDaemon!;
  f.service.codexDaemon = vi.fn(async (id, input) => { const result = await command(id, input); if (input) throw new Error('Host disconnected'); return result; });
  const container = await render(<HostSecurityActions host={host} service={f.service} />);
  await click(container, 'Restart Codex daemon'); await click(container, 'Confirm restart');
  expect(container.textContent).toContain('Check status');
  await click(container, 'Check status');
  expect(container.textContent).toContain('Restarting Codex daemon');
  expect(vi.mocked(f.service.codexDaemon!).mock.calls.filter(call => call[1])).toHaveLength(1);
});
it.each(['shared', 'unsupported', 'offline'] as const)('does not dispatch restart for %s Hosts', async kind => {
  const f = fixture();
  const target = { ...host, ...(kind === 'shared' ? { access: 'shared' as const } : kind === 'unsupported' ? { providers: [] } : { online: false }) };
  const container = await render(<HostSecurityActions host={target} service={f.service} />);
  const button = [...container.querySelectorAll('button')].find(value => value.textContent === 'Restart Codex daemon');
  expect(!button || button.disabled).toBe(true);
  expect(f.service.codexDaemon).not.toHaveBeenCalled();
});

afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks(); });
it('polls pending outcomes only while the management panel is visible and the page is foregrounded', async () => {
  vi.useFakeTimers();
  let hidden = false;
  vi.spyOn(document, 'hidden', 'get').mockImplementation(() => hidden);
  const f = fixture();
  f.setState({ revision, phase: 'restarting', operationId: crypto.randomUUID(), updatedAt: 0 });
  function Panel() {
    const [visible, setVisible] = useState(true);
    return <><button onClick={() => setVisible(value => !value)}>Toggle panel</button><HostSecurityActions host={host} service={f.service} visible={visible} /></>;
  }
  const container = await render(<Panel />);
  expect(f.service.codexDaemon).toHaveBeenCalledTimes(1);
  await act(async () => { await vi.advanceTimersByTimeAsync(1500); });
  expect(f.service.codexDaemon).toHaveBeenCalledTimes(2);
  hidden = true;
  await act(async () => { document.dispatchEvent(new Event('visibilitychange')); await vi.advanceTimersByTimeAsync(30000); });
  expect(f.service.codexDaemon).toHaveBeenCalledTimes(2);
  hidden = false;
  await act(async () => { document.dispatchEvent(new Event('visibilitychange')); });
  expect(f.service.codexDaemon).toHaveBeenCalledTimes(3);
  await click(container, 'Toggle panel');
  await act(async () => { await vi.advanceTimersByTimeAsync(30000); });
  expect(f.service.codexDaemon).toHaveBeenCalledTimes(3);
  await click(container, 'Toggle panel');
  expect(f.service.codexDaemon).toHaveBeenCalledTimes(4);
  f.setState({ revision, phase: 'ready', updatedAt: 1 });
  await act(async () => { await vi.advanceTimersByTimeAsync(1500); });
  expect(container.textContent).toContain('Restart completed');
  await act(async () => { await vi.advanceTimersByTimeAsync(30000); });
  expect(f.service.codexDaemon).toHaveBeenCalledTimes(5);
});
