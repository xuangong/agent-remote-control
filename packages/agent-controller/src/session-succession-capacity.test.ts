import { expect, test } from 'vitest';
import { SessionSuccessionContextStore } from './session-succession-context.js';
import { SessionSuccessionStore } from './session-succession-store.js';
import { jsonBytes, SUCCESSION_STORE_BYTES } from './succession-persistence.js';
import { memoryStateFiles } from './memory-state-files.js';
import { padInBulk } from './test-utils/succession-state.js';
// The stores run over in-memory state files: the rules of capacity do not depend on the disk.
const ref = (nativeSessionId: string) => ({ controllerId: 'host', providerId: 'fixture', nativeSessionId });
const request = { operationId: 'op', roleId: 'role', expectedRevision: 1, from: ref('A') };
const capture = { epoch: 'epoch', seq: 1, capturedAt: '2026-10-10T00:00:00Z' };
const directory = '/succession/capacity';
const attachment = (id: string, text = '[]') => ({ operationId: id, roleId: id, roleRevision: 2, source: ref(`source-${id}`), target: ref(`target-${id}`), boundary: { epoch: 'epoch', seq: 1 }, capturedAt: capture.capturedAt, text, itemCount: JSON.parse(text).length });

function fillRoleState(state: any, desiredBytes: number) {
  padInBulk(state, state.associationResults, index => ({ id: `unrelated-${index}`, fingerprint: 'fingerprint', scope: 'x'.repeat(16384), operationId: `unrelated-${index}`, source: ref('other-A'), reader: ref('other-B') }), desiredBytes, 16500);
  while (jsonBytes(state) < desiredBytes - 16500) {
    const index = state.associationResults.length;
    state.associationResults.push({ id: `unrelated-${index}`, fingerprint: 'fingerprint', scope: 'x'.repeat(16384), operationId: `unrelated-${index}`, source: ref('other-A'), reader: ref('other-B') });
  }
  const index = state.associationResults.length;
  state.associationResults.push({ id: `unrelated-${index}`, fingerprint: 'fingerprint', scope: 'x', operationId: `unrelated-${index}`, source: ref('other-A'), reader: ref('other-B') });
  state.associationResults.at(-1).scope += 'x'.repeat(desiredBytes - jsonBytes(state));
}
async function contextNearCapacity(freeBytes: number) {
  const files = memoryStateFiles(), store = new SessionSuccessionContextStore(directory, {}, files); await store.ready;
  await store.attach(attachment('input'));
  const state = files.json('context.json');
  const desired = SUCCESSION_STORE_BYTES - freeBytes;
  while (jsonBytes(state) < desired - 1024 * 1024) {
    const id = `fill-${state.attachments.length}`;
    state.attachments.push({ ...attachment(id, JSON.stringify([{ role: 'user', text: 'x'.repeat(1024 * 1024 - 100) }])), version: 2, state: 'pending', deliveries: [] });
  }
  const id = `fill-${state.attachments.length}`, last = { ...attachment(id, '[{"role":"user","text":""}]'), version: 2, state: 'pending', deliveries: [] };
  state.attachments.push(last);
  last.text = JSON.stringify([{ role: 'user', text: 'x'.repeat(desired - jsonBytes(state)) }]);
  files.put('context.json', state);
  const reopened = new SessionSuccessionContextStore(directory, {}, files); await reopened.ready;
  return { files, store: reopened };
}

test('initial role capacity failure publishes neither operation nor source reservation', async () => {
  const files = memoryStateFiles(), store = new SessionSuccessionStore(directory, files); await store.ready;
  await store.createRole({ id: 'role', revision: 1, origin: ref('A'), current: ref('A'), workspace: { controllerId: 'host', canonicalCwd: directory } });
  const state = files.json('state.json');
  fillRoleState(state, SUCCESSION_STORE_BYTES - 8192); files.put('state.json', state);
  const reopened = new SessionSuccessionStore(directory, files); await reopened.ready;
  await expect(reopened.begin(request, true)).rejects.toThrow(/capacity/);
  expect(reopened.read('role').operations).toEqual([]);
  expect(files.json('state.json').roles[0].operations).toEqual([]);
});

