import { bodyFromRow } from './journal-items.js';
import type { JournalStore } from './journal-store.js';
import { MemoryJournalStore } from './journal-store.js';
import { SessionJournal } from './session-journal.js';
import type { JournalCatalog, JournalPublication, JournalRowInput } from './types.js';

export { MemoryJournalStore };

/** Epochs for a journal under test: `epoch-1`, `epoch-2`, ... */
export function sequentialEpochs(): () => string {
  let count = 0;
  return () => `test-epoch-${++count}`;
}
export { describeDecision, heldTail, vectorText, windowItems, windowVectors } from './window-vectors.js';
export type { VectorDigest, VectorExpectation, VectorItem, WindowVector } from './window-vectors.js';

/** A store that can list and delete journals by key prefix; every store of the Relay can. */
export type CatalogedJournalStore = JournalStore & { catalog: JournalCatalog };

/**
 * A store under test. `reopen` returns a store over the same storage, as a restarted process or an evicted Durable
 * Object builds it. `chunkBytes` is the size at which the store splits a stored value; a store that does not split
 * leaves it out.
 */
export interface JournalStoreUnderTest {
  store: CatalogedJournalStore;
  reopen(): Promise<CatalogedJournalStore>;
  chunkBytes?: number;
}

/** One rule of the store contract. `run` throws when the store breaks it. */
export interface StoreConformanceCase<Subject> {
  readonly name: string;
  run(open: () => Promise<Subject>): Promise<void>;
}

/** The memory store as a store under test. */
export async function memoryJournalStoreUnderTest(): Promise<JournalStoreUnderTest> {
  const store = new MemoryJournalStore();
  return { store, reopen: async () => store };
}

/** Compares two values by their canonical JSON, with keys in order, and throws a message that names both. */
export function expectEqual(actual: unknown, expected: unknown, what: string): void {
  const left = canonical(actual);
  const right = canonical(expected);
  if (left !== right) throw new Error(`${what}: expected ${right.slice(0, 600)} but got ${left.slice(0, 600)}`);
}

export function expectTrue(condition: boolean, what: string): void {
  if (!condition) throw new Error(`${what}: expected it to hold`);
}

/** Runs `work`, which must reject; throws when it resolves. */
export async function expectRejects(work: () => Promise<unknown>, what: string): Promise<void> {
  try { await work(); } catch { return; }
  throw new Error(`${what}: expected a rejection`);
}

function canonical(value: unknown): string {
  return JSON.stringify(value, (_key, entry: unknown) => {
    if (entry === undefined) return null;
    if (entry instanceof Uint8Array) return Array.from(entry);
    if (entry !== null && typeof entry === 'object' && !Array.isArray(entry)) {
      return Object.fromEntries(Object.entries(entry).filter(([, field]) => field !== undefined).sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0)));
    }
    return entry;
  }) ?? 'undefined';
}

/** A complete assistant message as a publisher sends it. */
export const buildJournalRow = (itemKey: string, text: string, turnId = 'turn-1'): JournalRowInput => ({
  itemKey, providerId: 'codex', sourceKey: `${itemKey}:${text.length}`, occurredAt: 1_725_000_000_000, turnId,
  item: { type: 'assistant_message', text, messageId: itemKey },
});

/** The Snapshot a Controller reports for an idle Codex session. */
export const buildSnapshot = () => ({
  id: 'session-1', providerId: 'codex', createdAt: '2026-11-15T00:00:00.000Z', updatedAt: '2026-11-15T00:00:01.000Z', status: 'idle' as const, activeTurn: null,
  capabilities: { history: true, sendMessage: true, steer: true, cancel: true, readResource: true, interactions: { question: true, planApproval: true, toolApproval: true } },
  pendingInteractions: [], runtimeInfo: { providerId: 'codex', sessionId: 'session-1', status: 'idle' as const },
});

