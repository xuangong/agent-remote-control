import type { TimelineCursor } from '@orchardworks/agent-remote-protocol';
import { entryFromRow, includeSequence, mergeRowIntoEntry } from '@orchardworks/agent-remote-relay/timeline-projection';

import { canonicalRow, entryBody, itemEntry, mergeResources, stampRow } from './journal-items.js';
import { pageJournal, type JournalPageRequest, type JournalPageResult } from './journal-pages.js';
import { evictableItems } from './retention.js';
import { replacementOrder } from './replacement.js';
import {
  JournalBodyMissingError, JournalDuplicateItemError, JournalFencedError, JournalItemTypeChangedError, JournalStaleRevisionError, JournalUnknownItemError,
  type CompleteItemInput, type JournalChanges, type JournalIndexEntry, type JournalItem, type JournalMeta, type JournalPublication,
  type JournalBody, type JournalRow, type JournalRowInput, type JournalState,
} from './types.js';

/** How long a retired epoch is remembered, for diagnostics only. */
export const RETIRED_EPOCH_MS = 7 * 24 * 60 * 60 * 1000;

/**
 * The journal of one session: epochs and dense sequences assigned here, one record per item, and the one publisher
 * allowed to write. It changes only through its methods and hands out what changed to its store.
 */
export class SessionJournal {
  protected meta: JournalMeta;
  protected readonly items: JournalItem[];
  protected readonly byKey = new Map<string, JournalItem>();
  protected readonly dirty = new Set<string>();
  protected metaDirty = false;
  protected replaced = false;

  static create(sessionKey: string, epoch: string = crypto.randomUUID()): SessionJournal {
    const journal = new SessionJournal({ meta: { sessionKey, epoch, nextSeq: 1, minSeq: 1, publisher: null, retiredEpochs: [] }, items: [] });
    journal.metaDirty = true;
    return journal;
  }

  constructor(state: JournalState) {
    this.meta = structuredClone(state.meta);
    this.items = structuredClone(state.items).sort((left, right) => left.seqStart - right.seqStart);
    for (const item of this.items) this.byKey.set(item.itemKey, item);
  }

  get sessionKey(): string { return this.meta.sessionKey; }
  get epoch(): string { return this.meta.epoch; }
  /** The last forward sequence assigned: the cursor of a subscriber that has everything. */
  get cursor(): TimelineCursor { return { epoch: this.meta.epoch, seq: this.meta.nextSeq - 1 }; }

  /**
   * Registers a publisher's new uplink connection and fences off every older one. A reconnecting publisher resumes
   * after its watermark; a different publisher, such as a restarted Controller, starts from zero.
   */
  claim(publisherId: string): { generation: number; watermark: number } {
    const previous = this.meta.publisher;
    const generation = (previous?.generation ?? 0) + 1;
    const watermark = previous?.publisherId === publisherId ? previous.watermark : 0;
    this.meta.publisher = { publisherId, generation, watermark };
    this.metaDirty = true;
    return { generation, watermark };
  }

  /** Appends one live row, opening its item or folding into it. Returns undefined for a duplicate publication. */
  append(publication: JournalPublication, input: JournalRowInput): JournalRow | undefined {
    if (this.duplicate(publication)) return undefined;
    const row = stampRow(this.meta.epoch, this.meta.nextSeq, input);
    const existing = this.byKey.get(input.itemKey);
    if (existing && existing.body === null) throw new JournalBodyMissingError(input.itemKey);
    const existingType = existing?.body?.item.type;
    if (existingType !== undefined && existingType !== input.item.type) {
      throw new JournalItemTypeChangedError(input.itemKey, existingType, input.item.type);
    }
    if (!existing) {
      const opened = this.openItem(structuredClone(row), input.liveOnly === true);
      this.advance(publication);
      this.meta.nextSeq += 1;
      this.insertLast(opened);
      return row;
    }
    const entry = itemEntry(existing);
    mergeRowIntoEntry(entry, canonicalRow(structuredClone(row)));
    this.advance(publication);
    this.meta.nextSeq += 1;
    existing.seqEnd = entry.seqEnd;
    existing.sourceSeqRanges = entry.sourceSeqRanges;
    existing.body = entryBody(entry);
    if (input.liveOnly) existing.liveOnly = true;
    existing.state = 'open';
    delete existing.digest;
    existing.revision += 1;
    this.dirty.add(existing.itemKey);
    return row;
  }

