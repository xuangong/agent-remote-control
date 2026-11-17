import { journalStoreCases } from '@orchardworks/agent-remote-journal/testing';
import { SqlJournalStore } from '@orchardworks/agent-remote-journal-sqlite';

import { durableObjectJournalDatabase } from '../src/journal-sql-database.js';

/** Runs one case of the journal store contract over the SQLite storage of this Durable Object, on storage that is empty. */
export async function runJournalStoreCase(storage: DurableObjectStorage, index: number): Promise<{ name: string; error?: string }> {
  const testCase = journalStoreCases[index];
  if (!testCase) throw new RangeError(`There is no journal store case ${index}.`);
  await storage.deleteAll();
  const store = () => new SqlJournalStore(durableObjectJournalDatabase(storage));
  try {
    await testCase.run(async () => ({ store: store(), reopen: async () => store() }));
    return { name: testCase.name };
  } catch (error) {
    return { name: testCase.name, error: error instanceof Error ? error.message : String(error) };
  }
}
