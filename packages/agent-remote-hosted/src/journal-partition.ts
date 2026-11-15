import type { JournalIndexEntry, JournalPageRequest, JournalPageResult } from '@orchardworks/agent-remote-journal';
import type { CompleteItemInput, JournalPublishEntry } from '@orchardworks/agent-remote-protocol';

import { HOST_DELETIONS_AT_ONCE, type HostJournals, type JournalCapabilities, type JournalFilled, type JournalOpened, type JournalOpenRefusal, type JournalPublished, type JournalStatus } from './host-journals.js';
import { JournalHeadIndex } from './journal-head-index.js';

/** What a journal partition keeps in memory: a Durable Object has 128 MB, so only the journal in use stays. */
export const JOURNAL_PARTITION_CACHE = { maxJournals: 2, maxBytes: 20 * 1024 * 1024 } as const;
/** The growth limits of a partition; the per-Host quota is the one of the object's SQLite storage. */
export const JOURNAL_PARTITION_LIMITS = { sessionBytes: 12 * 1024 * 1024, hostBytes: 1024 * 1024 * 1024 } as const;
/** A reply whose estimated clone size passes this is answered again with fewer entries: a Workers RPC message may not exceed 32 MiB. A session holds at most 12 MiB of UTF-8, so one entry at two bytes per character stays well below the message limit. */
const REPLY_MAX_BYTES = 24 * 1024 * 1024;

/** A page read in the same step as a fill. Whether the Host may hold older history is known to `primary`, so it crosses as a value. */
export interface JournalPartitionRead {
  request: JournalPageRequest;
  olderBeyondJournal: boolean;
}

/**
 * What `primary` asks of the partition of one Host. Every argument and result is plain data that crosses Durable
 * Object RPC by structured clone; nothing here is a function. The partition runs the journal service of that one Host.
 *
 * The Relay and the partitions Worker deploy separately. The partitions Worker is always deployed first. The methods and
 * the fields of their arguments and results are never changed or removed, only added, and an added field is optional.
 * A Relay asks `capabilities` once per partition and grants nothing the partition did not report; a partition that has no
 * such method is a version-1 partition. `journal-partition.contract.json` records the calls and replies of every method.
 */
export interface JournalPartitionApi {
  open(hostId: string, sessionKey: string, publisherId: string, options: { maxIndexItems: number; pageItems: number; reset?: true }): Promise<JournalOpened | JournalOpenRefusal>;
  indexPage(hostId: string, sessionKey: string, epoch: string, after: number, maxItems: number): Promise<JournalIndexEntry[] | undefined>;
  publish(hostId: string, sessionKey: string, generation: number, entries: JournalPublishEntry[]): Promise<JournalPublished>;
  /** Fills bodies. With `read`, the page comes back in the same reply and was read in the same step as the fill. */
  fill(hostId: string, sessionKey: string, items: CompleteItemInput[], read?: JournalPartitionRead): Promise<JournalFilled>;
  page(hostId: string, sessionKey: string, request: JournalPageRequest, olderBeyondJournal: boolean): Promise<JournalPageResult | undefined>;
  status(hostId: string, sessionKey: string): Promise<JournalStatus | undefined>;
  /** The Controller of `generation` can no longer keep the session's journal current: clears its head. A partition that reports `journal: 2` has this method. */
  unserveHead(hostId: string, sessionKey: string, generation: number): Promise<JournalPublished | undefined>;
  /** The Host's sessions that have a head. */
  servedSessions(hostId: string): Promise<string[]>;
  deleteHost(hostId: string): Promise<void>;
  /** What this partition can serve. A partition of an earlier version has no such method. */
  capabilities(hostId: string): Promise<JournalCapabilities>;
}

/**
 * An upper estimate of the size of a value as V8 clones it, counted without copying it: a string takes two bytes per
 * character (its size as UTF-16, the most a clone can take), a number eight, and each value and key a few bytes of tag and length.
 */
export function estimateCloneBytes(value: unknown): number {
  switch (typeof value) {
    case 'string': return 8 + value.length * 2;
    case 'number': case 'bigint': return 9;
    case 'boolean': return 2;
    case 'object': {
      if (value === null) return 1;
      let bytes = 8;
      if (Array.isArray(value)) { for (const entry of value) bytes += estimateCloneBytes(entry); return bytes; }
      for (const [key, entry] of Object.entries(value)) bytes += estimateCloneBytes(key) + estimateCloneBytes(entry);
      return bytes;
    }
    default: return 1;
  }
}