const row = buildJournalRow;
const snapshot = buildSnapshot;
const tail = { requestId: 'r', agentId: 'a', direction: 'tail' as const, limit: 10 };

/** A journal claimed by one publisher, with a function that numbers its publications. */
function openJournal(sessionKey = 'host-1:codex:session-1') {
  const journal = SessionJournal.create(sessionKey, 'epoch-1', sequentialEpochs());
  const { generation } = journal.claim('controller-1');
  let sequence = 0;
  const at = (): JournalPublication => ({ publisherId: 'controller-1', generation, sequence: ++sequence });
  return { journal, at };
}

async function restore(store: JournalStore, sessionKey: string): Promise<SessionJournal> {
  const state = await store.load(sessionKey);
  if (!state) throw new Error(`${sessionKey} was not stored`);
  return new SessionJournal(state, sequentialEpochs());
}

const keysOf = async (store: JournalStore, sessionKey: string) => (await store.load(sessionKey))?.items.map(({ itemKey }) => itemKey);
const sessionKeys = async (store: CatalogedJournalStore, prefix: string) => (await store.catalog.list(prefix)).map(({ sessionKey }) => sessionKey);

/**
 * The contract of a `JournalStore`: what a journal hands out as changes comes back from `load`, in order, as the same
 * journal, and a store keeps each session apart. Every implementation runs this suite: the memory store, the SQLite
 * store over Node and the SQLite store in a Durable Object.
 */
