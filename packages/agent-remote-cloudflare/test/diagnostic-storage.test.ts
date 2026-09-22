import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { build } from 'esbuild';
import { Miniflare } from 'miniflare';
import { afterEach, expect, it } from 'vitest';

const closers: Array<() => Promise<void>> = [];
afterEach(async () => { for (const close of closers.splice(0).reverse()) await close(); });
function entry(id = 'event-1', hostId = 'host-1', timestamp = new Date().toISOString()) {
  return { id, hostId, timestamp, source: 'relay', relayInstanceId: 'relay-1', event: 'relay_started' };
}
async function fixture() {
  const directory = await mkdtemp(join(tmpdir(), 'diagnostic-workers-'));
  closers.push(() => rm(directory, { recursive: true, force: true }));
  const result = await build({ stdin: { contents: `
    import { SqliteDiagnosticStore } from './src/diagnostic-storage.ts';
    import { SqliteRelayStore } from './src/storage.ts';
    const auth = { origin: 'https://relay.example', issuer: 'https://gateway.example', secret: 'diagnostic-secret-01234567890123456789' };
    export class DiagnosticObject {
      constructor(ctx) { this.ctx = ctx; }
      async fetch(request) {
        const path = new URL(request.url).pathname;
        const storage = this.ctx.storage;
        const diagnostics = new SqliteDiagnosticStore(storage, auth);
        if (path === '/save') { try { await diagnostics.save(await request.json()); return new Response('ok'); } catch (error) { return new Response(String(error), { status: 503 }); } }
        if (path === '/load') return Response.json(diagnostics.initial);
        if (path === '/scope') return Response.json(new SqliteDiagnosticStore(storage, { ...auth, origin: 'https://other.example' }).initial);
        if (path === '/inject') {
          const value = await request.json(); const encoded = typeof value === 'string' ? value : JSON.stringify(value);
          const scope = storage.sql.exec('SELECT scope FROM relay_connection_diagnostics WHERE id = 1').toArray()[0].scope;
          storage.sql.exec('DROP TRIGGER IF EXISTS fail_diagnostics'); storage.sql.exec('DELETE FROM relay_connection_diagnostics');
          const total = Math.ceil(encoded.length / 65536);
          for (let index = 0; index < total; index++) storage.sql.exec('INSERT INTO relay_connection_diagnostics (id, version, scope, total, value) VALUES (?, 1, ?, ?, ?)', index + 1, scope, total, encoded.slice(index * 65536, (index + 1) * 65536));
          return new Response('ok');
        }
        if (path === '/fail') { storage.sql.exec("CREATE TRIGGER fail_diagnostics BEFORE INSERT ON relay_connection_diagnostics BEGIN SELECT RAISE(ABORT, 'diagnostic write failure'); END"); return new Response('ok'); }
        if (path === '/corrupt-schema') { storage.sql.exec('DROP TABLE relay_connection_diagnostics'); storage.sql.exec('CREATE TABLE relay_connection_diagnostics (invalid TEXT)'); return new Response('ok'); }
        if (path === '/business') {
          const business = new SqliteRelayStore(storage, auth);
          if (request.method === 'POST') { const state = business.initial; state.consumedProofs = [['fixture-proof-0123456789', Date.now() + 60000]]; await business.commit(state); }
          return Response.json(new SqliteRelayStore(storage, auth).initial.consumedProofs);
        }
        return new Response('missing', { status: 404 });
      }
    }
    export default { fetch(request, env) { return env.RELAY.get(env.RELAY.idFromName('diagnostics')).fetch(request); } };
  `, resolveDir: process.cwd(), loader: 'ts' }, bundle: true, write: false, format: 'esm', platform: 'browser',
    conditions: ['workerd', 'worker', 'import'], external: ['node:*', 'cloudflare:*'],
    alias: { '@orchardworks/agent-remote-hosted/relay-diagnostics': resolve('../agent-remote-hosted/src/relay-diagnostics.ts'), '@orchardworks/agent-remote-hosted': resolve('../agent-remote-hosted/src/index.ts') } });
  let mf: Miniflare;
  const start = () => { mf = new Miniflare({ modules: true, script: result.outputFiles[0]!.text, compatibilityDate: '2026-06-01', compatibilityFlags: ['nodejs_compat'],
    durableObjects: { RELAY: { className: 'DiagnosticObject', useSQLite: true } }, durableObjectsPersist: join(directory, 'state') }); };
  start(); closers.push(() => mf.dispose());
  const request = (path: string, body?: unknown) => mf.dispatchFetch('https://relay.example' + path, body === undefined ? {} : { method: 'POST', body: JSON.stringify(body) });
  return { request, async restart() { await mf.dispose(); start(); } };
}

