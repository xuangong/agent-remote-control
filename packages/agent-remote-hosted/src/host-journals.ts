import {
  bodyFromRow, JournalBodyMissingError, JournalDuplicateItemError, JournalFencedError, JournalItemTypeChangedError, JournalStaleRevisionError,
  JournalUnknownItemError, JournalInvalidRowError, JournalInvalidPublicationError, SessionJournal,
  type JournalIndexEntry, type JournalPageRequest, type JournalPageResult, type JournalPublication, type JournalRow, type JournalStore,
} from '@orchardworks/agent-remote-journal';
import type { CompleteItemInput, JournalPublishEntry, JournalRefusalReason, TimelineCursor } from '@orchardworks/agent-remote-protocol';

export interface HostJournalsOptions {
  store: JournalStore;
  now(): number;
}

export interface JournalOpened {
  generation: number;
  watermark: number;
  epoch: string;
  index: JournalIndexEntry[];
}

/** The journal could not be opened without claiming a generation nobody could be told about. */
export interface JournalOpenRefusal {
  refused: 'index_too_large';
}

export interface JournalRefusal {
  sequence: number;
  reason: JournalRefusalReason;
  itemKey?: string;
}

export interface JournalPublished {
  /** The rows the journal stamped, in order, for the subscribers that read this session. */
  rows: JournalRow[];
  /** The last publication applied; everything up to it is stored. */
  watermark: number;
  /** The journal's cursor after the publication; absent when the session has no journal. */
  cursor?: TimelineCursor;
  /** Set when a replacement started a new epoch. */
  replacedEpoch?: string;
  /** The first entry the journal refused; entries before it are applied and stored. */
  refusal?: JournalRefusal;
}

export interface JournalFilled {
  filled: string[];
  mismatched: string[];
  unknown: string[];
}

/**
 * The session journals of the Hosts of one Relay account. Journals are keyed by Host and session, loaded from the
 * store when first used, and changed only through this service. All work of one Host runs one call at a time.
 */
export interface HostJournals {
  /**
   * Claims the session's journal for a publisher, creating it when needed, and fences every older generation.
   * `fits` says whether the reply for this index and epoch can be sent; when it cannot, nothing is claimed.
   */
  open(hostId: string, sessionKey: string, publisherId: string, fits: (index: JournalIndexEntry[], epoch: string) => boolean): Promise<JournalOpened | JournalOpenRefusal>;
  /** Applies entries in order and stores the changes before returning. */
  publish(hostId: string, sessionKey: string, generation: number, entries: readonly JournalPublishEntry[]): Promise<JournalPublished>;
  /** Puts bodies the Host read again back into the journal. */
  fill(hostId: string, sessionKey: string, items: readonly CompleteItemInput[]): Promise<JournalFilled>;
  /** A page of the session's journal, or undefined when it has none. */
  page(hostId: string, sessionKey: string, request: JournalPageRequest, olderBeyondJournal: boolean): Promise<JournalPageResult | undefined>;
  /** Drops what is cached for a Host; the store keeps the journals. */
  forget(hostId: string): Promise<void>;
}

