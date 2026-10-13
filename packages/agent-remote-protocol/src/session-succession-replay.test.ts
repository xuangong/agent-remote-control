import { expect, test } from 'vitest';
import { decodeSessionChannelServerMessage, encodeSessionChannelServerMessage } from './codec.js';

const ref = (nativeSessionId: string) => ({ controllerId: 'installation', providerId: 'fixture', nativeSessionId });
const workspace = { controllerId: 'installation', canonicalCwd: '/workspace' };
const request = { operationId: 'op', roleId: 'role', expectedRevision: 1, from: ref('A') };
const projection = { version: 1, role: { id: 'role', revision: 2, origin: ref('A'), current: ref('B'), workspace },
  receipt: { ...request, to: ref('B'), phase: 'committed', committedRevision: 2, startedAt: 'now', updatedAt: 'now',
    prepared: { ...request, to: ref('B'), workspace, associationRevision: 1, participants: [], capture: { epoch: 'e', seq: 1, capturedAt: 'now' } } } };
const succession = { version: 1, projection, from: { hostId: 'mapped-host', providerId: 'fixture', nativeSessionId: 'A' },
  to: { hostId: 'mapped-host', providerId: 'fixture', nativeSessionId: 'B' } };
const frame = { protocolVersion: '1.8.0', type: 'session_succession_committed', succession };

test('decodes a cold committed successor locator independently of prompt-edit migration', () => {
  const decoded = decodeSessionChannelServerMessage(JSON.stringify(frame));
  expect(decoded.status).toBe('ok');
  if (decoded.status === 'ok') expect(encodeSessionChannelServerMessage(decoded.value)).toEqual({ status: 'ok', json: JSON.stringify(frame) });
});
test('rejects forged projection semantics, mismatched locators and extra fields', () => {
  for (const bad of [
    { ...succession, projection: { ...projection, role: { ...projection.role, revision: 3 } } },
    { ...succession, to: { ...succession.to, nativeSessionId: 'A' } },
    { ...succession, agentId: 'invented' },
  ]) expect(decodeSessionChannelServerMessage(JSON.stringify({ ...frame, succession: bad })).status).toBe('rejected');
});
test('accepts old readiness and explicit succession readiness without relaxing strictness', () => {
  expect(decodeSessionChannelServerMessage('{"protocolVersion":"1.8.0","type":"ready"}').status).toBe('ok');
  expect(decodeSessionChannelServerMessage('{"protocolVersion":"1.8.0","type":"ready","successions":1}').status).toBe('ok');
  expect(decodeSessionChannelServerMessage('{"protocolVersion":"1.8.0","type":"ready","successions":2}').status).toBe('rejected');
});
