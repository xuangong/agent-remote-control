import {
  bodyFromRow, JournalBodyMissingError, JournalDuplicateItemError, JournalFencedError, JournalInvalidPublicationError, JournalInvalidRowError, JournalItemTypeChangedError, JournalSequenceGapError,
  JournalStaleRevisionError, JournalUnknownItemError, SessionJournal, utf8ByteLength,
  type JournalHead, type JournalIndexEntry, type JournalListing, type JournalPageRequest, type JournalPageResult, type JournalPublication, type JournalRow, type JournalStore,
} from '@orchardworks/agent-remote-journal';
import { JOURNAL_INDEX_MAX_ITEMS, type BackgroundActivity, type CompleteItemInput, type JournalPublishEntry, type JournalRefusalReason, type ResourceBinding, type TimelineCursor } from '@orchardworks/agent-remote-protocol';

import { JournalHeadIndex } from './journal-head-index.js';

/** Journals kept in memory, for the whole Relay. */
const CACHE_MAX_JOURNALS = 64;
/** The estimated size of the journals kept in memory, for the whole Relay. */
const CACHE_MAX_BYTES = 128 * 1024 * 1024;
/** A session's estimated size above which a growing entry is refused once its bodies are evicted as far as they can be. */
const SESSION_MAX_BYTES = 64 * 1024 * 1024;
/** The estimated size of all journals of a Host above which a growing entry is refused. */
const HOST_MAX_BYTES = 1024 * 1024 * 1024;
/** Live-only items kept per session; beyond it the oldest complete ones are removed. An open one is never removed, so open items can keep the count above this. */
const LIVE_ONLY_MAX_ITEMS = 2000;
/** Turns whose bodies stay resident. */
const RETAIN_TURNS = 50;
/** Items whose bodies stay resident at least, so that the default tail of a conversation never needs a fill. */
const RETAIN_MIN_ITEMS = 200;

export interface HostJournalsOptions {
  store: JournalStore;
  now(): number;
  /** How much the service keeps in memory; a journal is read from the store again when it is needed after it was dropped. */
  cache?: { maxJournals?: number; maxBytes?: number };
  /** Safety bounds on growth. They are not the retention policy. `sessionItems` never exceeds what an index may list. */
  limits?: { sessionBytes?: number; sessionItems?: number; hostBytes?: number; liveOnlyItems?: number };
  /**
   * The working set kept resident: the latest `turns` turns or the latest `minItems` items, whichever reaches further back.
   * A publication evicts the bodies that left the window since the last one; bodies filled back stay until a limit needs room.
   */
  retention?: { turns?: number; minItems?: number };
}

export interface JournalOpenOptions {
  /** A journal whose index lists more items than this is refused, and nothing is claimed. */
  maxIndexItems: number;
  /** How many entries of the index the answer carries; `indexPage` reads the rest. */
  pageItems: number;
  /**
   * Asked inside the Host's queue: false means the connection that asked is gone, so the open is refused. The in-process
   * service asks again after it loads the journal, so it claims nothing; a partition proxy asks only before the call, so it
   * guarantees that nothing is announced to a gone connection, not that nothing is claimed.
   */
  allowed?(): boolean;
  /**
   * Claims the journal without listing its index, whatever its size: the answer has an empty index, the head is cleared, and
   * the journal is incomplete, so it accepts a replacement before anything else, the head included. This is the way out of an
   * index over `maxIndexItems`, which a normal open refuses.
   */
  reset?: boolean;
}

/** What a reader asks of the journal in the same step as a fill, so no publication comes between the fill and the page. */
export interface JournalReadRequest {
  request: JournalPageRequest;
  /** Whether the Host may still hold history older than the journal; asked inside the Host's queue. */
  olderBeyondJournal(): boolean;
}

export interface JournalOpened {
  generation: number;
  watermark: number;
  epoch: string;
  /** The first `pageItems` entries of the index. */
  index: JournalIndexEntry[];
  /** Whether the index has entries beyond `index`. */
  more: boolean;
  /** A reset took a served session out of serving: its head was cleared and the head index forgot the session. */
  unserved?: true;
}

