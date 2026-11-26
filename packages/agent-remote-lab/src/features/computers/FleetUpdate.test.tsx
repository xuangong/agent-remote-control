import { act, useState } from 'react';
import { expect, it, vi } from 'vitest';
import type { ControllerUpdateStatus } from '@orchardworks/agent-remote-protocol';
import { render } from '../../test/setup.js';
import { HostOverview } from './HostOverview.js';
import type { HostPairingService, RemoteHost } from '../../kernel/remote-host.js';

const release = { protocolVersion: '1.8.0', version: '0.2.0', revision: 'b'.repeat(40), sha256: 'c'.repeat(64), asset: 'controller-0.2.0.tgz', nodeMajor: 22, platforms: ['darwin-arm64'] };
const controller = { version: '0.1.0', revision: 'a'.repeat(40), platform: 'darwin', arch: 'arm64', nodeMajor: 22, remoteUpdate: true };
const host = (id: string, extra: Partial<RemoteHost> = {}): RemoteHost => ({ id, name: id, online: true, hostStatus: true, access: 'owner', sessionControl: true, controller, ...extra });
const fleet = [host('mac'), host('studio'), host('desk'), host('off', { online: false }), host('lent', { access: 'shared' }), host('fresh', { controller: { ...controller, version: '0.2.0' } })];
const card = (container: HTMLElement, id: string) => container.querySelector<HTMLElement>(`[data-host-id="${id}"]`)!;
const press = (container: ParentNode, label: string) => { const found = [...container.querySelectorAll('button')].find(item => item.textContent === label); expect(found, label).toBeDefined(); return act(async () => found!.click()); };
function setup(update: NonNullable<HostPairingService['controllerUpdate']>, hosts = fleet) {
  const service: HostPairingService = { hosts: async () => ({ hosts }), pair: async () => { throw new Error('unused'); }, controllerRelease: async () => ({ release }), controllerUpdate: vi.fn(update) };
  return { service, mount: (list = hosts) => render(<HostOverview hosts={list} service={service} visible onOpenHost={() => {}} />) };
}

