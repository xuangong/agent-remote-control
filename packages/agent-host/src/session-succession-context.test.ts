import { mkdtemp, rm } from 'node:fs/promises';
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

});