export const journalStoreCases: ReadonlyArray<StoreConformanceCase<JournalStoreUnderTest>> = [
  {
    name: 'knows nothing of a journal it never stored',
    async run(open) {
      expectEqual(await (await open()).store.load('host-1:codex:never'), undefined, 'load');
    },
  },
  {
    name: 'restores a journal from the changes it applied',
    async run(open) {
      const { store } = await open();
      const { journal, at } = openJournal();
      journal.append(at(), row('m1', 'Hel'));
      await store.apply(journal.takeChanges()!);
      journal.append(at(), row('m1', 'lo'));
      journal.append(at(), row('m2', 'Next'));
      await store.apply(journal.takeChanges()!);
      const restored = await restore(store, journal.sessionKey);
      expectEqual(restored.state(), journal.state(), 'state');
      expectEqual(restored.cursor, journal.cursor, 'cursor');
      expectEqual(restored.page(tail, { olderBeyondJournal: false }), journal.page(tail, { olderBeyondJournal: false }), 'tail page');
    },
  },
  {
    name: 'serves a store opened later over the same storage',
    async run(open) {
      const subject = await open();
      const { journal, at } = openJournal();
      journal.append(at(), row('m1', 'Hello'));
      journal.setHead(at(), { snapshot: snapshot(), observedAt: 5 });
      await subject.store.apply(journal.takeChanges()!);
      const reopened = await subject.reopen();
      expectEqual((await restore(reopened, journal.sessionKey)).state(), journal.state(), 'state after reopen');
      expectEqual(await sessionKeys(reopened, ''), [journal.sessionKey], 'listing after reopen');
    },
  },
  {
    name: 'continues the sequence of a restored journal',
    async run(open) {
      const { store } = await open();
      const { journal, at } = openJournal();
      journal.append(at(), row('m1', 'one'));
      journal.complete(at(), 'm1', 'digest-1');
      await store.apply(journal.takeChanges()!);
      const restored = await restore(store, journal.sessionKey);
      const publication = { publisherId: 'controller-1', generation: 1, sequence: (restored.publisher?.watermark ?? 0) + 1 };
      const next = restored.append(publication, row('m2', 'two'));
      expectEqual(next?.seq, journal.cursor.seq + 1, 'the next row follows the stored cursor');
    },
  },
  {
    name: 'keeps the publisher and head of a journal with its items',
    async run(open) {
      const { store } = await open();
      const { journal, at } = openJournal();
      journal.append(at(), row('m1', 'Hello'));
      journal.setHead(at(), { snapshot: snapshot(), observedAt: 5 });
      await store.apply(journal.takeChanges()!);
      const restored = await restore(store, journal.sessionKey);
      expectEqual(restored.publisher, journal.publisher, 'publisher');
      expectEqual(restored.head, journal.head, 'head');
    },
  },
  {
    name: 'drops the old items after a replacement',
    async run(open) {
      const { store } = await open();
      const { journal, at } = openJournal();
      journal.append(at(), row('m1', 'Old'));
      journal.complete(at(), 'm1', 'digest-1');
      await store.apply(journal.takeChanges()!);
      journal.sync(at(), [{ row: row('m2', 'Fresh'), digest: 'digest-2' }], { roomBytes: Number.MAX_SAFE_INTEGER });
      await store.apply(journal.takeChanges()!);
      expectEqual(await keysOf(store, journal.sessionKey), ['m2'], 'items after the replacement');
    },
  },
  {
    name: 'applies two replacements in a row',
    async run(open) {
      const { store } = await open();
      const { journal, at } = openJournal();
      journal.append(at(), row('m1', 'First'));
      journal.complete(at(), 'm1', 'digest-1');
      await store.apply(journal.takeChanges()!);
      for (const [key, digest] of [['m2', 'digest-2'], ['m3', 'digest-3']] as const) {
        journal.sync(at(), [{ row: row(key, key), digest }], { roomBytes: Number.MAX_SAFE_INTEGER });
        await store.apply(journal.takeChanges()!);
      }
      expectEqual(await keysOf(store, journal.sessionKey), ['m3'], 'items after two replacements');
      expectEqual((await restore(store, journal.sessionKey)).state(), journal.state(), 'state');
    },
  },
  {
    name: 'restores an equivalent journal after evict, prepend and fill',
    async run(open) {
      const { store } = await open();
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
      expectEqual((await restore(store, journal.sessionKey)).state(), journal.state(), 'state');
    },
  },
  {
    name: 'keeps one copy of an item that is upserted again',
    async run(open) {
      const { store } = await open();
      const { journal, at } = openJournal();
      journal.append(at(), row('m1', 'Hel'));
      await store.apply(journal.takeChanges()!);
      journal.append(at(), row('m1', 'lo'));
      await store.apply(journal.takeChanges()!);
      const state = (await store.load(journal.sessionKey))!;
      expectEqual(state.items.map(({ itemKey }) => itemKey), ['m1'], 'items');
      expectEqual(state.items[0]?.body?.item, journal.state().items[0]?.body?.item, 'the latest body');
    },
  },
  {
    name: 'loads items in sequence order',
    async run(open) {
      const { store } = await open();
      const { journal, at } = openJournal();
      for (const key of ['m1', 'm2', 'm3']) journal.append(at(), row(key, key));
      await store.apply(journal.takeChanges()!);
      journal.append(at(), row('m1', ' more'));
      await store.apply(journal.takeChanges()!);
      const seqs = (await store.load(journal.sessionKey))!.items.map(item => item.seqStart);
      expectEqual(seqs, [...seqs].sort((left, right) => left - right), 'sequence order');
      expectEqual(await keysOf(store, journal.sessionKey), ['m1', 'm2', 'm3'], 'items');
    },
  },
  {
    name: 'deletes the items a journal removed',
    async run(open) {
      const { store } = await open();
      const { journal, at } = openJournal();
      journal.append(at(), { ...row('l1', 'live'), liveOnly: true });
      journal.complete(at(), 'l1', 'digest-l1');
      journal.append(at(), row('m1', 'kept'));
      await store.apply(journal.takeChanges()!);
      journal.dropOldestLiveOnly(0);
      await store.apply(journal.takeChanges()!);
      expectEqual(await keysOf(store, journal.sessionKey), ['m1'], 'items');
    },
  },
  {
    name: 'deletes one journal and leaves the others',
    async run(open) {
      const { store } = await open();
      const first = openJournal('host-1:codex:session-1');
      const second = openJournal('host-1:codex:session-2');
      first.journal.append(first.at(), row('m1', 'Hello'));
      second.journal.append(second.at(), row('m1', 'Hello'));
      await store.apply(first.journal.takeChanges()!);
      await store.apply(second.journal.takeChanges()!);
      await store.delete(first.journal.sessionKey);
      expectEqual(await store.load(first.journal.sessionKey), undefined, 'the deleted journal');
      expectEqual(await keysOf(store, second.journal.sessionKey), ['m1'], 'the other journal');
    },
  },
  {
    name: 'accepts the deletion of a journal it never stored',
    async run(open) {
      const { store } = await open();
      await store.delete('host-1:codex:never');
      await store.catalog.deletePrefix('host-9:');
      expectEqual(await store.catalog.list(''), [], 'listing');
    },
  },
  {
    name: 'keeps an item far larger than a chunk, with characters that span chunk boundaries',
    async run(open) {
      const subject = await open();
      const chunkBytes = subject.chunkBytes ?? 256 * 1024;
      const text = '😀é'.repeat(Math.ceil((chunkBytes * 3) / 6) + 1);
      const { journal, at } = openJournal();
      journal.append(at(), row('big', text));
      await subject.store.apply(journal.takeChanges()!);
      const restored = (await subject.reopen().then(store => store.load(journal.sessionKey)))!;
      expectEqual((restored.items[0]?.body?.item as { text?: string } | undefined)?.text === text, true, 'the text of the large item');
    },
  },
  {
    name: 'lists journals by key prefix with their head flag and size',
    async run(open) {
      const { store } = await open();
      const first = openJournal('host-1:codex:session-1');
      const second = openJournal('host-2:codex:session-1');
      first.journal.append(first.at(), row('m1', 'Hello'));
      first.journal.setHead(first.at(), { snapshot: snapshot(), observedAt: 5 });
      second.journal.append(second.at(), row('m1', 'Hello'));
      await store.apply(first.journal.takeChanges()!);
      await store.apply(second.journal.takeChanges()!);
      expectEqual(await store.catalog.list('host-1:'), [{ sessionKey: 'host-1:codex:session-1', hasHead: true, bytes: first.journal.residentBytes() }], 'listing of one Host');
      expectEqual((await store.catalog.list('')).map(({ sessionKey, hasHead }) => [sessionKey, hasHead]), [['host-1:codex:session-1', true], ['host-2:codex:session-1', false]], 'listing in key order');
      expectEqual(await store.catalog.list('host-3:'), [], 'listing of an unknown Host');
    },
  },
  {
    name: 'reports the size of the latest changes',
    async run(open) {
      const { store } = await open();
      const { journal, at } = openJournal();
      journal.append(at(), row('m1', 'x'.repeat(500)));
      await store.apply(journal.takeChanges()!);
      const before = (await store.catalog.list(''))[0]!.bytes;
      journal.sync(at(), [{ row: row('m2', 'y'), digest: 'digest-2' }], { roomBytes: Number.MAX_SAFE_INTEGER });
      await store.apply(journal.takeChanges()!);
      const after = (await store.catalog.list(''))[0]!.bytes;
      expectTrue(after < before, 'the size shrinks with the replacement');
      expectEqual(after, journal.residentBytes(), 'size');
    },
  },
  {
    name: 'deletes the journals under a prefix and no others',
    async run(open) {
      const { store } = await open();
      const first = openJournal('host-1:codex:session-1');
      const second = openJournal('host-2:codex:session-1');
      first.journal.append(first.at(), row('m1', 'Hello'));
      second.journal.append(second.at(), row('m1', 'Hello'));
      await store.apply(first.journal.takeChanges()!);
      await store.apply(second.journal.takeChanges()!);
      await store.catalog.deletePrefix('host-2:');
      expectEqual(await sessionKeys(store, ''), ['host-1:codex:session-1'], 'journals left');
      expectEqual(await store.load('host-2:codex:session-1'), undefined, 'the deleted journal');
      expectTrue((await store.load('host-1:codex:session-1')) !== undefined, 'the kept journal loads');
    },
  },
  {
    name: 'does not take a key that merely starts like another Host\'s prefix',
    async run(open) {
      const { store } = await open();
      const first = openJournal('host-1:codex:session-1');
      const second = openJournal('host-10:codex:session-1');
      first.journal.append(first.at(), row('m1', 'Hello'));
      second.journal.append(second.at(), row('m1', 'Hello'));
      await store.apply(first.journal.takeChanges()!);
      await store.apply(second.journal.takeChanges()!);
      expectEqual(await sessionKeys(store, 'host-1:'), ['host-1:codex:session-1'], 'listing');
      await store.catalog.deletePrefix('host-1:');
      expectEqual(await sessionKeys(store, ''), ['host-10:codex:session-1'], 'journals left');
    },
  },
  {
    name: 'keeps the journals of two sessions apart',
    async run(open) {
      const { store } = await open();
      const first = openJournal('host-1:codex:session-1');
      const second = openJournal('host-1:codex:session-2');
      first.journal.append(first.at(), row('a', 'first'));
      second.journal.append(second.at(), row('b', 'second'));
      await store.apply(first.journal.takeChanges()!);
      await store.apply(second.journal.takeChanges()!);
      expectEqual(await keysOf(store, first.journal.sessionKey), ['a'], 'first');
      expectEqual(await keysOf(store, second.journal.sessionKey), ['b'], 'second');
    },
  },
  {
    name: 'lists a journal without a head after its head was cleared',
    async run(open) {
      const { store } = await open();
      const { journal, at } = openJournal();
      journal.append(at(), row('m1', 'Hello'));
      journal.setHead(at(), { snapshot: snapshot(), observedAt: 5 });
      await store.apply(journal.takeChanges()!);
      expectEqual((await store.catalog.list('')).map(({ hasHead }) => hasHead), [true], 'listing with a head');
      journal.clearHead();
      await store.apply(journal.takeChanges()!);
      expectEqual((await store.catalog.list('')).map(({ hasHead }) => hasHead), [false], 'listing after the head was cleared');
      expectEqual((await restore(store, journal.sessionKey)).head, undefined, 'the head of the restored journal');
    },
  },
  {
    name: 'keeps the mark of a journal that is missing rows',
    async run(open) {
      const { store } = await open();
      const { journal, at } = openJournal();
      journal.append(at(), row('m1', 'Hello'));
      journal.markIncomplete();
      await store.apply(journal.takeChanges()!);
      expectEqual((await restore(store, journal.sessionKey)).incomplete, true, 'incomplete');
    },
  },
  {
    name: 'keeps live-only items marked until they are dropped',
    async run(open) {
      const { store } = await open();
      const { journal, at } = openJournal();
      journal.append(at(), { ...row('l1', 'live'), liveOnly: true });
      journal.complete(at(), 'l1', 'digest-l1');
      journal.append(at(), row('m1', 'kept'));
      await store.apply(journal.takeChanges()!);
      const restored = await restore(store, journal.sessionKey);
      expectEqual(restored.liveOnlyCount, 1, 'live-only items');
      expectEqual(restored.state().items.map(item => [item.itemKey, item.liveOnly]), [['l1', true], ['m1', false]], 'items');
    },
  },
  {
    name: 'hands out copies, so changing a loaded state leaves the stored journal as it was',
    async run(open) {
      const { store } = await open();
      const { journal, at } = openJournal();
      journal.append(at(), row('m1', 'Hello'));
      await store.apply(journal.takeChanges()!);
      const loaded = (await store.load(journal.sessionKey))!;
      loaded.items.length = 0;
      loaded.meta.nextSeq = 999;
      expectEqual((await restore(store, journal.sessionKey)).state(), journal.state(), 'state');
    },
  },
];