/** The journal could not be opened, and no generation was claimed. */
export interface JournalOpenRefusal {
  refused: 'index_too_large' | 'unavailable';
  /** The refusal took the session out of serving: its journal had a head, which is cleared, and the head index forgot the session. */
  unserved?: true;
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
  | { kind: 'head'; head: JournalHead }
  /** A resource binding was replaced in place; clients find the item by its epoch and sequence. */
  | { kind: 'rebound'; epoch: string; seq: number; previous: ResourceBinding; replacement: ResourceBinding }
  /** A background outcome was applied in place to the items of that background. */
  | { kind: 'outcome'; providerId: string; turnId?: string; background: BackgroundActivity; occurredAt: number };

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
  /** The page read in the same step as the fill, when the fill was asked with a read; undefined when the session has no journal. */
  page?: JournalPageResult;
}

/**
 * The session journals of the Hosts of one Relay. Journals are keyed by Host and session, loaded from the store when
 * first used, and changed only through this service. All work of one Host runs one call at a time, in the order the calls
 * were made, and a journal is stored before the call that changed it returns.
 */
export interface HostJournals {
  /**
   * Claims the session's journal for a publisher, creating it when needed, and fences every older generation. When the
   * index is over `options.maxIndexItems`, or `options.allowed` says the connection is gone, nothing is claimed; an index
   * over the bound also takes the session out of serving, because its publisher is locked out and the journal goes stale.
   */
  open(hostId: string, sessionKey: string, publisherId: string, options: JournalOpenOptions): Promise<JournalOpened | JournalOpenRefusal>;
  /**
   * Up to `maxItems` entries of the session's index whose `seqStart` is above `after`, in order. Undefined when the session
   * has no journal or its epoch is no longer `epoch`: a replacement happened, and the cursor means nothing now.
   */
  indexPage(hostId: string, sessionKey: string, epoch: string, after: number, maxItems: number): Promise<JournalIndexEntry[] | undefined>;
  /** Applies entries in order and stores the changes before returning. */
  publish(hostId: string, sessionKey: string, generation: number, entries: readonly JournalPublishEntry[]): Promise<JournalPublished>;
  /**
   * Puts bodies the Host read again back into the journal, as far as the limits allow. With `read`, the page is read in the
   * same step, so no publication can come between the fill and the page.
   */
  fill(hostId: string, sessionKey: string, items: readonly CompleteItemInput[], read?: JournalReadRequest): Promise<JournalFilled>;
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
  /**
   * The Controller of generation `generation` can no longer keep the session's journal current: clears the head, stores that,
   * and forgets the session in the head index, so it is read through the Controller until a later publication sets a head.
   * Undefined when the session has no journal, `generation` is not the publisher's, or the session must be opened again.
   * `unserved` is set only when a head was cleared.
   */
  unserveHead(hostId: string, sessionKey: string, generation: number): Promise<JournalPublished | undefined>;
  /** Deletes every journal of the Host, in the order of the Host's other calls. Repeating it is harmless. */
  deleteHost(hostId: string): Promise<void>;
}

/** A growing entry the journal's limits do not allow. */
class JournalQuotaRefused extends Error {
  constructor(readonly limit: 'items' | 'session' | 'host') {
    super(`The journal is over its ${limit} limit.`);
    this.name = 'JournalQuotaRefused';
  }
}

/** An entry other than a replacement published while the journal is missing rows: it is refused on its own, and the publisher is not fenced. */
class JournalIncompleteRefused extends Error {
  constructor() {
    super('The journal is missing rows until a replacement rebuilds it.');
    this.name = 'JournalIncompleteRefused';
  }
}

function wholeNumber(name: string, value: number): number {
  if (!Number.isSafeInteger(value) || value < 0) throw new RangeError(`${name} must be a non-negative whole number.`);
  return value;
}