it('offers Update all with the count of computers it reaches, and lists who updates and who does not', async () => {
  const { mount } = setup(async () => ({ phase: 'idle', updatedAt: 0 }));
  const container = await mount();
  await press(container, 'Update all (3)');
  const group = container.querySelector<HTMLElement>('[role=group]')!;
  expect(group.textContent).toContain('Update 3 computers to 0.2.0?');
  const lists = (name: string) => [...group.querySelectorAll(`[data-list=${name}] li`)].map(item => item.textContent);
  expect(lists('update')).toEqual(['mac0.1.0 to 0.2.0', 'studio0.1.0 to 0.2.0', 'desk0.1.0 to 0.2.0']);
  expect(lists('skip')).toEqual(['offOffline', 'lentShared with you; only its owner can update it', 'freshAlready up to date']);
});
it('sends one request per eligible computer on confirmation and nothing before', async () => {
  const { service, mount } = setup(async (_id, input) => input ? { ...input, phase: 'downloading', updatedAt: 1 } : { phase: 'idle', updatedAt: 0 });
  const container = await mount();
  await press(container, 'Update all (3)');
  expect(service.controllerUpdate).not.toHaveBeenCalled();
  await press(container, 'Confirm update');
  const calls = vi.mocked(service.controllerUpdate!).mock.calls.filter(call => call[1]);
  expect(calls.map(call => call[0])).toEqual(['mac', 'studio', 'desk']);
  expect(calls.every(call => call[1]?.version === '0.2.0')).toBe(true);
  expect(container.querySelector('[role=group]')).toBeNull();
  expect(container.textContent).toContain('Updating 3 computers…');
  expect(card(container, 'mac').textContent).toContain('Downloading and installing…');
  expect(card(container, 'off').textContent).not.toContain('Downloading');
});
it('keeps one failure on its card with a retry while the others carry on', async () => {
  const { service, mount } = setup(async (id, input) => {
    if (!input) return { phase: 'idle', updatedAt: 0 };
    if (id === 'studio') throw new Error('Host connection lost');
    return { ...input, phase: 'restarting', updatedAt: 1 };
  });
  const container = await mount();
  await press(container, 'Update all (3)'); await press(container, 'Confirm update');
  expect(card(container, 'studio').textContent).toContain('Update failed');
  expect(card(container, 'studio').textContent).toContain('Host connection lost');
  expect(card(container, 'mac').textContent).toContain('Reconnecting…');
  expect(card(container, 'desk').textContent).toContain('Reconnecting…');
  const first = vi.mocked(service.controllerUpdate!).mock.calls.find(call => call[0] === 'studio')![1];
  await press(card(container, 'studio'), 'Retry update'); await press(card(container, 'studio'), 'Confirm update');
  const studio = vi.mocked(service.controllerUpdate!).mock.calls.filter(call => call[0] === 'studio' && call[1]);
  expect(studio).toHaveLength(2); expect(studio[1]![1]).toEqual(first);
  expect(vi.mocked(service.controllerUpdate!).mock.calls.filter(call => call[0] === 'mac' && call[1])).toHaveLength(1);
});
it('shows the result when a computer comes back with the new version, and Update all goes away when none is older', async () => {
  const { service } = setup(async (_id, input) => input ? { ...input, phase: 'restarting', updatedAt: 1 } : { phase: 'idle', updatedAt: 0 });
  const list = [host('mac'), host('studio')];
  function Page() {
    const [hosts, setHosts] = useState(list);
    return <><HostOverview hosts={hosts} service={service} visible onOpenHost={() => {}} />
      <button id="back" onClick={() => setHosts(current => current.map(item => ({ ...item, controller: { ...controller, version: '0.2.0' } })))}>back</button></>;
  }
  const container = await render(<Page />);
  await press(container, 'Update all (2)'); await press(container, 'Confirm update');
  expect(card(container, 'mac').textContent).toContain('Reconnecting…');
  await press(container, 'back');
  expect(card(container, 'mac').textContent).toContain('Updated to 0.2.0');
  expect(card(container, 'studio').querySelector('button.lab-host-update-action')).toBeNull();
  expect(container.textContent).not.toContain('Update all');
  expect(container.textContent).not.toContain('Updating');
});
it('stops saying Reconnecting after the patience: the card says the computer did not come back and offers a retry, until then it waits', async () => {
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
  try {
    const { service } = setup(async (_id, input) => input ? { ...input, phase: 'restarting', updatedAt: 1 } : { phase: 'idle', updatedAt: 0 });
    const list = [host('mac'), host('studio')];
    function Page() {
      const [hosts, setHosts] = useState(list);
      return <><HostOverview hosts={hosts} service={service} visible updatePatienceMs={1000} onOpenHost={() => {}} />
        <button id="drop" onClick={() => setHosts(current => current.map(item => item.id === 'studio' ? { ...item, online: false } : item))}>drop</button></>;
    }
    const container = await render(<Page />);
    await press(container, 'Update all (2)'); await press(container, 'Confirm update');
    await press(container, 'drop');
    await act(async () => { vi.advanceTimersByTime(999); });
    expect(card(container, 'mac').textContent).toContain('Reconnecting…');
    await act(async () => { vi.advanceTimersByTime(2); });
    expect(card(container, 'mac').textContent).toContain('Came back on 0.1.0, not 0.2.0');
    expect(card(container, 'mac').textContent).not.toContain('Reconnecting');
    expect(card(container, 'studio').textContent).toContain('Did not come back on 0.2.0 yet');
    expect(container.textContent).not.toContain('Updating');
    const before = vi.mocked(service.controllerUpdate!).mock.calls.filter(call => call[1]).length;
    await press(card(container, 'mac'), 'Retry update'); await press(card(container, 'mac'), 'Confirm update');
    expect(vi.mocked(service.controllerUpdate!).mock.calls.filter(call => call[1])).toHaveLength(before + 1);
    expect(card(container, 'mac').textContent).toContain('Reconnecting…');
  } finally { vi.useRealTimers(); }
});
it('gives a card of a current computer its version and no button, and a shared viewer no action', async () => {
  const { mount } = setup(async () => ({ phase: 'idle', updatedAt: 0 }));
  const container = await mount();
  expect(card(container, 'fresh').querySelector('.lab-host-update-line')!.textContent).toBe('Controller 0.2.0 · up to date');
  expect(card(container, 'fresh').querySelector('button.lab-host-update-action')).toBeNull();
  expect(card(container, 'mac').querySelector('button.lab-host-update-action')?.textContent).toBe('Update');
  const viewer = await mount([host('lent', { access: 'shared' })]);
  expect(viewer.textContent).not.toContain('Update all');
});
