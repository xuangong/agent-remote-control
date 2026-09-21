import { describe, expect, it } from 'vitest';
import { decodeRemoteHostUplinkMessage, encodeRemoteHostUplinkMessage } from './remote-host-uplink.js';

describe('Remote Host heartbeat envelopes', () => {
  it.each([
    { uplinkVersion: 2, type: 'registered', hostId: 'host', heartbeat: { intervalMs: 30000, timeoutMs: 10000 } },
    { uplinkVersion: 2, type: 'heartbeat', nonce: 'challenge' },
    { uplinkVersion: 2, type: 'heartbeat_ack', nonce: 'challenge' },
  ])('round trips heartbeat envelopes: %j', value => {
    const decoded = decodeRemoteHostUplinkMessage(JSON.stringify(value));
    expect(decoded).toEqual({ status: 'ok', value });
    if (decoded.status === 'ok') expect(encodeRemoteHostUplinkMessage(decoded.value)).toEqual({ status: 'ok', json: JSON.stringify(value) });
  });

  it.each(['host-only', 'gateway-setup'])('round trips the authorized %s pairing purpose', pairingPurpose => {
    const value = { uplinkVersion: 2, type: 'registered', hostId: 'host', pairingPurpose, heartbeat: { intervalMs: 30000, timeoutMs: 10000 } };
    expect(decodeRemoteHostUplinkMessage(JSON.stringify(value))).toEqual({ status: 'ok', value });
  });

  it.each(['codex', 'admin', '', null])('rejects an invalid pairing purpose: %j', pairingPurpose => {
    expect(decodeRemoteHostUplinkMessage(JSON.stringify({ uplinkVersion: 2, type: 'registered', hostId: 'host', pairingPurpose,
      heartbeat: { intervalMs: 30000, timeoutMs: 10000 } })).status).toBe('rejected');
  });

  it('requires heartbeat timing in registration acknowledgements', () => {
    expect(decodeRemoteHostUplinkMessage(JSON.stringify({ uplinkVersion: 2, type: 'registered', hostId: 'host' })).status).toBe('rejected');
  });

  it.each([
    { intervalMs: 0, timeoutMs: 1 }, { intervalMs: 100, timeoutMs: 0 },
    { intervalMs: 10, timeoutMs: 10 }, { intervalMs: 10, timeoutMs: 11 },
    { intervalMs: 600001, timeoutMs: 10 }, { intervalMs: 100, timeoutMs: 1.5 },
    { intervalMs: 100, timeoutMs: 10, extra: true },
  ])('rejects unsafe heartbeat deadlines: %j', heartbeat => {
    expect(decodeRemoteHostUplinkMessage(JSON.stringify({ uplinkVersion: 2, type: 'registered', hostId: 'host', heartbeat })).status).toBe('rejected');
  });

  it.each(['heartbeat', 'heartbeat_ack'])('bounds the %s challenge identity', type => {
    for (const nonce of ['', 'x'.repeat(129), 1]) {
      expect(decodeRemoteHostUplinkMessage(JSON.stringify({ uplinkVersion: 2, type, nonce })).status).toBe('rejected');
    }
    expect(decodeRemoteHostUplinkMessage(JSON.stringify({ uplinkVersion: 2, type, nonce: 'x'.repeat(128) })).status).toBe('ok');
  });
});
