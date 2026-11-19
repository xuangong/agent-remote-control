/**
 * The Controller's side of the succession enrollment RPC, `SessionSuccessionEnrollment.control`, with no Relay: each request is the frame
 * the Relay would send (a describe, a freeze, a relation reservation, a source-result query) and each answer is what the Relay would read.
 * The freeze is built here from a describe answer, as the Relay builds it. The Host is real over a scripted native provider and memory
 * state files (`successionHostFixture`).
 */
import { join } from 'node:path';
import { expect, test, vi } from 'vitest';
import type { SuccessionAssociationFreeze, TrustedSuccessionContext } from '@orchardworks/agent-remote-protocol';
import { successionHostFixture as fixture, ref, Native, EvidenceNative, TpmStore, SessionSuccessionCoordinator, SessionSuccessionBoundary, sendOverWebSocket } from './succession-host-testing.js';

type Host = Awaited<ReturnType<typeof fixture>>;
const authority = { version: 1 as const, origin: 'http://relay.example', issuer: 'https://issuer.example', namespace: 'tenant', ownerSubject: 'owner' };
const trusted = (version: 1 | 2 | 3 = 2, over: Partial<TrustedSuccessionContext> = {}): TrustedSuccessionContext => ({ authority, installationId: 'controller', successionEnrollmentVersion: version, ...over });
const source = { providerId: 'fixture', nativeSessionId: 'A' };

async function enroll(f: Host, input: unknown, context: TrustedSuccessionContext = trusted(), request: { method?: string; operationScope?: string } = {}) {
  const result = await f.host.enrollFromRelay({ method: (request.method ?? 'POST') as 'POST', path: '/remote/succession/enrollment', body: JSON.stringify(input),
    ...(request.operationScope ? { operationScope: request.operationScope } : {}) } as never, context);
  return { status: result.status, body: JSON.parse(result.body) };
}
/** The freeze the Relay builds from a describe answer (see `succession-service.ts`, `prepare`). */
async function freezeOf(f: Host, operationId: string, over: Record<string, unknown> = {}, relations: unknown[] = []): Promise<SuccessionAssociationFreeze> {
  const described = (await enroll(f, { action: 'describe', ...source })).body;
  return { version: 2, token: `token-${operationId}`, authority, controllerId: 'controller', request: { operationId, roleId: described.role.id, expectedRevision: described.role.revision, from: ref('A') },
    associationRevision: described.associationRevision, lineage: described.lineage, relations, maxProjectionBytes: 1 << 20, ...over } as never;
}
const act = (f: Host, action: string, freeze: unknown, more: object = {}, context = trusted()) => enroll(f, { action, freeze, ...more }, context);
const withHost = (run: (f: Host) => Promise<void>, ...args: Parameters<typeof fixture>) => async () => { const f = await fixture(...args); try { await run(f); } finally { await f.close(); } };

test('answers only a POST from this Controller, and reports a refusal as a 409 with a code', withHost(async f => {
  expect((await enroll(f, { action: 'describe', ...source }, trusted(2), { method: 'GET' })).status).toBe(409);
  const other = await enroll(f, { action: 'describe', ...source }, trusted(2, { installationId: 'another-controller' }));
  expect(other).toMatchObject({ status: 409, body: { code: 'succession_enrollment_failed' } });
  expect((await enroll(f, { action: 'describe', ...source })).status).toBe(200);
}, false, true));

test('describe takes an exact source selection and the real workspace of that source', withHost(async f => {
  for (const input of [{ action: 'describe', providerId: 'fixture', nativeSessionId: 'A', extra: 1 }, { action: 'describe', providerId: 1, nativeSessionId: 'A' },
    { action: 'describe', providerId: 'unregistered', nativeSessionId: 'A' }])
    expect((await enroll(f, input)).status, JSON.stringify(input)).toBe(409);
  const answer = (await enroll(f, { action: 'describe', ...source })).body;
  expect(answer).toMatchObject({ role: { origin: ref('A'), current: ref('A'), workspace: { canonicalCwd: f.root } }, lineage: [ref('A')], relationUpdates: 1, associationRevision: 0 });
  expect(f.creates()).toBe(0);
}, false, true));