  /** Marks an item complete with the digest of its whole content. */
  complete(publication: JournalPublication, itemKey: string, digest: string): void {
    if (this.duplicate(publication)) return;
    const item = this.require(itemKey);
    this.advance(publication);
    item.state = 'complete';
    item.digest = digest;
    item.revision += 1;
    this.dirty.add(itemKey);
  }

  /** Closes an item that native history no longer contains, keeping what was received. */
  seal(publication: JournalPublication, itemKey: string): void {
    if (this.duplicate(publication)) return;
    const item = this.require(itemKey);
    this.advance(publication);
    item.state = 'complete';
    delete item.digest;
    item.revision += 1;
    this.dirty.add(itemKey);
  }

  /** Records which operation produced a user message, so clients match its echo exactly. */
  alias(publication: JournalPublication, itemKey: string, clientMessageId: string): void {
    if (this.duplicate(publication)) return;
    const item = this.require(itemKey);
    this.advance(publication);
    item.clientMessageId = clientMessageId;
    if (item.body?.item.type === 'user_message') item.body.item.clientMessageId = clientMessageId;
    item.revision += 1;
    this.dirty.add(itemKey);
  }

  /** Replaces an item's content after a reread found it different, unless the item moved since the index was read. */
  correct(publication: JournalPublication, input: JournalRowInput, digest: string, expectedRevision: number): JournalRow | undefined {
    if (this.duplicate(publication)) return undefined;
    const item = this.require(input.itemKey);
    if (item.revision !== expectedRevision) throw new JournalStaleRevisionError(item.itemKey, item.revision);
    const row = stampRow(this.meta.epoch, this.meta.nextSeq, input);
    this.advance(publication);
    this.meta.nextSeq += 1;
    item.body = {
      item: structuredClone(row.item), timestamp: row.timestamp,
      collapsed: item.body?.collapsed ?? [], resources: mergeResources(item.body?.resources ?? [], row.resources),
    };
    item.seqEnd = row.seq;
    item.sourceSeqRanges = includeSequence(item.sourceSeqRanges, row.seq);
    item.state = 'complete';
    item.digest = digest;
    item.revision += 1;
    this.dirty.add(item.itemKey);
    return row;
  }

  /**
   * Starts a new epoch from a reread of native history: one sequence per item, oldest first. Live-only items, which a
   * reread cannot reproduce, are carried over in place.
   */
  replace(publication: JournalPublication, items: readonly CompleteItemInput[], now: number): string {
    if (this.duplicate(publication)) return this.meta.epoch;
    this.requireDistinct(items);
    const epoch = crypto.randomUUID();
    const next = replacementOrder(this.items, items).map((entry, offset): JournalItem => {
      const seq = offset + 1;
      if (entry.kind === 'reread') return this.completeItem(epoch, entry.complete, seq);
      return { ...entry.item, seqStart: seq, seqEnd: seq, sourceSeqRanges: [{ startSeq: seq, endSeq: seq }] };
    });
    this.advance(publication);
    this.meta.retiredEpochs = [
      ...this.meta.retiredEpochs.filter(({ retiredAt }) => now - retiredAt < RETIRED_EPOCH_MS),
      { epoch: this.meta.epoch, retiredAt: now },
    ];
    this.meta.epoch = epoch;
    this.meta.nextSeq = next.length + 1;
    this.meta.minSeq = 1;
    this.items.length = 0;
    this.byKey.clear();
    this.dirty.clear();
    this.replaced = true;
    for (const item of next) this.insertLast(item);
    return epoch;
  }

  /** Adds older items below the lowest sequence as one batch, oldest first. Items already known are skipped. */
  prepend(publication: JournalPublication, older: readonly CompleteItemInput[]): JournalRow[] {
    if (this.duplicate(publication)) return [];
    const seen = new Set<string>();
    const fresh = older.filter(({ row }) => {
      if (this.byKey.has(row.itemKey) || seen.has(row.itemKey)) return false;
      seen.add(row.itemKey);
      return true;
    });
    const lowest = Math.min(this.meta.minSeq, this.items[0]?.seqStart ?? this.meta.nextSeq);
    const first = lowest - fresh.length;
    if (!Number.isSafeInteger(first)) throw new Error('Journal history position exhausted.');
    const rows = fresh.map((complete, offset) => stampRow(this.meta.epoch, first + offset, complete.row));
    const created = fresh.map((complete, offset) => this.completeItem(this.meta.epoch, complete, first + offset));
    this.advance(publication);
    this.items.unshift(...created);
    for (const item of created) {
      this.byKey.set(item.itemKey, item);
      this.dirty.add(item.itemKey);
    }
    this.meta.minSeq = first;
    return rows;
  }

