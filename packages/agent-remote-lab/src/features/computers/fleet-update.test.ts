import { expect, it } from 'vitest';
import type { ControllerRelease, ControllerUpdateStatus } from '@orchardworks/agent-remote-protocol';
import type { RemoteHost } from '../../kernel/remote-host.js';
import { cardUpdate, planFleetUpdate } from './fleet-update.js';

const release: ControllerRelease = { protocolVersion: '1.8.0', version: '0.2.0', revision: 'b'.repeat(40), sha256: 'c'.repeat(64), asset: 'controller-0.2.0.tgz', nodeMajor: 22, platforms: ['darwin-arm64'] };
const mac: RemoteHost = { id: 'mac', name: 'Mac', online: true, access: 'owner', controller: { version: '0.1.0', revision: 'a'.repeat(40), platform: 'darwin', arch: 'arm64', nodeMajor: 22, remoteUpdate: true } };
const reasons = (hosts: RemoteHost[], statuses: Record<string, ControllerUpdateStatus> = {}) => planFleetUpdate(release, hosts, undefined, statuses).skipped.map(entry => [entry.host.id, entry.reason]);

it('updates the online owned computers that run an older Controller and can update remotely', () => {
  const hosts: RemoteHost[] = [mac, { ...mac, id: 'second' }, { ...mac, id: 'off', online: false }, { ...mac, id: 'shared', access: 'shared' },
    { ...mac, id: 'launcher', controller: { ...mac.controller!, remoteUpdate: false } }, { ...mac, id: 'linux', controller: { ...mac.controller!, platform: 'linux' } },
    { ...mac, id: 'current', controller: { ...mac.controller!, version: '0.2.0' } }, { ...mac, id: 'legacy', controller: undefined }];
  const plan = planFleetUpdate(release, hosts, undefined, {});
  expect(plan.eligible.map(entry => [entry.host.id, entry.target.version])).toEqual([['mac', '0.2.0'], ['second', '0.2.0']]);
  expect(plan.skipped.map(entry => [entry.host.id, entry.reason])).toEqual([['off', 'offline'], ['shared', 'shared'], ['launcher', 'noRemoteUpdate'], ['linux', 'unsupported'], ['current', 'current'], ['legacy', 'noRemoteUpdate']]);
});
it('plans nothing before a release is known, and skips a computer that is already updating', () => {
  expect(planFleetUpdate(null, [mac], undefined, {}).eligible).toEqual([]);
  expect(reasons([mac], { mac: { phase: 'restarting', version: '0.2.0', updatedAt: 1 } })).toEqual([['mac', 'updating']]);
});
it('shows the phases of an update on its card and the version the computer came back with as its result', () => {
  const at = (phase: ControllerUpdateStatus['phase'], host = mac) => cardUpdate(host, { phase, version: '0.2.0', updatedAt: 1, ...(phase === 'failed' ? { message: 'Rolled back' } : {}) });
  expect(at('downloading')).toEqual({ kind: 'updating', phase: 'downloading' });
  expect(at('waiting')).toEqual({ kind: 'updating', phase: 'waiting' });
  expect(at('restarting')).toEqual({ kind: 'reconnecting' });
  expect(at('downloading', { ...mac, online: false })).toEqual({ kind: 'reconnecting' });
  expect(at('failed')).toEqual({ kind: 'failed', message: 'Rolled back' });
  expect(at('succeeded')).toEqual({ kind: 'reconnecting' });
  const back = { ...mac, controller: { ...mac.controller!, version: '0.2.0' } };
  expect(at('succeeded', back)).toEqual({ kind: 'updated', version: '0.2.0' });
  expect(at('restarting', back)).toEqual({ kind: 'updated', version: '0.2.0' });
  expect(cardUpdate(mac, undefined)).toBeUndefined();
});
