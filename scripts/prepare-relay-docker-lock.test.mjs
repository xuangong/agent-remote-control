import assert from 'node:assert/strict';
import { test } from 'node:test';
import { prepareRelayDockerLock } from './prepare-relay-docker-lock.mjs';

const fixture = `lockfileVersion: '9.0'

importers:
  .:
    dependencies:
      '@github/copilot-sdk':
        specifier: 1.0.11
        version: 1.0.11

packages:
  '@github/copilot-linux-arm64@1.0.83':
    resolution: {integrity: native-integrity}
    cpu: [arm64]
    os: [linux]

  '@github/copilot-sdk@1.0.11':
    resolution: {integrity: sdk-integrity}

snapshots:
  '@github/copilot-linux-arm64@1.0.83':
    optional: true

  '@github/copilot-sdk@1.0.11':
    dependencies:
      zod: 4.4.3
    optionalDependencies:
      '@github/copilot-linux-arm64': 1.0.83
      esbuild: 0.25.12
`;

test('omits optional native leaves while preserving SDKs, build tools and lock metadata', { timeout: 1000 }, () => {
  const { content, omitted } = prepareRelayDockerLock(fixture);
  assert.equal(omitted, 1);
  assert.equal(content, `lockfileVersion: '9.0'

importers:
  .:
    dependencies:
      '@github/copilot-sdk':
        specifier: 1.0.11
        version: 1.0.11

packages:
  '@github/copilot-sdk@1.0.11':
    resolution: {integrity: sdk-integrity}

snapshots:
  '@github/copilot-sdk@1.0.11':
    dependencies:
      zod: 4.4.3
    optionalDependencies:
      esbuild: 0.25.12
`);
  assert.deepEqual(prepareRelayDockerLock(content), { content, omitted: 0 });
});

test('rejects required native snapshots instead of silently dropping them', { timeout: 1000 }, () => {
  assert.throws(() => prepareRelayDockerLock(fixture.replace('    optional: true', '    optional: false')), /non-leaf optional/);
});

test('rejects native references outside optional dependencies', { timeout: 1000 }, () => {
  assert.throws(() => prepareRelayDockerLock(fixture.replace('      zod: 4.4.3', "      '@github/copilot-linux-arm64': 1.0.83")), /Unexpected native CLI reference/);
});

test('rejects unsupported lock formats', { timeout: 1000 }, () => {
  assert.throws(() => prepareRelayDockerLock(fixture.replace("'9.0'", "'10.0'")), /format 9.0/);
});