test('concurrent unrelated role writes preserve actual participant, terminal and enrollment-release capacity', async () => {
  const files = memoryStateFiles(), store = new SessionSuccessionStore(directory, files); await store.ready;
  await store.createRole({ id: 'role', revision: 1, origin: ref('A'), current: ref('A'), workspace: { controllerId: 'host', canonicalCwd: directory } });
  const before = files.json('state.json');
  const participants = Array.from({ length: 10 }, (_, index) => ({ relationId: `${index}-引号"\\`.repeat(30), kind: 'tpm' as const, before: ref(`reader-${index}`), after: ref(`reader-${index}`) }));
  const freeze = { version: 2 as const, maxProjectionBytes: 8 * 1024 * 1024, token: 'token-中\\"'.repeat(20), authority: { version: 1 as const, origin: 'https://relay.example', issuer: 'https://issuer.example', namespace: 'tenant', ownerSubject: 'owner' }, controllerId: 'host', request, associationRevision: 0, lineage: [ref('A')], relations: [] };
  await store.beginEnrolled(freeze, participants, store.generation, true);
  const admitted = files.json('state.json');
  const reserved = Number(admitted.roles[0].localPreparations[0].reservedBytes), actualGrowth = jsonBytes(admitted) - jsonBytes(before);
  fillRoleState(before, SUCCESSION_STORE_BYTES - reserved - actualGrowth - 18000); files.put('state.json', before);
  const reopened = new SessionSuccessionStore(directory, files); await reopened.ready;
  await reopened.beginEnrolled(freeze, participants, reopened.generation, true);
  const unrelated = await Promise.allSettled([reopened.ensureRole(ref('other-1'), '中'.repeat(4096)), reopened.ensureRole(ref('other-2'), '中'.repeat(4096))]);
  expect(unrelated.map(result => result.status)).toEqual(['fulfilled', 'rejected']);
  await reopened.savePreparation('op', capture); await reopened.startCreation('op');
  const target = ref('\ud800'.repeat(512)); await reopened.saveCandidate('op', target);
  const state = reopened.read('role');
  await reopened.advance('op', 'transferring', { phase: 'ready', prepared: { ...request, to: target, workspace: state.role.workspace, associationRevision: state.associationRevision, participants, capture } });
  expect((await reopened.commit('op')).phase).toBe('committed');
  await reopened.releaseEnrollment(freeze);
  expect(reopened.read('role').releasedEnrollments).toContain(freeze.token);
});

test.each(['accepted', 'rejected', 'unknown'] as const)('reserves actual escaped one-MiB input and finite %s settlement near capacity', async outcome => {
  const text = '\0'.repeat(1024 * 1024), f = await contextNearCapacity(6 * 1024 * 1024 + 1024);
  await f.store.begin('input', { operationId: 'delivery', roleId: 'input', roleRevision: 2, target: ref('target-input'), text });
  const receipt = await f.store.settle('input', 'delivery', outcome, outcome === 'accepted' ? { disposition: 'started' } : undefined);
  expect(receipt.state).toBe(outcome);
  const reopened = new SessionSuccessionContextStore(directory, {}, f.files); await reopened.ready;
  expect(reopened.delivery('delivery')!.state).toBe(outcome);
});

test('a large input rejected at admission keeps context pending for a smaller explicit input', async () => {
  const f = await contextNearCapacity(1000);
  const input = { operationId: 'large', roleId: 'input', roleRevision: 2, target: ref('target-input'), text: '\0'.repeat(1024 * 1024) };
  await expect(f.store.begin('input', input)).rejects.toThrow(/capacity/);
  expect(f.store.read('input').state).toBe('pending'); expect(f.store.delivery('large')).toBeUndefined();
  await f.store.begin('input', { ...input, operationId: 'small', text: '继续' });
  expect((await f.store.settle('input', 'small', 'accepted', { disposition: 'queued' })).state).toBe('accepted');
});