test('a native prefix selection is described only after the Relay acknowledged enrollment version 3', withHost(async f => {
  const preparation = { kind: 'native_prefix', turnId: 'turn', messageId: 'message' };
  expect((await enroll(f, { action: 'describe', ...source, preparation }, trusted(2))).status).toBe(409);
  expect((await enroll(f, { action: 'describe', ...source, preparation: { kind: 'native_prefix', turnId: 'turn' } }, trusted(3))).status).toBe(409);
  expect((await enroll(f, { action: 'describe', ...source, preparation }, trusted(3))).status).toBe(200);
}, false, true, undefined, false, false, false, true));

test('describe refuses a primary role that another association authority already owns', withHost(async f => {
  expect((await act(f, 'prepare', await freezeOf(f, 'op'))).status).toBe(200);
  const foreign = { ...authority, namespace: 'other-tenant' };
  const described = await enroll(f, { action: 'describe', ...source }, trusted(2, { authority: foreign }));
  expect(described).toMatchObject({ status: 409, body: { error: 'Primary role belongs to another association authority.' } });
}, false, true));

test('a freeze must be complete, from this Controller and authority, and no newer than the acknowledged version', withHost(async f => {
  const freeze = await freezeOf(f, 'op');
  expect((await act(f, 'prepare', { ...freeze, extra: true })).status).toBe(409);
  expect((await enroll(f, { action: 'prepare', freeze, includeContext: true })).status).toBe(409);
  expect((await enroll(f, { action: 'status', freeze: { ...freeze, controllerId: 'another-controller' } })).status).toBe(409);
  expect((await act(f, 'status', { ...freeze, authority: { ...authority, namespace: 'other-tenant' } })).status).toBe(409);
  expect((await act(f, 'prepare', { ...freeze, version: 3 }, {}, trusted(2))).status).toBe(409);
  expect(await act(f, 'prepare', { ...freeze, version: 3 }, {}, trusted(2))).toMatchObject({ body: { code: 'succession_enrollment_unavailable' } });
  expect(f.creates()).toBe(0);
}, false, true));

test('new preparation needs a version 2 freeze, before any native effect', withHost(async f => {
  const legacy = { ...(await freezeOf(f, 'legacy')), version: 1 } as Record<string, unknown>; delete legacy.maxProjectionBytes;
  expect(await act(f, 'prepare', legacy, {}, trusted(1))).toMatchObject({ status: 409, body: { code: 'succession_preparation_unavailable' } });
  expect(await act(f, 'prepare', legacy)).toMatchObject({ status: 409, body: { code: 'succession_preparation_unavailable' } });
  expect(f.creates()).toBe(0);
}, false, true));

test('prepare saves the freeze with the role, enrolls only the linked direct readers and answers ready', withHost(async f => {
  const reader = (id: string, linked = true) => ({ relationId: `${id}-relation`, kind: 'side', readerRef: ref(id), sourceRef: ref('A'), linked, revision: 0 });
  f.grants.push({ nativeSessionId: 'side', sourceNativeSessionId: 'A' }, { nativeSessionId: 'unlinked', sourceNativeSessionId: 'A' });
  const freeze = await freezeOf(f, 'op', {}, [reader('side'), reader('unlinked', false)]);
  const prepared = await act(f, 'prepare', freeze);
  expect(prepared).toMatchObject({ status: 200, body: { record: { phase: 'ready', to: ref('B') }, role: { current: ref('A') }, freeze } });
  const state = f.stateFiles.roles.json('state.json');
  expect(state.roles[0].enrollments.map((item: { request: { operationId: string } }) => item.request.operationId)).toEqual(['op']);
  expect(state.roles[0].participants.map((item: { before: { nativeSessionId: string } }) => item.before.nativeSessionId)).toEqual(['side']);
  expect(state.roles[0].associationAuthority).toEqual(authority);
}, false, true));

