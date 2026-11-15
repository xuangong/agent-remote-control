import {
  bodyFromRow, JournalBodyMissingError, JournalDuplicateItemError, JournalFencedError, JournalInvalidPublicationError, JournalInvalidRowError, JournalItemTypeChangedError,
  JournalStaleRevisionError, JournalUnknownItemError, SessionJournal, utf8ByteLength,
  type JournalHead, type JournalIndexEntry, type JournalListing, type JournalPageRequest, type JournalPageResult, type JournalPublication, type JournalRow, type JournalStore,
} from '@orchardworks/agent-remote-journal';
import { JOURNAL_INDEX_MAX_ITEMS, type CompleteItemInput, type JournalPublishEntry, type JournalRefusalReason, type TimelineCursor } from '@orchardworks/agent-remote-protocol';

import { JournalHeadIndex } from './journal-head-index.js';

/** Journals kept in memory, for the whole Relay. */
const CACHE_MAX_JOURNALS = 64;
/** The estimated size of the journals kept in memory, for the whole Relay. */
const CACHE_MAX_BYTES = 128 * 1024 * 1024;
/** A session's estimated size above which a growing entry is refused once its bodies are evicted as far as they can be. */
const SESSION_MAX_BYTES = 64 * 1024 * 1024;
/** The estimated size of all journals of a Host above which a growing entry is refused. */
const HOST_MAX_BYTES = 1024 * 1024 * 1024;
/** Live-only items kept per session; beyond it the oldest are removed. */
const LIVE_ONLY_MAX_ITEMS = 2000;
/** Turns whose bodies stay resident. */
const RETAIN_TURNS = 50;

export interface HostJournalsOptions {
  store: JournalStore;
  now(): number;
  /** How much the service keeps in memory; a journal is read from the store again when it is needed after it was dropped. */
  cache?: { maxJournals?: number; maxBytes?: number };
  /** Safety bounds on growth. They are not the retention policy. `sessionItems` never exceeds what an index may list. */
  limits?: { sessionBytes?: number; sessionItems?: number; hostBytes?: number; liveOnlyItems?: number };
  /** The working set: how many of the latest turns keep their bodies after a publication. */
  retention?: { turns?: number };
}

export interface JournalOpenOptions {
  /** A journal whose index lists more items than this is refused, and nothing is claimed. */
  maxIndexItems: number;
  /** How many entries of the index the answer carries; `indexPage` reads the rest. */
  pageItems: number;
  /** Asked inside the Host's queue: false means the connection that asked is gone, so nothing is created or claimed. */
  allowed?(): boolean;
}

export interface JournalOpened {
  generation: number;
  watermark: number;
  epoch: string;
  /** The first `pageItems` entries of the index. */
  index: JournalIndexEntry[];
  /** Whether the index has entries beyond `index`. */
  more: boolean;
}

/** The journal could not be opened, and no generation was claimed. */
export interface JournalOpenRefusal {
  refused: 'index_too_large' | 'unavailable';
}

export interface JournalRefusal {
  sequence: number;
  reason: JournalRefusalReason;
  itemKey?: string;
}

/** What a subscriber of the session sees of a publication, in the order its entries were applied. */
export type JournalLiveEvent =
  /** An appended row; it is delivered live with its epoch and sequence. Corrections and prepended rows are never events. */
  | { kind: 'row'; row: JournalRow }
  /** A replacement started a new epoch. */
  | { kind: 'replaced'; epoch: string }
  /** A head that was not already applied. */
  | { kind: 'head'; head: JournalHead };

/** The journal's cursor, and its head once the Controller has published one. */
export interface JournalStatus {
  cursor: TimelineCursor;
  head?: JournalHead;
}

