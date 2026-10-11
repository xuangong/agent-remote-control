import { createHash } from 'node:crypto';
import { serializeAgentPreparedTextInput, serializeAgentInputMaterialization, type AgentPreparedTextInput } from '@orchardworks/agent-provider-sdk';
import { quotedSessionContextPrefix } from '@orchardworks/agent-remote-protocol';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { SessionSuccessionContextStore, SessionSuccessionInputDispatcher } from './session-succession-context.js';
const target = { controllerId: 'host', providerId: 'codex', nativeSessionId: 'B' };
const source = { ...target, nativeSessionId: 'A' };
const attachment = { operationId: 'succession', roleId: 'primary', roleRevision: 2, source, target,
  capturedAt: '2026-10-10T00:00:00.000Z', boundary: { epoch: 'epoch', seq: 3 }, text: '[{"role":"user","text":"old"}]', itemCount: 1 };
const directories: string[] = [];
afterEach(async () => { await Promise.all(directories.splice(0).map(path => rm(path, { recursive: true, force: true }))); });
async function setup() { const path = await mkdtemp(join(tmpdir(), 'succession-context-')); directories.push(path); const store = new SessionSuccessionContextStore(path); await store.ready; await store.attach(attachment); return { path, store, dispatcher: new SessionSuccessionInputDispatcher(store) }; }
const input = (operationId = 'input') => ({ operationId, target, roleId: 'primary', roleRevision: 2, text: 'new' });
const admitted = async () => {};
describe('durable succession first input', () => {
  it('records actual recipient before dispatch and requires native evidence after acceptance', async () => {
    const { store, dispatcher } = await setup();
    const result = await dispatcher.dispatch(input(), admitted, async request => {
      expect(store.read('succession').deliveries[0]).toMatchObject({ operationId: 'input', target, roleRevision: 2, state: 'dispatching' });
      expect(request.text).toContain('quoted conversation history'); expect(request.text).toContain('old'); expect(request.text.endsWith('new')).toBe(true);
      return { outcome: 'accepted' };
    });
    expect(result.state).toBe('accepted');
    await expect(dispatcher.dispatch(input('later'), admitted, async () => ({ outcome: 'accepted' }))).rejects.toThrow('unresolved');
    await store.reconcile('succession', { operationId: 'input', target, roleRevision: 2, outcome: 'materialized', nativeEvidence: 'native-entry-42' });
    await dispatcher.dispatch(input('later'), admitted, async request => { expect(request.text).toBe('new'); return { outcome: 'accepted' }; });
  });
  it('preserves unknown delivery across restart and does not replay the same identity', async () => {
    const { path, dispatcher } = await setup(); let sends = 0;
    await expect(dispatcher.dispatch(input(), admitted, async () => { sends++; throw new Error('disconnected'); })).rejects.toThrow('disconnected');
    const restored = new SessionSuccessionContextStore(path); await restored.ready;
    expect(restored.read('succession').state).toBe('unknown');
    const next = new SessionSuccessionInputDispatcher(restored);
    expect((await next.dispatch(input(), admitted, async () => { sends++; return { outcome: 'accepted' }; })).state).toBe('unknown');
    expect(sends).toBe(1);
    await expect(restored.reconcile('succession', { operationId: 'input', target: source, roleRevision: 2, outcome: 'materialized', nativeEvidence: 'wrong' })).rejects.toThrow('identity');
  });
  it('serializes racing first inputs and keeps attachment pending after definite rejection', async () => {
    const { store, dispatcher } = await setup(); let release!: () => void;
    const wait = new Promise<void>(resolve => { release = resolve; }); let entered!: () => void;
    const entry = new Promise<void>(resolve => { entered = resolve; });
    const first = dispatcher.dispatch(input(), admitted, async () => { entered(); await wait; return { outcome: 'rejected' }; });
    await entry;
    const second = dispatcher.dispatch(input('other-device'), admitted, async request => { expect(request.text).toContain('old'); return { outcome: 'accepted' }; });
    release(); await first; await second;
    expect(store.read('succession').deliveries.map(item => item.state)).toEqual(['rejected', 'accepted']);
  });
  it('restores in-flight dispatch as unknown and refuses conflicting identity or oversized attachment', async () => {
    const { path, store } = await setup(); await store.begin('succession', input());
    const restored = new SessionSuccessionContextStore(path); await restored.ready;
    expect(restored.read('succession').state).toBe('unknown');
    await expect(restored.begin('succession', { ...input(), text: 'changed' })).rejects.toThrow('identity');
    await expect(restored.attach({ ...attachment, operationId: 'huge', text: JSON.stringify([{ role: 'user', text: 'x'.repeat(1024 * 1024) }]) })).rejects.toThrow('limit');
  });
  it('rejects stale routing before any dispatch or first-input reservation', async () => {
    const { store, dispatcher } = await setup();
    await expect(dispatcher.dispatch(input(), async () => { throw new Error('role changed'); }, async () => ({ outcome: 'accepted' }))).rejects.toThrow('role changed');
    expect(store.read('succession').state).toBe('pending'); expect(store.read('succession').deliveries).toEqual([]);
  });
  it('rechecks admission after durable reservation and preserves rich input prefix separately', async () => {
    const { store, dispatcher } = await setup(); let checks = 0;
    await expect(dispatcher.dispatch(input(), async () => { checks++; if (checks === 2) throw new Error('reserved source'); }, async () => ({ outcome: 'accepted' }))).rejects.toThrow('reserved source');
    expect(store.read('succession').state).toBe('pending');
    await dispatcher.dispatch({ ...input('rich'), contentIdentity: 'sha256-of-text-and-images' }, admitted, async (request, prefix) => {
      expect(prefix).toContain('old'); expect(request.text).toBe(prefix + 'new'); expect(request.contentIdentity).toBe('sha256-of-text-and-images');
      return { outcome: 'accepted' };
    });
  });
  it('keeps rejected receipts immutable and requires a new explicit operation to retry', async () => {
    const { dispatcher } = await setup(); let count = 0;
    await dispatcher.dispatch(input(), admitted, async () => { count++; return { outcome: 'rejected' }; });
    expect((await dispatcher.dispatch(input(), admitted, async () => { count++; return { outcome: 'accepted' }; })).state).toBe('rejected');
    expect(count).toBe(1);
  });

  it('accepts idempotent attachment writes with reordered nested properties', async () => {
    const { store } = await setup();
    const reordered = { ...attachment, source: { nativeSessionId: 'A', providerId: 'codex', controllerId: 'host' }, boundary: { seq: 3, epoch: 'epoch' } };
    expect((await store.attach(reordered)).state).toBe('pending');
  });

});