test('the same freeze is prepared once; a changed freeze under the same operation is refused', withHost(async f => {
  const freeze = await freezeOf(f, 'op');
  const first = await act(f, 'prepare', freeze);
  expect(await act(f, 'prepare', freeze)).toMatchObject({ status: 200, body: { record: { phase: 'ready' } } });
  expect(f.creates()).toBe(1);
  expect(first.body.record.operationId).toBe('op');
  expect(await act(f, 'status', { ...freeze, token: 'other-token' })).toMatchObject({ status: 409, body: { error: 'Frozen association receipt changed.' } });
}, false, true));

test('commit, status, reconcile, release and cancel act only on an enrolled freeze, and a commit moves the role to the candidate', withHost(async f => {
  const freeze = await freezeOf(f, 'op');
  expect(await act(f, 'commit', freeze)).toMatchObject({ status: 409, body: { error: 'Frozen association receipt is not enrolled.' } });
  expect((await act(f, 'prepare', freeze)).status).toBe(200);
  expect(await act(f, 'bogus', freeze)).toMatchObject({ status: 409 });
  expect(await act(f, 'status', freeze)).toMatchObject({ status: 200, body: { record: { phase: 'ready' }, role: { current: ref('A') } } });
  expect(await act(f, 'reconcile', freeze)).toMatchObject({ status: 409, body: { error: 'This unknown outcome requires native effect reconciliation.' } });
  const committed = await act(f, 'commit', freeze);
  expect(committed).toMatchObject({ status: 200, body: { record: { phase: 'committed', committedRevision: 2 }, role: { current: ref('B'), revision: 2, workspace: { canonicalCwd: f.root } } } });
  expect((await act(f, 'release', freeze)).status).toBe(200);
  expect((await act(f, 'status', freeze)).body.record.phase).toBe('committed');
}, false, true));

test('cancel of an enrolled freeze cancels the prepared operation and keeps the role on its source', withHost(async f => {
  const freeze = await freezeOf(f, 'op');
  expect((await act(f, 'prepare', freeze)).status).toBe(200);
  expect(await act(f, 'cancel', freeze)).toMatchObject({ status: 200, body: { record: { phase: 'cancelled' }, role: { current: ref('A'), revision: 1 } } });
}, false, true));

test('cancel of a freeze that was never enrolled is recorded durably against its historical source', withHost(async f => {
  const freeze = await freezeOf(f, 'never-prepared');
  expect(await act(f, 'cancel', freeze)).toMatchObject({ status: 200, body: { record: { operationId: 'never-prepared', phase: 'cancelled' }, role: { current: ref('A') } } });
  expect(f.creates()).toBe(0);
  expect(await act(f, 'prepare', freeze)).toMatchObject({ body: { record: { phase: 'cancelled' } } });
  expect(f.creates()).toBe(0);
}, false, true));

test('status asks for context only after a committed generic handoff, and reads the attachment of the target', withHost(async f => {
  const freeze = await freezeOf(f, 'op');
  await act(f, 'prepare', freeze); await act(f, 'commit', freeze);
  const status = await act(f, 'status', freeze, { includeContext: true });
  expect(status.body.context).toMatchObject({ operationId: 'op', target: ref('B') });
  expect((await act(f, 'status', freeze)).body.context).toBeUndefined();
  const early = await freezeOf(f, 'second', { request: { operationId: 'second', roleId: freeze.request.roleId, expectedRevision: 2, from: ref('B') }, lineage: [ref('A'), ref('B')] });
  expect((await act(f, 'status', early, { includeContext: true })).status).toBe(409);
}, false, true));