export interface JournalPublished {
  /** What live subscribers see of the publication, in order. */
  events: JournalLiveEvent[];
  /** The last publication applied; everything up to it is stored. */
  watermark: number;
  /** The journal's cursor after the publication; absent when the session has no journal. */
  cursor?: TimelineCursor;
  /** Whether the journal has a head after the publication; absent when the session has no journal. */
  hasHead?: boolean;
  /** The first entry the journal refused; entries before it are applied and stored. */
  refusal?: JournalRefusal;
  /** A quota refusal cleared the journal's head: the session is no longer served from it until a later head is published. */
  unserved?: true;
  /** Live-only items removed because the session passed its cap. */
  droppedLiveOnly?: number;
}

export interface JournalFilled {
  filled: string[];
  mismatched: string[];
  unknown: string[];
  /** Bodies that were not put back because the session, the Host or the cache has no room; they stay missing. */
  skipped?: string[];
}

/**
 * The session journals of the Hosts of one Relay. Journals are keyed by Host and session, loaded from the store when
 * first used, and changed only through this service. All work of one Host runs one call at a time, in the order the calls
 * were made, and a journal is stored before the call that changed it returns.
 */
export interface HostJournals {
  /**
   * Claims the session's journal for a publisher, creating it when needed, and fences every older generation. When the
   * index is over `options.maxIndexItems`, or `options.allowed` says the connection is gone, nothing is created or claimed.
   */
  open(hostId: string, sessionKey: string, publisherId: string, options: JournalOpenOptions): Promise<JournalOpened | JournalOpenRefusal>;
  /**
   * Up to `maxItems` entries of the session's index whose `seqStart` is above `after`, in order. Undefined when the session
   * has no journal or its epoch is no longer `epoch`: a replacement happened, and the cursor means nothing now.
   */
  indexPage(hostId: string, sessionKey: string, epoch: string, after: number, maxItems: number): Promise<JournalIndexEntry[] | undefined>;
  /** Applies entries in order and stores the changes before returning. */
  publish(hostId: string, sessionKey: string, generation: number, entries: readonly JournalPublishEntry[]): Promise<JournalPublished>;
  /** Puts bodies the Host read again back into the journal, as far as the limits allow. */
  fill(hostId: string, sessionKey: string, items: readonly CompleteItemInput[]): Promise<JournalFilled>;
  /** A page of the session's journal, or undefined when it has none. */
  page(hostId: string, sessionKey: string, request: JournalPageRequest, olderBeyondJournal: boolean): Promise<JournalPageResult | undefined>;
  /** The cursor and head of the session's journal, or undefined when it has none. */
  status(hostId: string, sessionKey: string): Promise<JournalStatus | undefined>;
  /** Drops the journals cached for a Host; the store keeps them. */
  forget(hostId: string): Promise<void>;
  /** Whether the session has a journal head, answered from memory; undefined until the Host's sessions are loaded. */
  served(hostId: string, sessionKey: string): boolean | undefined;
  /**
   * The Host's sessions that have a journal head. Loads them for `served` when the Host was not loaded. It does not wait
   * for the Host's queue, and concurrent calls share one load.
   */
  servedSessions(hostId: string): Promise<string[]>;
  /** Loads the sessions with a head of every Host the store holds, so `served` never answers undefined. */
  loadAllServed(): Promise<void>;
  /**
   * A stream found the session without a head although `served` said it had one: forget it, so the client's reconnect is
   * read through the Controller instead of looping. A later publication that sets a head serves it again.
   */
  unserve(hostId: string, sessionKey: string): void;
  /** Deletes every journal of the Host. */
  deleteHost(hostId: string): Promise<void>;
}

/** A growing entry the journal's limits do not allow. */
class JournalQuotaRefused extends Error {
  constructor(readonly limit: 'items' | 'session' | 'host') {
    super(`The journal is over its ${limit} limit.`);
    this.name = 'JournalQuotaRefused';
  }
}

function wholeNumber(name: string, value: number): number {
  if (!Number.isSafeInteger(value) || value < 0) throw new RangeError(`${name} must be a non-negative whole number.`);
  return value;
}

