import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, it } from 'vitest';
import type { AgentSessionExtensions } from '@orchardworks/agent-provider-sdk';
import type { SessionWireAgent, AgentManagerEvent } from '@orchardworks/agent-remote-relay';
import { TpmCoordinator, type TpmSessionAccess } from './tpm.js';
import type { TpmRecord } from './tpm-store.js';
const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => { for (const close of cleanups.splice(0)) await close(); });
function record(id: string, lastReviewAt: number, nextCheckAt: number, pending = false): TpmRecord {
  return { version: 1, createKey: id, createFingerprint: id, creation: 'accepted', requirement: 'Goal', dirty: true, lastReviewAt, actions: {},
    ...(pending ? { reviewIntentId: id + '-review' } : {}),
    work: { id, revision: 1, title: id, providerId: 'codex', mainNativeSessionId: 'main-' + id, tpmNativeSessionId: 'tpm-' + id,
      phase: 'clarifying', waiting: 'none', paused: false, summary: '', nextAction: '', document: '', acceptance: '', evidence: [], createdAt: '2026', updatedAt: '2026', nextCheckAt,
      outbox: pending ? [{ id: id + '-review', target: 'tpm', purpose: 'review', text: 'review', status: 'accepted', createdAt: '2026' }] : [] } };
}
async function fixture() {
  const directory = await mkdtemp(join(tmpdir(), 'tpm-review-'));
  let available = false;
  const messages: string[] = [];
  const listeners = new Map<string, Set<(event: AgentManagerEvent) => void>>();
  const statuses = new Map<string, 'idle' | 'running'>();
  const recovery: Array<{ nativeSessionId: string; extensions: AgentSessionExtensions }> = [];
  const access: TpmSessionAccess = {
    supportedProviders: () => ['codex'], available: () => available,
    async acquire(_providerId, nativeSessionId) {
      const group = listeners.get(nativeSessionId) ?? new Set(); listeners.set(nativeSessionId, group);
      const agent = { agentId: nativeSessionId,
        snapshot: () => ({ payload: { id: nativeSessionId, providerId: 'codex', status: statuses.get(nativeSessionId) ?? 'idle', activeTurn: statuses.get(nativeSessionId) === 'running' ? { turnId: 'turn', startedAt: '2026' } : null,
          pendingInteractions: [], capabilities: { sendMessage: true }, runtimeInfo: { providerId: 'codex', sessionId: nativeSessionId, status: 'idle', cwd: directory } } }),
        subscribe: (listener: (event: AgentManagerEvent) => void) => { group.add(listener); return () => { group.delete(listener); }; },
        sendMessage: async () => { messages.push(nativeSessionId); statuses.set(nativeSessionId, 'running'); },
      } as unknown as SessionWireAgent;
      return { agent, release() {} };
    },
    async recover(_providerId, nativeSessionId, extensions) { recovery.push({ nativeSessionId, extensions }); },
    create: async () => { throw new Error('Unexpected creation'); }, execute: async (_agent, _operation, work) => work.dispatch(),
  };
  const coordinator = new TpmCoordinator({ stateDirectory: directory, now: () => 100000, tickMs: 1000000, minimumReviewMs: 1 }, access);
  await coordinator.ready;
  cleanups.push(async () => { await coordinator.close(); await rm(directory, { recursive: true, force: true }); });
  const tick = async () => { available = true; await coordinator.tick(); await new Promise(resolve => setTimeout(resolve, 20)); };
  return { coordinator, access, messages, listeners, statuses, recovery, tick };
}
it('gives a due work its review and attaches every active work despite earlier non-due works', async () => {
  const f = await fixture();
  for (const item of [record('a', 1, 900000), record('b', 2, 900000), record('due', 3, 0), record('d', 4, 900000)]) await f.coordinator.store.insert(item);
  for (let count = 0; count < 4; count++) await f.tick();
  expect(f.messages).toEqual(['tpm-due']);
  for (const id of ['a', 'b', 'due', 'd']) expect(f.listeners.get('main-' + id)?.size).toBe(1);
}, 10000);
it('reserves review capacity before awaited claims with an already-running review', async () => {
  const f = await fixture(); f.statuses.set('tpm-running', 'running');
  for (const item of [record('running', 50000, 900000, true), record('a', 1, 0), record('b', 2, 0)]) await f.coordinator.store.insert(item);
  for (let count = 0; count < 4; count++) await f.tick();
  expect(f.messages).toHaveLength(1);
  expect(f.coordinator.store.all().filter(item => item.reviewIntentId)).toHaveLength(2);
}, 10000);
it('rejects recovered TPM identities bound to any main or another TPM before recovery', async () => {
  const f = await fixture(); const item = record('lost', 0, 0); item.creation = 'unknown'; delete item.work.tpmNativeSessionId;
  await f.coordinator.store.insert(item); await f.coordinator.store.insert(record('other', 0, 900000));
  for (const nativeSessionId of ['main-lost', 'main-other', 'tpm-other']) await expect(f.coordinator.action({ id: 'lost', revision: 1, action: 'resolve', intentId: 'creation', resolution: 'accepted', nativeSessionId, operationId: nativeSessionId }, 'scope')).rejects.toThrow(/bound|main|another/i);
  expect(f.recovery).toEqual([]);
}, 10000);
it('verifies and rebinds recovered creation before accepting its durable native identity', async () => {
  const f = await fixture(); const item = record('lost', 0, 0); item.creation = 'unknown'; delete item.work.tpmNativeSessionId;
  await f.coordinator.store.insert(item); await f.tick();
  const result = await f.coordinator.action({ id: 'lost', revision: 1, action: 'resolve', intentId: 'creation', resolution: 'accepted', nativeSessionId: 'recovered', operationId: 'resolve' }, 'scope');
  expect(f.recovery).toHaveLength(1); expect(f.recovery[0]?.extensions.instructions).toContain('lost'); expect(f.recovery[0]?.extensions.tools?.length).toBe(11);
  expect(result.tpmNativeSessionId).toBe('recovered'); expect(result.paused).toBe(false);
  await f.tick(); expect(f.messages).toEqual(['recovered']);
}, 10000);
it('does not let a work tool implicitly reopen completed delivery', async () => {
  const f = await fixture(); const item = record('done', 0, 0); item.work.phase = 'completed'; item.work.acceptance = 'Accepted'; item.work.evidence = ['Evidence'];
  await f.coordinator.store.insert(item); await f.tick();
  const tool = (await f.coordinator.extensions('codex', 'tpm-done'))!.tools!.find(tool => tool.name === 'update_work')!;
  await expect(tool.execute({ revision: 1, phase: 'implementing', waiting: 'none', summary: '', nextAction: '' })).rejects.toThrow(/reopen/i);
  expect((await f.coordinator.get('done')).phase).toBe('completed');
}, 10000);
it('applies the same two-review limit to persisted initial TPM inputs', async () => {
  const f = await fixture();
  for (const id of ['a', 'b', 'c']) {
    const item = record(id, 0, 0); item.work.outbox = [{ id: id + '-initial', target: 'tpm', purpose: 'initial', text: 'Initial request', status: 'prepared', createdAt: '2026' }];
    await f.coordinator.store.insert(item);
  }
  for (let count = 0; count < 4; count++) await f.tick();
  expect(f.messages).toHaveLength(2);
  expect(f.coordinator.store.all().filter(item => item.reviewIntentId)).toHaveLength(2);
  expect(f.coordinator.store.all().flatMap(item => item.work.outbox ?? []).filter(intent => intent.status === 'prepared')).toHaveLength(1);
}, 10000);
it('retains uncertainty when recovered binding verification fails or is unsupported', async () => {
  const f = await fixture(); const item = record('lost', 0, 0); item.creation = 'unknown'; delete item.work.tpmNativeSessionId;
  await f.coordinator.store.insert(item); await f.tick();
  const action = { id: 'lost', revision: 1, action: 'resolve' as const, intentId: 'creation', resolution: 'accepted' as const, nativeSessionId: 'recovered', operationId: 'resolve' };
  f.access.recover = async () => { throw new Error('Native policy denied'); };
  await expect(f.coordinator.action(action, 'scope')).rejects.toThrow('Native policy denied');
  delete f.access.recover;
  await expect(f.coordinator.action(action, 'scope')).rejects.toThrow(/safely recover/);
  expect(f.coordinator.store.get('lost').creation).toBe('unknown');
  expect((await f.coordinator.get('lost')).tpmNativeSessionId).toBeUndefined();
}, 10000);
it('ignores historical TPM completion while an accepted review remains pending', async () => {
  const f = await fixture(); await f.coordinator.store.insert(record('pending', 0, 900000, true)); await f.tick();
  for (const listener of f.listeners.get('tpm-pending') ?? []) listener({ type: 'agent_stream', agentId: 'tpm-pending', event: { type: 'turn_completed', provider: 'codex', turnId: 'historical' }, delivery: 'history', timestamp: '2026' });
  await f.coordinator.store.flush();
  expect(f.coordinator.store.get('pending').reviewIntentId).toBe('pending-review'); expect(f.messages).toEqual([]);
}, 10000);
it('uses a fresh reflection after an accepted overdue review resumes idle without assessment', async () => {
  const f = await fixture(); await f.coordinator.store.insert(record('overdue', 0, 0, true)); await f.tick();
  expect(f.messages).toEqual(['tpm-overdue']);
  const item = f.coordinator.store.get('overdue');
  expect(item.work.outbox?.find(intent => intent.id === 'overdue-review')?.status).toBe('accepted');
  expect(item.reviewIntentId).not.toBe('overdue-review'); expect(item.work.outbox).toHaveLength(2);
}, 10000);
it('keeps bounded work document versions accessible without changing the current work revision', async () => {
  const f = await fixture(); const item = record('documents', 0, 900000); item.work.document = 'Original'; item.work.acceptance = 'Original criteria';
  await f.coordinator.store.insert(item); await f.tick();
  const tools = (await f.coordinator.extensions('codex', 'tpm-documents'))!.tools!;
  const write = tools.find(tool => tool.name === 'write_work_document')!, read = tools.find(tool => tool.name === 'read_work')!;
  const current = await f.coordinator.get('documents');
  await write.execute({ revision: current.revision, document: 'Updated', acceptance: 'Updated criteria' });
  const version = JSON.parse(await read.execute({ documentRevision: current.revision }));
  expect(version.document).toBe('Original'); expect(version.acceptance).toBe('Original criteria');
  expect(version.revision).toBe(current.revision + 1); expect(version.documentRevision).toBe(current.revision);
  expect(version.documentVersions).toContainEqual({ revision: current.revision });
  await expect(read.execute({ documentRevision: 999 })).rejects.toThrow(/document revision/i);
  expect((await f.coordinator.get('documents')).document).toBe('Updated');
}, 10000);

