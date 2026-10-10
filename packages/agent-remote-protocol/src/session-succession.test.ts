import { expect, test } from 'vitest';
import { isPrimaryRole, isPreparedSuccession, isSuccessionRequest } from './session-succession.js';

const source = { controllerId: 'host', providerId: 'codex', nativeSessionId: 'A' };
const workspace = { controllerId: 'host', canonicalCwd: '/workspace' };

test('accepts complete role identities without treating placement as identity', () => {
  expect(isPrimaryRole({ id: 'role', revision: 1, origin: source, current: source, workspace })).toBe(true);
  expect(isPrimaryRole({ id: 'role', revision: 1, origin: source,
    current: { ...source, controllerId: 'future-host' }, workspace: { ...workspace, controllerId: 'future-host' } })).toBe(true);
});

test.each([0, -1, 1.5, Number.MAX_SAFE_INTEGER + 1])('rejects an unsafe expected revision %s', revision => {
  expect(isSuccessionRequest({ operationId: 'op', roleId: 'role', expectedRevision: revision, from: source })).toBe(false);
});

test('rejects unknown fields and incomplete participant identities', () => {
  const prepared = { operationId: 'op', roleId: 'role', expectedRevision: 1, associationRevision: 0,
    from: source, to: { ...source, nativeSessionId: 'B' }, workspace, participants: [],
    capture: { epoch: 'epoch', seq: 4, capturedAt: '2026-10-10T00:00:00.000Z' } };
  expect(isPreparedSuccession(prepared)).toBe(true);
  expect(isPreparedSuccession({ ...prepared, trusted: true })).toBe(false);
  expect(isPreparedSuccession({ ...prepared, participants: [{ relationId: 'ask', kind: 'ask', before: source, after: { nativeSessionId: 'Q' } }] })).toBe(false);
  expect(isSuccessionRequest({ operationId: 'op', roleId: 'role', expectedRevision: 1, from: source, ready: true })).toBe(false);
});