/** A committed handoff A to B whose reader `side` is linked to A, and the reservation the Relay sends to unlink that reader. */
async function committedWithSideReader(f: Host) {
  const row = { relationId: 'side-relation', kind: 'side' as const, readerRef: ref('side'), sourceRef: ref('A'), linked: true, revision: 0 };
  f.grants.push({ nativeSessionId: 'side', sourceNativeSessionId: 'A' });
  f.sessions.set('side', new Native('side', f.root));
  const freeze = await freezeOf(f, 'op', {}, [row]);
  await act(f, 'prepare', freeze); await act(f, 'commit', freeze); await act(f, 'release', freeze);
  const described = (await enroll(f, { action: 'describe', providerId: 'fixture', nativeSessionId: 'B' })).body;
  const reservation = { version: 1, operationId: 'unlink', token: 'unlink-token', authority, hostId: 'host', controllerId: 'controller', roleId: freeze.request.roleId,
    expectedRoleRevision: 2, origin: ref('A'), current: ref('B'), lineage: [ref('A'), ref('B')], associationRevision: described.associationRevision, catalogRevision: 0,
    relationId: 'side-relation', kind: 'side', readerRef: ref('side'), sourceRef: ref('A'), expectedRelationRevision: 0, previousLinked: true, linked: false, previousMember: true,
    relations: [row] };
  return { freeze, reservation, described };
}
const relation = (f: Host, action: string, reservation: unknown, more: object = {}, context = trusted()) => enroll(f, { action, reservation, ...more }, context);

test('a relation request carries only its action and a strict reservation from this Controller and authority', withHost(async f => {
  const { reservation } = await committedWithSideReader(f);
  expect((await relation(f, 'relation_status', { ...reservation, extra: 1 })).status).toBe(409);
  expect((await enroll(f, { action: 'relation_status', reservation, extra: 1 })).status).toBe(409);
  expect((await relation(f, 'relation_status', { ...reservation, controllerId: 'another-controller' })).status).toBe(409);
  expect((await relation(f, 'relation_status', reservation, {}, trusted(2, { authority: { ...authority, namespace: 'other-tenant' } }))).status).toBe(409);
  expect((await relation(f, 'relation_unknown', reservation)).status).toBe(409);
}, false, true));

test('relation_status answers the saved receipt, or none, after authorizing the three sessions it names', withHost(async f => {
  const { reservation } = await committedWithSideReader(f);
  expect(await relation(f, 'relation_status', reservation)).toMatchObject({ status: 200, body: { receipt: null } });
  expect((await relation(f, 'relation_reserve', reservation)).status).toBe(200);
  expect(await relation(f, 'relation_status', reservation)).toMatchObject({ status: 200, body: { receipt: { phase: 'reserved', reservation: { operationId: 'unlink' } } } });
}, false, true));

test('a relation change goes reserved, applied, released, and a reservation that conflicts with the saved one is refused', withHost(async f => {
  const { reservation } = await committedWithSideReader(f);
  const reserved = await relation(f, 'relation_reserve', reservation);
  expect(reserved).toMatchObject({ status: 200, body: { receipt: { phase: 'reserved' } } });
  expect(await relation(f, 'relation_reserve', reservation)).toMatchObject({ status: 200, body: { receipt: { phase: 'reserved' } } });
  expect(await relation(f, 'relation_reserve', { ...reservation, token: 'other-token' })).toMatchObject({ status: 409, body: { error: 'Relation operation identity conflict.' } });
  const applied = await relation(f, 'relation_apply', reservation);
  expect(applied).toMatchObject({ status: 200, body: { receipt: { phase: 'applied' } } });
  const revision = applied.body.receipt.associationRevision;
  expect((await relation(f, 'relation_release', reservation)).status).toBe(409);
  expect((await relation(f, 'relation_release', reservation, { associationRevision: 1.5 })).status).toBe(409);
  expect(await relation(f, 'relation_release', reservation, { associationRevision: revision })).toMatchObject({ status: 200, body: { receipt: { phase: 'released' } } });
}, false, true));

