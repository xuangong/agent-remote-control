import type { JournalPageRequest, JournalPageResult } from '@orchardworks/agent-remote-journal';
import type { CompleteItemInput, JournalPublishEntry } from '@orchardworks/agent-remote-protocol';

import { JOURNAL_VERSION } from '@orchardworks/agent-remote-protocol';

import { type HostJournals, type JournalFilled, type JournalOpened, type JournalOpenRefusal, type JournalPublished, type JournalStatus } from './host-journals.js';
import { JournalHeadIndex } from './journal-head-index.js';

/** What a journal partition keeps in memory: a Durable Object has 128 MB, so only the journal in use stays. */
export const JOURNAL_PARTITION_CACHE = { maxJournals: 2, maxBytes: 20 * 1024 * 1024 } as const;
/** The growth limits of a partition; the per-Host quota is the one of the object's SQLite storage. */
export const JOURNAL_PARTITION_LIMITS = { sessionBytes: 12 * 1024 * 1024, hostBytes: 1024 * 1024 * 1024 } as const;
/** A reply whose estimated clone size passes this is answered again with fewer entries: a Workers RPC message may not exceed 32 MiB. A session holds at most 12 MiB of UTF-8, so one entry at two bytes per character stays well below the message limit. */
const REPLY_MAX_BYTES = 24 * 1024 * 1024;

/** What a partition reports about itself: the journal version it serves. */
export interface JournalPartitionCapabilities {
  journal: number;
}

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
 * A Relay asks `capabilities` before the first open of a Host and refuses the open unless the partition answers the
 * journal version the Relay speaks, so a partition never receives an operation it does not know. `journal-partition.contract.json` records the calls and replies of every method.
 */
export interface JournalPartitionApi {
  open(hostId: string, sessionKey: string, publisherId: string): Promise<JournalOpened | JournalOpenRefusal>;
  publish(hostId: string, sessionKey: string, generation: number, entries: JournalPublishEntry[]): Promise<JournalPublished>;
  /** Fills bodies. With `read`, the page comes back in the same reply and was read in the same step as the fill. */
  fill(hostId: string, sessionKey: string, items: CompleteItemInput[], read?: JournalPartitionRead): Promise<JournalFilled>;
  page(hostId: string, sessionKey: string, request: JournalPageRequest, olderBeyondJournal: boolean): Promise<JournalPageResult | undefined>;
  status(hostId: string, sessionKey: string): Promise<JournalStatus | undefined>;
  /** The Controller of `generation` can no longer keep the session's journal current: clears its head. */
  unserveHead(hostId: string, sessionKey: string, generation: number): Promise<JournalPublished | undefined>;
  /** The Host's sessions that have a head. */
  servedSessions(hostId: string): Promise<string[]>;
  deleteHost(hostId: string): Promise<void>;
  /** The journal version this partition serves. */
  capabilities(hostId: string): Promise<JournalPartitionCapabilities>;
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
    open: (hostId, sessionKey, publisherId) => journals.open(hostId, sessionKey, publisherId, {}),
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
    capabilities: async () => ({ journal: JOURNAL_VERSION }),
  };
}

export interface PartitionJournalsOptions {
  /** The partition of a Host: a Durable Object stub. */
  partition(hostId: string): JournalPartitionApi;
}

/**
 * The `primary` side: a `HostJournals` that forwards each call to the Host's partition. It keeps the head index, so a
 * browser stream is gated without a call. Opens, publications, fills and deletions of one Host run in the order they were
 * made, so a deletion is never overtaken by a later call.
 */
