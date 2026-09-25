import { expect, it } from 'vitest';
import { isHostProviderChange, isHostProviderSettings } from './host-providers.js';
import { decodeRemoteHostUplinkMessage } from './remote-host-uplink.js';
it('validates provider preferences and unique provider snapshots', () => {
  expect(isHostProviderChange({ refresh: true })).toBe(true);
  expect(isHostProviderChange({ providerId: 'codex', enabled: false, revision: 'r' })).toBe(true);
  expect(isHostProviderChange({ providerId: 'codex', enabled: false })).toBe(false);
  const entry = { providerId: 'codex', displayName: 'Codex', state: 'disabled' };
  expect(isHostProviderSettings({ revision: 'r', providers: [entry] })).toBe(true);
  expect(isHostProviderSettings({ revision: 'r', providers: [entry, entry] })).toBe(false);
  const frame = { uplinkVersion: 2, type: 'provider_snapshot', providers: [{ providerId: 'codex', displayName: 'Codex' }] };
  expect(decodeRemoteHostUplinkMessage(JSON.stringify(frame)).status).toBe('ok');
  expect(decodeRemoteHostUplinkMessage(JSON.stringify({ ...frame, providers: [...frame.providers, ...frame.providers] })).status).toBe('rejected');
});
it('accepts only host-scoped provider settings RPCs', () => {
  const frame = { uplinkVersion: 2, type: 'rpc_request', requestId: 'r', method: 'GET', path: '/remote/provider-settings' };
  expect(decodeRemoteHostUplinkMessage(JSON.stringify(frame)).status).toBe('ok');
  for (const invalid of [{ ...frame, sessionId: 'session' }, { ...frame, path: frame.path + '?x=y' }, { ...frame, method: 'POST' }]) {
    expect(decodeRemoteHostUplinkMessage(JSON.stringify(invalid)).status).toBe('rejected');
  }
});
