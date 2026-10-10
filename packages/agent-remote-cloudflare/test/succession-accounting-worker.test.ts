import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { build } from 'esbuild';
import { Miniflare } from 'miniflare';
import { expect, test } from 'vitest';
import { codecState } from './storage-codec-fixture.js';
import { sourceCompletionState, relationCompletionState } from './source-completion-fixture.js';
import { retentionState } from './retention-consumption-fixture.js';

const auth = { origin: 'https://relay.example', issuer: 'https://gateway.example', secret: 's'.repeat(32) };
/** An isolated state/store boundary; this test object has no Host or native-effect supplier. */
async function accountingWorker() {
  const directory = await mkdtemp(join(tmpdir(), 'arc-accounting-worker-'));
  const result = await build({ stdin: { contents: `
    import { createHash } from 'node:crypto';
    import { createRelayState } from '../agent-remote-hosted/src/state.ts';
    import { sourceCompletionBroker } from './test/source-completion-fixture.ts';
    import { retentionPeer } from './test/retention-consumption-fixture.ts';
    import { SqliteRelayStore, TEST_ONLY_COMPLETE_SQL_CODEC } from './src/storage.ts';
    import { encodeSqlSnapshot, quoteSqlRecord, SQL_CHUNK_BYTES } from './src/storage-codec.ts';
    const auth = ${JSON.stringify(auth)};
    export class AccountingFixture {
      constructor(ctx) {
        this.ctx = ctx; this.mode = 'normal'; this.publications = 0; this.failures = 0;
        this.storage = { sql: ctx.storage.sql, transactionSync: change => ctx.storage.transactionSync(change), sync: async () => {
          await ctx.storage.sync();
          if (this.retentionMode) {
            const mode = this.retentionMode; this.retentionMode = undefined;
            if (mode === 'reject') throw new Error('unknown retention sync');
            if (mode === 'hold') { this.entered = true; await new Promise(resolve => { this.release = resolve; }); }
          }
          if (this.mode === 'reject') throw new Error('unknown fixture sync');
          if (this.mode === 'hold') { this.entered = true; await new Promise(resolve => { this.release = resolve; }); }
        } };
        this.open();
      }
      open() {
        this.store = new SqliteRelayStore(this.storage, auth, TEST_ONLY_COMPLETE_SQL_CODEC);
        this.relay = createRelayState(auth, this.store, () => { this.failures++; }, () => { this.publications++; }, {
          measureSnapshot: state => ({ snapshotFormat: 3, recordFormat: 1, chunkBytes: SQL_CHUNK_BYTES, costs: encodeSqlSnapshot(state, auth).costs }), quoteRecord: quoteSqlRecord
        });
      }
      async fetch(request) {
        const url = new URL(request.url), path = url.pathname;
        if (path === '/retention/open') { this.retention?.close(); this.retention = retentionPeer(this.relay, auth); return new Response('ok'); }
        if (path === '/retention/status') return Response.json({ broker: this.retention.broker.snapshot(), counts: this.retention.counts() });
        if (path === '/retention/arm') {
          this.entered = false; this.retentionMode = url.searchParams.get('mode');
          if (this.retentionMode === 'rollback') for (const operation of ['INSERT', 'UPDATE', 'DELETE']) this.ctx.storage.sql.exec('CREATE TRIGGER fail_retention_' + operation + ' BEFORE ' + operation + " ON relay_snapshot_manifests BEGIN SELECT RAISE(ABORT, 'retention rollback'); END");
          return new Response('ok');
        }
        if (path === '/retention/clear') { for (const operation of ['INSERT', 'UPDATE', 'DELETE']) this.ctx.storage.sql.exec('DROP TRIGGER IF EXISTS fail_retention_' + operation); this.retentionMode = undefined; return new Response('ok'); }
        if (path.startsWith('/retention/')) {
          try {
            const action = path.slice('/retention/'.length);
            if (action === 'connect') await this.retention.connect();
            else if (action === 'registration') await this.retention.connect(this.invitationKey);
            else if (action === 'favorites') await this.retention.apply();
            else if (action === 'acknowledgment') await this.retention.acknowledge();
            else {
              const result = await this.retention[action === 'rotation' ? 'rotate' : action]();
              if (action === 'invitation' && result.status === 201) this.invitationKey = (await result.clone().json()).key;
              return result;
            }
            return new Response('ok');
          } catch (error) { return new Response(String(error), { status: 503 }); }
        }
        if (path === '/source/connect') { this.source?.broker.close(); this.source = await sourceCompletionBroker(this.relay, auth, () => {
          if (this.sourceMode === 'rollback' && this.sourceTarget === 'relation') this.ctx.storage.sql.exec("CREATE TRIGGER fail_source BEFORE UPDATE ON relay_snapshot_manifests WHEN NEW.kind = 'relationChange' BEGIN SELECT RAISE(ABORT, 'relation rollback'); END");
          else if (this.sourceMode === 'rollback') this.ctx.storage.sql.exec("CREATE TRIGGER fail_source BEFORE DELETE ON relay_snapshot_manifests WHEN OLD.kind = 'admission' BEGIN SELECT RAISE(ABORT, 'source rollback'); END");
          else this.mode = this.sourceMode ?? 'normal';
        }); return new Response('ok'); }
        if (path === '/source/reconcile') { this.sourceTarget = 'relation'; this.sourceMode = url.searchParams.get('mode'); try { return Response.json(await this.source.reconcile()); } catch (error) { return new Response(String(error), { status: 503 }); } }
        if (path === '/source/create') { this.sourceMode = url.searchParams.get('mode'); return await this.source.create(); }
        if (path === '/source/status') return Response.json({ broker: this.source.broker.snapshot(), counts: this.source.counts() });
        if (path === '/source/clear-fault') { this.ctx.storage.sql.exec('DROP TRIGGER IF EXISTS fail_source'); return new Response('ok'); }
        if (path === '/mode') { this.mode = url.searchParams.get('value'); this.entered = false; return new Response('ok'); }
        if (path === '/release') { this.mode = 'normal'; this.release?.(); return new Response('ok'); }
        if (path === '/status') return Response.json({ entered: this.entered, publications: this.publications, failures: this.failures, current: this.relay.read() });
        if (path === '/physical') return Response.json({ metadata: this.ctx.storage.sql.exec('SELECT * FROM relay_metadata').toArray(),
          manifests: this.ctx.storage.sql.exec('SELECT * FROM relay_snapshot_manifests ORDER BY kind, identity').toArray(),
          chunks: this.ctx.storage.sql.exec('SELECT * FROM relay_snapshot_chunks ORDER BY kind, identity, ordinal').toArray().map(row => ({ ...row, bytes: createHash('sha256').update(new Uint8Array(row.bytes)).digest('hex') })) });
        if (path === '/restore') return Response.json(new SqliteRelayStore(this.storage, auth, TEST_ONLY_COMPLETE_SQL_CODEC).initial);
        if (path === '/recover') { this.retention?.close(); this.retention = undefined; this.retentionMode = undefined; this.source?.broker.close(); this.source = undefined; this.mode = 'normal'; await this.relay.close(); this.open(); return new Response('ok'); }
        if (path === '/fault') {
          if (url.searchParams.get('on') === '1') this.ctx.storage.sql.exec("CREATE TRIGGER fail_accounting BEFORE UPDATE ON relay_snapshot_manifests WHEN NEW.kind = 'relayHeader' BEGIN SELECT RAISE(ABORT, 'fixture accounting rollback'); END");
          else this.ctx.storage.sql.exec('DROP TRIGGER IF EXISTS fail_accounting');
          return new Response('ok');
        }
        if (path === '/mutate') {
          const next = await request.json();
          try { await this.relay.mutate(draft => { Object.assign(draft, next); }); return new Response('committed'); }
          catch (error) { return new Response(String(error), { status: 500 }); }
        }
        return new Response('missing', { status: 404 });
      }
    }
    export default { fetch(request, env) { return env.STATE.get(env.STATE.idFromName('isolated')).fetch(request); } };
  `, resolveDir: process.cwd(), loader: 'ts' }, bundle: true, write: false, format: 'esm', platform: 'browser', conditions: ['workerd', 'worker', 'import'],
    external: ['node:*', 'cloudflare:*'], alias: {
      '@orchardworks/agent-remote-hosted/host-recovery': resolve('../agent-remote-hosted/src/host-recovery.ts'),
      '@orchardworks/agent-remote-hosted': resolve('../agent-remote-hosted/src/index.ts'),
    } });
  let mf: Miniflare;
  async function start() {
    mf = new Miniflare({ modules: true, script: result.outputFiles[0]!.text, compatibilityDate: '2026-06-01', compatibilityFlags: ['nodejs_compat'],
      durableObjects: { STATE: { className: 'AccountingFixture', useSQLite: true } }, durableObjectsPersist: join(directory, 'state') });
    await mf.ready;
  }
  try { await start(); } catch (error) { await rm(directory, { recursive: true, force: true }); throw error; }
  const request = (path: string, body?: object) => mf.dispatchFetch(auth.origin + path, { signal: AbortSignal.timeout(5000), ...(body ? { method: 'POST', body: JSON.stringify(body) } : {}) } as any);
  return { request, async json(path: string) { return await (await request(path)).json() as any; },
    async restart() { await mf.dispose(); await start(); }, async close() { await mf.dispose(); await rm(directory, { recursive: true, force: true }); } };
}

