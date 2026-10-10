import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { build } from 'esbuild';
import { Miniflare } from 'miniflare';
import { expect, test } from 'vitest';
import { codecState } from './storage-codec-fixture.js';

const auth = { origin: 'https://relay.example', issuer: 'https://gateway.example', secret: 's'.repeat(32) };
/** An isolated state/store boundary; this test object has no Host or native-effect supplier. */
async function accountingWorker() {
  const directory = await mkdtemp(join(tmpdir(), 'arc-accounting-worker-'));
  const result = await build({ stdin: { contents: `
    import { createHash } from 'node:crypto';
    import { createRelayState } from '../agent-remote-hosted/src/state.ts';
    import { SqliteRelayStore, TEST_ONLY_COMPLETE_SQL_CODEC } from './src/storage.ts';
    import { encodeSqlSnapshot, quoteSqlRecord, SQL_CHUNK_BYTES } from './src/storage-codec.ts';
    const auth = ${JSON.stringify(auth)};
    export class AccountingFixture {
      constructor(ctx) {
        this.ctx = ctx; this.mode = 'normal'; this.publications = 0; this.failures = 0;
        this.storage = { sql: ctx.storage.sql, transactionSync: change => ctx.storage.transactionSync(change), sync: async () => {
          await ctx.storage.sync();
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
        if (path === '/mode') { this.mode = url.searchParams.get('value'); this.entered = false; return new Response('ok'); }
        if (path === '/release') { this.mode = 'normal'; this.release?.(); return new Response('ok'); }
        if (path === '/status') return Response.json({ entered: this.entered, publications: this.publications, failures: this.failures, current: this.relay.read() });
        if (path === '/physical') return Response.json({ metadata: this.ctx.storage.sql.exec('SELECT * FROM relay_metadata').toArray(),
          manifests: this.ctx.storage.sql.exec('SELECT * FROM relay_snapshot_manifests ORDER BY kind, identity').toArray(),
          chunks: this.ctx.storage.sql.exec('SELECT * FROM relay_snapshot_chunks ORDER BY kind, identity, ordinal').toArray().map(row => ({ ...row, bytes: createHash('sha256').update(new Uint8Array(row.bytes)).digest('hex') })) });
        if (path === '/restore') return Response.json(new SqliteRelayStore(this.storage, auth, TEST_ONLY_COMPLETE_SQL_CODEC).initial);
        if (path === '/recover') { this.mode = 'normal'; await this.relay.close(); this.open(); return new Response('ok'); }
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
