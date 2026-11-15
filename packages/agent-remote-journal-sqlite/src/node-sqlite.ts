/// <reference types="node" />
import { chmodSync, closeSync, mkdirSync, openSync } from 'node:fs';
import { dirname } from 'node:path';
import type { StatementSync } from 'node:sqlite';

import type { JournalSqlDatabase, SqlValue } from './sql-journal-store.js';

export interface NodeJournalDatabase extends JournalSqlDatabase {
  close(): void;
}

/**
 * Opens, and creates when missing, the journal database file with Node's built-in `node:sqlite` (Node 22.13 or later).
 * The directory is private to its owner and so is the file. Pass `:memory:` for a database that lives as long as the handle.
 * The module is imported here, not at the top of the file, so a Relay that never enables journals never loads it.
 * The binding is synchronous, and it expects one process per database file: a second writer waits at most 250 ms for the lock and then fails.
 */
export async function openNodeJournalDatabase(file: string): Promise<NodeJournalDatabase> {
  let sqlite: typeof import('node:sqlite');
  try { sqlite = await import('node:sqlite'); }
  catch (error) { throw new Error('Session journals need Node 22.13 or later: the built-in node:sqlite module is unavailable.', { cause: error }); }
  if (file !== ':memory:') {
    mkdirSync(dirname(file), { recursive: true, mode: 0o700 });
    closeSync(openSync(file, 'a', 0o600));
    chmodSync(file, 0o600);
  }
  const database = new sqlite.DatabaseSync(file);
  database.exec('PRAGMA journal_mode = WAL');
  database.exec('PRAGMA synchronous = FULL');
  database.exec('PRAGMA busy_timeout = 250');
  const statements = new Map<string, StatementSync>();
  const statement = (sql: string): StatementSync => {
    let prepared = statements.get(sql);
    if (!prepared) { prepared = database.prepare(sql); statements.set(sql, prepared); }
    return prepared;
  };
  return {
    run(sql, ...params) { statement(sql).run(...params); },
    all<Row extends Record<string, SqlValue>>(sql: string, ...params: SqlValue[]) { return statement(sql).all(...params) as unknown as Row[]; },
    transaction<T>(work: () => T): T {
      database.exec('BEGIN IMMEDIATE');
      try {
        const result = work();
        database.exec('COMMIT');
        return result;
      } catch (error) {
        try { database.exec('ROLLBACK'); } catch { /* the transaction had already ended */ }
        throw error;
      }
    },
    close() { database.close(); },
  };
}