  protected requireDistinct(items: readonly CompleteItemInput[]): void {
    const seen = new Set<string>();
    for (const { row } of items) {
      if (seen.has(row.itemKey)) throw new JournalDuplicateItemError(row.itemKey);
      seen.add(row.itemKey);
    }
  }

  protected completeItem(epoch: string, complete: CompleteItemInput, seq: number): JournalItem {
    return { ...this.openItem(stampRow(epoch, seq, complete.row), false), state: 'complete', digest: complete.digest };
  }

  index(): JournalIndexEntry[] {
    return this.items.map(item => ({
      itemKey: item.itemKey, seqStart: item.seqStart, seqEnd: item.seqEnd, state: item.state,
      ...(item.digest === undefined ? {} : { digest: item.digest }), liveOnly: item.liveOnly,
      ...(item.clientMessageId === undefined ? {} : { clientMessageId: item.clientMessageId }),
      revision: item.revision, resident: item.body !== null,
    }));
  }

  /** A page of the journal; `olderBeyondJournal` says whether the Host still holds history older than the journal. */
  page(request: JournalPageRequest, options: { olderBeyondJournal: boolean }): JournalPageResult {
    return pageJournal({ epoch: this.meta.epoch, items: this.items, nextSeq: this.meta.nextSeq }, request, options);
  }

  /** Evicts the bodies of complete, non-live-only items outside the latest turns. Returns the evicted item keys. */
  evict(keepLatestTurns: number): string[] {
    const keys = evictableItems(this.items, keepLatestTurns);
    for (const key of keys) {
      this.require(key).body = null;
      this.dirty.add(key);
    }
    return keys;
  }

  /** Puts back a body read again from the Host. Its digest must equal the one recorded when the item completed. */
  fill(itemKey: string, body: JournalBody, digest: string): 'filled' | 'mismatch' | 'unknown' {
    const item = this.byKey.get(itemKey);
    if (!item) return 'unknown';
    if (item.digest !== undefined && item.digest !== digest) return 'mismatch';
    if (item.body === null) {
      item.body = structuredClone(body);
      this.dirty.add(itemKey);
    }
    return 'filled';
  }

  state(): JournalState {
    return { meta: structuredClone(this.meta), items: structuredClone(this.items) };
  }

  /** What changed since the last call, or undefined when nothing did. */
  takeChanges(): JournalChanges | undefined {
    if (!this.metaDirty && this.dirty.size === 0 && !this.replaced) return undefined;
    const upsert = [...this.dirty]
      .map(key => this.byKey.get(key))
      .filter((item): item is JournalItem => item !== undefined)
      .map(item => structuredClone(item));
    const changes: JournalChanges = { meta: structuredClone(this.meta), upsert, replaced: this.replaced };
    this.dirty.clear();
    this.metaDirty = false;
    this.replaced = false;
    return changes;
  }

  protected duplicate(publication: JournalPublication): boolean {
    const publisher = this.meta.publisher;
    if (!publisher || publisher.publisherId !== publication.publisherId || publisher.generation !== publication.generation) {
      throw new JournalFencedError(this.meta.sessionKey);
    }
    return publication.sequence <= publisher.watermark;
  }

  protected advance(publication: JournalPublication): void {
    (this.meta.publisher as NonNullable<JournalMeta['publisher']>).watermark = publication.sequence;
    this.metaDirty = true;
  }

  protected require(itemKey: string): JournalItem {
    const item = this.byKey.get(itemKey);
    if (!item) throw new JournalUnknownItemError(itemKey);
    return item;
  }

  protected openItem(row: JournalRow, liveOnly: boolean): JournalItem {
    const entry = entryFromRow(canonicalRow(row));
    return {
      itemKey: row.itemKey, providerId: row.providerId, ...(row.turnId === undefined ? {} : { turnId: row.turnId }),
      seqStart: row.seq, seqEnd: row.seq, sourceSeqRanges: entry.sourceSeqRanges,
      state: 'open', liveOnly, revision: 1, body: entryBody(entry),
    };
  }

  protected insertLast(item: JournalItem): void {
    this.items.push(item);
    this.byKey.set(item.itemKey, item);
    this.dirty.add(item.itemKey);
  }
}