/** The partition side: adapts a journal service to the contract and keeps its replies within the RPC bound. */
export function serveJournalPartition(journals: HostJournals, options: { replyMaxBytes?: number } = {}): JournalPartitionApi {
  const replyMaxBytes = options.replyMaxBytes ?? REPLY_MAX_BYTES;
  return {
    open: (hostId, sessionKey, publisherId, bounds) => journals.open(hostId, sessionKey, publisherId, bounds),
    indexPage: (hostId, sessionKey, epoch, after, maxItems) => journals.indexPage(hostId, sessionKey, epoch, after, maxItems),
    publish: (hostId, sessionKey, generation, entries) => journals.publish(hostId, sessionKey, generation, entries),
    async fill(hostId, sessionKey, items, read) {
      if (!read) return journals.fill(hostId, sessionKey, items);
      const olderBeyondJournal = () => read.olderBeyondJournal;
      let filled = await journals.fill(hostId, sessionKey, items, { request: read.request, olderBeyondJournal });
      let limit = read.request.limit;
      // The bodies are filled once. A page that is too large is read again with fewer entries, in a step of its own;
      // bodies that were filled stay resident until a publication moves the retained window past them.
      while (filled.page?.kind === 'page' && limit > 1 && estimateCloneBytes(filled) > replyMaxBytes) {
        limit = Math.max(1, Math.floor(limit / 2));
        const { page } = await journals.fill(hostId, sessionKey, [], { request: { ...read.request, limit }, olderBeyondJournal });
        const { page: _discarded, ...rest } = filled;
        filled = page ? { ...rest, page } : rest;
      }
      return filled;
    },
    async page(hostId, sessionKey, request, olderBeyondJournal) {
      let limit = request.limit;
      for (;;) {
        const result = await journals.page(hostId, sessionKey, { ...request, limit }, olderBeyondJournal);
        if (!result || result.kind !== 'page' || limit === 1 || estimateCloneBytes(result) <= replyMaxBytes) return result;
        limit = Math.max(1, Math.floor(limit / 2));
      }
    },
    status: (hostId, sessionKey) => journals.status(hostId, sessionKey),
    unserveHead: (hostId, sessionKey, generation) => journals.unserveHead(hostId, sessionKey, generation),
    servedSessions: hostId => journals.servedSessions(hostId),
    deleteHost: hostId => journals.deleteHost(hostId),
    capabilities: hostId => journals.capabilities(hostId),
  };
}

/** What a partition that has no `capabilities` method can serve. */
const VERSION_ONE_PARTITION: JournalCapabilities = { journal: 1 };
/** How long a failed `capabilities` call is remembered; an answer is remembered for the life of the proxy. */
const CAPABILITIES_RETRY_MS = 30_000;

export interface PartitionJournalsOptions {
  /** The partition of a Host: a Durable Object stub. */
  partition(hostId: string): JournalPartitionApi;
  now?(): number;
}

/**
 * The `primary` side: a `HostJournals` that forwards each call to the Host's partition. It keeps the head index, so a
 * browser stream is gated without a call. Opens, publications, fills and deletions of one Host run in the order they were
 * made, so a deletion is never overtaken by a later call. Each partition holds one Host, so the cap of four deletions at
 * once across the Relay is held here, not in the partitions.
 */
