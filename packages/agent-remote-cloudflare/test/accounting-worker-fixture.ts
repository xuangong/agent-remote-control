import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { build } from 'esbuild';
import { Miniflare } from 'miniflare';

export const accountingAuth = { origin: 'https://relay.example', issuer: 'https://gateway.example', secret: 's'.repeat(32) };
/** An isolated state/store boundary; this test object has no Host or native-effect supplier. */
export async function accountingWorker() {
  const directory = await mkdtemp(join(tmpdir(), 'arc-accounting-worker-'));
  const result = await build({ stdin: { contents: `
    import { createHash } from 'node:crypto';
    import { createRelayState } from '../agent-remote-hosted/src/state.ts';
    import { sourceCompletionBroker } from './test/source-completion-fixture.ts';
    import { retentionPeer } from './test/retention-consumption-fixture.ts';
    import { SqliteRelayStore, TEST_ONLY_COMPLETE_SQL_CODEC } from './src/storage.ts';
    import { encodeSqlSnapshot, quoteSqlRecord, SQL_CHUNK_BYTES } from './src/storage-codec.ts';
    const auth = ${JSON.stringify(accountingAuth)};
    export class AccountingFixture {
      constructor(ctx) {
        this.ctx = ctx; this.mode = 'normal'; this.publications = 0; this.failures = 0;
        this.observed = { commitEntries: 0, commitCompleted: 0, measureCalls: 0, quoteCalls: 0,
          transactionEntries: 0, transactionCompleted: 0, transactionMilliseconds: 0,
          syncEntries: 0, physicalSyncCompleted: 0, physicalSyncMilliseconds: 0, gateCompleted: 0,
          statements: [], transactions: [] };
        this.phase = 'construction';
        this.storage = { sql: { exec: (query, ...bindings) => {
          const entry = { phase: this.phase, query, kind: typeof bindings[0] === 'string' ? bindings[0] : undefined,
            identity: typeof bindings[1] === 'string' ? bindings[1] : undefined, succeeded: false };
          this.observed.statements.push(entry);
          try { const cursor = ctx.storage.sql.exec(query, ...bindings); entry.succeeded = true; return cursor; }
          catch (error) { entry.error = String(error); throw error; }
        } }, transactionSync: change => {
          this.observed.transactionEntries++; const start = performance.now();
          const entry = { owner: this.phase, statementStart: this.observed.statements.length, succeeded: false };
          this.observed.transactions.push(entry);
          try { const result = ctx.storage.transactionSync(change); entry.succeeded = true; this.observed.transactionCompleted++; return result; }
          catch (error) { entry.error = String(error); throw error; }
          finally { entry.statementEnd = this.observed.statements.length; entry.milliseconds = performance.now() - start; this.observed.transactionMilliseconds += entry.milliseconds; }
        }, sync: async () => {
          this.observed.syncEntries++; const start = performance.now();
          try { await ctx.storage.sync(); this.observed.physicalSyncCompleted++; }
          finally { this.observed.physicalSyncMilliseconds += performance.now() - start; }
          if (this.retentionMode) {
            const mode = this.retentionMode; this.retentionMode = undefined;
            if (mode === 'reject') throw new Error('unknown retention sync');
            if (mode === 'hold') { this.entered = true; await new Promise(resolve => { this.release = resolve; }); }
          }
          if (this.mode === 'reject') throw new Error('unknown fixture sync');
          if (this.mode === 'hold') { this.entered = true; await new Promise(resolve => { this.release = resolve; }); }
          this.observed.gateCompleted++;
        } };
        this.open();
      }
      open() {
        this.store = new SqliteRelayStore(this.storage, auth, TEST_ONLY_COMPLETE_SQL_CODEC);
        const commit = this.store.commit.bind(this.store);
        this.store.commit = async state => {
          this.observed.commitEntries++; this.phase = 'commit';
          try { await commit(state); this.observed.commitCompleted++; }
          finally { this.phase = 'inspection'; }
        };
        this.relay = createRelayState(auth, this.store, () => { this.failures++; }, () => { this.publications++; }, {
          measureSnapshot: state => { this.observed.measureCalls++; return { snapshotFormat: 3, recordFormat: 1, chunkBytes: SQL_CHUNK_BYTES, costs: encodeSqlSnapshot(state, auth).costs }; },
          quoteRecord: input => { this.observed.quoteCalls++; return quoteSqlRecord(input); }
        });
        this.phase = 'inspection';
      }
      async fetch(request) {
        const url = new URL(request.url), path = url.pathname;
        if (path === '/retention/open') { this.retention?.close(); this.retention = retentionPeer(this.relay, auth); return new Response('ok'); }
        if (path === '/retention/status') return Response.json({ broker: this.retention.broker.snapshot(), counts: this.retention.counts() });
        if (path === '/operating/status') return Response.json({ observed: this.observed,
          cache: [...this.store.records.values()].map(record => record.manifest) });
        if (path === '/operating/late-progress') {
          if (url.searchParams.get('on') === '1') this.ctx.storage.sql.exec("CREATE TRIGGER fail_late_progress BEFORE INSERT ON relay_snapshot_manifests WHEN NEW.kind = 'favoritesReceipt' BEGIN SELECT RAISE(ABORT, 'late favorites progress rollback'); END");
          else this.ctx.storage.sql.exec('DROP TRIGGER IF EXISTS fail_late_progress');
          return new Response('ok');
        }
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
            else if (action === 'admission') return await this.retention.admission();
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
          chunks: this.ctx.storage.sql.exec('SELECT * FROM relay_snapshot_chunks ORDER BY kind, identity, ordinal').toArray().map(row => ({ ...row, byteLength: row.bytes.byteLength, bytes: createHash('sha256').update(new Uint8Array(row.bytes)).digest('hex') })) });
        if (path === '/restore') {
          const previous = this.phase; this.phase = 'restore';
          try { return Response.json(new SqliteRelayStore(this.storage, auth, TEST_ONLY_COMPLETE_SQL_CODEC).initial); }
          finally { this.phase = previous; }
        }
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
  const request = (path: string, body?: object) => mf.dispatchFetch(accountingAuth.origin + path, { signal: AbortSignal.timeout(5000), ...(body ? { method: 'POST', body: JSON.stringify(body) } : {}) } as any);
  return { directory, request, async json(path: string) { return await (await request(path)).json() as any; },
    async restart(afterDispose?: () => Promise<void>) { await mf.dispose(); await afterDispose?.(); await start(); },
    async close(afterDispose?: () => Promise<void>) { await mf.dispose(); try { await afterDispose?.(); } finally { await rm(directory, { recursive: true, force: true }); } } };
}