it('restores bounded diagnostics independently of business records through a real Worker restart', async () => {
  const f = await fixture(); const diagnostic = entry();
  const business = await (await f.request('/business', {})).json();
  expect((await f.request('/save', [diagnostic])).status).toBe(200);
  await f.restart();
  expect(await (await f.request('/load')).json()).toEqual([diagnostic]);
  expect(await (await f.request('/business')).json()).toEqual(business);
  expect(await (await f.request('/scope')).json()).toEqual([]);
});

it('discards corrupt diagnostics and isolates failed diagnostic writes and schema from business state', async () => {
  const f = await fixture(); const diagnostic = entry();
  const business = await (await f.request('/business', {})).json();
  await f.request('/save', [diagnostic]); await f.request('/fail');
  expect((await f.request('/save', [entry('replacement')])).status).toBe(503);
  expect(await (await f.request('/load')).json()).toEqual([diagnostic]);
  await f.request('/inject', '{broken'); await f.restart();
  expect(await (await f.request('/load')).json()).toEqual([]);
  expect(await (await f.request('/business')).json()).toEqual(business);
  await f.request('/corrupt-schema'); await f.restart();
  expect(await (await f.request('/load')).json()).toEqual([]);
  expect((await f.request('/business', {})).status).toBe(200);
});

it('bounds saved and loaded records and drops expired and unknown diagnostic fields', async () => {
  const f = await fixture(); const now = Date.now();
  const entries = Array.from({ length: 18 * 300 }, (_, index) => entry(String(index), 'host-' + Math.floor(index / 300), new Date(now - 10_000 + index).toISOString()));
  const unsafe = { ...entry('unsafe'), message: 'not diagnostic metadata' };
  const expired = entry('expired', 'host-expired', new Date(now - 86_400_001).toISOString());
  expect((await f.request('/save', [...entries, unsafe, expired])).status).toBe(200);
  const restored = await (await f.request('/load')).json() as ReturnType<typeof entry>[];
  expect(restored).toHaveLength(4096);
  expect(Math.max(...Array.from(new Set(restored.map(value => value.hostId)), hostId => restored.filter(value => value.hostId === hostId).length))).toBeLessThanOrEqual(256);
  expect(restored.some(value => value.id === 'unsafe' || value.id === 'expired')).toBe(false);
  await f.request('/inject', [...entries, unsafe, expired]);
  expect(await (await f.request('/load')).json()).toEqual(restored);
});

it('persists the full retention window with maximum-length diagnostic identifiers', async () => {
  const f = await fixture(); const identifier = 'a'.repeat(120);
  const entries = Array.from({ length: 4096 }, (_, index) => ({ ...entry(identifier + index, identifier + Math.floor(index / 256)),
    relayInstanceId: identifier, connectionId: identifier, requestId: identifier, streamId: identifier, agentId: identifier }));
  const response = await f.request('/save', entries);
  expect(response.status, await response.text()).toBe(200);
  await f.restart();
  expect(await (await f.request('/load')).json()).toEqual(entries);
});
