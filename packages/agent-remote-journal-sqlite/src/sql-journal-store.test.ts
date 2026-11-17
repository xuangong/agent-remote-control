import { statSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { SessionJournal, type JournalRowInput } from '@orchardworks/agent-remote-journal';
import { journalStoreCases, type JournalStoreUnderTest } from '@orchardworks/agent-remote-journal/testing';
import { afterEach, describe, expect, it } from 'vitest';

import { openNodeJournalDatabase } from './node-sqlite.js';
import { SqlJournalStore } from './sql-journal-store.js';

const cleanups: Array<() => void | Promise<void>> = [];
afterEach(async () => { for (const cleanup of cleanups.splice(0).reverse()) await cleanup(); });

const row = (itemKey: string, text: string, turnId = 'turn-1'): JournalRowInput => ({
  itemKey, providerId: 'codex', sourceKey: `${itemKey}:${text.length}`, occurredAt: 1_725_000_000_000, turnId,
  item: { type: 'assistant_message', text, messageId: itemKey },
});

/** A journal claimed by one publisher, with a function that numbers its publications. */
function openJournal(sessionKey = 'host-1:codex:session-1') {
  const journal = SessionJournal.create(sessionKey, 'epoch-1');
  const { generation } = journal.claim('controller-1');
  let sequence = 0;
  return { journal, at: () => ({ publisherId: 'controller-1', generation, sequence: ++sequence }) };
}

async function memoryDatabase() {
  const database = await openNodeJournalDatabase(':memory:');
  cleanups.push(() => database.close());
  return database;
}

const stores: Array<[string, (chunkBytes?: number) => Promise<JournalStoreUnderTest>]> = [
  ['the SQLite store', async () => sqliteUnderTest()],
  ['the SQLite store with 64-byte chunks', async () => sqliteUnderTest(64)],
];

async function sqliteUnderTest(chunkBytes?: number): Promise<JournalStoreUnderTest> {
  const database = await memoryDatabase();
  const options = chunkBytes === undefined ? undefined : { chunkBytes };
  return { store: new SqlJournalStore(database, options), reopen: async () => new SqlJournalStore(database, options), ...(chunkBytes === undefined ? {} : { chunkBytes }) };
}

describe.each(stores)('%s', (_name, create) => {
  for (const { name, run } of journalStoreCases) it(name, () => run(() => create()));
});

describe('the SQLite store over its file', () => {
  it('splits every stored value into chunks no larger than the chunk size and leaves nothing behind after a delete', async () => {
    const database = await memoryDatabase();
    const store = new SqlJournalStore(database, { chunkBytes: 100 });
    const { journal, at } = openJournal();
    journal.append(at(), row('m1', 'x'.repeat(1000)));
    await store.apply(journal.takeChanges()!);
    const [stats] = database.all<{ size: number; chunks: number }>('SELECT max(length(bytes)) AS size, count(*) AS chunks FROM journal_chunks');
    expect(stats!.size).toBeLessThanOrEqual(100);
    expect(stats!.chunks).toBeGreaterThan(10);
    await store.delete(journal.sessionKey);
    expect(database.all<{ rows: number }>('SELECT (SELECT count(*) FROM journal_chunks) + (SELECT count(*) FROM journal_items) + (SELECT count(*) FROM journal_sessions) AS rows')[0]!.rows).toBe(0);
  });

  it('applies a change atomically', async () => {
    const store = new SqlJournalStore(await memoryDatabase());
    const { journal, at } = openJournal();
    journal.append(at(), row('m1', 'Hello'));
    await store.apply(journal.takeChanges()!);
    const before = await store.load(journal.sessionKey);
    journal.append(at(), row('m2', 'World'));
    const changes = journal.takeChanges()!;
    const unwritable = { ...changes, upsert: [{ ...changes.upsert[0]!, keptBody: { big: 10n } as never }] };
    await expect(store.apply(unwritable)).rejects.toThrow();
    expect(await store.load(journal.sessionKey)).toEqual(before);
  });

  it('keeps journals in its file across a restart, readable by its owner only', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'arc-journal-store-'));
    cleanups.push(() => rm(directory, { recursive: true, force: true }));
    const file = join(directory, 'nested', 'journals.sqlite');
    const first = await openNodeJournalDatabase(file);
    const { journal, at } = openJournal();
    journal.append(at(), row('m1', 'Hello'));
    await new SqlJournalStore(first).apply(journal.takeChanges()!);
    first.close();
    if (process.platform !== 'win32') expect(statSync(file).mode & 0o777).toBe(0o600);
    const second = await openNodeJournalDatabase(file);
    cleanups.push(() => second.close());
    expect((await new SqlJournalStore(second).load(journal.sessionKey))?.items.map(({ itemKey }) => itemKey)).toEqual(['m1']);
  });

  it('opens a file database in write-ahead logging with full synchronous writes and a short lock wait', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'arc-journal-store-'));
    cleanups.push(() => rm(directory, { recursive: true, force: true }));
    const database = await openNodeJournalDatabase(join(directory, 'journals.sqlite'));
    cleanups.push(() => database.close());
    expect(database.all<{ journal_mode: string }>('PRAGMA journal_mode')[0]?.journal_mode).toBe('wal');
    expect(database.all<{ synchronous: number }>('PRAGMA synchronous')[0]?.synchronous).toBe(2);
    expect(database.all<{ timeout: number }>('PRAGMA busy_timeout')[0]?.timeout).toBe(250);
  });

  it('refuses a database written by a newer format', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'arc-journal-store-'));
    cleanups.push(() => rm(directory, { recursive: true, force: true }));
    const file = join(directory, 'journals.sqlite');
    const first = await openNodeJournalDatabase(file);
    new SqlJournalStore(first);
    first.run('UPDATE journal_schema SET version = 99');
    first.close();
    const second = await openNodeJournalDatabase(file);
    cleanups.push(() => second.close());
    expect(() => new SqlJournalStore(second)).toThrow(/version 99/);
  });

  it('rejects a chunk size the platform cannot store', async () => {
    const database = await memoryDatabase();
    expect(() => new SqlJournalStore(database, { chunkBytes: 0 })).toThrow(RangeError);
    expect(() => new SqlJournalStore(database, { chunkBytes: 262_145 })).toThrow(RangeError);
  });
});
