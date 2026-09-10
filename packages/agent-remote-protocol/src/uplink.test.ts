import { describe, expect, it } from 'vitest';
import * as protocol from './index.js';

describe('Agent Remote uplink codecs', () => {
  it('accepts a v2 Host registration and a target-bound stream', () => {
    const registration = {
      uplinkVersion: 2,
      type: 'register',
      installationId: 'installation-one',
      name: 'Desk DSH',
      providerId: 'dsh',
    } as const;
    const opened = {
      uplinkVersion: 2,
      type: 'stream_open',
      streamId: 'browser-one',
      sessionId: 'remote-session-one',
    } as const;

    expect(protocol.encodeRemoteHostUplinkMessage).toBeTypeOf('function');
    expect(protocol.decodeRemoteHostUplinkMessage(JSON.stringify(registration)))
      .toEqual({ status: 'ok', value: registration });
    expect(protocol.decodeRemoteHostUplinkMessage(JSON.stringify(opened)))
      .toEqual({ status: 'ok', value: opened });
  });

  it('accepts unique provider descriptors and rejects duplicate providers', () => {
    const registration = { uplinkVersion: 2, type: 'register', installationId: 'machine', name: 'Machine', providers: [
      { providerId: 'codex', displayName: 'Codex' }, { providerId: 'example', displayName: 'Example' },
    ] } as const;
    expect(protocol.decodeRemoteHostUplinkMessage(JSON.stringify(registration))).toEqual({ status: 'ok', value: registration });
    expect(protocol.decodeRemoteHostUplinkMessage(JSON.stringify({ ...registration, providers: [registration.providers[0], registration.providers[0]] })).status).toBe('rejected');
    expect(protocol.decodeRemoteHostUplinkMessage(JSON.stringify({ ...registration, providerId: 'dsh' })).status).toBe('rejected');
  });

  it('requires a Remote Session target for Host provider requests', () => {
    const request = {
      uplinkVersion: 2,
      type: 'rpc_request',
      requestId: 'providers-one',
      method: 'GET',
      path: '/v1/providers?protocolVersion=1.4.0',
      sessionId: 'remote-session-one',
    } as const;

    expect(protocol.decodeRemoteHostUplinkMessage(JSON.stringify(request)))
      .toEqual({ status: 'ok', value: request });
    expect(protocol.decodeRemoteHostUplinkMessage(JSON.stringify({ ...request, sessionId: undefined })).status)
      .toBe('rejected');
  });

  it('accepts a target-free catalog query while retaining strict Host route validation', () => {
    const request = {
      uplinkVersion: 2,
      type: 'rpc_request',
      requestId: 'catalog-one',
      method: 'GET',
      path: '/remote/catalog?limit=30',
    } as const;

    expect(protocol.decodeRemoteHostUplinkMessage(JSON.stringify(request)))
      .toEqual({ status: 'ok', value: request });
  });

  it('accepts exact catalog metadata only as a target-free read', () => {
    const request = {
      uplinkVersion: 2,
      type: 'rpc_request',
      requestId: 'metadata-one',
      method: 'GET',
      path: '/remote/catalog/session?nativeSessionId=native%2Fone',
    } as const;

    expect(protocol.decodeRemoteHostUplinkMessage(JSON.stringify(request)))
      .toEqual({ status: 'ok', value: request });
    expect(protocol.encodeRemoteHostUplinkMessage(request))
      .toEqual({ status: 'ok', json: JSON.stringify(request) });
    for (const invalid of [
      { ...request, sessionId: 'remote-session-one' },
      { ...request, body: '{}' },
      { ...request, method: 'POST', body: '{}' },
    ]) {
      expect(protocol.decodeRemoteHostUplinkMessage(JSON.stringify(invalid)).status).toBe('rejected');
    }
  });

  it.each([
    { uplinkVersion: 2, type: 'register', installationId: 'one', name: 'Desk', providerId: 'other' },
    { uplinkVersion: 2, type: 'stream_open', streamId: 'one' },
    { uplinkVersion: 2, type: 'rpc_request', requestId: 'one', method: 'POST', path: '/remote/attach' },
    { uplinkVersion: 1, type: 'register', installationId: 'one', name: 'Desk', providerId: 'dsh' },
  ])('rejects malformed or cross-version v2 Host frames: %j', (value) => {
    expect(protocol.decodeRemoteHostUplinkMessage(JSON.stringify(value)).status).toBe('rejected');
  });

  it('preserves public JSON as an opaque string across transport encoding', () => {
    const message = '{ "seq": 9007199254740993, "text": "hello" }';
    const envelope = { uplinkVersion: 1, type: 'stream_message', streamId: 'browser-one', message } as const;
    expect(protocol.encodeUplinkMessage).toBeTypeOf('function');
    const encoded = protocol.encodeUplinkMessage(envelope);
    expect(encoded.status).toBe('ok');
    if (encoded.status !== 'ok') throw new Error('Encoding failed.');
    expect(protocol.decodeUplinkMessage(encoded.json)).toEqual({ status: 'ok', value: envelope });
  });

  it.each([
    { uplinkVersion: 2, type: 'register', agentId: 'one' },
    { uplinkVersion: 1, type: 'register', agentId: '' },
    { uplinkVersion: 1, type: 'rpc_request', requestId: 'r', method: 'DELETE', path: '/v1/sessions' },
    { uplinkVersion: 1, type: 'rpc_request', requestId: 'r', method: 'GET', path: 'https://other/v1/providers' },
    { uplinkVersion: 1, type: 'rpc_response', requestId: 'r', status: 200.5, body: '{}' },
    { uplinkVersion: 1, type: 'rpc_response', requestId: 'r', status: 100, body: '{}' },
    { uplinkVersion: 1, type: 'stream_close', streamId: 's', code: 1005, reason: 'reserved' },
    { uplinkVersion: 1, type: 'stream_close', streamId: 's', code: 1000, reason: 'é'.repeat(62) },
    { uplinkVersion: 1, type: 'stream_message', streamId: 's', message: {} },
    { uplinkVersion: 1, type: 'stream_open', streamId: 's', agentId: 'other' },
  ])('rejects invalid transport contracts: %j', (value) => {
    expect(protocol.decodeUplinkMessage).toBeTypeOf('function');
    expect(protocol.decodeUplinkMessage(JSON.stringify(value)).status).toBe('rejected');
  });
});