test('concurrent preparations cannot spend each other target-binding reservation', async () => {
  const f = await contextNearCapacity(20000);
  const first = { ...attachment('prepared-甲', JSON.stringify([{ role: 'user', text: '引号 " \\ 与中文' }])), target: undefined };
  const { target: _target, ...preparation } = first;
  await f.store.prepare(preparation);
  const outcomes = await Promise.allSettled([
    f.store.prepare({ ...preparation, operationId: 'prepared-乙' }),
    f.store.attach(attachment('unrelated', JSON.stringify([{ role: 'user', text: 'x'.repeat(15000) }]))),
  ]);
  expect(outcomes.some(outcome => outcome.status === 'rejected')).toBe(true);
  await f.store.bind(preparation.operationId, { controllerId: '\ud800'.repeat(512), providerId: '\ud800'.repeat(512), nativeSessionId: '\ud800'.repeat(512) });
  expect(f.store.read(preparation.operationId).text).toBe(preparation.text);
});

const encodedBytes = (value: unknown) => Buffer.byteLength(JSON.stringify(value), 'utf8');
function fillContextState(state: any, desired: number) {
  while (encodedBytes(state) < desired - 1024 * 1024) {
    const id = `bounded-${state.attachments.length}`;
    state.attachments.push({ ...attachment(id, JSON.stringify([{ role: 'user', text: 'x'.repeat(1024 * 1024 - 100) }])), version: 2, state: 'pending', deliveries: [] });
  }
  const id = `bounded-${state.attachments.length}`, last = { ...attachment(id, '[{"role":"user","text":""}]'), version: 2, state: 'pending', deliveries: [] };
  state.attachments.push(last); last.text = JSON.stringify([{ role: 'user', text: 'x'.repeat(desired - encodedBytes(state)) }]);
  expect(encodedBytes(state)).toBe(desired);
}
test.each(['accepted', 'unknown', 'restart'] as const)('optional %s keeps a complete positive-proof reserve at the eight-MiB boundary', async transition => {
  const { createHash } = await import('node:crypto');
  const { serializeAgentPreparedTextInput, serializeAgentInputMaterialization } = await import('@orchardworks/agent-provider-sdk');
  const { quotedSessionContextPrefix } = await import('@orchardworks/agent-remote-protocol');
  const hash = (value: string) => createHash('sha256').update(value).digest('hex');
  const files = memoryStateFiles(), store = new SessionSuccessionContextStore(directory, {}, files); await store.ready;
  const context = attachment('input'); await store.attach(context);
  const input = { operationId: 'delivery', roleId: 'input', roleRevision: 2, target: context.target, text: transition === 'unknown' ? '\u0000'.repeat(300000) : '\n"\\中'.repeat(200) };
  const text = quotedSessionContextPrefix({ id: context.operationId, sourceSession: context.source.nativeSessionId, capturedAt: context.capturedAt, text: context.text }) + input.text;
  const witness = { version: 2 as const, providerId: 'fixture', nativeSessionId: context.target.nativeSessionId, inputId: 'U', cwd: '\u0001'.repeat(4096), authority: { kind: 'trusted-service' as const, authorityId: 'authority', namespaceId: 'store' },
    parts: [{ type: 'text' as const, text }] as const, content: { encoding: 'utf-8' as const, bytes: Buffer.byteLength(text), sha256: hash(text) }, selections: {} };
  await store.begin('input', input, witness);
  if (transition !== 'restart') await store.settle('input', 'delivery', transition, transition === 'accepted' ? { disposition: 'started' } : undefined);
  let current = store;
  if (transition === 'restart') { current = new SessionSuccessionContextStore(directory, {}, files); await current.ready; }
  const state = files.json('context.json'), delivery = state.attachments[0].deliveries[0];
  const nativeEvidence = serializeAgentInputMaterialization({ status: 'materialized', proof: { version: 2, providerId: witness.providerId, nativeSessionId: witness.nativeSessionId, inputId: witness.inputId, nativeInputId: 'U'.repeat(256), cwd: witness.cwd, authority: witness.authority,
    witnessSha256: hash(serializeAgentPreparedTextInput(witness)), contentSha256: witness.content.sha256, nativeSelectionsSha256: hash('{}'), nativePartIds: ['p'.repeat(256)] }, execution: { disposition: 'started', nativeExecutionId: 'R'.repeat(256) } });
  const future = structuredClone(state); future.attachments[0].state = 'materialized'; Object.assign(future.attachments[0].deliveries[0], { state: 'materialized', nativeEvidence, inputAcceptance: { disposition: 'started' }, reservedBytes: '00000000' });
  const growth = encodedBytes(future) - encodedBytes(state);
  expect(Number(delivery.reservedBytes)).toBe(growth); expect(growth).toBeGreaterThan(28000);
  fillContextState(state, SUCCESSION_STORE_BYTES - growth); files.put('context.json', state);
  const full = new SessionSuccessionContextStore(directory, {}, files); await full.ready;
  await expect(full.attach(attachment('unrelated'))).rejects.toThrow(/capacity/);
  expect(full.delivery('delivery')!.preparedInput!.witness).toEqual(witness);
  await full.reconcile('input', { operationId: 'delivery', target: context.target, roleRevision: 2, outcome: 'materialized', nativeEvidence });
  expect(Buffer.byteLength(files.text('context.json'))).toBe(SUCCESSION_STORE_BYTES);
  const final = new SessionSuccessionContextStore(directory, {}, files); await final.ready;
  expect(final.delivery('delivery')).toMatchObject({ state: 'materialized', nativeEvidence, inputAcceptance: { disposition: 'started' }, reservedBytes: '00000000' });
  expect(final.delivery('delivery')!.inputAcceptance).toEqual({ disposition: 'started' });
});

