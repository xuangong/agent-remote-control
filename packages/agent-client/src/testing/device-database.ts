import type { DeviceDatabase, IndexRow, StoredRecord } from '../device-store.js';

/** A device database in memory that tests can break: `failWrites` makes the next writes reject with the error. */
export interface MemoryDeviceDatabase extends DeviceDatabase {
  keys(): string[];
  failWrites(error: Error, count?: number): void;
  readonly writes: number;
}

export function memoryDeviceDatabase(): MemoryDeviceDatabase {
  const records = new Map<string, StoredRecord>();
  let failures: { error: Error; count: number } | undefined;
  let writes = 0;
  return {
    keys: () => [...records.keys()],
    failWrites(error, count = 1) { failures = { error, count }; },
    get writes() { return writes; },
    async readIndex() { return [...records.values()].map(({ key, relayUrl, updatedAt, bytes }): IndexRow => ({ key, relayUrl, updatedAt, bytes })); },
    async read(key) { return records.get(key); },
    async write(batch) {
      if (failures && failures.count > 0) { failures.count--; throw failures.error; }
      writes++;
      for (const [key, record] of batch) { if (record) records.set(key, record); else records.delete(key); }
    },
    async clear() { records.clear(); },
  };
}

/** What every `DeviceDatabase` does, for the store to rely on. Each case gets a fresh, empty database. */
export const deviceDatabaseCases: ReadonlyArray<{ name: string; run(make: () => DeviceDatabase | Promise<DeviceDatabase>, record: (name: string, updatedAt?: number) => StoredRecord): Promise<void> }> = [
  { name: 'reads back what a batch wrote, and its index row',
    async run(make, record) {
      const database = await make(), saved = record('a', 5);
      await database.write(new Map([[saved.key, saved]]));
      expectSame(await database.read(saved.key), saved, 'the record');
      expectSame(await database.readIndex(), [{ key: saved.key, relayUrl: saved.relayUrl, updatedAt: 5, bytes: saved.bytes }], 'the index');
    } },
  { name: 'reads nothing for a key it does not hold',
    async run(make) { expectSame(await (await make()).read('missing'), undefined, 'a missing key'); } },
  { name: 'removes a record and its index row with a null entry, and keeps the others',
    async run(make, record) {
      const database = await make(), a = record('a'), b = record('b');
      await database.write(new Map([[a.key, a], [b.key, b]]));
      await database.write(new Map([[a.key, null]]));
      expectSame(await database.read(a.key), undefined, 'the removed record');
      expectSame((await database.readIndex()).map(row => row.key), [b.key], 'the index after removal');
    } },
  { name: 'applies one batch of writes and removals together',
    async run(make, record) {
      const database = await make(), a = record('a'), b = record('b'), c = record('c');
      await database.write(new Map([[a.key, a], [b.key, b]]));
      await database.write(new Map<string, StoredRecord | null>([[a.key, null], [c.key, c]]));
      expectSame((await database.readIndex()).map(row => row.key).sort(), [b.key, c.key].sort(), 'the keys after the batch');
    } },
  { name: 'replaces a record written again under the same key',
    async run(make, record) {
      const database = await make(), first = record('a', 1), second = record('a', 2);
      await database.write(new Map([[first.key, first]]));
      await database.write(new Map([[second.key, second]]));
      expectSame((await database.readIndex()).map(row => row.updatedAt), [2], 'one row, the newest');
    } },
  { name: 'clears every record and index row',
    async run(make, record) {
      const database = await make(), a = record('a');
      await database.write(new Map([[a.key, a]]));
      await database.clear();
      expectSame(await database.readIndex(), [], 'the index after a clear');
      expectSame(await database.read(a.key), undefined, 'the record after a clear');
    } },
];

function expectSame(actual: unknown, expected: unknown, what: string): void {
  if (JSON.stringify(actual) !== JSON.stringify(expected)) throw new Error(`${what}: expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
}
