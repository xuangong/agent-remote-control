import { expect, test } from 'vitest';
import { buildCompleteRelayState as codecState } from '@orchardworks/agent-relay-core/testing';
import { SQL_SNAPSHOT_FORMAT } from '../src/storage-codec.js';
import { sourceCompletionState, relationCompletionState } from './source-completion-fixture.js';
import { retentionState } from './retention-consumption-fixture.js';
import { accountingWorker, accountingAuth as auth } from './accounting-worker-fixture.js';

test('real Worker accounting migrates legacy state, holds sync, rolls back faults and reopens complete evidence after unknown sync', async () => {
  const f = await accountingWorker();
  try {
    const initial = codecState(auth);
    const unresolved: any = initial.tenants[0]!.broker.associations!.freezes.find(row => row.released === undefined)!;
    unresolved.receipt = { ...unresolved.receipt, version: 2, maxProjectionBytes: 65536 };
    expect(initial.version).toBe(9); expect(initial.tenants[0]!.broker.associations!.version).toBe(5);
    const migrated = structuredClone(initial);
    migrated.version = 11; migrated.successionAccounting = true; migrated.tenants[0]!.broker.associations!.version = 6;
    expect((await f.request('/mutate', initial)).status).toBe(200);
    const before = await f.json('/status'); expect(before.current).toEqual(migrated);
    await f.request('/mode?value=hold');
    let replied = false;
    const pending = f.request('/mutate', { securityEvents: [] }).then(response => { replied = true; return response; });
    const deadline = Date.now() + 3000; let held;
    do { held = await f.json('/status'); if (Date.now() > deadline) throw new Error('Worker hold deadline'); } while (!held.entered);
    expect(replied).toBe(false); expect(held.current).toEqual(before.current); expect(held.publications).toBe(before.publications);
    const committed = { ...migrated, securityEvents: [] };
    expect(await f.json('/restore')).toEqual(committed);
    await f.request('/release'); expect((await pending).status).toBe(200);
    const released = await f.json('/status'); expect(released.publications).toBe(before.publications + 1);
    expect(released.current).toEqual(committed);
    const physical = await f.json('/physical');
    expect(physical.metadata[0].version).toBe(SQL_SNAPSHOT_FORMAT); expect(physical.manifests.every((row: any) => row.format === 1)).toBe(true);
    await f.request('/fault?on=1');
    expect((await f.request('/mutate', { extraRelay: 'must roll back' })).status).toBe(500);
    expect(await f.json('/physical')).toEqual(physical);
    expect((await f.json('/status')).current).toEqual(released.current);
    await f.request('/fault?on=0'); await f.request('/recover');
    await f.request('/mode?value=reject');
    expect((await f.request('/mutate', { extraRelay: 'unknown complete evidence' })).status).toBe(500);
    const unknown = await f.json('/status'); expect(unknown.publications).toBe(released.publications); expect(unknown.failures).toBe(2);
    expect(unknown.current.extraRelay).not.toBe('unknown complete evidence');
    expect((await f.json('/restore')).extraRelay).toBe('unknown complete evidence');
    await f.restart();
    const reopened = await f.json('/status');
    expect(reopened.current).toEqual({ ...committed, extraRelay: 'unknown complete evidence',
      sessions: committed.sessions.map(session => ({ ...session, grant: { ...session.grant, expiresAt: 0 } })) });
  } finally { await f.close(); }
}, 30000);