it('keeps a referenced document version stable across assessments and later document edits', async () => {
  const f = await fixture(); await f.coordinator.store.insert(record('versions', 0, 900000)); await f.tick();
  const tools = (await f.coordinator.extensions('codex', 'tpm-versions'))!.tools!;
  const call = async (name: string, input: unknown) => JSON.parse(await tools.find(tool => tool.name === name)!.execute(input));
  const original = await call('write_work_document', { revision: 1, document: 'First specification', acceptance: 'First criteria' });
  const version = (await call('read_work', {})).documentRevision;
  await call('update_work', { revision: original.revision, phase: 'clarifying', waiting: 'none', summary: 'Assessment changed', nextAction: 'Wait' });
  const current = await f.coordinator.get('versions');
  await call('write_work_document', { revision: current.revision, document: 'Second specification', acceptance: 'Second criteria' });
  const historical = await call('read_work', { documentRevision: version });
  expect(historical.document).toBe('First specification'); expect(historical.acceptance).toBe('First criteria');
  expect(historical.documentRevision).toBe(version);
}, 10000);

it('persists compact action receipts and returns current work when the same action is retried', async () => {
  const f = await fixture(); await f.coordinator.store.insert(record('receipts', 0, 900000));
  const input = { id: 'receipts', revision: 1, action: 'pause' as const, operationId: 'pause' };
  await f.coordinator.action(input, 'scope');
  await f.coordinator.store.update('receipts', undefined, item => { item.work.document = 'Latest specification'; });
  const repeated = await f.coordinator.action(input, 'scope');
  expect(repeated.revision).toBe(3); expect(repeated.document).toBe('Latest specification');
  const receipts = Object.values(f.coordinator.store.get('receipts').actions);
  expect(receipts).toEqual([{ fingerprint: expect.any(String), revision: 2 }]);
}, 10000);