test('a relation reservation is validated against the provider grants, so a missing durable grant refuses it', withHost(async f => {
  const { reservation } = await committedWithSideReader(f);
  f.grants.splice(0);
  expect(await relation(f, 'relation_reserve', reservation)).toMatchObject({ status: 409 });
  expect(await relation(f, 'relation_status', reservation)).toMatchObject({ body: { receipt: null } });
}, false, true));

const created = '00000000-0000-4000-8000-000000000001';
const createSource = (f: Host, operationId = created) => f.host.enrollFromRelay({ method: 'POST', path: '/remote/create', sessionId: 'proposed', operationScope: 'scope',
  body: JSON.stringify({ providerId: 'fixture', operationId, sourceNativeSessionId: 'A' }) } as never, trusted());
const sourceResult = (f: Host, over: Record<string, unknown> = {}, scope: string | null = 'scope') => enroll(f, { action: 'source-result', providerId: 'fixture', operationId: created,
  sourceNativeSessionId: 'A', parameters: { sourceNativeSessionId: 'A' }, ...over }, trusted(), scope ? { operationScope: scope } : {});

test('source-result answers the retained result of an exact source creation, and says unknown when no witness was kept', withHost(async f => {
  expect(await sourceResult(f)).toMatchObject({ status: 409, body: { error: 'Source creation has no durable result witness; it remains unknown.' } });
  expect((await createSource(f)).status).toBe(200);
  expect(await sourceResult(f)).toMatchObject({ status: 200, body: { source: ref('A'), reader: ref('source-1'), operationId: created } });
  expect(f.sourceCreates()).toBe(1);
}, false, true));

test('source-result is strict about its fields, its scope and the parameters that identify the creation', withHost(async f => {
  await createSource(f);
  expect((await sourceResult(f, {}, null)).status).toBe(409);
  expect((await sourceResult(f, { extra: 1 })).status).toBe(409);
  expect((await sourceResult(f, { operationId: 7 })).status).toBe(409);
  expect((await sourceResult(f, { providerId: 7 })).status).toBe(409);
  expect((await sourceResult(f, { sourceNativeSessionId: 7 })).status).toBe(409);
  expect((await sourceResult(f, { parameters: { sourceNativeSessionId: 'A', unknownField: 'x' } })).status).toBe(409);
  expect((await sourceResult(f, { parameters: { sourceNativeSessionId: 'A', model: { nested: true } } })).status).toBe(409);
  expect((await sourceResult(f, { parameters: [] })).status).toBe(409);
  expect((await sourceResult(f, { parameters: { sourceNativeSessionId: 'A', model: 'other' } })).status).toBe(409);
  expect((await sourceResult(f, {}, 'another-scope')).status).toBe(409);
  expect((await sourceResult(f)).status).toBe(200);
}, false, true));

test('a retained source result is refused once its durable native grant is gone', withHost(async f => {
  await createSource(f);
  f.grants.splice(0);
  expect(await sourceResult(f)).toMatchObject({ status: 409, body: { error: 'Persisted source creation no longer has its durable native grant.' } });
}, false, true));

const tpmWork = (creation: 'accepted' | 'unknown', main = 'A') => ({ version: 1 as const, createKey: 'tpm-key', createFingerprint: 'tpm-fingerprint', creation, requirement: 'Done', dirty: false, lastReviewAt: 0, actions: {},
  work: { id: 'tpm-work', revision: 1, title: 'Work', providerId: 'fixture', mainNativeSessionId: main, tpmNativeSessionId: 'cold-tpm', phase: 'completed', waiting: 'none', paused: false, summary: 'Done',
    nextAction: '', document: 'Plan', acceptance: 'Accepted', evidence: ['verified'], createdAt: '2026-10-10T00:00:00.000Z', updatedAt: '2026-10-10T00:00:00.000Z', nextCheckAt: 0, outbox: [] } });
