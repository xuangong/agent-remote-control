import { expect, test } from 'vitest';
import { codecState } from './storage-codec-fixture.js';
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
    expect(physical.metadata[0].version).toBe(3); expect(physical.manifests.every((row: any) => row.format === 1)).toBe(true);
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

for (const mode of ['hold', 'rollback', 'reject']) test(`real Worker source completion keeps its atomic snapshot through ${mode}`, async () => {
  const f = await accountingWorker();
  try {
    expect((await f.request('/mutate', sourceCompletionState(auth))).status).toBe(200);
    expect((await f.request('/source/connect')).status).toBe(200);
    let replied = false; const pending = f.request('/source/create?mode=' + mode).then(response => { replied = true; return response; });
    if (mode === 'hold') {
      const deadline = Date.now() + 3000; let status;
      do { status = await f.json('/status'); if (Date.now() > deadline) throw new Error('Source Worker sync deadline'); } while (!status.entered);
      expect(replied).toBe(false); expect(status.current.tenants[0].broker.associations.admissions).toHaveLength(1);
      expect((await f.json('/source/status')).broker).toEqual(status.current.tenants[0].broker);
      const local = (await f.json('/restore')).tenants[0].broker;
      expect(local.bindings).toHaveLength(2); expect(local.creations).toHaveLength(1); expect(local.sharing.reservations[0].agentId).toBe('reader-agent'); expect(local.associations.admissions).toHaveLength(0);
      await f.request('/release'); expect((await pending).status).toBe(200);
    } else {
      expect((await pending).status).toBe(503);
      const status = await f.json('/status'), source = await f.json('/source/status');
      expect(source.broker).toEqual(status.current.tenants[0].broker); expect(source.broker.associations.admissions).toHaveLength(1);
      const local = (await f.json('/restore')).tenants[0].broker;
      expect(local.associations.admissions).toHaveLength(mode === 'rollback' ? 1 : 0);
      expect(local.bindings).toHaveLength(mode === 'rollback' ? 1 : 2); expect(local.creations).toHaveLength(mode === 'rollback' ? 0 : 1);
      if (mode === 'rollback') await f.request('/source/clear-fault');
    }
    expect((await f.json('/source/status')).counts.creates).toBe(1);
    await f.restart(); await f.request('/source/connect'); expect((await f.request('/source/create')).status).toBe(200);
    const recovered = await f.json('/source/status'); expect(recovered.counts.creates).toBe(0); expect(recovered.counts.readbacks).toBe(mode === 'rollback' ? 1 : 0);
    expect(recovered.broker.associations.admissions).toHaveLength(0); expect(recovered.broker.associations.revision).toBe(2);
  } finally { await f.close(); }
}, 30000);

for (const mode of ['rollback', 'reject']) test(`real Worker relation recovery retains complete phase evidence after ${mode}`, async () => {
  const f = await accountingWorker();
  try {
    expect((await f.request('/mutate', relationCompletionState(auth))).status).toBe(200); await f.request('/source/connect');
    const before = await f.json('/source/status'), physical = await f.json('/physical');
    expect((await f.request('/source/reconcile?mode=' + mode)).status).toBe(503);
    expect((await f.json('/source/status')).broker).toEqual(before.broker);
    expect((await f.json('/status')).current.tenants[0].broker).toEqual(before.broker);
    const local = (await f.json('/restore')).tenants[0].broker.associations;
    expect(local.relationChanges[0].phase).toBe(mode === 'rollback' ? 'overlay_applied' : 'committed'); expect(local.revision).toBe(mode === 'rollback' ? 10 : 11);
    if (mode === 'rollback') { expect(await f.json('/physical')).toEqual(physical); await f.request('/source/clear-fault'); }
    await f.restart(); await f.request('/source/connect'); expect((await f.request('/source/reconcile')).status).toBe(200);
    const recovered = (await f.json('/source/status')).broker.associations;
    expect(recovered.relationChanges[0].phase).toBe('committed'); expect(recovered.revision).toBe(11);
  } finally { await f.close(); }
}, 30000);