it('paginates bounded catalog summaries without losing work identities or exposing large artifacts', async () => {
  const f = await fixture();
  for (let index = 0; index < 105; index++) {
    const item = record(`catalog-${String(index).padStart(3, '0')}`, 0, 900000); item.work.paused = true;
    item.work.document = 'Private specification'; item.work.acceptance = 'Full criteria'; item.work.evidence = ['Evidence'];
    item.work.outbox = [{ id: 'pending', target: 'main', purpose: 'implementation', text: 'Pending message', status: 'unknown', createdAt: '2026' }];
    await f.coordinator.store.insert(item);
  }
  const first = await f.coordinator.list();
  expect(first.works).toHaveLength(100); expect(first.nextCursor).toBeDefined();
  expect(Buffer.byteLength(JSON.stringify(first))).toBeLessThanOrEqual(512 * 1024);
  expect(first.works[0]).toMatchObject({ detailsOmitted: true, document: '', acceptance: '', evidence: [] });
  expect(first.works[0]?.outbox?.[0]?.text).toMatch(/omitted/i);
  const last = await f.coordinator.list(first.nextCursor);
  expect(last.works).toHaveLength(5); expect(last.nextCursor).toBeUndefined();
  expect(new Set([...first.works, ...last.works].map(work => work.id)).size).toBe(105);
  expect((await f.coordinator.get(first.works[0]!.id)).document).toBe('Private specification');
  await expect(f.coordinator.list('invalid/cursor')).rejects.toThrow(/cursor/i);
}, 10000);

