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

test('native prefix selection is bounded, same-provider, and semantically bound to prepared receipts', async () => {
  const { isSuccessionRecord, isCommittedSuccessionProjection } = await import('./session-succession.js');
  const request = { operationId: 'op', roleId: 'role', expectedRevision: 1, from: source, preparation: { kind: 'native_prefix', turnId: 'turn', messageId: 'message' } };
  expect(isSuccessionRequest(request)).toBe(true);
  for (const value of [{ ...request, targetProviderId: 'other' }, { ...request, preparation: { ...request.preparation, messageId: '' } }, { ...request, preparation: { ...request.preparation, turnId: 'x'.repeat(513) } }]) expect(isSuccessionRequest(value)).toBe(false);
  const to = { ...source, nativeSessionId: 'B' };
  const prepared = { ...request, to, workspace, associationRevision: 0, participants: [], capture: { epoch: 'e', seq: 1, capturedAt: 'now' } };
  const receipt = { ...request, to, phase: 'committed', committedRevision: 2, prepared, startedAt: 'now', updatedAt: 'now' };
  const projection = { version: 1, role: { ...role, revision: 2, current: to }, receipt };
  expect(isCommittedSuccessionProjection(projection)).toBe(true);
  expect(isSuccessionRecord({ ...receipt, targetProviderId: 'other' })).toBe(false);
  expect(isCommittedSuccessionProjection({ ...projection, receipt: { ...receipt, prepared: { ...prepared, preparation: { ...request.preparation, messageId: 'other' } } } })).toBe(false);
});


function committedEdge(from: string, to: string, revision: number, prefix = true) {
  const request = { operationId: `op-${revision}`, roleId: 'role', expectedRevision: revision, from: { ...source, nativeSessionId: from },
    ...(prefix ? { preparation: { kind: 'native_prefix' as const, turnId: 'turn', messageId: 'message' } } : {}) };
  return { ...request, to: { ...source, nativeSessionId: to }, phase: 'committed' as const, committedRevision: revision + 1, startedAt: 'now', updatedAt: 'now',
    prepared: { ...request, to: { ...source, nativeSessionId: to }, workspace, associationRevision: 0, participants: [], capture: { epoch: 'epoch', seq: 4, capturedAt: 'now' } } };
}
test('native prefix routing follows only complete exact committed chains and returns inclusive ancestry', async () => {
  const api = await import('./session-succession.js');
  expect(api.resolveNativePrefix).toBeTypeOf('function');
  const a = committedEdge('A', 'B', 1), b = committedEdge('B', 'C', 2);
  expect(api.resolveNativePrefix(source, [b, a])).toEqual({ anchor: source, target: b.to, operationIds: ['op-1', 'op-2'] });
  expect(api.resolveNativePrefix(b.to, [a, b])).toEqual({ anchor: b.to, target: b.to, operationIds: [] });
  expect(api.nativePrefixAncestors(b.to, [b, a])).toEqual([source, a.to, b.to]);
  expect(api.resolveNativePrefix(source, [])).toEqual({ anchor: source, target: source, operationIds: [] });
  for (const records of [[b], [a, a], [a, committedEdge('B', 'A', 2)], [a, committedEdge('A', 'C', 2)],
    [a, { ...committedEdge('B', 'C', 2), phase: 'ready' }], [a, { ...b, preparation: undefined }],
    [a, { ...b, from: { ...b.from, controllerId: 'foreign' } }], [a, { ...committedEdge('X', 'B', 1), operationId: 'other', roleId: 'other' }]]) {
    expect(() => api.resolveNativePrefix(source, records as never)).toThrow();
  }
  const owned = committedEdge('X', 'B', 1); owned.roleId = 'other'; owned.operationId = 'other'; owned.prepared.roleId = 'other'; owned.prepared.operationId = 'other';
  expect(() => api.resolveNativePrefix(source, [a, owned])).toThrow();
  expect(() => api.resolveNativePrefix(source, [a, committedEdge('B', 'C', 2, false)])).toThrow(/unavailable/i);
  expect(() => api.nativePrefixAncestors(b.to, [a, committedEdge('B', 'C', 2, false)])).toThrow(/unavailable/i);
});
