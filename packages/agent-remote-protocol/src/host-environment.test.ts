import { expect, it } from 'vitest';
import { decodeRemoteHostUplinkMessage, encodeRemoteHostUplinkMessage } from './remote-host-uplink.js';
const registration = { uplinkVersion: 2, type: 'register', installationId: 'host', name: 'Host', providers: [] };
const environment = { detectedAt: 1234, os: { platform: 'linux', name: 'Ubuntu', arch: 'x64', release: '6.8' },
  wsl: false, container: true, shell: { name: 'bash', source: 'account' }, shells: [], browsers: [{ id: 'chromium', name: 'Chromium', status: 'found' }], vscode: { status: 'not-found' } };
it('round trips optional environment descriptions while accepting existing Hosts', () => {
  expect(decodeRemoteHostUplinkMessage(JSON.stringify(registration)).status).toBe('ok');
  const decoded = decodeRemoteHostUplinkMessage(JSON.stringify({ ...registration, environment }));
  expect(decoded.status).toBe('ok');
  if (decoded.status === 'ok') expect(encodeRemoteHostUplinkMessage(decoded.value)).toEqual({ status: 'ok', json: JSON.stringify({ ...registration, environment }) });
});
it('rejects unbounded, malformed and unexpected environment fields', () => {
  for (const invalid of [{ ...environment, env: { SECRET: 'no' } }, { ...environment, browsers: Array(65).fill(environment.browsers[0]) },
    { ...environment, vscode: { status: 'available' } }, { ...environment, detectedAt: -1 }]) {
    expect(decodeRemoteHostUplinkMessage(JSON.stringify({ ...registration, environment: invalid })).status).toBe('rejected');
  }
});
