import { describe, expect, it } from 'vitest';

import { createAccess } from './access.js';
import { createBrokerState, type BrokerState } from './broker-state.js';
import type { Binding, Host } from './broker-types.js';
import { createRelations } from './relation-service.js';
import { sequentialRelayIds } from './relay-ids.js';
import { createSuccession } from './succession-service.js';
import { RELAY_SOCKET_OPEN } from './transport.js';

const authority = { version: 1 as const, origin: 'https://relay.example', issuer: 'https://issuer.example', namespace: 'tenant', ownerSubject: 'owner' };
const ref = (nativeSessionId: string) => ({ controllerId: 'installation', providerId: 'codex', nativeSessionId });
const emptyAssociations = () => ({ version: 6 as const, revision: 0, admissions: [], freezes: [], relationChanges: [], relationResets: [] });
const host = (): Host => ({ id: 'h1', installationId: 'installation', name: 'Host', providers: [{ providerId: 'codex', displayName: 'Codex' }], legacyDsh: false, generation: 1,
  pending: new Map(), streams: new Map(), ready: true, socket: { readyState: RELAY_SOCKET_OPEN } as never, successionEnrollmentVersion: 3 });
const binding = (nativeSessionId: string, extra: Partial<Binding> = {}): Binding => ({ hostId: 'h1', providerId: 'codex', nativeSessionId, agentId: `agent-${nativeSessionId}`, generation: 1, ...extra });
const side = (sourceNativeSessionId: string, revision = 0) => ({ id: 'conversation-1', kind: 'side' as const, sourceNativeSessionId, nativeSourceRef: ref(sourceNativeSessionId), createdAt: '2026-11-18T00:00:00.000Z', revision });

function setup(options: { enrolled?: boolean } = {}) {
  const state: BrokerState = createBrokerState({ initialState: undefined, now: () => 0, keepsAssociations: true, keepsSharing: true });
  const subject = host();
  state.hosts.set(subject.id, subject);
  const source = binding('S'), reader = binding('R', { sourceRelation: side('S') });
  for (const item of [source, reader]) { state.bindings.set(item.agentId, item); state.nativeBindings.set(JSON.stringify([item.hostId, item.providerId, item.nativeSessionId]), item); }
  const access = createAccess({ state, ownerSubject: 'owner' });
  const enrollment = options.enrolled === false ? undefined : authority;
  const ids = sequentialRelayIds();
  const succession = createSuccession({ brokerState: state, enrollment, projectionAllowance: undefined, ids, rpc: async () => { throw new Error('No Controller in this test.'); },
    teams: { assertReplacementSupported: () => undefined, hasUnsettledRecipient: () => false }, creations: { has: () => false } });
  return { state, source, reader, relations: createRelations({ brokerState: state, access, succession, enrollment, ids }) };
}

const update = (extra: Record<string, unknown> = {}) => ({ hostId: 'h1', providerId: 'codex', nativeSessionId: 'R', id: 'conversation-1', sourceNativeSessionId: 'S', linked: false, expectedRevision: 0,
  operationId: 'op-1', expectedRoleRevision: 1, ...extra }) as never;

