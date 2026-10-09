import { expect, it } from 'vitest';
import { isControllerRelease, compareControllerVersions, releaseCoversHost, controllerUpdateTarget, controllerUpgradeBridgeVersion } from './controller-release.js';
it('binds a stable release to its asset, revision and supported platforms', () => {
  const release = { protocolVersion: '1.7.0', version: '0.2.0', revision: 'a'.repeat(40), sha256: 'b'.repeat(64), asset: 'orchardworks-agent-remote-controller-0.2.0.tgz', nodeMajor: 22, platforms: ['darwin-arm64', 'linux-x64'] };
  expect(isControllerRelease(release)).toBe(true);
  expect(releaseCoversHost({ ...release, protocolVersion: '99.0.0' }, { platform: 'darwin', arch: 'arm64', nodeMajor: 22 })).toBe(true);
  expect(isControllerRelease({ ...release, asset: '../../other.tgz' })).toBe(false);
  expect(isControllerRelease({ ...release, version: '0.2.0-beta' })).toBe(false);
  expect(isControllerRelease({ ...release, sha256: 'oops' })).toBe(false);
  expect(compareControllerVersions('0.10.0', '0.2.9')).toBe(1);
  expect(releaseCoversHost(release, { platform: 'darwin', arch: 'arm64', nodeMajor: 22 })).toBe(true);
  expect(releaseCoversHost(release, { platform: 'win32', arch: 'x64', nodeMajor: 22 })).toBe(false);
  expect(releaseCoversHost(release, { platform: 'linux', arch: 'x64', nodeMajor: 20 })).toBe(false);
});

const target = { protocolVersion: '1.7.0', version: '0.2.33', revision: 'a'.repeat(40), sha256: 'b'.repeat(64), asset: 'orchardworks-agent-remote-controller-0.2.33.tgz', nodeMajor: 22, platforms: ['darwin-arm64'] };
const bridge = { ...target, protocolVersion: '1.5.0', version: '0.2.32', asset: 'orchardworks-agent-remote-controller-0.2.32.tgz' };
const host = { version: '0.2.30', platform: 'darwin', arch: 'arm64', nodeMajor: 22 };
it('routes legacy updaters through the published protocol 1.5 bridge', () => {
  expect(controllerUpgradeBridgeVersion(target, host)).toBe('0.2.32');
  expect(controllerUpdateTarget(target, host, bridge)).toEqual(bridge);
  expect(controllerUpdateTarget(target, host)).toBeNull();
  expect(controllerUpdateTarget(target, host, { ...bridge, protocolVersion: '1.7.0' })).toBeNull();
  expect(controllerUpdateTarget(target, host, { ...bridge, platforms: ['win32-x64'] })).toBeNull();
  expect(controllerUpdateTarget(target, host, { ...bridge, version: '0.2.34' })).toBeNull();
});
it('offers the final release after bridging, without downgrading current protocol Hosts', () => {
  expect(controllerUpdateTarget(target, { ...host, version: '0.2.32' }, bridge)).toEqual(target);
  expect(controllerUpdateTarget(target, { ...host, version: '0.2.31' }, bridge)).toEqual(target);
  expect(controllerUpdateTarget(bridge, { ...host, version: '0.2.31' })).toBeNull();
  expect(controllerUpdateTarget({ ...target, protocolVersion: '99.0.0' }, host, bridge)).toBeNull();
  expect(controllerUpdateTarget(target, { ...host, nodeMajor: 20 }, bridge)).toBeNull();
});

it('supports a staged bridge release without reopening the final release', () => {
  for (const version of ['0.2.0', '0.2.29', '0.2.30', '0.2.32']) {
    expect(controllerUpdateTarget(bridge, { ...host, version })).toEqual(bridge);
  }
  for (const version of ['0.1.0', '0.2.31', '0.2.33']) {
    expect(controllerUpdateTarget(bridge, { ...host, version })).toBeNull();
  }
  expect(controllerUpgradeBridgeVersion(bridge, host)).toBeUndefined();
  expect(controllerUpdateTarget({ ...bridge, version: '0.2.34' }, host)).toBeNull();
  expect(controllerUpdateTarget(bridge, { ...host, platform: 'win32' })).toBeNull();
});
