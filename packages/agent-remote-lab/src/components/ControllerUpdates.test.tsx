import { act } from 'react';
import { expect, it, vi } from 'vitest';
import { render } from '../test/setup.js';
import { ControllerUpdates, controllerUpdateCoverage } from './ControllerUpdates.js';
import type { HostPairingService, RemoteHost } from './HostPairing.js';
const release = { protocolVersion: '1.5.0', version: '0.2.0', revision: 'a'.repeat(40), sha256: 'b'.repeat(64), asset: 'orchardworks-agent-remote-controller-0.2.0.tgz', nodeMajor: 22, platforms: ['darwin-arm64'] };
const host: RemoteHost = { id: 'mac', name: 'Mac', online: true, access: 'owner', controller: { version: '0.1.0', revision: 'c'.repeat(40), platform: 'darwin', arch: 'arm64', nodeMajor: 22, remoteUpdate: true } };
const others: RemoteHost[] = [{ ...host, id: 'offline', online: false }, { ...host, id: 'shared', access: 'shared' }, { ...host, id: 'unsupported', controller: { ...host.controller!, platform: 'linux' } }];
function button(container: HTMLElement, label: string) { const element = [...container.querySelectorAll('button')].find(b => b.textContent === label); expect(element).toBeDefined(); return element!; }
it('allows a compatible Host independently of offline, shared and unsupported Hosts', () => {
  const coverage = controllerUpdateCoverage(release, [host, ...others]);
  expect(coverage.covered).toBe(false); expect(coverage.eligible.map(h => h.id)).toEqual(['mac']);
  expect(controllerUpdateCoverage({ ...release, protocolVersion: '99.0.0' }, [host]).eligible).toEqual([]);
});
it('requires confirmation for one Host and retains the operation ID on explicit retry', async () => {
  const requests: unknown[] = [];
  const service: HostPairingService = { hosts: async () => ({ hosts: [host] }), pair: async () => { throw new Error('unused'); }, controllerRelease: async () => ({ release }),
    controllerUpdate: vi.fn(async (_id, input) => { if (!input) return { phase: 'idle' as const, updatedAt: 0 };
      requests.push(input); throw new Error('Host connection lost'); }) };
  const container = await render(<ControllerUpdates service={service} hosts={[host, ...others]} />);
  await act(async () => container.querySelector('button')!.click());
  await act(async () => button(container, 'Update Host').click());
  expect(requests).toEqual([]);
  await act(async () => button(container, 'Confirm update').click());
  expect(requests).toHaveLength(1); expect(container.textContent).toContain('Host connection lost');
  await act(async () => button(container, 'Retry update').click());
  await act(async () => button(container, 'Confirm update').click());
  expect(requests).toHaveLength(2); expect(requests[1]).toEqual(requests[0]);
  expect(container.textContent).not.toContain('shared');
});
it('creates a fresh operation when discovery advances to another release', async () => {
  let latest = release;
  const requests: Array<{ version: string; operationId: string }> = [];
  const service: HostPairingService = { hosts: async () => ({ hosts: [host] }), pair: async () => { throw new Error('unused'); }, controllerRelease: async () => ({ release: latest }),
    controllerUpdate: async (_id, input) => { if (!input) return { phase: 'idle', updatedAt: 0 }; requests.push(input); return { ...input, phase: 'failed', updatedAt: Date.now() }; } };
  const container = await render(<ControllerUpdates service={service} hosts={[host]} />);
  await act(async () => container.querySelector('button')!.click());
  await act(async () => button(container, 'Update Host').click());
  await act(async () => button(container, 'Confirm update').click());
  latest = { ...release, version: '0.3.0' };
  await act(async () => document.dispatchEvent(new Event('visibilitychange')));
  await act(async () => button(container, 'Update Host').click());
  await act(async () => button(container, 'Confirm update').click());
  expect(requests.map(r => r.version)).toEqual(['0.2.0', '0.3.0']);
  expect(requests[1]!.operationId).not.toBe(requests[0]!.operationId);
});