const digest = (text: string) => createHash('sha256').update(text).digest('hex');
function prepared(text = quotedSessionContextPrefix({ id: attachment.operationId, sourceSession: source.nativeSessionId, capturedAt: attachment.capturedAt, text: attachment.text }) + 'new'): AgentPreparedTextInput {
  return { version: 1, providerId: target.providerId, nativeSessionId: 'B', nativeInputId: 'U', cwd: '/workspace', store: { authorityId: 'authority', storeId: 'store' },
    parts: [{ type: 'text', text }], content: { encoding: 'utf-8', bytes: Buffer.byteLength(text), sha256: digest(text) }, selections: { model: 'model', delivery: 'immediate' } };
}
function positive(witness: AgentPreparedTextInput) {
  const { delivery: _delivery, ...selections } = witness.selections;
  return serializeAgentInputMaterialization({ status: 'materialized', proof: { version: 1, providerId: witness.providerId, nativeSessionId: witness.nativeSessionId, nativeInputId: witness.nativeInputId,
    cwd: witness.cwd, store: witness.store, witnessSha256: digest(serializeAgentPreparedTextInput(witness)), contentSha256: witness.content.sha256, nativeSelectionsSha256: digest(JSON.stringify(selections)) } });
}
it('persists a nested witness with exact original context/input bindings, without preparation replay', async () => {
  const { path, store } = await setup(), witness = prepared();
  const first = await store.begin('succession', input(), witness);
  expect(first.preparedInput).toMatchObject({ version: 1, contextOperationId: 'succession', witness });
  const disk = JSON.parse(await readFile(join(path, 'context.json'), 'utf8'));
  expect(disk.version).toBe(3); expect(disk.attachments[0].deliveries[0].preparedInput.witness.parts).toEqual(witness.parts);
  expect((await store.begin('succession', input())).preparedInput).toEqual(first.preparedInput);
  await expect(store.begin('succession', input(), { ...witness, nativeInputId: 'other-U' })).rejects.toThrow(/identity|conflict/);
  const restored = new SessionSuccessionContextStore(path); await restored.ready;
  expect(restored.delivery('input')).toMatchObject({ state: 'unknown', preparedInput: first.preparedInput });
  expect(Number(restored.delivery('input')!.reservedBytes)).toBeGreaterThan(0);
});
it('rejects a witness for another native target or differently composed input before admission', async () => {
  const { store } = await setup();
  for (const witness of [prepared('new'), { ...prepared(), nativeSessionId: 'C' }, { ...prepared(), providerId: 'other' }]) {
    await expect(store.begin('succession', input(), witness)).rejects.toThrow(/binding|match/);
    expect(store.read('succession').deliveries).toEqual([]);
  }
});
it('requires exact positive proof for optional delivery and keeps actual acceptance separate', async () => {
  const { store } = await setup(), witness = prepared(); await store.begin('succession', input(), witness);
  await store.settle('succession', 'input', 'accepted', { disposition: 'queued' });
  const evidence = { operationId: 'input', target, roleRevision: 2, outcome: 'materialized' as const, nativeEvidence: positive(witness) };
  for (const invalid of [
    { ...evidence, outcome: 'not-dispatched' as const }, { ...evidence, nativeEvidence: 'native-row' },
    { ...evidence, nativeEvidence: positive({ ...witness, nativeInputId: 'other-U' }) },
    { ...evidence, nativeEvidence: positive({ ...witness, cwd: '/other' }) },
    ...['providerId', 'nativeSessionId'].map(key => ({ ...evidence, nativeEvidence: positive({ ...witness, [key]: 'other' }) })),
    { ...evidence, nativeEvidence: positive({ ...witness, store: { ...witness.store, storeId: 'other' } }) },
    { ...evidence, nativeEvidence: positive({ ...witness, selections: { model: 'other' } }) },
    ...['witnessSha256', 'contentSha256', 'nativeSelectionsSha256'].map(key => { const value = JSON.parse(evidence.nativeEvidence); value.proof[key] = '0'.repeat(64); return { ...evidence, nativeEvidence: serializeAgentInputMaterialization(value) }; }),
  ]) await expect(store.reconcile('succession', invalid)).rejects.toThrow();
  const result = await store.reconcile('succession', evidence);
  expect(result).toMatchObject({ state: 'materialized', inputAcceptance: { disposition: 'queued' }, nativeEvidence: evidence.nativeEvidence, reservedBytes: '00000000' });
  expect(await store.reconcile('succession', evidence)).toEqual(result);
  await expect(store.reconcile('succession', { ...evidence, nativeEvidence: positive({ ...witness, selections: {} }) })).rejects.toThrow();
});
it('rejects persisted optional evidence with changed original input/context binding and legacy version mixtures', async () => {
  const { path, store } = await setup(); await store.begin('succession', input(), prepared());
  const file = join(path, 'context.json'), original = await readFile(file, 'utf8');
  for (const mutation of [(state: any) => { state.attachments[0].deliveries[0].text = 'other'; },
    (state: any) => { state.attachments[0].text = '[{"role":"user","text":"changed"}]'; },
    (state: any) => { state.version = 2; }]) {
    const state = JSON.parse(original); mutation(state); await writeFile(file, JSON.stringify(state));
    await expect(new SessionSuccessionContextStore(path).ready).rejects.toThrow();
  }
});

it('optional definite rejection keeps context pending and releases only its settled proof obligation', async () => {
  const { path, store } = await setup(); await store.begin('succession', input(), prepared());
  const result = await store.settle('succession', 'input', 'rejected');
  expect(result.reservedBytes).toBe('00000000'); expect(store.read('succession').state).toBe('pending');
  const restored = new SessionSuccessionContextStore(path); await restored.ready;
  expect(await restored.begin('succession', input())).toEqual(result);
  await expect(restored.reconcile('succession', { operationId: 'input', roleRevision: 2, target, outcome: 'materialized', nativeEvidence: positive(prepared()) })).rejects.toThrow(/current state/);
});
