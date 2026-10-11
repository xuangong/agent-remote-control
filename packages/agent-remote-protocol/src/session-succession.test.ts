import { expect, test } from 'vitest';
import { isPrimaryRole, isPreparedSuccession, isSuccessionRequest, isSuccessionDescription, isSuccessionActionResult } from './session-succession.js';

const source = { controllerId: 'host', providerId: 'codex', nativeSessionId: 'A' };
const workspace = { controllerId: 'host', canonicalCwd: '/workspace' };
const role = { id: 'role', revision: 1, origin: source, current: source, workspace };

test('strict public handoff descriptions separate availability from current target identity', () => {
  const description = { role, targets: [{ providerId: 'codex', displayName: 'Codex' }], eligibility: { status: 'ready' } };
  expect(isSuccessionDescription(description)).toBe(true);
  expect(isSuccessionDescription({ ...description, eligibility: { status: 'blocked', code: 'working', reason: 'Wait for the active turn.' } })).toBe(true);
  expect(isSuccessionDescription({ ...description, eligibility: { status: 'unavailable', code: 'missing', reason: 'Native evidence is unavailable.' } })).toBe(true);
  for (const value of [{ ...description, freeze: {} }, { ...description, role: { ...role, revision: 0 } },
    { ...description, targets: [{ providerId: 'codex', displayName: 'Codex', ready: true }] },
    { ...description, eligibility: { status: 'blocked' } }, { ...description, eligibility: { status: 'ready', reserved: true } }]) expect(isSuccessionDescription(value)).toBe(false);
});

test('strict public action results retain the original receipt and optional resolved locator', () => {
  const record = { operationId: 'op', roleId: 'role', expectedRevision: 1, from: source, phase: 'preparing', startedAt: 'now', updatedAt: 'now' };
  const result = { record, role };
  expect(isSuccessionActionResult(result)).toBe(true);
  expect(isSuccessionActionResult({ ...result, locator: { hostId: 'public-host', providerId: 'codex', nativeSessionId: 'B' } })).toBe(true);
  expect(isSuccessionActionResult({ ...result, locator: { nativeSessionId: 'B' } })).toBe(false);
  expect(isSuccessionActionResult({ ...result, freeze: {} })).toBe(false);
});

test('context status is strictly bound to the committed operation and native successor', () => {
  const target = { ...source, nativeSessionId: 'B' };
  const record = { operationId: 'op', roleId: 'role', expectedRevision: 1, from: source, to: target, phase: 'committed', committedRevision: 2, startedAt: 'now', updatedAt: 'now' };
  const result = { record, role: { ...role, current: target, revision: 2 }, context: { operationId: 'op', target, state: 'pending' } };
  expect(isSuccessionActionResult(result)).toBe(true);
  for (const state of ['dispatching', 'accepted', 'unknown', 'materialized']) expect(isSuccessionActionResult({ ...result, context: { ...result.context, state } })).toBe(true);
  for (const context of [{ ...result.context, operationId: 'other' }, { ...result.context, target: source }, { ...result.context, state: 'ready' }, { ...result.context, text: 'private history' }]) {
    expect(isSuccessionActionResult({ ...result, context })).toBe(false);
  }
  expect(isSuccessionActionResult({ ...result, record: { ...record, phase: 'ready' } })).toBe(false);
});

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