describe('relation edits', () => {
  it('builds the intent of an edit from the reader binding and the source, for the owner only', () => {
    const run = setup();
    expect(run.relations.relationIntent('owner', update())).toEqual({ version: 1, operationId: 'op-1', authority, hostId: 'h1', controllerId: 'installation',
      readerRef: ref('R'), sourceRef: ref('S'), relationId: 'conversation-1', linked: false, expectedRelationRevision: 0, expectedRoleRevision: 1 });
    expect(() => run.relations.relationIntent('guest', update())).toThrow(expect.objectContaining({ status: 403, code: 'owner_required' }));
  });

  it('requires an operation identity and a role revision, and a Side or Ask relation that matches', () => {
    const run = setup();
    expect(() => run.relations.relationIntent('owner', update({ operationId: undefined }))).toThrow(expect.objectContaining({ status: 409, code: 'relation_operation_required' }));
    expect(() => run.relations.relationIntent('owner', update({ expectedRoleRevision: undefined }))).toThrow(expect.objectContaining({ code: 'relation_operation_required' }));
    expect(() => run.relations.relationIntent('owner', update({ id: 'other' }))).toThrow(expect.objectContaining({ status: 409, code: 'relation_conflict' }));
  });

  it('edits only Side relations, not Ask ones', () => {
    const run = setup();
    run.reader.sourceRelation = { ...side('S'), kind: 'ask' };
    expect(() => run.relations.relationIntent('owner', update())).toThrow(expect.objectContaining({ status: 409, code: 'relation_conflict' }));
  });

  it('refuses an edit without enrollment, because the Relay cannot name the authority', () => {
    const run = setup({ enrolled: false });
    expect(() => run.relations.relationIntent('owner', update())).toThrow(expect.objectContaining({ status: 403, code: 'session_forbidden' }));
  });

  it('accepts only the exact intent a reset operation held, and answers a repeat of it as reset', () => {
    const run = setup();
    const intent = run.relations.relationIntent('owner', update());
    const state = { ...emptyAssociations(), relationResets: [{ intent }] } as never;
    expect(() => run.relations.assertRelationNotReset(state, intent)).toThrow(expect.objectContaining({ status: 409, code: 'relation_change_reset' }));
    expect(() => run.relations.assertRelationNotReset(state, { ...intent, linked: true })).toThrow(expect.objectContaining({ code: 'relation_identity_conflict' }));
    expect(() => run.relations.assertRelationNotReset(emptyAssociations() as never, intent)).not.toThrow();
  });

  it('compares a saved reservation with an intent field by field', () => {
    const run = setup();
    const intent = run.relations.relationIntent('owner', update());
    expect(() => run.relations.assertExactRelationIntent(intent, intent)).not.toThrow();
    expect(() => run.relations.assertExactRelationIntent(intent, { ...intent, expectedRoleRevision: 2 })).toThrow(expect.objectContaining({ code: 'relation_identity_conflict' }));
    expect(() => run.relations.assertExactRelationIntent(intent, { ...intent, hostId: 'h2' })).toThrow(expect.objectContaining({ code: 'relation_identity_conflict' }));
  });

  it('knows no pending operation that was not saved', () => {
    const run = setup();
    expect(() => run.relations.savedRelationOperation('owner', { hostId: 'h1', operationId: 'missing' })).toThrow(expect.objectContaining({ status: 404, code: 'relation_change_not_found' }));
  });
});

describe('relation reads', () => {
  it('maps an input that names the reader, or one of its predecessors, to the reader binding', () => {
    const run = setup();
    expect(run.relations.canonicalRelationInput('owner', { hostId: 'h1', providerId: 'codex', nativeSessionId: 'R' })).toEqual({ hostId: 'h1', providerId: 'codex', nativeSessionId: 'R' });
  });

  it('refuses a Host that is unknown, and a reader that cannot be found or is ambiguous', () => {
    const run = setup();
    expect(() => run.relations.canonicalRelationInput('owner', { hostId: 'nope', providerId: 'codex', nativeSessionId: 'R' })).toThrow(expect.objectContaining({ status: 404, code: 'host_not_found' }));
    expect(() => run.relations.canonicalRelationInput('owner', { hostId: 'h1', providerId: 'codex', nativeSessionId: 'S' })).toThrow(expect.objectContaining({ status: 409, code: 'relation_conflict' }));
  });

  it('refuses a subject that cannot see the session', () => {
    const run = setup();
    expect(() => run.relations.canonicalRelationInput('guest', { hostId: 'h1', providerId: 'codex', nativeSessionId: 'R' })).toThrow(expect.objectContaining({ status: 403, code: 'session_forbidden' }));
  });
});