test('optional admission rejects one byte beyond its full reachable representation without losing the pending context', async () => {
  const { createHash } = await import('node:crypto'); const { quotedSessionContextPrefix } = await import('@orchardworks/agent-remote-protocol');
  const files = memoryStateFiles(), store = new SessionSuccessionContextStore(directory, {}, files); await store.ready;
  const context = attachment('input'); await store.attach(context);
  const before = files.json('context.json');
  const input = { operationId: 'delivery', roleId: 'input', roleRevision: 2, target: context.target, text: 'work' };
  const text = quotedSessionContextPrefix({ id: context.operationId, sourceSession: context.source.nativeSessionId, capturedAt: context.capturedAt, text: context.text }) + input.text;
  const witness = { version: 2 as const, providerId: 'fixture', nativeSessionId: context.target.nativeSessionId, inputId: 'U', cwd: '/workspace', authority: { kind: 'trusted-service' as const, authorityId: 'authority', namespaceId: 'store' }, parts: [{ type: 'text' as const, text }] as const,
    content: { encoding: 'utf-8' as const, bytes: Buffer.byteLength(text), sha256: createHash('sha256').update(text).digest('hex') }, selections: {} };
  await store.begin('input', input, witness);
  const admitted = files.json('context.json');
  const completeGrowth = encodedBytes(admitted) - encodedBytes(before) + Number(admitted.attachments[0].deliveries[0].reservedBytes);
  fillContextState(before, SUCCESSION_STORE_BYTES - completeGrowth + 1); files.put('context.json', before);
  const over = new SessionSuccessionContextStore(directory, {}, files); await over.ready;
  await expect(over.begin('input', input, witness)).rejects.toThrow(/capacity/);
  expect(over.read('input')).toMatchObject({ state: 'pending', deliveries: [] });
  expect(files.json('context.json')).toEqual(before);
});

