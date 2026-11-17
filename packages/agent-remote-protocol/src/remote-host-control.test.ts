import { expect, it } from 'vitest';
import { decodeRemoteHostUplinkMessage } from './index.js';

it('carries the session-control acknowledgement on the registration answer, and nowhere else', () => {
  const registered = { uplinkVersion: 2, type: 'registered', hostId: 'host', heartbeat: { intervalMs: 30_000, timeoutMs: 10_000 }, pairingPurpose: 'host-only' };
  const decode = (value: object) => decodeRemoteHostUplinkMessage(JSON.stringify(value)).status;
  expect(decode(registered)).toBe('ok');
  expect(decode({ ...registered, control: 1 })).toBe('ok');
  expect(decode({ ...registered, control: 2 })).not.toBe('ok');
  expect(decode({ ...registered, control: true })).not.toBe('ok');
});
