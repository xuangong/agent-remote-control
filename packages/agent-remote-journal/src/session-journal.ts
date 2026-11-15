import type { TimelineCursor } from '@orchardworks/agent-remote-protocol';
import { entryFromRow, includeSequence, mergeRowIntoEntry } from '@orchardworks/agent-remote-relay/timeline-projection';

import {
  canonicalRow, carryKnownFields, entryBody, extendSequenceRanges, knownFields, mergeResources, residentEntry, stampRow,
} from './journal-items.js';
import { pageJournal, type JournalPageRequest, type JournalPageResult } from './journal-pages.js';
import { evictableItems } from './retention.js';
import { replacementOrder } from './replacement.js';
import {
  JournalBodyMissingError, JournalDuplicateItemError, JournalFencedError, JournalInvalidPublicationError, JournalItemTypeChangedError,
  JournalStaleRevisionError, JournalUnknownItemError,
  type CompleteItemInput, type JournalChanges, type JournalHead, type JournalPublisher, type JournalIndexEntry, type JournalItem, type JournalMeta, type JournalPublication,
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

  /** The latest Snapshot the publisher reported, or undefined before the first one. */
  get head(): JournalHead | undefined { return this.meta.head === undefined ? undefined : structuredClone(this.meta.head); }
  /** The publisher that may write now: its generation and last applied publication. Null before the first claim. */
  get publisher(): JournalPublisher | null { return this.meta.publisher === null ? null : { ...this.meta.publisher }; }

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
    const body = existing.body as JournalBody;
    const entry = residentEntry(existing);
    this.advance(publication);
    this.meta.nextSeq += 1;
    mergeRowIntoEntry(entry, canonicalRow(structuredClone(row)));
    body.item = entry.item;
    existing.seqEnd = row.seq;
    extendSequenceRanges(existing.sourceSeqRanges, row.seq);
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

  /** Closes an item that native history no longer contains, keeping what was received. It has no native copy, so it is relay-only. */
  seal(publication: JournalPublication, itemKey: string): void {
    if (this.duplicate(publication)) return;
    const item = this.require(itemKey);
    if (item.body === null) throw new JournalBodyMissingError(itemKey);
    this.advance(publication);
    item.state = 'complete';
    item.liveOnly = true;
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

  /** Replaces the head with the Controller's latest Snapshot. */
  setHead(publication: JournalPublication, head: JournalHead): void {
    if (this.duplicate(publication)) return;
    const stored = structuredClone(head);
    this.advance(publication);
    this.meta.head = stored;
  }

  /** Replaces an item's content after a reread found it different, unless the item moved since the index was read. */
  correct(publication: JournalPublication, input: JournalRowInput, digest: string, expectedRevision: number): JournalRow | undefined {
    if (this.duplicate(publication)) return undefined;
    const item = this.require(input.itemKey);
    if (item.revision !== expectedRevision) throw new JournalStaleRevisionError(item.itemKey, item.revision);
    const row = stampRow(this.meta.epoch, this.meta.nextSeq, input);
    this.advance(publication);
    this.meta.nextSeq += 1;
    const stored = structuredClone(row.item);
    carryKnownFields(stored, knownFields(item));
    row.item = structuredClone(stored);
    const known = item.body ?? item.keptBody;
    item.body = {
      item: stored, timestamp: row.timestamp,
      collapsed: [...(known?.collapsed ?? [])], resources: mergeResources(known?.resources ?? [], row.resources),
    };
    delete item.background;
    delete item.keptBody;
    item.liveOnly = false;
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
    let newestRevision = 0;
    for (const { revision } of this.items) if (revision > newestRevision) newestRevision = revision;
    const next = replacementOrder(this.items, items).map((entry, offset): JournalItem => {
      const seq = offset + 1;
      if (entry.kind === 'carried') return { ...entry.item, seqStart: seq, seqEnd: seq, sourceSeqRanges: [{ startSeq: seq, endSeq: seq }] };
      const item = this.completeItem(epoch, entry.complete, seq, this.byKey.get(entry.complete.row.itemKey));
      item.revision = newestRevision + 1;
      return item;
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
    const merged = created.concat(this.items);
    this.advance(publication);
    this.items.length = 0;
    for (const item of merged) this.items.push(item);
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

  /** A complete item built from native history; `previous` is the item of the same key whose alias and background it keeps. */
  protected completeItem(epoch: string, complete: CompleteItemInput, seq: number, previous?: JournalItem): JournalItem {
    const item: JournalItem = { ...this.openItem(stampRow(epoch, seq, complete.row), false), state: 'complete', digest: complete.digest };
    if (previous) {
      carryKnownFields((item.body as JournalBody).item, knownFields(previous));
      if (previous.clientMessageId !== undefined) item.clientMessageId = previous.clientMessageId;
    }
    return item;
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

  /**
   * Evicts the bodies of complete, non-live-only items that carry a digest, outside the latest turns. Returns the
   * evicted item keys. The background outcome, time, collapse marks and resources of a body stay on the item.
   */
  evict(keepLatestTurns: number): string[] {
    const keys = evictableItems(this.items, keepLatestTurns);
    for (const key of keys) {
      const item = this.require(key);
      if (item.body?.item.background) item.background = structuredClone(item.body.item.background);
      else delete item.background;
      if (item.body) item.keptBody = { timestamp: item.body.timestamp, collapsed: [...item.body.collapsed], resources: structuredClone(item.body.resources) };
      item.body = null;
      this.dirty.add(key);
    }
    return keys;
  }

  /**
   * Puts back a body read again from the Host, with the item's alias, background outcome, time, collapse marks and
   * resources. An already resident body stays as it is; otherwise the digest must equal the one recorded when the item
   * completed, and an item that recorded none cannot be filled.
   */
  fill(itemKey: string, body: JournalBody, digest: string): 'filled' | 'mismatch' | 'unknown' {
    const item = this.byKey.get(itemKey);
    if (!item) return 'unknown';
    if (item.body !== null) return 'filled';
    if (item.digest === undefined || item.digest !== digest) return 'mismatch';
    const filled = structuredClone(body);
    carryKnownFields(filled.item, knownFields(item));
    if (item.keptBody) Object.assign(filled, structuredClone(item.keptBody));
    item.body = filled;
    delete item.background;
    delete item.keptBody;
    this.dirty.add(itemKey);
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
    if (!Number.isSafeInteger(publication.sequence) || publication.sequence < 1) throw new JournalInvalidPublicationError(publication.sequence);
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