export function createHostJournals(options: HostJournalsOptions): HostJournals {
  const { store, now } = options;
  const cache = new Map<string, Map<string, SessionJournal>>();
  const chains = new Map<string, Promise<void>>();
  const storeKey = (hostId: string, sessionKey: string) => `${hostId}:${sessionKey}`;

  function serialized<T>(hostId: string, work: () => Promise<T>): Promise<T> {
    const result = (chains.get(hostId) ?? Promise.resolve()).then(work);
    const tail = result.then(() => undefined, () => undefined);
    chains.set(hostId, tail);
    void tail.then(() => { if (chains.get(hostId) === tail) chains.delete(hostId); });
    return result;
  }

  async function load(hostId: string, sessionKey: string, create: boolean): Promise<SessionJournal | undefined> {
    const cached = cache.get(hostId)?.get(sessionKey);
    if (cached) return cached;
    const saved = await store.load(storeKey(hostId, sessionKey));
    const journal = saved ? new SessionJournal(saved) : create ? SessionJournal.create(storeKey(hostId, sessionKey)) : undefined;
    if (journal) {
      const sessions = cache.get(hostId) ?? new Map<string, SessionJournal>();
      sessions.set(sessionKey, journal);
      cache.set(hostId, sessions);
    }
    return journal;
  }

  /** Writes what changed. After a failed write the cached journal is ahead of the store, so it is dropped. */
  async function persist(hostId: string, sessionKey: string, journal: SessionJournal): Promise<void> {
    const changes = journal.takeChanges();
    if (!changes) return;
    try { await store.apply(changes); }
    catch (error) { cache.get(hostId)?.delete(sessionKey); throw error; }
  }

  function apply(journal: SessionJournal, publication: JournalPublication, entry: JournalPublishEntry, published: JournalPublished): void {
    switch (entry.op) {
      case 'append': { const row = journal.append(publication, entry.row); if (row) published.rows.push(row); break; }
      case 'complete': journal.complete(publication, entry.itemKey, entry.digest); break;
      case 'seal': journal.seal(publication, entry.itemKey); break;
      case 'alias': journal.alias(publication, entry.itemKey, entry.clientMessageId); break;
      case 'correct': { const row = journal.correct(publication, entry.row, entry.digest, entry.expectedRevision); if (row) published.rows.push(row); break; }
      case 'replace': {
        const before = journal.epoch;
        const epoch = journal.replace(publication, entry.items, now());
        if (epoch !== before) published.replacedEpoch = epoch;
        break;
      }
      case 'prepend': published.rows.push(...journal.prepend(publication, entry.items)); break;
      case 'head': journal.setHead(publication, entry.head); break;
    }
  }

  /** The refusal for an error the journal raises on purpose; undefined for an unexpected one. */
  function refusalOf(error: unknown, sequence: number): JournalRefusal | undefined {
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
    open: (hostId, sessionKey, publisherId, fits) => serialized<JournalOpened | JournalOpenRefusal>(hostId, async () => {
      const journal = (await load(hostId, sessionKey, true))!;
      const index = journal.index();
      if (!fits(index, journal.epoch)) return { refused: 'index_too_large' };
      const { generation, watermark } = journal.claim(publisherId);
      await persist(hostId, sessionKey, journal);
      return { generation, watermark, epoch: journal.epoch, index };
    }),

    publish: (hostId, sessionKey, generation, entries) => serialized<JournalPublished>(hostId, async () => {
      const journal = await load(hostId, sessionKey, false);
      const publisherId = journal?.publisher?.publisherId;
      if (!journal || publisherId === undefined) return { rows: [], watermark: 0, refusal: { sequence: entries[0]?.sequence ?? 0, reason: 'fenced' } };
      const published: JournalPublished = { rows: [], watermark: 0 };
      for (const entry of entries) {
        try { apply(journal, { publisherId, generation, sequence: entry.sequence }, entry, published); }
        catch (error) {
          const refusal = refusalOf(error, entry.sequence);
          if (!refusal) { cache.get(hostId)?.delete(sessionKey); throw error; }
          published.refusal = refusal;
          break;
        }
      }
      await persist(hostId, sessionKey, journal);
      return { ...published, watermark: journal.publisher?.watermark ?? 0, cursor: journal.cursor };
    }),

    fill: (hostId, sessionKey, items) => serialized<JournalFilled>(hostId, async () => {
      const filled: string[] = [], mismatched: string[] = [], unknown: string[] = [];
      const journal = await load(hostId, sessionKey, false);
      for (const { row, digest } of items) {
        const outcome = journal ? journal.fill(row.itemKey, bodyFromRow(row), digest) : 'unknown';
        (outcome === 'filled' ? filled : outcome === 'mismatch' ? mismatched : unknown).push(row.itemKey);
      }
      if (journal) await persist(hostId, sessionKey, journal);
      return { filled, mismatched, unknown };
    }),

    page: (hostId, sessionKey, request, olderBeyondJournal) => serialized<JournalPageResult | undefined>(hostId, async () =>
      (await load(hostId, sessionKey, false))?.page(request, { olderBeyondJournal })),

    forget: hostId => serialized<void>(hostId, async () => { cache.delete(hostId); }),
  };
}
