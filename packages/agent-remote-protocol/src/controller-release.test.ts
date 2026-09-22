import { expect, it } from 'vitest';
import { isControllerRelease, compareControllerVersions, releaseCoversHost } from './controller-release.js';
it('binds a stable release to its asset, revision and supported platforms', () => {
  const release = { protocolVersion: '1.5.0', version: '0.2.0', revision: 'a'.repeat(40), sha256: 'b'.repeat(64), asset: 'orchardworks-agent-remote-controller-0.2.0.tgz', nodeMajor: 22, platforms: ['darwin-arm64', 'linux-x64'] };
  expect(isControllerRelease(release)).toBe(true);
  expect(releaseCoversHost({ ...release, protocolVersion: '99.0.0' }, { platform: 'darwin', arch: 'arm64', nodeMajor: 22 })).toBe(false);
  expect(isControllerRelease({ ...release, asset: '../../other.tgz' })).toBe(false);
  expect(isControllerRelease({ ...release, version: '0.2.0-beta' })).toBe(false);
  expect(isControllerRelease({ ...release, sha256: 'oops' })).toBe(false);
  expect(compareControllerVersions('0.10.0', '0.2.9')).toBe(1);
  expect(releaseCoversHost(release, { platform: 'darwin', arch: 'arm64', nodeMajor: 22 })).toBe(true);
  expect(releaseCoversHost(release, { platform: 'win32', arch: 'x64', nodeMajor: 22 })).toBe(false);
  expect(releaseCoversHost(release, { platform: 'linux', arch: 'x64', nodeMajor: 20 })).toBe(false);
});