const withTpm = (record: ReturnType<typeof tpmWork>) => async (root: string, files: Parameters<NonNullable<Parameters<typeof fixture>[2]>>[1]) => {
  const store = new TpmStore(join(root, 'tpm'), files.tpm); await store.ready; await store.insert(record as never);
};

test('prepare enrolls the TPM works of the source lineage as participants that keep their own session', withHost(async f => {
  expect((await act(f, 'prepare', await freezeOf(f, 'op'))).status).toBe(200);
  expect(f.stateFiles.roles.json('state.json').roles[0].participants).toEqual([{ relationId: 'tpm:tpm-work', kind: 'tpm', before: ref('cold-tpm'), after: ref('cold-tpm') }]);
  expect(f.sessions.has('cold-tpm')).toBe(false);
}, true, true, withTpm(tpmWork('accepted'))));

test('prepare ignores the TPM works of another main session', withHost(async f => {
  expect((await act(f, 'prepare', await freezeOf(f, 'op'))).status).toBe(200);
  expect(f.stateFiles.roles.json('state.json').roles[0].participants).toEqual([]);
}, true, true, withTpm(tpmWork('accepted', 'unrelated'))));

test('prepare refuses while a TPM work of the source lineage has an unresolved creation, before any native effect', withHost(async f => {
  expect(await act(f, 'prepare', await freezeOf(f, 'op'))).toMatchObject({ status: 409, body: { error: 'TPM association creation is unresolved.' } });
  expect(f.creates()).toBe(0);
}, true, true, withTpm(tpmWork('unknown'))));

test('an exact retry of a source creation returns its saved reader without another native creation', withHost(async f => {
  const first = await createSource(f), retry = await createSource(f);
  expect([first.status, retry.status]).toEqual([200, 200]);
  expect(JSON.parse(retry.body).nativeSessionId).toBe('source-1');
  expect(f.sourceCreates()).toBe(1);
  expect(f.stateFiles.roles.json('state.json').associationResults).toHaveLength(1);
}, false, true));

test('a source creation whose native result is lost keeps its admission, answers no witness and is never created again', withHost(async f => {
  f.loseSourceCreation();
  expect((await createSource(f)).status).toBeGreaterThanOrEqual(400);
  expect(f.stateFiles.roles.json('state.json').associationAdmissions).toHaveLength(1);
  expect((await sourceResult(f)).status).toBe(409);
  expect((await createSource(f)).status).toBeGreaterThanOrEqual(400);
  expect(f.sourceCreates()).toBe(1);
  expect(f.stateFiles.roles.json('state.json').associationAdmissions).toHaveLength(1);
}, false, true));

test('a request that arrives right after a restart waits for the saved state to be restored', withHost(async f => {
  const freeze = await freezeOf(f, 'op');
  expect((await act(f, 'prepare', freeze)).status).toBe(200);
  await f.restart();
  expect(await act(f, 'status', freeze)).toMatchObject({ status: 200, body: { record: { operationId: 'op', phase: 'unknown' } } });
}, false, true));

test('describe lists the readers of the role as source participants, and leaves TPM works out of them', withHost(async f => {
  const { described } = await committedWithSideReader(f);
  expect(described.sourceParticipants).toEqual([{ relationId: expect.any(String), kind: 'side', readerRef: ref('side') }]);
  expect(described.lineage).toEqual([ref('A'), ref('B')]);
}, true, true, withTpm(tpmWork('accepted'))));