test.each(['created', 'known_rejected'] as const)('cancelled creation retains capacity for a maximum %s envelope after restart and unrelated writes', async status => {
  const files = memoryStateFiles(), store = new SessionSuccessionStore(directory, files); await store.ready;
  await store.createRole({ id: 'role', revision: 1, origin: ref('A'), current: ref('A'), workspace: { controllerId: 'host', canonicalCwd: directory } });
  await store.begin(request, true); await store.savePreparation('op', capture, true); await store.startCreation('op'); await store.settlePreparation('op', 'cancelled');
  const state = files.json('state.json'), progress = state.roles[0].localPreparations[0];
  const handle = { providerId: 'fixture', sessionId: 'B'.repeat(256), opaque: '' };
  handle.opaque = '\n'.repeat(Math.floor((16384 - encodedBytes(handle)) / 2));
  if (encodedBytes(handle) < 16384) handle.opaque += 'x'; expect(encodedBytes(handle)).toBe(16384);
  const outcome = status === 'created' ? { status, handle } : { status, handle, code: 'native_evidence_identity_unusable' as const, reason: 'The native session identity cannot be retained safely.' };
  const future = structuredClone(state); future.roles[0].localPreparations[0].nativeCreation.outcome = outcome;
  future.roles[0].localPreparations[0].orphanCandidate = ref(handle.sessionId);
  const actualGrowth = encodedBytes(future) - encodedBytes(state); expect(Number(progress.reservedBytes)).toBeGreaterThanOrEqual(actualGrowth);
  fillRoleState(state, SUCCESSION_STORE_BYTES - Number(progress.reservedBytes)); files.put('state.json', state);
  const restored = new SessionSuccessionStore(directory, files); await restored.ready;
  await expect(restored.ensureRole(ref('unrelated'), '/workspace')).rejects.toThrow(/capacity/);
  await restored.saveCreationResult('op', outcome);
  expect(restored.progress('op')).toMatchObject({ orphanCandidate: ref(handle.sessionId), nativeCreation: { outcome } });
  expect(Buffer.byteLength(files.text('state.json'))).toBeLessThanOrEqual(SUCCESSION_STORE_BYTES);
});

test('native prefix reserves the complete handle envelope before any native effect', async () => {
  const { SessionSuccessionService } = await import('./session-succession-service.js');
  // The service keeps a small signing key on disk beside the two in-memory stores.
  const { mkdtemp, realpath, rm } = await import('node:fs/promises'), { tmpdir } = await import('node:os'), { join } = await import('node:path');
  const directory = await realpath(await mkdtemp(join(tmpdir(), 'succession-capacity-')));
  try {
  const roles = memoryStateFiles(), contexts = memoryStateFiles(), service = new SessionSuccessionService(directory, 'host', {} as never, { roles, contexts }); await service.ready;
  await service.createRole({ id: 'role', revision: 1, origin: ref('A'), current: ref('A'), workspace: { controllerId: 'host', canonicalCwd: directory } });
  const before = roles.json('state.json');
  const prefix = { ...request, preparation: { kind: 'native_prefix' as const, turnId: 'turn', messageId: 'message' } };
  await service.store.begin(prefix, true);
  const admitted = roles.json('state.json');
  const allowance = Number(admitted.roles[0].localPreparations[0].reservedBytes) + jsonBytes(admitted) - jsonBytes(before);
  expect(allowance).toBeGreaterThan(16384);
  fillRoleState(before, SUCCESSION_STORE_BYTES - allowance + 1); roles.put('state.json', before);
  let forks = 0;
  const reopened = new SessionSuccessionService(directory, 'host', { inspect: async () => ({ cwd: directory, idle: true, managed: true, pendingInputs: 0, inFlightInputs: 0, pendingInteractions: 0, activeChildren: 0, boundary: { epoch: 'e', seq: 1 } }),
    supportsNativePrefix: async () => true, createNativePrefix: async () => { forks++; return { target: ref('B'), handle: { providerId: 'fixture', sessionId: 'B', opaque: '{}' } }; }, verifyNativePrefix: async () => {}, retainVerification: async () => ({ inspect: async () => { throw new Error('unexpected'); }, assertCurrent(){}, release(){} }) } as never, { roles, contexts });
  await reopened.ready;
  await expect(reopened.prepare(prefix)).rejects.toThrow(/capacity/); expect(forks).toBe(0); expect(reopened.store.read('role').operations).toEqual([]);
  } finally { await rm(directory, { recursive: true, force: true }); }
});