test('real Worker accounting holds sync, rolls back transaction faults and reopens complete outer10 after unknown sync', async () => {
  const f = await accountingWorker();
  try {
    const initial = codecState(auth);
    const unresolved: any = initial.tenants[0]!.broker.associations!.freezes.find(row => row.released === undefined)!;
    unresolved.receipt = { ...unresolved.receipt, version: 2, maxProjectionBytes: 65536 };
    expect((await f.request('/mutate', initial)).status).toBe(200);
    const before = await f.json('/status'); expect(before.current.version).toBe(10);
    await f.request('/mode?value=hold');
    let replied = false;
    const pending = f.request('/mutate', { securityEvents: [] }).then(response => { replied = true; return response; });
    const deadline = Date.now() + 3000; let held;
    do { held = await f.json('/status'); if (Date.now() > deadline) throw new Error('Worker hold deadline'); } while (!held.entered);
    expect(replied).toBe(false); expect(held.current).toEqual(before.current); expect(held.publications).toBe(before.publications);
    expect((await f.json('/restore')).securityEvents).toEqual([]);
    await f.request('/release'); expect((await pending).status).toBe(200);
    const released = await f.json('/status'); expect(released.publications).toBe(before.publications + 1);
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
    expect(reopened.current.version).toBe(10); expect(reopened.current.extraRelay).toBe('unknown complete evidence');
    expect(reopened.current.tenants[0].broker.associations).toEqual(initial.tenants[0]!.broker.associations);
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
