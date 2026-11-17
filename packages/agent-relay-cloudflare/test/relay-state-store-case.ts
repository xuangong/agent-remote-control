import { relayStateStoreAuth, relayStateStoreCases } from '@orchardworks/agent-relay-core/testing';

import { SqliteRelayStore } from '../src/storage.js';

const BREAK_COMMITS = "CREATE TRIGGER conformance_break BEFORE INSERT ON relay_snapshot_manifests BEGIN SELECT RAISE(ABORT, 'conformance write failure'); END";

/** Runs one case of the Relay state store contract over the SQLite storage of this Durable Object, on storage that is empty. */
export async function runRelayStateStoreCase(storage: DurableObjectStorage, index: number): Promise<{ name: string; error?: string }> {
  const testCase = relayStateStoreCases[index];
  if (!testCase) throw new RangeError(`There is no Relay state store case ${index}.`);
  await storage.deleteAll();
  const store = () => new SqliteRelayStore(storage, relayStateStoreAuth);
  try {
    await testCase.run(async () => ({
      store: store(), reopen: async () => store(),
      breakStorage: async () => { storage.sql.exec(BREAK_COMMITS); },
      repairStorage: async () => { storage.sql.exec('DROP TRIGGER IF EXISTS conformance_break'); },
    }));
    return { name: testCase.name };
  } catch (error) {
    return { name: testCase.name, error: error instanceof Error ? error.message : String(error) };
  }
}