export function createPartitionJournals(options: PartitionJournalsOptions): HostJournals {
  const { partition } = options;
  const now = options.now ?? Date.now;
  const capabilitiesOf = new Map<string, { capabilities: JournalCapabilities; failedAt?: number }>();
  const heads = new JournalHeadIndex();
  const chains = new Map<string, Promise<void>>();
  const loading = new Map<string, Promise<void>>();
  /** Raised when the head index loses a session (an unserve, an open or publication that cleared a head) and when a deletion starts and ends, so a load read in between is discarded. Adding a head never raises it. */
  const epochs = new Map<string, number>();
  const bump = (hostId: string) => { epochs.set(hostId, (epochs.get(hostId) ?? 0) + 1); };
  let deletionsRunning = 0;
  const deletionWaiters: Array<() => void> = [];

  async function withDeletionSlot<T>(operation: () => Promise<T>): Promise<T> {
    while (deletionsRunning >= HOST_DELETIONS_AT_ONCE) await new Promise<void>(resolve => deletionWaiters.push(resolve));
    deletionsRunning += 1;
    try { return await operation(); } finally { deletionsRunning -= 1; deletionWaiters.shift()?.(); }
  }

  function serialized<T>(hostId: string, work: () => Promise<T>): Promise<T> {
    const result = (chains.get(hostId) ?? Promise.resolve()).then(work);
    const tail = result.then(() => undefined, () => undefined);
    chains.set(hostId, tail);
    void tail.then(() => { if (chains.get(hostId) === tail) chains.delete(hostId); });
    return result;
  }

  /** One load per Host at a time, outside the Host's queue. A load that a head change or a deletion overtook is read again. */
  function loadHost(hostId: string): Promise<void> {
    if (heads.loaded(hostId)) return Promise.resolve();
    let pending = loading.get(hostId);
    if (!pending) {
      pending = (async () => {
        for (let attempt = 0; attempt < 3 && !heads.loaded(hostId); attempt++) {
          const epoch = epochs.get(hostId) ?? 0;
          const sessions = await partition(hostId).servedSessions(hostId);
          if ((epochs.get(hostId) ?? 0) === epoch && !heads.loaded(hostId)) heads.load(hostId, sessions);
        }
      })().finally(() => { loading.delete(hostId); });
      loading.set(hostId, pending);
    }
    return pending;
  }

  return {
    open: (hostId, sessionKey, publisherId, { allowed, maxIndexItems, pageItems, reset }) => serialized<JournalOpened | JournalOpenRefusal>(hostId, async () => {
      if (allowed && !allowed()) return { refused: 'unavailable' };
      const opened = await partition(hostId).open(hostId, sessionKey, publisherId, { maxIndexItems, pageItems, ...(reset ? { reset: true as const } : {}) });
      if (opened.unserved) {
        heads.remove(hostId, sessionKey);
        bump(hostId);
      }
      return opened;
    }),

    indexPage: (hostId, sessionKey, epoch, after, maxItems) => serialized(hostId, () => partition(hostId).indexPage(hostId, sessionKey, epoch, after, maxItems)),

    publish: (hostId, sessionKey, generation, entries) => serialized<JournalPublished>(hostId, async () => {
      try {
        const result = await partition(hostId).publish(hostId, sessionKey, generation, [...entries]);
        if (result.hasHead === true) heads.add(hostId, sessionKey);
        else if (result.hasHead === false) heads.remove(hostId, sessionKey);
        // A publication that gives a head only adds to what a load reads, so it cannot make a load stale; one that took a head away can.
        if (result.unserved) bump(hostId);
        return result;
      } catch (error) {
        bump(hostId);
        throw error;
      }
    }),

    // Whether the Host may hold older history is asked here, in the Host's queue, as the service asks it.
    fill: (hostId, sessionKey, items, read) => serialized<JournalFilled>(hostId, () =>
      partition(hostId).fill(hostId, sessionKey, [...items], read && { request: read.request, olderBeyondJournal: read.olderBeyondJournal() })),

    // Reads wait in the Host's queue behind earlier publications, as in the in-process service.
    page: (hostId, sessionKey, request, olderBeyondJournal) => serialized(hostId, () => partition(hostId).page(hostId, sessionKey, request, olderBeyondJournal)),

    status: (hostId, sessionKey) => serialized(hostId, () => partition(hostId).status(hostId, sessionKey)),

    unserveHead: (hostId, sessionKey, generation) => serialized<JournalPublished | undefined>(hostId, async () => {
      const result = await partition(hostId).unserveHead(hostId, sessionKey, generation);
      if (result) {
        heads.remove(hostId, sessionKey);
        bump(hostId);
      }
      return result;
    }),

    async capabilities(hostId) {
      const known = capabilitiesOf.get(hostId);
      if (known && (known.failedAt === undefined || now() - known.failedAt < CAPABILITIES_RETRY_MS)) return { ...known.capabilities };
      try {
        const capabilities = await partition(hostId).capabilities(hostId);
        capabilitiesOf.set(hostId, { capabilities });
        return { ...capabilities };
      } catch {
        // An error is what a partition without the method answers: grant nothing it may not know.
        capabilitiesOf.set(hostId, { capabilities: VERSION_ONE_PARTITION, failedAt: now() });
        return { ...VERSION_ONE_PARTITION };
      }
    },

    async forget() { /* The partition owns its cache. */ },

    served: (hostId, sessionKey) => heads.served(hostId, sessionKey),

    unserve(hostId, sessionKey) {
      heads.remove(hostId, sessionKey);
      bump(hostId);
    },

    async servedSessions(hostId) {
      await loadHost(hostId);
      return heads.sessions(hostId);
    },

    async loadAllServed() { /* A Host's sessions load when the first stream for it needs them. */ },

    deleteHost: hostId => withDeletionSlot(() => serialized<void>(hostId, async () => {
      bump(hostId);
      try {
        await partition(hostId).deleteHost(hostId);
        heads.clearHost(hostId);
      } finally { bump(hostId); }
    })),
  };
}