it('advances a catalog cursor at the UTF-8 budget before the item-count limit', async () => {
  const f = await fixture();
  for (let index = 0; index < 10; index++) {
    const item = record(`large-catalog-${index}`, 0, 900000); item.work.paused = true;
    item.work.outbox = Array.from({ length: 200 }, (_, intent) => ({ id: String(intent).padEnd(128, 'a'), target: 'main' as const, purpose: 'p'.repeat(64), text: 'Full pending text', status: 'unknown' as const, createdAt: 't'.repeat(128) }));
    await f.coordinator.store.insert(item);
  }
  const first = await f.coordinator.list();
  expect(first.works.length).toBeGreaterThan(0); expect(first.works.length).toBeLessThan(10);
  expect(first.nextCursor).toBeDefined(); expect(Buffer.byteLength(JSON.stringify(first))).toBeLessThanOrEqual(512 * 1024);
  const remaining = await f.coordinator.list(first.nextCursor);
  expect(first.works.length + remaining.works.length).toBe(10);
}, 10000);

it('refuses oversized pending outboxes without dropping prepared communication', async () => {
  const f = await fixture(); await f.coordinator.store.insert(record('budget', 0, 900000)); await f.tick();
  f.statuses.set('main-budget', 'running');
  const send = (await f.coordinator.extensions('codex', 'tpm-budget'))!.tools!.find(tool => tool.name === 'send_main_message')!;
  const todo = (await f.coordinator.get('budget')).todo!;
  const start = (await f.coordinator.extensions('codex', 'tpm-budget'))!.tools!.find(tool => tool.name === 'update_todo_step')!;
  await start.execute({ revision: todo.revision, stepId: 'clarify', status: 'in_progress', note: 'Investigating' });
  const input = { todoStepId: 'clarify', purpose: 'consultation', text: '中'.repeat(48000) };
  for (let index = 0; index < 3; index++) await send.execute({ ...input, operationId: `pending-${index}` });
  await expect(send.execute({ ...input, operationId: 'too-large' })).rejects.toThrow(/pending|budget|size/i);
  const work = await f.coordinator.get('budget');
  expect(work.outbox).toHaveLength(3); expect(work.outbox?.every(intent => intent.status === 'prepared')).toBe(true);
  expect(Buffer.byteLength(JSON.stringify(work.outbox))).toBeLessThanOrEqual(512 * 1024);
}, 10000);

it('evicts settled communication before refusing a new pending message budget', async () => {
  const f = await fixture(); const item = record('settled-budget', 0, 900000);
  item.work.outbox = [0, 1, 2].map(index => ({ id: `settled-${index}`, target: 'main' as const, purpose: 'implementation', text: '中'.repeat(48000), status: 'accepted' as const, createdAt: '2026' }));
  await f.coordinator.store.insert(item); await f.tick(); f.statuses.set('main-settled-budget', 'running');
  const send = (await f.coordinator.extensions('codex', 'tpm-settled-budget'))!.tools!.find(tool => tool.name === 'send_main_message')!;
  const todo = (await f.coordinator.get('settled-budget')).todo!;
  const start = (await f.coordinator.extensions('codex', 'tpm-settled-budget'))!.tools!.find(tool => tool.name === 'update_todo_step')!;
  await start.execute({ revision: todo.revision, stepId: 'clarify', status: 'in_progress', note: 'Investigating' });
  await send.execute({ todoStepId: 'clarify', purpose: 'consultation', text: '中'.repeat(48000), operationId: 'new-pending' });
  const outbox = (await f.coordinator.get('settled-budget')).outbox!;
  expect(outbox.find(intent => intent.status === 'prepared')).toBeDefined();
  expect(outbox).toHaveLength(3); expect(Buffer.byteLength(JSON.stringify(outbox))).toBeLessThanOrEqual(512 * 1024);
}, 10000);

it('isolates corrupt TPM recovery from ordinary session extensions and shutdown', async () => {
  const f = await fixture(); const directory = await mkdtemp(join(tmpdir(), 'tpm-corrupt-'));
  await writeFile(join(directory, 'invalid.json'), '{invalid');
  const coordinator = new TpmCoordinator({ stateDirectory: directory }, f.access);
  cleanups.push(async () => { await coordinator.close(); await rm(directory, { recursive: true, force: true }); });
  await expect(coordinator.ready).rejects.toThrow();
  await expect(coordinator.extensions('codex', 'ordinary')).resolves.toBeUndefined();
  await expect(coordinator.list()).rejects.toThrow();
  await expect(coordinator.close()).resolves.toBeUndefined();
}, 10000);