type Cached = { hostId: string; sessionKey: string; journal: SessionJournal; bytes: number };
type HostUsage = { total: number; sessions: Map<string, number> };

export function createHostJournals(options: HostJournalsOptions): HostJournals {
  const { store, now } = options;
  const cacheLimits = {
    maxJournals: wholeNumber('Journal cache journals', options.cache?.maxJournals ?? CACHE_MAX_JOURNALS),
    maxBytes: wholeNumber('Journal cache bytes', options.cache?.maxBytes ?? CACHE_MAX_BYTES),
  };
  const limits = {
    sessionBytes: wholeNumber('Journal session bytes', options.limits?.sessionBytes ?? SESSION_MAX_BYTES),
    sessionItems: Math.min(wholeNumber('Journal session items', options.limits?.sessionItems ?? JOURNAL_INDEX_MAX_ITEMS), JOURNAL_INDEX_MAX_ITEMS),
    hostBytes: wholeNumber('Journal Host bytes', options.limits?.hostBytes ?? HOST_MAX_BYTES),
    liveOnlyItems: wholeNumber('Journal live-only items', options.limits?.liveOnlyItems ?? LIVE_ONLY_MAX_ITEMS),
  };
  const retainTurns = wholeNumber('Journal retained turns', options.retention?.turns ?? RETAIN_TURNS);
  /** Least recently used first. */
  const cache = new Map<string, Cached>();
  let cacheBytes = 0;
  const chains = new Map<string, Promise<void>>();
  /** Sessions whose last publication failed to apply or store: nothing more is accepted until the session is opened again. */
  const needsReopen = new Set<string>();
  const heads = new JournalHeadIndex();
  const hostsLoaded = new Set<string>();
  const usage = new Map<string, HostUsage>();
  const loading = new Map<string, Promise<void>>();
  /** Raised on every change of a Host's head index and when its deletion starts and ends, so a listing read in between is discarded. */
  const epochs = new Map<string, number>();
  const bump = (hostId: string) => { epochs.set(hostId, (epochs.get(hostId) ?? 0) + 1); };
  const storeKey = (hostId: string, sessionKey: string) => `${hostId}:${sessionKey}`;
  const hostPrefix = (hostId: string) => `${hostId}:`;

  function serialized<T>(hostId: string, work: () => Promise<T>): Promise<T> {
    const result = (chains.get(hostId) ?? Promise.resolve()).then(work);
    const tail = result.then(() => undefined, () => undefined);
    chains.set(hostId, tail);
    void tail.then(() => { if (chains.get(hostId) === tail) chains.delete(hostId); });
    return result;
  }

  function drop(key: string): void {
    const entry = cache.get(key);
    if (!entry) return;
    cache.delete(key);
    cacheBytes -= entry.bytes;
  }

  function remember(hostId: string, sessionKey: string, journal: SessionJournal, bytes: number = journal.residentBytes()): void {
    const key = storeKey(hostId, sessionKey);
    drop(key);
    cache.set(key, { hostId, sessionKey, journal, bytes });
    cacheBytes += bytes;
  }

  /** Drops least recently used journals until the cache is within its bounds, but never the journal in use. */
  function trimCache(keepKey: string): void {
    for (const key of [...cache.keys()]) {
      if (cache.size <= cacheLimits.maxJournals && cacheBytes <= cacheLimits.maxBytes) return;
      if (key !== keepKey) drop(key);
    }
  }

  async function load(hostId: string, sessionKey: string, create: boolean): Promise<SessionJournal | undefined> {
    const key = storeKey(hostId, sessionKey);
    const cached = cache.get(key);
    if (cached) {
      cache.delete(key);
      cache.set(key, cached);
      return cached.journal;
    }
    const saved = await store.load(key);
    const journal = saved ? new SessionJournal(saved) : create ? SessionJournal.create(key) : undefined;
    if (journal) {
      remember(hostId, sessionKey, journal);
      trimCache(key);
    }
    return journal;
  }

  /** Writes what changed and returns the journal's estimated size; after a failed write the cached journal is ahead of the store, so it is dropped. */
  async function persist(hostId: string, sessionKey: string, journal: SessionJournal): Promise<number | undefined> {
    const changes = journal.takeChanges();
    if (!changes) return undefined;
    try { await store.apply(changes); }
    catch (error) { drop(storeKey(hostId, sessionKey)); throw error; }
    return changes.bytes;
  }

  function adopt(hostId: string, listing: readonly JournalListing[]): void {
    const sessions = new Map<string, number>();
    const withHead: string[] = [];
    let total = 0;
    for (const entry of listing) {
      const sessionKey = entry.sessionKey.slice(hostPrefix(hostId).length);
      sessions.set(sessionKey, entry.bytes);
      total += entry.bytes;
      if (entry.hasHead) withHead.push(sessionKey);
    }
    usage.set(hostId, { total, sessions });
    heads.load(hostId, withHead);
    hostsLoaded.add(hostId);
  }

  /** Lists what the store holds for the Host, once at a time, for the head index and the Host's usage. A load that a deletion overtook is read again. */
  function loadHost(hostId: string): Promise<void> {
    if (hostsLoaded.has(hostId)) return Promise.resolve();
    let pending = loading.get(hostId);
    if (!pending) {
      pending = (async () => {
        for (let attempt = 0; attempt < 3 && !hostsLoaded.has(hostId); attempt++) {
          const epoch = epochs.get(hostId) ?? 0;
          const listing = await store.catalog?.list(hostPrefix(hostId)) ?? [];
          if ((epochs.get(hostId) ?? 0) === epoch && !hostsLoaded.has(hostId)) adopt(hostId, listing);
        }
      })().finally(() => { loading.delete(hostId); });
      loading.set(hostId, pending);
    }
    return pending;
  }

  function account(hostId: string, sessionKey: string, bytes: number): void {
    const host = usage.get(hostId) ?? { total: 0, sessions: new Map<string, number>() };
    usage.set(hostId, host);
    host.total += bytes - (host.sessions.get(sessionKey) ?? 0);
    host.sessions.set(sessionKey, bytes);
  }

  /** Whether the Host can take `size` for this session, counting what its other sessions hold. */
  function hostHasRoom(hostId: string, sessionKey: string, size: number): boolean {
    const host = usage.get(hostId);
    return !host || host.total - (host.sessions.get(sessionKey) ?? 0) + size <= limits.hostBytes;
  }

  /** Evicts bodies, from the larger window to none, until the journal is within `target` or nothing more can go. */
  function shrink(journal: SessionJournal, target: number): number {
    let size = journal.residentBytes();
    for (const keep of [5, 1, 0]) {
      if (size <= target) break;
      journal.evict(keep);
      size = journal.residentBytes();
    }
    return size;
  }

  /**
   * Checks each entry that grows the journal against the limits. A replacement is admitted by its own size and the
   * live-only items it carries over, without evicting first; the other entries may evict bodies to make room. The size is
   * measured once and then counted up by the entries.
   */
  function admission(hostId: string, sessionKey: string, journal: SessionJournal): (entry: JournalPublishEntry) => void {
    let size: number | undefined;
    return entry => {
      if (entry.op === 'replace') {
        if (entry.items.length + journal.liveOnlyCount > limits.sessionItems) throw new JournalQuotaRefused('items');
        const need = utf8ByteLength(JSON.stringify(entry)) + journal.liveOnlyBytes();
        if (need > limits.sessionBytes) throw new JournalQuotaRefused('session');
        if (!hostHasRoom(hostId, sessionKey, need)) throw new JournalQuotaRefused('host');
        size = undefined;
        return;
      }
      if (entry.op !== 'append' && entry.op !== 'correct' && entry.op !== 'prepend') return;
      const itemsAfter = entry.op === 'append' ? journal.itemCount + (journal.has(entry.row.itemKey) ? 0 : 1)
        : entry.op === 'prepend' ? journal.itemCount + entry.items.length : journal.itemCount;
      if (itemsAfter > limits.sessionItems) throw new JournalQuotaRefused('items');
      const entryBytes = utf8ByteLength(JSON.stringify(entry));
      size ??= journal.residentBytes();
      if (size + entryBytes > limits.sessionBytes) size = shrink(journal, limits.sessionBytes - entryBytes);
      if (size + entryBytes > limits.sessionBytes) throw new JournalQuotaRefused('session');
      size += entryBytes;
      if (!hostHasRoom(hostId, sessionKey, size)) throw new JournalQuotaRefused('host');
    };
  }

  function apply(journal: SessionJournal, publication: JournalPublication, entry: JournalPublishEntry, published: JournalPublished): void {
    switch (entry.op) {
      case 'append': { const row = journal.append(publication, entry.row); if (row) published.events.push({ kind: 'row', row }); break; }
      case 'complete': journal.complete(publication, entry.itemKey, entry.digest); break;
      case 'seal': journal.seal(publication, entry.itemKey); break;
      case 'alias': journal.alias(publication, entry.itemKey, entry.clientMessageId); break;
      case 'correct': journal.correct(publication, entry.row, entry.digest, entry.expectedRevision); break;
      case 'replace': {
        const before = journal.epoch;
        const epoch = journal.replace(publication, entry.items, now());
        if (epoch !== before) published.events.push({ kind: 'replaced', epoch });
        break;
      }
      case 'prepend': journal.prepend(publication, entry.items); break;
      case 'head': {
        const before = journal.publisher?.watermark;
        journal.setHead(publication, entry.head);
        const head = journal.head;
        if (journal.publisher?.watermark !== before && head) published.events.push({ kind: 'head', head });
        break;
      }
    }
  }

  /** The refusal for an error the journal raises on purpose; undefined for an unexpected one. */
  function refusalOf(error: unknown, sequence: number): JournalRefusal | undefined {
    if (error instanceof JournalQuotaRefused) return { sequence, reason: 'quota_exceeded' };
    if (error instanceof JournalFencedError) return { sequence, reason: 'fenced' };
    if (error instanceof JournalStaleRevisionError) return { sequence, reason: 'stale_revision', itemKey: error.itemKey };
    if (error instanceof JournalUnknownItemError) return { sequence, reason: 'unknown_item', itemKey: error.itemKey };
    if (error instanceof JournalBodyMissingError) return { sequence, reason: 'body_missing', itemKey: error.itemKey };
    if (error instanceof JournalItemTypeChangedError) return { sequence, reason: 'type_changed', itemKey: error.itemKey };
    if (error instanceof JournalDuplicateItemError) return { sequence, reason: 'duplicate_item', itemKey: error.itemKey };
    if (error instanceof JournalInvalidRowError) return { sequence, reason: 'invalid', itemKey: error.itemKey };
    if (error instanceof JournalInvalidPublicationError) return { sequence, reason: 'invalid' };
    return undefined;
  }

  return {
    open: (hostId, sessionKey, publisherId, openOptions) => serialized<JournalOpened | JournalOpenRefusal>(hostId, async () => {
      if (openOptions.allowed && !openOptions.allowed()) return { refused: 'unavailable' };
      await loadHost(hostId);
      const key = storeKey(hostId, sessionKey);
      const journal = (await load(hostId, sessionKey, true))!;
      const refuse = (refused: JournalOpenRefusal['refused']): JournalOpenRefusal => {
        if (journal.publisher === null) drop(key);
        return { refused };
      };
      if (openOptions.allowed && !openOptions.allowed()) return refuse('unavailable');
      const index = journal.index();
      if (index.length > openOptions.maxIndexItems) return refuse('index_too_large');
      const { generation, watermark } = journal.claim(publisherId);
      const bytes = (await persist(hostId, sessionKey, journal)) ?? journal.residentBytes();
      needsReopen.delete(key);
      account(hostId, sessionKey, bytes);
      remember(hostId, sessionKey, journal, bytes);
      trimCache(key);
      return { generation, watermark, epoch: journal.epoch, index: index.slice(0, openOptions.pageItems), more: index.length > openOptions.pageItems };
    }),

    indexPage: (hostId, sessionKey, epoch, after, maxItems) => serialized<JournalIndexEntry[] | undefined>(hostId, async () => {
      const journal = await load(hostId, sessionKey, false);
      if (!journal || journal.epoch !== epoch) return undefined;
      const page: JournalIndexEntry[] = [];
      for (const entry of journal.index()) {
        if (entry.seqStart <= after) continue;
        page.push(entry);
        if (page.length >= maxItems) break;
      }
      return page;
    }),

    publish: (hostId, sessionKey, generation, entries) => serialized<JournalPublished>(hostId, async () => {
      const fenced = (): JournalPublished => ({ events: [], watermark: 0, refusal: { sequence: entries[0]?.sequence ?? 0, reason: 'fenced' } });
      const key = storeKey(hostId, sessionKey);
      if (needsReopen.has(key)) return fenced();
      const published: JournalPublished = { events: [], watermark: 0 };
      let journal!: SessionJournal;
      let bytes = 0;
      try {
        await loadHost(hostId);
        const loaded = await load(hostId, sessionKey, false);
        const publisherId = loaded?.publisher?.publisherId;
        if (!loaded || publisherId === undefined) return fenced();
        journal = loaded;
        const admit = admission(hostId, sessionKey, journal);
        let applied = false;
        let liveOnlyChanged = false;
        for (const entry of entries) {
          const current = journal.publisher;
          const fresh = current !== null && current.generation === generation && entry.sequence > current.watermark;
          try {
            if (fresh) admit(entry);
            apply(journal, { publisherId, generation, sequence: entry.sequence }, entry, published);
            if (fresh) {
              applied = true;
              if (entry.op === 'complete' || entry.op === 'seal' || entry.op === 'replace' || (entry.op === 'append' && entry.row.liveOnly === true)) liveOnlyChanged = true;
            }
          } catch (error) {
            const refusal = refusalOf(error, entry.sequence);
            if (!refusal) throw error;
            published.refusal = refusal;
            if (error instanceof JournalQuotaRefused && journal.hasHead) {
              journal.clearHead();
              published.unserved = true;
            }
            break;
          }
        }
        if (liveOnlyChanged) {
          const dropped = journal.dropOldestLiveOnly(limits.liveOnlyItems);
          if (dropped.length > 0) published.droppedLiveOnly = dropped.length;
        }
        if (applied) journal.evict(retainTurns);
        bytes = (await persist(hostId, sessionKey, journal)) ?? journal.residentBytes();
      } catch (error) {
        drop(key);
        needsReopen.add(key);
        throw error;
      }
      account(hostId, sessionKey, bytes);
      remember(hostId, sessionKey, journal, bytes);
      if (journal.hasHead) heads.add(hostId, sessionKey); else heads.remove(hostId, sessionKey);
      bump(hostId);
      trimCache(key);
      return { ...published, watermark: journal.publisher?.watermark ?? 0, cursor: journal.cursor, hasHead: journal.hasHead };
    }),

    fill: (hostId, sessionKey, items) => serialized<JournalFilled>(hostId, async () => {
      const filled: string[] = [], mismatched: string[] = [], unknown: string[] = [], skipped: string[] = [];
      const journal = await load(hostId, sessionKey, false);
      const fits = (journal: SessionJournal, added: number) => {
        const size = journal.residentBytes() + added;
        return size <= Math.min(limits.sessionBytes, cacheLimits.maxBytes) && hostHasRoom(hostId, sessionKey, size);
      };
      let trimmed = false;
      for (const { row, digest } of items) {
        if (!journal || !journal.has(row.itemKey)) { unknown.push(row.itemKey); continue; }
        const added = utf8ByteLength(JSON.stringify(row));
        if (!fits(journal, added) && !trimmed) {
          // The first body that does not fit: bodies outside the latest turns, such as ones filled earlier, make room once.
          trimmed = true;
          const evicted = new Set(journal.evict(retainTurns));
          for (const key of filled.filter(filledKey => evicted.has(filledKey))) skipped.push(key);
          for (const key of evicted) { const at = filled.indexOf(key); if (at >= 0) filled.splice(at, 1); }
        }
        if (!fits(journal, added)) { skipped.push(row.itemKey); continue; }
        const outcome = journal.fill(row.itemKey, bodyFromRow(row), digest);
        (outcome === 'filled' ? filled : outcome === 'mismatch' ? mismatched : unknown).push(row.itemKey);
      }
      if (journal) {
        const bytes = (await persist(hostId, sessionKey, journal)) ?? journal.residentBytes();
        account(hostId, sessionKey, bytes);
        remember(hostId, sessionKey, journal, bytes);
        trimCache(storeKey(hostId, sessionKey));
      }
      return { filled, mismatched, unknown, ...(skipped.length > 0 ? { skipped } : {}) };
    }),

    page: (hostId, sessionKey, request, olderBeyondJournal) => serialized<JournalPageResult | undefined>(hostId, async () =>
      (await load(hostId, sessionKey, false))?.page(request, { olderBeyondJournal })),

    status: (hostId, sessionKey) => serialized<JournalStatus | undefined>(hostId, async () => {
      const journal = await load(hostId, sessionKey, false);
      if (!journal) return undefined;
      const head = journal.head;
      return { cursor: journal.cursor, ...(head ? { head } : {}) };
    }),

    forget: hostId => serialized<void>(hostId, async () => {
      for (const [key, entry] of cache) if (entry.hostId === hostId) drop(key);
    }),

    served: (hostId, sessionKey) => heads.served(hostId, sessionKey),

    unserve(hostId, sessionKey) {
      heads.remove(hostId, sessionKey);
      bump(hostId);
    },

    async servedSessions(hostId) {
      await loadHost(hostId);
      return heads.sessions(hostId);
    },

    async loadAllServed() {
      const byHost = new Map<string, JournalListing[]>();
      for (const entry of await store.catalog?.list('') ?? []) {
        const at = entry.sessionKey.indexOf(':');
        if (at < 1) continue;
        const hostId = entry.sessionKey.slice(0, at);
        const listing = byHost.get(hostId) ?? [];
        listing.push(entry);
        byHost.set(hostId, listing);
      }
      for (const [hostId, listing] of byHost) if (!hostsLoaded.has(hostId)) adopt(hostId, listing);
      heads.markEveryHostLoaded();
    },

    deleteHost: hostId => serialized<void>(hostId, async () => {
      bump(hostId);
      const prefix = hostPrefix(hostId);
      const known = [...(usage.get(hostId)?.sessions.keys() ?? [])];
      for (const key of [...cache.keys()]) if (key.startsWith(prefix)) drop(key);
      for (const key of [...needsReopen]) if (key.startsWith(prefix)) needsReopen.delete(key);
      if (store.catalog) await store.catalog.deletePrefix(prefix);
      else for (const sessionKey of known) await store.delete(storeKey(hostId, sessionKey));
      heads.clearHost(hostId);
      usage.set(hostId, { total: 0, sessions: new Map() });
      hostsLoaded.add(hostId);
      bump(hostId);
    }),
  };
}