export function createPartitionJournals(options: PartitionJournalsOptions): HostJournals {
  const { partition } = options;
  /** The Hosts whose partition answered the version this Relay speaks. */
  const verified = new Set<string>();
  const heads = new JournalHeadIndex();
  const chains = new Map<string, Promise<void>>();
  const loading = new Map<string, Promise<void>>();
  /** Inside the Host's queue. An answer other than the Relay's version, or none, is not cached: the next open asks again. */
  async function ensureVersion(hostId: string): Promise<boolean> {
    if (verified.has(hostId)) return true;
    try {
      if ((await partition(hostId).capabilities(hostId)).journal !== JOURNAL_VERSION) return false;
    } catch { return false; }
    verified.add(hostId);
    return true;
  }

  function serialized<T>(hostId: string, work: () => Promise<T>): Promise<T> {
    const result = (chains.get(hostId) ?? Promise.resolve()).then(work);
    const tail = result.then(() => undefined, () => undefined);
    chains.set(hostId, tail);
    void tail.then(() => { if (chains.get(hostId) === tail) chains.delete(hostId); });
    return result;
  }

  /** One load per Host at a time, outside the Host's queue. `heads.load` merges, so a head set meanwhile stays; a session wrongly listed as served is unserved when a browser finds no head. */
  function loadHost(hostId: string): Promise<void> {
    if (heads.loaded(hostId)) return Promise.resolve();
    let pending = loading.get(hostId);
    if (!pending) {
      pending = (async () => {
        const sessions = await partition(hostId).servedSessions(hostId);
        if (!heads.loaded(hostId)) heads.load(hostId, sessions);
      })().finally(() => { loading.delete(hostId); });
      loading.set(hostId, pending);
    }
    return pending;
  }

  return {
    open: (hostId, sessionKey, publisherId, { allowed }) => serialized<JournalOpened | JournalOpenRefusal>(hostId, async () => {
      if (allowed && !allowed()) return { refused: 'unavailable' };
      if (!await ensureVersion(hostId)) {
        // The partition cannot take this Controller's journal, so the old head must not go on serving the session: streams close and read crude.
        const wasServed = heads.served(hostId, sessionKey) === true;
        heads.remove(hostId, sessionKey);
        return wasServed ? { refused: 'unavailable', unserved: true } : { refused: 'unavailable' };
      }
      return partition(hostId).open(hostId, sessionKey, publisherId);
    }),

    publish: (hostId, sessionKey, generation, entries) => serialized<JournalPublished>(hostId, async () => {
      const result = await partition(hostId).publish(hostId, sessionKey, generation, [...entries]);
      if (result.hasHead === true) heads.add(hostId, sessionKey);
      else if (result.hasHead === false) heads.remove(hostId, sessionKey);
      return result;
    }),

    // Whether the Host may hold older history is asked here, in the Host's queue, as the service asks it.
    fill: (hostId, sessionKey, items, read) => serialized<JournalFilled>(hostId, () =>
      partition(hostId).fill(hostId, sessionKey, [...items], read && { request: read.request, olderBeyondJournal: read.olderBeyondJournal() })),

    // Reads wait in the Host's queue behind earlier publications, as in the in-process service.
    page: (hostId, sessionKey, request, olderBeyondJournal) => serialized(hostId, () => partition(hostId).page(hostId, sessionKey, request, olderBeyondJournal)),

    status: (hostId, sessionKey) => serialized(hostId, () => partition(hostId).status(hostId, sessionKey)),

    unserveHead: (hostId, sessionKey, generation) => serialized<JournalPublished | undefined>(hostId, async () => {
      const result = await partition(hostId).unserveHead(hostId, sessionKey, generation);
      if (result) heads.remove(hostId, sessionKey);
      return result;
    }),

    async forget() { /* The partition owns its cache. */ },

    served: (hostId, sessionKey) => heads.served(hostId, sessionKey),

    unserve(hostId, sessionKey) {
      heads.remove(hostId, sessionKey);
    },

    async servedSessions(hostId) {
      await loadHost(hostId);
      return heads.sessions(hostId);
    },

    async loadAllServed() { /* A Host's sessions load when the first stream for it needs them. */ },

    deleteHost: hostId => serialized<void>(hostId, async () => {
      await partition(hostId).deleteHost(hostId);
      heads.clearHost(hostId);
    }),
  };
}
