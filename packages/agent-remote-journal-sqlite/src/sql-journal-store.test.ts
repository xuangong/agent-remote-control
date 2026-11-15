import { statSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { bodyFromRow, MemoryJournalStore, SessionJournal, type JournalCatalog, type JournalRowInput, type JournalStore } from '@orchardworks/agent-remote-journal';
import { afterEach, describe, expect, it } from 'vitest';

import { openNodeJournalDatabase } from './node-sqlite.js';
import { SqlJournalStore } from './sql-journal-store.js';

const cleanups: Array<() => void | Promise<void>> = [];
afterEach(async () => { for (const cleanup of cleanups.splice(0).reverse()) await cleanup(); });

const row = (itemKey: string, text: string, turnId = 'turn-1'): JournalRowInput => ({
  itemKey, providerId: 'codex', sourceKey: `${itemKey}:${text.length}`, occurredAt: 1_725_000_000_000, turnId,
  item: { type: 'assistant_message', text, messageId: itemKey },
});
const snapshot = () => ({
  id: 'session-1', providerId: 'codex', createdAt: '2026-11-15T00:00:00.000Z', updatedAt: '2026-11-15T00:00:01.000Z', status: 'idle' as const, activeTurn: null,
  capabilities: { history: true, sendMessage: true, steer: true, cancel: true, readResource: true, interactions: { question: true, planApproval: true, toolApproval: true } },
  pendingInteractions: [], runtimeInfo: { providerId: 'codex', sessionId: 'session-1', status: 'idle' as const },
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

type CatalogedStore = JournalStore & { catalog: JournalCatalog };
const stores: Array<[string, () => Promise<CatalogedStore>]> = [
  ['the memory store', async () => new MemoryJournalStore()],
  ['the SQLite store', async () => new SqlJournalStore(await memoryDatabase())],
  ['the SQLite store with 64-byte chunks', async () => new SqlJournalStore(await memoryDatabase(), { chunkBytes: 64 })],
];

describe.each(stores)('%s', (_name, create) => {
  it('restores a journal from the changes it applied', async () => {
    const store = await create();
    const { journal, at } = openJournal();
    journal.append(at(), row('m1', 'Hel'));
    await store.apply(journal.takeChanges()!);
    journal.append(at(), row('m1', 'lo'));
    journal.append(at(), row('m2', 'Next'));
    await store.apply(journal.takeChanges()!);
    const restored = new SessionJournal((await store.load(journal.sessionKey))!);
    expect(restored.index()).toEqual(journal.index());
    expect(restored.cursor).toEqual(journal.cursor);
    const request = { requestId: 'r', agentId: 'a', direction: 'tail' as const, limit: 10 };
    expect(restored.page(request, { olderBeyondJournal: false })).toEqual(journal.page(request, { olderBeyondJournal: false }));
  });

  it('knows nothing of a journal it never stored', async () => {
    expect(await (await create()).load('host-1:codex:never')).toBeUndefined();
  });

  it('drops the old items after a replacement and deletes a journal', async () => {
    const store = await create();
    const { journal, at } = openJournal();
    journal.append(at(), row('m1', 'Old'));
    journal.complete(at(), 'm1', 'digest-1');
    await store.apply(journal.takeChanges()!);
    journal.replace(at(), [{ row: row('m2', 'Fresh'), digest: 'digest-2' }], 0);
    await store.apply(journal.takeChanges()!);
    expect((await store.load(journal.sessionKey))?.items.map(({ itemKey }) => itemKey)).toEqual(['m2']);
    await store.delete(journal.sessionKey);
    expect(await store.load(journal.sessionKey)).toBeUndefined();
  });

  it('restores an equivalent journal after evict, fill and prepend', async () => {
    const store = await create();
    const { journal, at } = openJournal();
    journal.append(at(), row('m1', 'first', 'turn-1'));
    journal.complete(at(), 'm1', 'digest-1');
    journal.append(at(), row('m2', 'second', 'turn-2'));
    journal.setHead(at(), { snapshot: snapshot(), observedAt: 5 });
    await store.apply(journal.takeChanges()!);
    journal.evict(1);
    journal.prepend(at(), [{ row: row('m0', 'zeroth', 'turn-0'), digest: 'digest-0' }]);
    await store.apply(journal.takeChanges()!);
    journal.fill('m1', bodyFromRow(row('m1', 'first', 'turn-1')), 'digest-1');
    await store.apply(journal.takeChanges()!);
    expect(new SessionJournal((await store.load(journal.sessionKey))!).state()).toEqual(journal.state());
  });

  it('deletes the items a journal removed', async () => {
    const store = await create();
    const { journal, at } = openJournal();
    journal.append(at(), { ...row('l1', 'live'), liveOnly: true });
    journal.append(at(), row('m1', 'kept'));
    await store.apply(journal.takeChanges()!);
    journal.dropOldestLiveOnly(0);
    await store.apply(journal.takeChanges()!);
    expect((await store.load(journal.sessionKey))?.items.map(({ itemKey }) => itemKey)).toEqual(['m1']);
  });

  it('keeps an item far larger than a chunk, with characters that span chunk boundaries', async () => {
    const store = await create();
    const { journal, at } = openJournal();
    const text = '😀é'.repeat(100_000);
    journal.append(at(), row('big', text));
    await store.apply(journal.takeChanges()!);
    const restored = (await store.load(journal.sessionKey))!;
    expect(restored.items[0]?.body?.item).toMatchObject({ text });
  });

  it('lists journals by key prefix with their head flag and size, and deletes them by prefix', async () => {
    const store = await create();
    const first = openJournal('host-1:codex:session-1');
    const second = openJournal('host-2:codex:session-1');
    first.journal.append(first.at(), row('m1', 'Hello'));
    first.journal.setHead(first.at(), { snapshot: snapshot(), observedAt: 5 });
    second.journal.append(second.at(), row('m1', 'Hello'));
    await store.apply(first.journal.takeChanges()!);
    await store.apply(second.journal.takeChanges()!);
    expect(await store.catalog.list('host-1:')).toEqual([{ sessionKey: 'host-1:codex:session-1', hasHead: true, bytes: first.journal.residentBytes() }]);
    expect((await store.catalog.list('')).map(({ sessionKey, hasHead }) => [sessionKey, hasHead])).toEqual([['host-1:codex:session-1', true], ['host-2:codex:session-1', false]]);
    await store.catalog.deletePrefix('host-2:');
    expect((await store.catalog.list('')).map(({ sessionKey }) => sessionKey)).toEqual(['host-1:codex:session-1']);
    expect(await store.load('host-2:codex:session-1')).toBeUndefined();
    expect(await store.load('host-1:codex:session-1')).toBeDefined();
  });

  it('does not take a key that merely starts like another Host\'s prefix', async () => {
    const store = await create();
    const first = openJournal('host-1:codex:session-1');
    const second = openJournal('host-10:codex:session-1');
    first.journal.append(first.at(), row('m1', 'Hello'));
    second.journal.append(second.at(), row('m1', 'Hello'));
    await store.apply(first.journal.takeChanges()!);
    await store.apply(second.journal.takeChanges()!);
    expect((await store.catalog.list('host-1:')).map(({ sessionKey }) => sessionKey)).toEqual(['host-1:codex:session-1']);
    await store.catalog.deletePrefix('host-1:');
    expect((await store.catalog.list('')).map(({ sessionKey }) => sessionKey)).toEqual(['host-10:codex:session-1']);
  });
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