type Cached = { hostId: string; sessionKey: string; journal: SessionJournal; bytes: number };
/** Where a journal's retained window began after its last eviction, in the epoch it was measured in. */
type RetainedWindow = { epoch: string; start: number };
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
  const retainItems = wholeNumber('Journal retained items', options.retention?.minItems ?? RETAIN_MIN_ITEMS);
  /** The window of each loaded journal. A journal loaded again measures its window afresh and evicts nothing. */
  const windows = new WeakMap<SessionJournal, RetainedWindow>();
  const windowOf = (journal: SessionJournal): RetainedWindow => ({ epoch: journal.epoch, start: journal.windowStart(retainTurns, retainItems) });
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
      windows.set(journal, windowOf(journal));
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

  /** Lists what the store holds for the Host, once at a time, for the head index and the Host's usage. A listing that a deletion overtook is not adopted: the deletion marks the Host loaded. A session the listing wrongly shows as served is found without a head when a browser opens it, and unserved. */
  function loadHost(hostId: string): Promise<void> {
    if (hostsLoaded.has(hostId)) return Promise.resolve();
    let pending = loading.get(hostId);
    if (!pending) {
      pending = (async () => {
        const listing = await store.catalog?.list(hostPrefix(hostId)) ?? [];
        if (!hostsLoaded.has(hostId)) adopt(hostId, listing);
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

  /** The most this session may hold: its own limit, or what the Host's quota leaves after its other sessions. */
  function roomOf(hostId: string, sessionKey: string): number {
    const host = usage.get(hostId);
    const others = host ? host.total - (host.sessions.get(sessionKey) ?? 0) : 0;
    return Math.min(limits.sessionBytes, limits.hostBytes - others);
  }

  /**
   * Checks each entry that grows the journal against the limits. A replacement is admitted by its own size plus what it
   * carries over, without evicting first; the other entries evict bodies to make room before they are refused. An entry
   * larger than the room is refused before anything is evicted. The size is measured once and then counted up by the entries.
   */
  function admission(hostId: string, sessionKey: string, journal: SessionJournal): (entry: JournalPublishEntry) => void {
    let size: number | undefined;
    return entry => {
      // A journal that is missing rows takes a replacement before anything else, the head included.
      if (entry.op !== 'replace' && journal.incomplete) throw new JournalIncompleteRefused();
      if (entry.op === 'head') return;
      if (entry.op === 'replace') {
        const carried = journal.carriedOnReplace(entry.items);
        if (entry.items.length + carried.count > limits.sessionItems) throw new JournalQuotaRefused('items');
        const need = utf8ByteLength(JSON.stringify(entry)) + carried.bytes;
        if (need > limits.sessionBytes) throw new JournalQuotaRefused('session');
        if (need > roomOf(hostId, sessionKey)) throw new JournalQuotaRefused('host');
        size = undefined;
        return;
      }
      if (entry.op !== 'append' && entry.op !== 'correct' && entry.op !== 'prepend' && entry.op !== 'rebind') return;
      const itemsAfter = entry.op === 'append' ? journal.itemCount + (journal.has(entry.row.itemKey) ? 0 : 1)
        : entry.op === 'prepend' ? journal.itemCount + entry.items.length : journal.itemCount;
      if (itemsAfter > limits.sessionItems) throw new JournalQuotaRefused('items');
      const entryBytes = utf8ByteLength(JSON.stringify(entry));
      const room = roomOf(hostId, sessionKey);
      if (entryBytes > room) throw new JournalQuotaRefused(room < limits.sessionBytes ? 'host' : 'session');
      size ??= journal.residentBytes();
      if (size + entryBytes > room) size = shrink(journal, room - entryBytes);
      if (size + entryBytes > room) throw new JournalQuotaRefused(room < limits.sessionBytes ? 'host' : 'session');
      size += entryBytes;
    };
  }

  /** Evicts the bodies that left the retained window since the last eviction; bodies filled back since stay. */
  function evictLeavers(journal: SessionJournal): void {
    const before = windows.get(journal) ?? windowOf(journal);
    const from = before.epoch === journal.epoch ? before.start : Number.NEGATIVE_INFINITY;
    const start = Math.max(from, journal.windowStart(retainTurns, retainItems));
    if (start > from) journal.evictRange(from, start);
    windows.set(journal, { epoch: journal.epoch, start });
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
      case 'rebind': {
        const at = journal.rebind(publication, entry.itemKey, entry.previous, entry.replacement);
        if (at) published.events.push({ kind: 'rebound', ...at, previous: entry.previous, replacement: entry.replacement });
        break;
      }
      case 'outcome':
        if (journal.outcome(publication, entry.background)) {
          published.events.push({ kind: 'outcome', providerId: entry.providerId, ...(entry.turnId === undefined ? {} : { turnId: entry.turnId }), background: entry.background, occurredAt: entry.occurredAt });
        }
        break;
      case 'head': {
        const before = journal.publisher?.watermark;
        journal.setHead(publication, entry.head);
        const head = journal.head;
        if (journal.publisher?.watermark !== before && head) published.events.push({ kind: 'head', head });
        break;
      }
      // An operation this service does not know is refused, never skipped: skipping it would advance the watermark and lose it.
      default: throw new JournalInvalidPublicationError((entry as { sequence: number }).sequence);
    }
  }

  /** The refusal for an error the journal raises on purpose; undefined for an unexpected one. */
  function refusalOf(error: unknown, sequence: number): JournalRefusal | undefined {
    if (error instanceof JournalQuotaRefused) return { sequence, reason: 'quota_exceeded' };
    if (error instanceof JournalIncompleteRefused) return { sequence, reason: 'incomplete' };
    if (error instanceof JournalFencedError) return { sequence, reason: 'fenced' };
    if (error instanceof JournalStaleRevisionError) return { sequence, reason: 'stale_revision', itemKey: error.itemKey };
    if (error instanceof JournalUnknownItemError) return { sequence, reason: 'unknown_item', itemKey: error.itemKey };
    if (error instanceof JournalBodyMissingError) return { sequence, reason: 'body_missing', itemKey: error.itemKey };
    if (error instanceof JournalItemTypeChangedError) return { sequence, reason: 'type_changed', itemKey: error.itemKey };
    if (error instanceof JournalDuplicateItemError) return { sequence, reason: 'duplicate_item', itemKey: error.itemKey };
    if (error instanceof JournalInvalidRowError) return { sequence, reason: 'invalid', itemKey: error.itemKey };
    // Entries before the gap were lost: the publisher must open the journal again, and must not skip this refusal.
    if (error instanceof JournalSequenceGapError) return { sequence, reason: 'sequence_gap' };
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
      if (openOptions.reset) {
        const unserved = journal.hasHead;
        if (unserved) journal.clearHead();
        journal.markIncomplete();
        const { generation, watermark } = journal.claim(publisherId);
        const kept = (await persist(hostId, sessionKey, journal)) ?? journal.residentBytes();
        needsReopen.delete(key);
        account(hostId, sessionKey, kept);
        remember(hostId, sessionKey, journal, kept);
        if (unserved) { heads.remove(hostId, sessionKey); }
        trimCache(key);
        return { generation, watermark, epoch: journal.epoch, index: [], more: false, ...(unserved ? { unserved: true as const } : {}) };
      }
      const index = journal.index();
      if (index.length > openOptions.maxIndexItems) {
        if (!journal.hasHead) return refuse('index_too_large');
        journal.clearHead();
        const kept = (await persist(hostId, sessionKey, journal)) ?? journal.residentBytes();
        account(hostId, sessionKey, kept);
        remember(hostId, sessionKey, journal, kept);
        heads.remove(hostId, sessionKey);
        trimCache(key);
        return { refused: 'index_too_large', unserved: true };
      }
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
      const index = journal.index();
      let low = 0, high = index.length;
      while (low < high) {
        const middle = (low + high) >>> 1;
        if (index[middle]!.seqStart <= after) low = middle + 1; else high = middle;
      }
      return index.slice(low, low + maxItems);
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
        let liveOnlyChanged = false;
        for (const entry of entries) {
          const current = journal.publisher;
          const fresh = current !== null && current.generation === generation && entry.sequence === current.watermark + 1;
          try {
            if (fresh) admit(entry);
            apply(journal, { publisherId, generation, sequence: entry.sequence }, entry, published);
            if (fresh) {
              if (entry.op === 'complete' || entry.op === 'seal' || entry.op === 'replace' || (entry.op === 'append' && entry.row.liveOnly === true)
                || (entry.op === 'prepend' && entry.items.some(({ row: { liveOnly } }) => liveOnly === true))) liveOnlyChanged = true;
            }
          } catch (error) {
            const refusal = refusalOf(error, entry.sequence);
            if (!refusal) throw error;
            published.refusal = refusal;
            if (error instanceof JournalQuotaRefused) {
              // The refused row is missing from the journal: it is not served, and every later entry is a gap or incomplete.
              journal.markIncomplete();
              if (journal.hasHead) {
                journal.clearHead();
                published.unserved = true;
              }
            }
            break;
          }
        }
        if (liveOnlyChanged) {
          const dropped = journal.dropOldestLiveOnly(limits.liveOnlyItems);
          if (dropped.length > 0) published.droppedLiveOnly = dropped.length;
        }
        evictLeavers(journal);
        bytes = (await persist(hostId, sessionKey, journal)) ?? journal.residentBytes();
      } catch (error) {
        drop(key);
        needsReopen.add(key);
        throw error;
      }
      account(hostId, sessionKey, bytes);
      remember(hostId, sessionKey, journal, bytes);
      if (journal.hasHead) heads.add(hostId, sessionKey); else heads.remove(hostId, sessionKey);
      trimCache(key);
      return { ...published, watermark: journal.publisher?.watermark ?? 0, cursor: journal.cursor, hasHead: journal.hasHead };
    }),

    fill: (hostId, sessionKey, items, read) => serialized<JournalFilled>(hostId, async () => {
      const filled: string[] = [], mismatched: string[] = [], unknown: string[] = [], skipped: string[] = [];
      await loadHost(hostId);
      const journal = await load(hostId, sessionKey, false);
      const fits = (journal: SessionJournal, added: number) => {
        const size = journal.residentBytes() + added;
        return size <= Math.min(limits.sessionBytes, cacheLimits.maxBytes) && size <= roomOf(hostId, sessionKey);
      };
      let trimmed = false;
      for (const { row, digest } of items) {
        if (!journal || !journal.has(row.itemKey)) { unknown.push(row.itemKey); continue; }
        if (!journal.resident(row.itemKey)) {
          const added = utf8ByteLength(JSON.stringify(row));
          if (!fits(journal, added) && !trimmed) {
            // The first body that does not fit: bodies outside the retained window, such as ones filled earlier, make room once.
            trimmed = true;
            const evicted = new Set(journal.evict(retainTurns, retainItems));
            for (const key of filled.filter(filledKey => evicted.has(filledKey))) skipped.push(key);
            for (const key of evicted) { const at = filled.indexOf(key); if (at >= 0) filled.splice(at, 1); }
          }
          if (!fits(journal, added)) { skipped.push(row.itemKey); continue; }
        }
        const outcome = journal.fill(row.itemKey, bodyFromRow(row), digest);
        (outcome === 'filled' ? filled : outcome === 'mismatch' ? mismatched : unknown).push(row.itemKey);
      }
      if (journal) {
        const bytes = (await persist(hostId, sessionKey, journal)) ?? journal.residentBytes();
        account(hostId, sessionKey, bytes);
        remember(hostId, sessionKey, journal, bytes);
        trimCache(storeKey(hostId, sessionKey));
      }
      const page = read ? journal?.page(read.request, { olderBeyondJournal: read.olderBeyondJournal() }) : undefined;
      return { filled, mismatched, unknown, ...(skipped.length > 0 ? { skipped } : {}), ...(page ? { page } : {}) };
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
    },

    unserveHead: (hostId, sessionKey, generation) => serialized<JournalPublished | undefined>(hostId, async () => {
      const key = storeKey(hostId, sessionKey);
      if (needsReopen.has(key)) return undefined;
      let journal: SessionJournal | undefined;
      let cleared = false;
      let bytes = 0;
      try {
        await loadHost(hostId);
        journal = await load(hostId, sessionKey, false);
        if (!journal || journal.publisher?.generation !== generation) return undefined;
        cleared = journal.hasHead;
        if (cleared) journal.clearHead();
        bytes = (await persist(hostId, sessionKey, journal)) ?? journal.residentBytes();
      } catch (error) {
        drop(key);
        needsReopen.add(key);
        throw error;
      }
      account(hostId, sessionKey, bytes);
      remember(hostId, sessionKey, journal, bytes);
      heads.remove(hostId, sessionKey);
      trimCache(key);
      return { events: [], watermark: journal.publisher?.watermark ?? 0, cursor: journal.cursor, hasHead: false, ...(cleared ? { unserved: true as const } : {}) };
    }),

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
      const prefix = hostPrefix(hostId);
      const known = [...(usage.get(hostId)?.sessions.keys() ?? [])];
      for (const key of [...cache.keys()]) if (key.startsWith(prefix)) drop(key);
      for (const key of [...needsReopen]) if (key.startsWith(prefix)) needsReopen.delete(key);
      if (store.catalog) await store.catalog.deletePrefix(prefix);
      else for (const sessionKey of known) await store.delete(storeKey(hostId, sessionKey));
      heads.clearHost(hostId);
      usage.set(hostId, { total: 0, sessions: new Map() });
      hostsLoaded.add(hostId);
    }),
  };
}
