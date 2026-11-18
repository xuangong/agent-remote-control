import { describe, expect, it } from 'vitest';

import { createBrokerState, type BrokerState } from './broker-state.js';
import type { Host, RemoteHostBrokerState } from './broker-types.js';
import { sequentialRelayIds } from './relay-ids.js';
import { createSuccession } from './succession-service.js';

const authority = { version: 1 as const, origin: 'https://relay.example', issuer: 'https://issuer.example', namespace: 'tenant', ownerSubject: 'owner' };
const ref = (nativeSessionId: string) => ({ controllerId: 'installation', providerId: 'codex', nativeSessionId });
const emptyAssociations = () => ({ version: 6 as const, revision: 0, admissions: [], freezes: [], relationChanges: [], relationResets: [] });
const host = (extra: Partial<Host> = {}): Host => ({ id: 'h1', installationId: 'installation', name: 'Host', providers: [{ providerId: 'codex', displayName: 'Codex' }], legacyDsh: false, generation: 1,
  pending: new Map(), streams: new Map(), successionEnrollmentVersion: 3, ...extra });

function setup(options: { associations?: ReturnType<typeof emptyAssociations>; rpc?: (input: Record<string, unknown>) => { status: number; body: unknown }; allowance?: number; enrolled?: boolean } = {}) {
  const saves: RemoteHostBrokerState[] = [];
  const initialState: RemoteHostBrokerState = { keys: [], hosts: [], bindings: [], creations: [], associations: emptyAssociations() };
  const state: BrokerState = createBrokerState({ initialState, now: () => 0, onStateChange: next => { saves.push(next); }, keepsAssociations: true, keepsSharing: false });
  // Guard tests start from records the Relay only reaches through a succession, so they are set directly.
  if (options.associations) state.associations = options.associations;
  const subject = host();
  state.hosts.set(subject.id, subject);
  const calls: Array<Record<string, unknown>> = [];
  const succession = createSuccession({
    brokerState: state, enrollment: options.enrolled === false ? undefined : authority, ids: sequentialRelayIds(),
    projectionAllowance: options.allowance === undefined ? undefined : () => options.allowance!,
    rpc: async (_host, _method, _path, _session, body) => {
      const input = JSON.parse(body!) as Record<string, unknown>; calls.push(input);
      const answer = options.rpc?.(input) ?? { status: 500, body: {} };
      return { status: answer.status, body: JSON.stringify(answer.body) };
    },
    teams: { assertReplacementSupported: () => undefined, hasUnsettledRecipient: () => false }, creations: { has: () => false },
  });
  return { state, saves, succession, host: subject, calls };
}

describe('succession guards', () => {
  it('refuses a source that a pending relation change or an unreleased freeze holds, and allows it again once they end', () => {
    const pending = { reservation: { lineage: [ref('A')] }, phase: 'reserved' };
    const run = setup({ associations: { ...emptyAssociations(), relationChanges: [pending as never] } });
    expect(() => run.succession.assertOpen(ref('A'))).toThrow(expect.objectContaining({ status: 409, code: 'relation_change_pending' }));
    expect(() => run.succession.assertOpen(ref('B'))).not.toThrow();
    pending.phase = 'committed';
    expect(() => run.succession.assertOpen(ref('A'))).not.toThrow();
    const frozen = setup({ associations: { ...emptyAssociations(), freezes: [{ hostId: 'h1', receipt: { lineage: [ref('A')] } } as never] } });
    expect(() => frozen.succession.assertOpen(ref('A'))).toThrow(expect.objectContaining({ code: 'succession_associations_frozen' }));
    frozen.state.associations.freezes[0]!.released = 'committed';
    expect(() => frozen.succession.assertOpen(ref('A'))).not.toThrow();
  });

  it('refuses relationship updates on a role whose succession has a trusted projection', () => {
    const projected = { hostId: 'h1', released: 'committed', receipt: { lineage: [ref('A')] }, projection: { role: { current: ref('B') } } };
    const run = setup({ associations: { ...emptyAssociations(), freezes: [projected as never] } });
    expect(() => run.succession.assertMutable(ref('B'))).toThrow(expect.objectContaining({ code: 'succession_relationship_updates_unavailable' }));
    expect(() => run.succession.assertMutable(ref('A'))).toThrow(expect.objectContaining({ code: 'succession_relationship_updates_unavailable' }));
    expect(() => run.succession.assertMutable(ref('Z'))).not.toThrow();
  });

  it('refuses to create from a session that a later succession superseded, as a rejected creation', () => {
    const projected = { hostId: 'h1', released: 'committed', receipt: { lineage: [ref('A')] }, projection: { role: { current: ref('B') } } };
    const run = setup({ associations: { ...emptyAssociations(), freezes: [projected as never] } });
    expect(() => run.succession.assertCreationOpen(ref('A'))).toThrow(expect.objectContaining({ status: 409, code: 'session_superseded', creationRejected: true }));
    expect(() => run.succession.assertCreationOpen(ref('B'))).not.toThrow();
  });
});