for (const consumer of ['terminal', 'favorites', 'invitation', 'registration', 'rotation', 'acknowledgment', 'revoke'] as const) {
  for (const mode of ['hold', 'rollback', 'reject']) test(`retention ${consumer} fences actual Worker publication through ${mode}`, async () => {
    const f = await accountingWorker();
    try {
      const initial = retentionState(auth, true);
      if (consumer === 'invitation' || consumer === 'registration') {
        const broker = initial.tenants[0]!.broker; broker.hosts = []; broker.keys = [];
        broker.revokedHosts![0]!.revocationId = '00000000-0000-4000-8000-000000000002';
      }
      expect((await f.request('/mutate', initial)).status).toBe(200); await f.request('/retention/open');
      if (consumer === 'registration') expect((await f.request('/retention/invitation')).status).toBe(201);
      else if (consumer !== 'invitation') expect((await f.request('/retention/connect')).status).toBe(200);
      if (consumer === 'favorites' || consumer === 'revoke') expect((await f.request('/retention/terminal')).status).toBe(200);
      if (consumer === 'acknowledgment') expect((await f.request('/retention/rotation')).status).toBe(200);
      const before = await f.json('/status'), peer = await f.json('/retention/status'), physical = await f.json('/physical');
      await f.request('/retention/arm?mode=' + mode);
      let replied = false;
      const pending = f.request('/retention/' + consumer).then(response => { replied = true; return response; });
      if (mode === 'hold') {
        const deadline = Date.now() + 3000; let status;
        do { status = await f.json('/status'); if (Date.now() > deadline) throw new Error('Retention Worker sync deadline'); } while (!status.entered);
        expect(replied).toBe(false); expect(status.current).toEqual(before.current); expect(status.publications).toBe(before.publications);
        const held = await f.json('/retention/status'); expect(held.broker).toEqual(peer.broker);
        expect(held.counts).toMatchObject({ releases: peer.counts.releases, issued: peer.counts.issued, registered: peer.counts.registered });
        if (consumer === 'terminal') expect((await f.json('/restore')).tenants[0]).toMatchObject({ favoritesSuccession: { receipts: [{ status: 'pending' }] }, broker: { associations: { freezes: [{ released: 'committed', projection: { version: 1 } }] } } });
        await f.request('/release'); expect((await pending).status).toBeLessThan(400);
      } else {
        const response = await pending;
        if (!['registration', 'acknowledgment'].includes(consumer)) expect(response.status).toBeGreaterThanOrEqual(500);
        const status = await f.json('/status'), failed = await f.json('/retention/status');
        expect(status.current).toEqual(before.current); expect(status.publications).toBe(before.publications); expect(failed.broker).toEqual(peer.broker);
        expect(failed.counts).toMatchObject({ releases: peer.counts.releases, issued: peer.counts.issued, registered: peer.counts.registered });
        if (mode === 'rollback') expect(await f.json('/physical')).toEqual(physical);
      }
      const restored = await f.json('/restore');
      if (mode === 'rollback') expect(restored).toEqual(before.current);
      else if (consumer === 'terminal' || consumer === 'favorites') {
        expect(restored.tenants[0].broker.associations.freezes[0].projection).toBeDefined();
        expect(restored.tenants[0].favoritesSuccession.receipts[0].status).toBe(consumer === 'terminal' ? 'pending' : 'applied');
        expect(restored.sessionStars[0].nativeSessionId).toBe(consumer === 'terminal' ? 'A' : 'B');
      } else if (consumer === 'rotation') expect(restored.tenants[0].broker.keys).toHaveLength(2);
      else if (consumer === 'acknowledgment') expect(restored.tenants[0].broker.keys).toHaveLength(1);
      else if (consumer === 'invitation') expect(restored.tenants[0].broker.pairings).toHaveLength(2);
      else if (consumer === 'registration') expect(restored.tenants[0].broker.hosts[0]).toMatchObject({ id: 'mapped-host', credentialRotation: true });
      else {
        expect(restored.tenants[0].broker.hosts).toEqual([]); expect(restored.tenants[0].broker.keys).toEqual([]);
        expect(restored.tenants[0].broker.associations).toEqual(before.current.tenants[0].broker.associations);
        expect(restored.tenants[0].favoritesSuccession).toEqual(before.current.tenants[0].favoritesSuccession);
        expect(restored.tenants[0].broker.sharing).toEqual(before.current.tenants[0].broker.sharing);
      }
      await f.request('/retention/clear'); await f.restart();
      expect((await f.json('/status')).current).toEqual(restored);
      if (consumer === 'terminal' || consumer === 'favorites') {
        await f.request('/retention/open'); await f.request('/retention/connect');
        expect((await f.request('/retention/terminal')).status).toBe(200);
        expect((await f.request('/retention/favorites')).status).toBe(200);
        const applied = (await f.json('/status')).current;
        expect((await f.request('/retention/favorites')).status).toBe(200);
        expect((await f.json('/status')).current).toEqual(applied);
      } else if (consumer === 'rotation' && mode !== 'rollback') {
        await f.request('/retention/open'); await f.request('/retention/connect');
        expect((await f.json('/status')).current.tenants[0].broker.keys).toEqual(restored.tenants[0].broker.keys);
        expect((await f.request('/retention/rotation')).status).toBe(409);
        expect((await f.json('/retention/status')).counts.issued).toBe(0);
      }
    } finally { await f.close(); }
  }, 30000);
}
