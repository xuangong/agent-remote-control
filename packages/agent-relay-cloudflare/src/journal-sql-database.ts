import type { JournalSqlDatabase, SqlValue } from '@orchardworks/agent-remote-journal-sqlite';

/** Binds the journal store to a Durable Object's SQLite storage. Binary values cross as `ArrayBuffer`s and are given back as `Uint8Array`s. */
export function durableObjectJournalDatabase(storage: DurableObjectStorage): JournalSqlDatabase {
  const bind = (params: SqlValue[]): SqlStorageValue[] => params.map(value => (value instanceof Uint8Array ? value.slice().buffer as ArrayBuffer : value));
  return {
    run(sql, ...params) { storage.sql.exec(sql, ...bind(params)); },
    all<Row extends Record<string, SqlValue>>(sql: string, ...params: SqlValue[]): Row[] {
      return storage.sql.exec(sql, ...bind(params)).toArray().map(row => {
        const converted: Record<string, SqlValue> = {};
        for (const [key, value] of Object.entries(row)) converted[key] = value instanceof ArrayBuffer ? new Uint8Array(value) : value as SqlValue;
        return converted as Row;
      });
    },
    transaction: work => storage.transactionSync(work),
  };
}
