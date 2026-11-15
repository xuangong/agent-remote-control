import type { TimelineCursor } from '@orchardworks/agent-remote-protocol';
import { entryFromRow, mergeRowIntoEntry } from '@orchardworks/agent-remote-relay/timeline-projection';

import { canonicalRow, entryBody, itemEntry, stampRow } from './journal-items.js';
import {
  JournalBodyMissingError, JournalFencedError, JournalItemTypeChangedError, JournalUnknownItemError,
  type JournalChanges, type JournalIndexEntry, type JournalItem, type JournalMeta, type JournalPublication,
  type JournalRow, type JournalRowInput, type JournalState,
} from './types.js';

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
    const existing = this.byKey.get(input.itemKey);
    if (existing && existing.body === null) throw new JournalBodyMissingError(input.itemKey);
    const existingType = existing?.body?.item.type;
    if (existingType !== undefined && existingType !== input.item.type) {
      throw new JournalItemTypeChangedError(input.itemKey, existingType, input.item.type);
    }
    this.advance(publication);
    const row = stampRow(this.meta.epoch, this.meta.nextSeq++, input);
    if (existing) {
      const entry = itemEntry(existing);
      mergeRowIntoEntry(entry, canonicalRow(row));
      existing.seqEnd = entry.seqEnd;
      existing.sourceSeqRanges = entry.sourceSeqRanges;
      existing.body = entryBody(entry);
      if (input.liveOnly) existing.liveOnly = true;
      existing.revision += 1;
      this.dirty.add(existing.itemKey);
    } else {
      this.insertLast(this.openItem(row, input.liveOnly === true));
    }
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

  index(): JournalIndexEntry[] {
    return this.items.map(item => ({
      itemKey: item.itemKey, seqStart: item.seqStart, seqEnd: item.seqEnd, state: item.state,
      ...(item.digest === undefined ? {} : { digest: item.digest }), liveOnly: item.liveOnly,
      ...(item.clientMessageId === undefined ? {} : { clientMessageId: item.clientMessageId }),
      revision: item.revision, resident: item.body !== null,
    }));
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
