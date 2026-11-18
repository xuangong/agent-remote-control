import { describe, expect, it } from 'vitest';
import { buildRoleEvidence } from '../testing/succession.js';
import { committedRefreshOf, handoffOutcome, restoredSourceOf, settlementOf, type RoleProgress, type SettlementObservation } from './settlement.js';

const observation = (over: Partial<SettlementObservation> = {}): SettlementObservation => ({
  live: true, target: { hostId: 'host', providerId: 'recorded', nativeSessionId: 'B' }, related: true, discovering: false,
  layoutApplied: true, nativeSettled: true, callerSettled: true, mustRemain: false, ...over,
});

describe('settlementOf', () => {
  it.each<[string, Partial<SettlementObservation>, ReturnType<typeof settlementOf>]>([
    ['a bound, synchronized native session for the wanted target', {}, { status: 'settled' }],
    ['workspace authority lost', { live: false }, { status: 'failed', message: 'Workspace access changed while refreshing this Handoff.' }],
    ['authority lost, even when everything else settled', { live: false, nativeSettled: true }, { status: 'failed', message: 'Workspace access changed while refreshing this Handoff.' }],
    ['navigation left the conversation', { target: undefined }, { status: 'settled' }],
    ['the wanted session belongs to another conversation', { related: false }, { status: 'settled' }],
    ['navigation left while the caller must stay', { target: undefined, mustRemain: true }, { status: 'failed', message: 'Session navigation changed before native restoration was confirmed.' }],
    ['another conversation while the caller must stay', { related: false, mustRemain: true }, { status: 'failed', message: 'Session navigation changed before native restoration was confirmed.' }],
    ['a discovery still running', { discovering: true }, { status: 'waiting' }],
    ['a discovery running with an error shown', { discovering: true, error: 'old' }, { status: 'waiting' }],
    ['an error shown', { error: 'The session could not be opened.' }, { status: 'failed', message: 'The session could not be opened.' }],
    ['a layout that is not applied', { layoutApplied: false }, { status: 'failed', message: 'The conversation layout still needs synchronization.' }],
    ['an error and an unapplied layout', { error: 'first', layoutApplied: false }, { status: 'failed', message: 'first' }],
    ['a native session that is not yet synchronized', { nativeSettled: false }, { status: 'waiting' }],
    ['a caller condition that does not hold yet', { callerSettled: false }, { status: 'waiting' }],
  ])('for %s', (_name, over, expected) => {
    expect(settlementOf(observation(over))).toEqual(expected);
  });
});

const roles = (over: Partial<RoleProgress> = {}): RoleProgress[] => [{ key: 'role-key', appliedRevision: 3, committedRevision: 3, operationId: 'primary-op-3', ...over }];
const evidenceFor = (key = 'role-key') => new Map([[key, buildRoleEvidence(['A', 'B', 'C'])]]);

describe('committedRefreshOf', () => {
  it('confirms an operation that exactly one role holds once the role applied the committed revision', () => {
    const result = committedRefreshOf({ operationId: 'primary-op-2', evidence: evidenceFor(), roles: roles() });
    expect(result).toMatchObject({ status: 'confirmed', roleKey: 'role-key' });
  });
  it.each([
    ['an operation no role holds', 'unknown-op', evidenceFor(), roles(), undefined, 'The committed Handoff could not be verified. Refresh its current role again.'],
    ['an operation two roles hold', 'primary-op-2', new Map([['one', buildRoleEvidence(['A', 'B', 'C'])], ['two', buildRoleEvidence(['A', 'B', 'C'])]]), roles(), undefined, 'The committed Handoff could not be verified. Refresh its current role again.'],
    ['a role with no local checkpoint', 'primary-op-2', evidenceFor(), [], undefined, 'The committed Handoff still needs local synchronization.'],
    ['a checkpoint that applied an older revision', 'primary-op-2', evidenceFor(), roles({ appliedRevision: 2 }), undefined, 'The committed Handoff still needs local synchronization.'],
    ['a checkpoint that committed an older revision', 'primary-op-2', evidenceFor(), roles({ committedRevision: 2 }), undefined, 'The committed Handoff still needs local synchronization.'],
    ['the error already on screen', 'unknown-op', evidenceFor(), roles(), 'Replay denied.', 'Replay denied.'],
    ['the error already on screen over a missing checkpoint', 'primary-op-2', evidenceFor(), [], 'Replay denied.', 'Replay denied.'],
  ])('refuses %s', (_name, operationId, evidence, progress, shown, message) => {
    expect(committedRefreshOf({ operationId, evidence, roles: progress, shown })).toEqual({ status: 'failed', message });
  });
  it('accepts an older committed operation of the role, not only the newest', () => {
    expect(committedRefreshOf({ operationId: 'primary-op-3', evidence: evidenceFor(), roles: roles() }).status).toBe('confirmed');
  });
});

describe('handoffOutcome', () => {
  const from = { controllerId: 'installation', providerId: 'recorded', nativeSessionId: 'A' };
  const source = { hostId: 'host', providerId: 'recorded', nativeSessionId: 'A' };
  it.each([
    ['committed', 'committed', source, 'committed'],
    ['committed from another source', 'committed', { ...source, nativeSessionId: 'Z' }, 'committed'],
    ['cancelled from the source', 'cancelled', source, 'restore_source'],
    ['rejected from the source', 'rejected', source, 'restore_source'],
    ['cancelled from another source', 'cancelled', { ...source, nativeSessionId: 'Z' }, 'unconfirmed'],
    ['cancelled on another Host', 'cancelled', { ...source, hostId: 'elsewhere' }, 'restore_source'],
    ['still prepared', 'prepared', source, 'unconfirmed'],
    ['unknown phase', 'surprise', source, 'unconfirmed'],
  ])('reads %s', (_name, phase, session, expected) => {
    expect(handoffOutcome(phase, from, session)).toBe(expected);
  });
});

describe('restoredSourceOf', () => {
  const a = { controllerId: 'installation', providerId: 'recorded', nativeSessionId: 'A' };
  const b = { ...a, nativeSessionId: 'B' };
  it.each([
    ['the role still points at the original', a, a, false, 'settled'],
    ['the role moved and the refresh read its evidence', b, a, true, 'settled'],
    ['the role moved and nothing was read', b, a, false, 'failed'],
    ['the role is the original and evidence exists', a, a, true, 'settled'],
  ])('when %s', (_name, roleCurrent, recordFrom, hasEvidence, status) => {
    expect(restoredSourceOf({ roleCurrent, recordFrom, hasEvidence }).status).toBe(status);
  });
});