describe('succession associations change', () => {
  it('saves the changed records with the next revision, and saves nothing for a change that leaves them equal', async () => {
    const run = setup();
    await run.succession.change(state => { state.admissions.push({ id: 'a1', fingerprint: 'f', source: ref('A') }); });
    expect(run.saves).toHaveLength(1);
    expect(run.saves[0]!.associations).toMatchObject({ revision: 1, admissions: [{ id: 'a1' }] });
    expect(run.state.associations.revision).toBe(1);
    await run.succession.change(() => undefined);
    expect(run.saves).toHaveLength(1);
  });

  it('refuses a change when no revision is left, before anything is saved', async () => {
    const run = setup({ associations: { ...emptyAssociations(), revision: Number.MAX_SAFE_INTEGER } });
    await expect(run.succession.change(state => { state.admissions.push({ id: 'a1', fingerprint: 'f', source: ref('A') }); })).rejects.toMatchObject({ status: 409, code: 'association_capacity' });
    expect(run.saves).toHaveLength(0);
  });
});

describe('succession action', () => {
  it('refuses every action when enrollment was not negotiated on both sides', async () => {
    const withoutRelay = setup({ enrolled: false });
    await expect(withoutRelay.succession.action(withoutRelay.host, 'describe', { providerId: 'codex', nativeSessionId: 'A' })).rejects.toMatchObject({ status: 409, code: 'succession_enrollment_unavailable' });
    const withoutHost = setup();
    withoutHost.host.successionEnrollmentVersion = undefined;
    await expect(withoutHost.succession.action(withoutHost.host, 'status', { operationId: 'op' })).rejects.toMatchObject({ code: 'succession_enrollment_unavailable' });
  });

  it('describes a source through the Controller, and marks new handoffs unavailable without a projection allowance', async () => {
    const answer = { role: { id: 'role', revision: 1, origin: ref('A'), current: ref('A'), workspace: { controllerId: 'installation', canonicalCwd: '/w' } }, targets: [], eligibility: { status: 'ready' } };
    const run = setup({ rpc: () => ({ status: 200, body: answer }) });
    const result = await run.succession.action(run.host, 'describe', { providerId: 'codex', nativeSessionId: 'A' });
    expect(run.calls).toEqual([{ action: 'describe', providerId: 'codex', nativeSessionId: 'A' }]);
    expect(result).toMatchObject({ role: { id: 'role' }, eligibility: { status: 'unavailable', code: 'succession_preparation_unavailable' } });
    const allowed = setup({ allowance: 1000, rpc: () => ({ status: 200, body: answer }) });
    expect(await allowed.succession.action(allowed.host, 'describe', { providerId: 'codex', nativeSessionId: 'A' })).toMatchObject({ eligibility: { status: 'ready' } });
  });

  it('rejects a description of another Controller and input beyond the source selection', async () => {
    const foreign = { role: { id: 'role', revision: 1, origin: ref('A'), current: { ...ref('A'), controllerId: 'other' }, workspace: { controllerId: 'other', canonicalCwd: '/w' } }, targets: [], eligibility: { status: 'ready' } };
    const run = setup({ rpc: () => ({ status: 200, body: foreign }) });
    await expect(run.succession.action(run.host, 'describe', { providerId: 'codex', nativeSessionId: 'A' })).rejects.toMatchObject({ status: 502, code: 'invalid_host_response' });
    await expect(run.succession.action(run.host, 'describe', { providerId: 'codex', nativeSessionId: 'A', extra: 1 })).rejects.toMatchObject({ status: 400, code: 'invalid_succession_request' });
  });

  it('knows no operation that was never frozen, and requires an operation identity', async () => {
    const run = setup();
    await expect(run.succession.action(run.host, 'status', { operationId: 'missing' })).rejects.toMatchObject({ status: 404, code: 'succession_not_found' });
    await expect(run.succession.action(run.host, 'status', {})).rejects.toMatchObject({ status: 400, code: 'invalid_request' });
    expect(run.calls).toEqual([]);
  });

  it('saves the freeze of a new operation before the Controller is asked to prepare it', async () => {
    const lineage = [ref('A')];
    const role = { id: 'role', revision: 1, origin: ref('A'), current: ref('A'), workspace: { controllerId: 'installation', canonicalCwd: '/w' } };
    const run = setup({ allowance: 4096, rpc: input => input.action === 'describe' ? { status: 200, body: { role, lineage } } : { status: 503, body: { code: 'host_busy', error: 'Busy.' } } });
    await expect(run.succession.action(run.host, 'prepare', { operationId: 'op-1', providerId: 'codex', nativeSessionId: 'A', expectedRevision: 1 })).rejects.toMatchObject({ status: 503, code: 'host_busy' });
    expect(run.calls.map(call => call.action)).toEqual(['describe', 'prepare']);
    expect(run.state.associations.freezes).toHaveLength(1);
    expect(run.state.associations.freezes[0]).toMatchObject({ hostId: 'h1', receipt: { version: 2, maxProjectionBytes: 4096, token: expect.stringContaining('00000000-0000-4000-8000'),
      request: { operationId: 'op-1', roleId: 'role', expectedRevision: 1, from: ref('A') }, lineage } });
    expect(run.saves.at(-1)!.associations!.freezes).toHaveLength(1);
  });

  it('refuses to prepare when the Controller describes another revision than the caller expected', async () => {
    const role = { id: 'role', revision: 2, origin: ref('A'), current: ref('B'), workspace: { controllerId: 'installation', canonicalCwd: '/w' } };
    const run = setup({ allowance: 4096, rpc: () => ({ status: 200, body: { role, lineage: [ref('A'), ref('B')] } }) });
    await expect(run.succession.action(run.host, 'prepare', { operationId: 'op-1', providerId: 'codex', nativeSessionId: 'A', expectedRevision: 1 })).rejects.toMatchObject({ status: 409, code: 'invalid_host_response' });
    expect(run.state.associations.freezes).toEqual([]);
  });

  const savedFreeze = (extra: Record<string, unknown> = {}) => ({ hostId: 'h1', receipt: { version: 2, token: 't', authority, controllerId: 'installation', maxProjectionBytes: 1000,
    request: { operationId: 'op-1', roleId: 'role', expectedRevision: 1, from: ref('A') }, associationRevision: 0, lineage: [ref('A')], relations: [], ...extra } });

  it('refuses a saved operation whose authority is no longer the Relay\'s, and one that needs a newer enrollment than the Host negotiated', async () => {
    const changed = setup({ associations: { ...emptyAssociations(), freezes: [savedFreeze({ authority: { ...authority, namespace: 'other tenant' } }) as never] } });
    await expect(changed.succession.action(changed.host, 'status', { operationId: 'op-1' })).rejects.toMatchObject({ status: 409, code: 'succession_authority_changed' });
    const newer = setup({ associations: { ...emptyAssociations(), freezes: [savedFreeze({ version: 3 }) as never] } });
    newer.host.successionEnrollmentVersion = 2;
    await expect(newer.succession.action(newer.host, 'status', { operationId: 'op-1' })).rejects.toMatchObject({ code: 'succession_enrollment_unavailable' });
    expect(changed.calls).toEqual([]);
  });
});
