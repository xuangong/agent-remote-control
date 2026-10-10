import { DatabaseSync } from 'node:sqlite';
import { afterEach, expect, test } from 'vitest';
import { emptyRelayState, type HostedRelayState } from '@orchardworks/agent-remote-hosted';
import { SqliteRelayStore } from '../src/storage.js';

const auth = { origin: 'https://relay.example', issuer: 'https://gateway.example', secret: 's'.repeat(32) };
const databases: DatabaseSync[] = [];
afterEach(() => { for (const db of databases.splice(0)) db.close(); }, 10000);
function fixture() {
  const db = new DatabaseSync(':memory:'); databases.push(db);
  const storage = {
    sql: { exec(query: string, ...bindings: any[]) { const statement = db.prepare(query);
      const rows = statement.columns().length ? statement.all(...bindings) : (statement.run(...bindings), []);
      return { toArray: () => rows }; } },
    transactionSync<T>(change: () => T) { db.exec('BEGIN'); try { const result = change(); db.exec('COMMIT'); return result; } catch (error) { db.exec('ROLLBACK'); throw error; } },
    async sync() {},
  } as unknown as DurableObjectStorage;
  const store = new SqliteRelayStore(storage, auth);
  const snapshot = () => JSON.stringify(db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name").all()
    .map(row => [row.name, db.prepare(`SELECT * FROM ${row.name} ORDER BY rowid`).all()]));
  return { store, storage, snapshot };
}
test('refuses unsupported succession formats before changing any SQLite rows and retains normal Relay2 writes', async () => {
  const f = fixture(); const normal = emptyRelayState(auth);
  normal.favoritesTrees = [{ subject: 'owner', revision: 1, folders: [{ id: 'folder', parentId: null, title: 'Original', order: 0 }] }];
  await f.store.commit(normal); const before = f.snapshot();
  for (const change of [
    (state: any) => { state.version = 6; },
    (state: any) => { state.version = 7; },
    (state: any) => { state.tenants = [{ subject: 'owner', namespace: 'namespace', broker: { associations: { version: 4 } } }]; },
    (state: any) => { state.tenants = [{ subject: 'owner', namespace: 'namespace', favoritesSuccession: { version: 1, receipts: [] }, broker: {} }]; },
  ]) {
    const state = structuredClone(normal); state.favoritesTrees![0]!.folders[0]!.title = 'Must not persist'; change(state);
    await expect(f.store.commit(state as HostedRelayState)).rejects.toThrow(/unsupported|succession/i);
    expect(f.snapshot()).toBe(before);
  }
  expect(new SqliteRelayStore(f.storage, auth).initial.favoritesTrees).toEqual(normal.favoritesTrees);
}, 10000);
