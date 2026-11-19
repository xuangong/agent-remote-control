import { expect, it } from 'vitest';
import { SqliteDiagnosticStore } from '../src/diagnostic-storage.js';
import { SqliteRelayStore } from '../src/storage.js';
import { sqliteStorage } from './sqlite-storage.js';

const auth = { origin: 'https://relay.example', issuer: 'https://gateway.example', secret: 'diagnostic-secret-01234567890123456789' };
function entry(id = 'event-1', hostId = 'host-1', timestamp = new Date().toISOString()) {
  return { id, hostId, timestamp, source: 'relay', relayInstanceId: 'relay-1', event: 'relay_started' };
}
/** The Relay's diagnostics and business records over one storage; each call of `diagnostics()` opens the stores again, as a restart does. */
function fixture() {
  const { storage } = sqliteStorage();
  const exec = (query: string, ...bindings: unknown[]) => storage.sql.exec(query, ...bindings as []).toArray() as any[];
  const diagnostics = (scope = auth) => new SqliteDiagnosticStore(storage, scope);
  const request = async (path: string, body?: unknown): Promise<{ status: number; json(): Promise<any>; text(): Promise<string> }> => {
    const reply = (status: number, value: unknown) => ({ status, json: async () => value, text: async () => String(value) });
    if (path === '/save') { try { await diagnostics().save(body as any); return reply(200, 'ok'); } catch (error) { return reply(503, String(error)); } }
    if (path === '/load') return reply(200, diagnostics().initial);
    if (path === '/scope') return reply(200, diagnostics({ ...auth, origin: 'https://other.example' }).initial);
    if (path === '/inject') {
      const encoded = typeof body === 'string' ? body : JSON.stringify(body);
      const scope = exec('SELECT scope FROM relay_connection_diagnostics WHERE id = 1')[0].scope;
      exec('DROP TRIGGER IF EXISTS fail_diagnostics'); exec('DELETE FROM relay_connection_diagnostics');
      const total = Math.ceil(encoded.length / 65536);
      for (let index = 0; index < total; index++) exec('INSERT INTO relay_connection_diagnostics (id, version, scope, total, value) VALUES (?, 1, ?, ?, ?)', index + 1, scope, total, encoded.slice(index * 65536, (index + 1) * 65536));
      return reply(200, 'ok');
    }
    if (path === '/fail') { exec("CREATE TRIGGER fail_diagnostics BEFORE INSERT ON relay_connection_diagnostics BEGIN SELECT RAISE(ABORT, 'diagnostic write failure'); END"); return reply(200, 'ok'); }
    if (path === '/corrupt-schema') { exec('DROP TABLE relay_connection_diagnostics'); exec('CREATE TABLE relay_connection_diagnostics (invalid TEXT)'); return reply(200, 'ok'); }
    if (path === '/business') {
      const business = new SqliteRelayStore(storage, auth);
      if (body !== undefined) { const state = business.initial; state.consumedProofs = [['fixture-proof-0123456789', Date.now() + 60000]]; await business.commit(state); }
      return reply(200, new SqliteRelayStore(storage, auth).initial.consumedProofs);
    }
    return reply(404, 'missing');
  };
  return { request, restart() {} };
}

it('restores bounded diagnostics independently of business records through a real Worker restart', async () => {
  const f = fixture(); const diagnostic = entry();
  const business = await (await f.request('/business', {})).json();
  expect((await f.request('/save', [diagnostic])).status).toBe(200);
  await f.restart();
  expect(await (await f.request('/load')).json()).toEqual([diagnostic]);
  expect(await (await f.request('/business')).json()).toEqual(business);
  expect(await (await f.request('/scope')).json()).toEqual([]);
});

it('discards corrupt diagnostics and isolates failed diagnostic writes and schema from business state', async () => {
  const f = fixture(); const diagnostic = entry();
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
  const f = fixture(); const now = Date.now();
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
  const f = fixture(); const identifier = 'a'.repeat(120);
  const entries = Array.from({ length: 4096 }, (_, index) => ({ ...entry(identifier + index, identifier + Math.floor(index / 256)),
    relayInstanceId: identifier, connectionId: identifier, requestId: identifier, streamId: identifier, agentId: identifier }));
  const response = await f.request('/save', entries);
  expect(response.status, await response.text()).toBe(200);
  await f.restart();
  expect(await (await f.request('/load')).json()).toEqual(entries);
});