test('a fresh relation reservation is refused while a transient handoff fence holds one of its sessions', async () => {
  for (const held of ['A', 'B', 'side']) {
    let boundary: SessionSuccessionBoundary | undefined;
    const install = SessionSuccessionCoordinator.prototype.setAdmission;
    const spy = vi.spyOn(SessionSuccessionCoordinator.prototype, 'setAdmission').mockImplementation(function (this: SessionSuccessionCoordinator, admission) { boundary = admission as SessionSuccessionBoundary; install.call(this, admission); });
    const f = await fixture(false, true);
    try {
      const { reservation } = await committedWithSideReader(f);
      f.sessions.set('C', new Native('C', f.root)); await f.attach('C');
      boundary!.reserve('fixture-fence', ref('C')); boundary!.registerCandidate('fixture-fence', ref(held));
      const before = f.stateFiles.roles.text('state.json');
      const blocked = await relation(f, 'relation_reserve', reservation);
      expect(blocked.status, held).toBe(409); expect(blocked.body.error).toMatch(/handoff/);
      expect(f.stateFiles.roles.text('state.json')).toBe(before);
      boundary!.releaseReservation('fixture-fence');
      const exact = await Promise.all([relation(f, 'relation_reserve', reservation), relation(f, 'relation_reserve', reservation)]);
      expect(exact.map(row => row.status)).toEqual([200, 200]); expect(exact[0]!.body).toEqual(exact[1]!.body);
      expect(f.stateFiles.roles.json('state.json').roles[0].relationChanges).toHaveLength(1);
      expect(await relation(f, 'relation_reserve', { ...reservation, linked: true })).toMatchObject({ status: 409, body: { error: 'Relation operation identity conflict.' } });
    } finally { boundary?.releaseReservation('fixture-fence'); spy.mockRestore(); await f.close(); }
  }
});

test('a projection larger than the ceiling the Relay froze is refused before any native effect, with the Relay-visible code', withHost(async f => {
  const freeze = await freezeOf(f, 'op', { maxProjectionBytes: 1 });
  expect(await act(f, 'prepare', freeze)).toMatchObject({ status: 409, body: { code: 'succession_projection_capacity_exceeded' } });
  expect(f.creates()).toBe(0);
  expect(await act(f, 'cancel', freeze)).toMatchObject({ status: 200, body: { record: { phase: 'cancelled' } } });
}, false, true));

test('a committed output that no longer fits its frozen ceiling answers the invariant code on every action and keeps its evidence', withHost(async f => {
  const freeze = await freezeOf(f, 'op');
  await act(f, 'prepare', freeze); await act(f, 'commit', freeze);
  const state = f.stateFiles.roles.json('state.json');
  state.roles[0].enrollments[0].maxProjectionBytes = 1; f.stateFiles.roles.put('state.json', state);
  await f.restart();
  const tampered = state.roles[0].enrollments[0];
  for (const action of ['prepare', 'status', 'commit', 'reconcile', 'release', 'cancel'])
    expect(await act(f, action, tampered), action).toMatchObject({ status: 409, body: { code: 'succession_projection_invariant_failed' } });
  expect(f.stateFiles.roles.json('state.json').roles[0].operations[0].phase).toBe('committed');
  expect(f.creates()).toBe(1);
}, false, true));

test('status with context reads the target\'s attachment and settles its first input from native proof', withHost(async f => {
  const freeze = await freezeOf(f, 'handoff');
  const status = async () => (await act(f, 'status', freeze, { includeContext: true })).body;
  await act(f, 'prepare', freeze); await act(f, 'commit', freeze); await act(f, 'release', freeze);
  expect(await status()).toMatchObject({ context: { operationId: 'handoff', target: ref('B'), state: 'pending' } });
  await f.restart();
  expect(await status()).toMatchObject({ context: { target: ref('B'), state: 'pending' } });
  const attached = await f.attach('B'), b = f.sessions.get('B') as EvidenceNative;
  await sendOverWebSocket(f, attached.agentId, 'Continue once', '00000000-0000-4000-8000-000000009201');
  expect(await status()).toMatchObject({ context: { state: 'accepted' } });
  b.materialized = true;
  expect(await status()).toMatchObject({ context: { state: 'materialized' } });
  expect(b.dispatches).toBe(1);
}, false, true, undefined, false, true));
