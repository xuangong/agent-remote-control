import { DatabaseSync } from 'node:sqlite';
import { afterEach } from 'vitest';

const databases: DatabaseSync[] = [];
afterEach(() => { for (const db of databases.splice(0)) db.close(); });

/** A Durable Object storage over an in-memory SQLite database: `storage.sql`, synchronous transactions and `sync`. Opening a store over the same `storage` again is a restart. */
export function sqliteStorage() {
  const db = new DatabaseSync(':memory:'); databases.push(db);
  const storage = { sql: { exec(query: string, ...bindings: any[]) { const statement = db.prepare(query);
    bindings = bindings.map(value => value instanceof ArrayBuffer ? new Uint8Array(value) : value);
    const rows = statement.columns().length ? statement.all(...bindings) : (statement.run(...bindings), []);
    return { toArray: () => rows }; } },
    transactionSync<T>(change: () => T) { db.exec('BEGIN'); try { const result = change(); db.exec('COMMIT'); return result; } catch (error) { db.exec('ROLLBACK'); throw error; } },
    async sync() {} } as unknown as DurableObjectStorage;
  return { db, storage };
}
