import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, test } from 'vitest';
import { TpmStore, type TpmRecord } from './tpm-store.js';
const dirs: string[] = [];
afterEach(async () => { await Promise.all(dirs.splice(0).map(path => rm(path, { recursive: true, force: true }))); });
function record(): TpmRecord {
  return { version: 1, createKey: 'scope:op', createFingerprint: 'a', creation: 'prepared', requirement: 'goal', dirty: true, lastReviewAt: 0, actions: {},
    work: { id: 'test-work', revision: 1, title: 'Example', providerId: 'codex', mainNativeSessionId: 'main', phase: 'clarifying', waiting: 'none', paused: false, summary: '', nextAction: '', document: '', acceptance: '', evidence: [], createdAt: '2026-10-09T00:00:00Z', updatedAt: '2026-10-09T00:00:00Z', nextCheckAt: 0, outbox: [] } };
}
test('durably recovers dispatching intents as unknown without retrying creation', async () => {
  const path = await mkdtemp(join(tmpdir(), 'arc-tpm-')); dirs.push(path);
  const store = new TpmStore(path); await store.ready;
  const value = record(); value.creation = 'dispatching';
  value.work.outbox!.push({ id: 'send', target: 'main', status: 'dispatching', text: 'implement', purpose: 'implementation', createdAt: value.work.createdAt });
  await store.insert(value);
  const restored = new TpmStore(path); await restored.ready;
  expect(restored.get(value.work.id).creation).toBe('unknown');
  expect(restored.get(value.work.id).work.outbox![0]!.status).toBe('unknown');
});
test('serializes revision checks and does not mutate memory after rejected writes', async () => {
  const path = await mkdtemp(join(tmpdir(), 'arc-tpm-')); dirs.push(path);
  const store = new TpmStore(path); await store.ready; await store.insert(record());
  const results = await Promise.allSettled([store.update('test-work', 1, item => { item.work.summary = 'one'; }), store.update('test-work', 1, item => { item.work.summary = 'two'; })]);
  expect(results.map(value => value.status)).toEqual(['fulfilled', 'rejected']);
  expect(store.get('test-work').work.summary).toBe('one');
  expect(() => store.get('../escape')).toThrow();
});
