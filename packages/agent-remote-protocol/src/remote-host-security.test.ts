import { expect, it } from 'vitest';
import { decodeRemoteHostUplinkMessage } from './remote-host-uplink.js';

it('accepts an enrollment-only Host without advertising native providers', () => {
  const message = { uplinkVersion: 2, type: 'register', installationId: 'docker-enrollment', name: 'Docker Host', credentialRotation: true, providers: [] };
  expect(decodeRemoteHostUplinkMessage(JSON.stringify(message))).toEqual({ status: 'ok', value: message });
}, 10000);

it('accepts optional durable credential exchange while preserving legacy registration', () => {
  for (const message of [
    { type: 'register', installationId: 'i', name: 'Host', providers: [{ providerId: 'codex', displayName: 'Codex' }] },
    { type: 'register', installationId: 'i', name: 'Host', providers: [{ providerId: 'codex', displayName: 'Codex' }], credentialRotation: true },
    { type: 'credential_issued', credential: 'durable-secret' }, { type: 'credential_saved' },
    { type: 'rpc_request', requestId: 'stop', method: 'POST', path: '/remote/stop', body: '{}' },
  ]) expect(decodeRemoteHostUplinkMessage(JSON.stringify({ uplinkVersion: 2, ...message })).status).toBe('ok');
  for (const message of [
    { type: 'credential_issued', credential: '' }, { type: 'credential_issued', credential: 'bad\nheader' },
    { type: 'credential_saved', credential: 'leaked' },
    { type: 'rpc_request', requestId: 'stop', method: 'GET', path: '/remote/stop' },
    { type: 'rpc_request', requestId: 'stop', method: 'POST', path: '/remote/stop', body: '{}', sessionId: 'other' },
  ]) expect(decodeRemoteHostUplinkMessage(JSON.stringify({ uplinkVersion: 2, ...message })).status).toBe('rejected');
});
