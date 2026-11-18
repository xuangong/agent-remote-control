import { mergeBackgroundActivity, type AgentTimelineItem, type BackgroundActivity, type ProjectedTimelineEntry, type ResourceBinding, type TimelineCursor } from '@orchardworks/agent-remote-protocol';
import { entryFromRow, mergeRowIntoEntry } from '@orchardworks/agent-timeline';

import {
  canonicalRow, carryKnownFields, entryBody, extendSequenceRanges, knownFields, residentEntry, stampRow,
} from './journal-items.js';
import { canonicalJson } from './item-digest.js';
import { pageJournal, type JournalPageRequest, type JournalPageResult } from './journal-pages.js';
import { evictable, retainedFrom } from './retention.js';
import { replacementOrder } from './replacement.js';
import { CONTENT_REPLACING_TYPES, decideWindow, type WindowTail } from './window-decision.js';
import { utf8ByteLength } from './utf8-size.js';
import {
  JournalFencedError, JournalInvalidPublicationError, JournalSequenceGapError,
  type JournalItemInput, type JournalChanges, type JournalHead, type JournalPublisher, type JournalItem, type JournalMeta, type JournalPublication,
  type JournalBody, type JournalRow, type JournalRowInput, type JournalState, type SyncResult,
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
  /** Items removed since changes were last taken. */
  protected readonly removedKeys = new Set<string>();
  /** The measured size of each item record, a running total of them, and the items not measured since they changed. */
  protected readonly sizes = new Map<string, number>();
  protected sizedTotal = 0;
  protected readonly unmeasured = new Set<string>();
  /** The live-only items, and the measured size of each with a running total. */
  protected readonly liveOnlyKeys = new Set<string>();
  protected readonly liveOnlySizes = new Map<string, number>();
  protected liveOnlyTotal = 0;

  /** `epoch` is the new journal's, drawn by the caller; `newEpoch` supplies the epochs of later replacements. */
  static create(sessionKey: string, epoch: string, newEpoch?: () => string): SessionJournal {
    const journal = new SessionJournal({ meta: { sessionKey, epoch, nextSeq: 1, minSeq: 1, publisher: null }, items: [] }, newEpoch);
    journal.metaDirty = true;
    return journal;
  }

  /**
   * `newEpoch` is where the epoch of a replacement comes from: the journal draws no random value itself, so the caller (the Relay's
   * ids, or a test's sequence) decides it. A journal without one cannot replace its window.
   */
  constructor(state: JournalState, private readonly newEpoch: () => string = () => { throw new Error('A journal needs an epoch source to replace its window.'); }) {
    this.meta = structuredClone(state.meta);
    this.items = structuredClone(state.items).sort((left, right) => left.seqStart - right.seqStart);
    for (const item of this.items) this.byKey.set(item.itemKey, item);
    for (const item of this.items) {
      this.unmeasured.add(item.itemKey);
      if (item.liveOnly) this.liveOnlyKeys.add(item.itemKey);
    }
  }

  get sessionKey(): string { return this.meta.sessionKey; }
  get epoch(): string { return this.meta.epoch; }
  /** The last forward sequence assigned: the cursor of a subscriber that has everything. */
  get cursor(): TimelineCursor { return { epoch: this.meta.epoch, seq: this.meta.nextSeq - 1 }; }

  /**
   * The latest Snapshot the publisher reported, or undefined before the first one. Its attention cursor is the cursor of
   * the item the publisher named, in this journal's epoch and sequence; without a named item it is the journal's latest cursor.
   */
  get head(): JournalHead | undefined {
    if (this.meta.head === undefined) return undefined;
    const { attentionItemKey, ...head } = structuredClone(this.meta.head);
    if (head.snapshot.attention) {
      const item = attentionItemKey === undefined ? undefined : this.byKey.get(attentionItemKey);
      // A live cursor is never negative; a prepended item sits below zero, so the cursor of the oldest items is the start.
      head.snapshot.attention.cursor = { epoch: this.meta.epoch, seq: Math.max(0, item ? item.seqEnd : this.meta.nextSeq - 1) };
    }
    return head;
  }
  /** The publisher that may write now: its generation and last applied publication. Null before the first claim. */
  get publisher(): JournalPublisher | null { return this.meta.publisher === null ? null : { ...this.meta.publisher }; }

  /** How many items the journal holds, resident or evicted. */
  get itemCount(): number { return this.items.length; }

  has(itemKey: string): boolean { return this.byKey.has(itemKey); }

  /** Whether the Controller has published a head; cheaper than reading it. */
  get hasHead(): boolean { return this.meta.head !== undefined; }

  /** Takes the journal out of serving until a later head is published. The Relay does this when a quota refuses a publication. */
  clearHead(): void {
    delete this.meta.head;
    this.metaDirty = true;
  }

  /** Whether a refused publication left rows missing: such a journal must not be served until a replacement rebuilds it. */
  get incomplete(): boolean { return this.meta.incomplete === true; }

  /** Records that rows of this journal are missing, and takes it out of serving until a replacement. */
  markIncomplete(): void {
    this.meta.incomplete = true;
    this.metaDirty = true;
  }

  /** How many live-only items the journal holds. */
  get liveOnlyCount(): number { return this.liveOnlyKeys.size; }

  /** The key of the first item that is not live-only: where a request for older history starts. */
  /** The first sequence of an item, which an update in place keeps. */
  seqStartOf(itemKey: string): number | undefined { return this.byKey.get(itemKey)?.seqStart; }

  get oldestItemKey(): string | undefined { return this.items.find(item => !item.liveOnly)?.itemKey; }

  /** Whether the item's body is in memory; false for an evicted or unknown item. */
  resident(itemKey: string): boolean { return this.byKey.get(itemKey)?.body != null; }

  /**
   * An estimate of what the journal holds: the size of its meta and of each item record as stored, in UTF-8 bytes of JSON.
   * Only items that changed since the last call are measured, so the cost follows the change, not the journal.
   */
  residentBytes(): number {
    for (const key of this.unmeasured) {
      const item = this.byKey.get(key);
      const before = this.sizes.get(key) ?? 0;
      const size = item ? utf8ByteLength(JSON.stringify(item)) : 0;
      if (item) this.sizes.set(key, size); else this.sizes.delete(key);
      this.sizedTotal += size - before;
      this.liveOnlyTotal -= this.liveOnlySizes.get(key) ?? 0;
      this.liveOnlySizes.delete(key);
      if (item?.liveOnly) { this.liveOnlySizes.set(key, size); this.liveOnlyTotal += size; }
    }
    this.unmeasured.clear();
    return this.sizedTotal + utf8ByteLength(JSON.stringify(this.meta));
  }

  /** The estimated size of the live-only items, which a replacement carries over. */
  liveOnlyBytes(): number {
    this.residentBytes();
    return this.liveOnlyTotal;
  }

  /** What a replacement keeps of this journal: its meta and its live-only items. */
  keptBytes(): number {
    return this.residentBytes() - (this.sizedTotal - this.liveOnlyTotal);
  }

  /**
   * Removes the oldest live-only items until at most `keep` live-only items and `keepBytes` of them remain, skeleton and
   * body: nothing can rebuild them, so their place in the sequence goes with them. An open item is removed only when
   * `includeOpen` is set (the byte cap, which must always be reachable): the next append recreates it with only the new text.
   * Returns the keys removed.
   */
  dropOldestLiveOnly(keep: number, keepBytes = Number.POSITIVE_INFINITY, includeOpen = false): string[] {
    let count = this.liveOnlyCount;
    let bytes = this.liveOnlyBytes();
    const doomed = new Set<string>();
    for (const item of this.items) {
      if (count <= Math.max(0, keep) && bytes <= keepBytes) break;
      if (!item.liveOnly || (item.state !== 'complete' && !includeOpen)) continue;
      doomed.add(item.itemKey);
      count -= 1;
      bytes -= this.sizes.get(item.itemKey) ?? 0;
    }
    if (doomed.size === 0) return [];
    const remaining = this.items.filter(item => !doomed.has(item.itemKey));
    this.items.length = 0;
    for (const item of remaining) this.items.push(item);
    for (const key of doomed) {
      this.byKey.delete(key);
      this.dirty.delete(key);
      this.removedKeys.add(key);
      this.unmeasured.add(key);
      this.liveOnlyKeys.delete(key);
    }
    return [...doomed];
  }

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
    if (existing && existing.body === null) {
      const keptType = existing.keptBody?.itemType;
      if (keptType !== undefined && keptType !== input.item.type) throw new JournalInvalidPublicationError(`Item ${input.itemKey} changed from ${keptType} to ${input.item.type}.`);
      if (!CONTENT_REPLACING_TYPES.has(input.item.type)) throw new JournalInvalidPublicationError(`Item ${input.itemKey} has no resident body.`);
      return this.appendToEvicted(publication, existing, row, input.liveOnly === true);
    }
    const existingType = existing?.body?.item.type;
    if (existingType !== undefined && existingType !== input.item.type) {
      throw new JournalInvalidPublicationError(`Item ${input.itemKey} changed from ${existingType} to ${input.item.type}.`);
    }
    if (!existing) {
      const opened = this.openItem(structuredClone(row), input.liveOnly === true);
      this.advance(publication);
      this.meta.nextSeq += 1;
      this.insertLast(opened);
      return row;
    }
    this.foldRow(existing, row, input.liveOnly === true);
    this.advance(publication);
    this.meta.nextSeq += 1;
    return row;
  }

  /** Merges a stamped row into the resident item it continues, which is open again afterwards. */
  protected foldRow(existing: JournalItem, row: JournalRow, liveOnly: boolean): void {
    const body = existing.body as JournalBody;
    const entry = residentEntry(existing);
    mergeRowIntoEntry(entry, canonicalRow(structuredClone(row)));
    body.item = entry.item;
    existing.seqEnd = row.seq;
    extendSequenceRanges(existing.sourceSeqRanges, row.seq);
    if (liveOnly) existing.liveOnly = true;
    existing.state = 'open';
    delete existing.digest;
    this.touch(existing.itemKey);
  }

  /**
   * A row of a type whose rows replace the item's content (`tool_call` and `todo`, as `mergeRowIntoEntry` does) reaches an
   * item whose body was evicted. The row brings all the content, so the item is resident again and open, with:
   * - the content of the row;
   * - the resources the item kept, plus the row's, and the collapse marks and time the item kept;
   * - the background the item kept, merged with the row's so an outcome never regresses.
   * A row of any other type, which would append to or spread over content the journal no longer holds, is refused as before:
   * a compaction's merge spreads fields, so a late row would lose the fields it omits and break the digest.
   */
  protected appendToEvicted(publication: JournalPublication, existing: JournalItem, row: JournalRow, liveOnly: boolean): JournalRow {
    const kept = existing.keptBody;
    if (!kept) throw new JournalInvalidPublicationError(`Item ${existing.itemKey} has no resident body.`);
    const entry: ProjectedTimelineEntry = {
      providerId: existing.providerId,
      item: { ...structuredClone(row.item), ...(existing.background ? { background: structuredClone(existing.background) } : {}) } as AgentTimelineItem,
      ...(existing.turnId === undefined ? {} : { turnId: existing.turnId }), timestamp: kept.timestamp, seqStart: existing.seqStart, seqEnd: existing.seqEnd,
      sourceSeqRanges: [], collapsed: [...kept.collapsed], resources: structuredClone(kept.resources),
    };
    mergeRowIntoEntry(entry, canonicalRow(structuredClone(row)));
    this.advance(publication);
    this.meta.nextSeq += 1;
    existing.body = entryBody(entry);
    delete existing.keptBody;
    delete existing.background;
    existing.seqEnd = row.seq;
    extendSequenceRanges(existing.sourceSeqRanges, row.seq);
    if (liveOnly) existing.liveOnly = true;
    existing.state = 'open';
    delete existing.digest;
    this.touch(existing.itemKey);
    return row;
  }

  /** Marks an item complete with the digest of its whole content. */
  complete(publication: JournalPublication, itemKey: string, digest: string): void {
    if (this.duplicate(publication)) return;
    const item = this.require(itemKey);
    this.advance(publication);
    item.state = 'complete';
    item.digest = digest;
    this.touch(itemKey);
  }

  /** Records which operation produced a user message, so clients match its echo exactly. */
  alias(publication: JournalPublication, itemKey: string, clientMessageId: string): void {
    if (this.duplicate(publication)) return;
    const item = this.require(itemKey);
    this.advance(publication);
    item.clientMessageId = clientMessageId;
    if (item.body?.item.type === 'user_message') item.body.item.clientMessageId = clientMessageId;
    this.touch(itemKey);
  }

  /** Replaces the head with the Controller's latest Snapshot. */
  setHead(publication: JournalPublication, head: JournalHead): void {
    if (this.duplicate(publication)) return;
    const stored = structuredClone(head);
    this.advance(publication);
    this.meta.head = stored;
  }

  /**
   * Replaces the binding of the item's resource with the previous binding's locator, in its body or, while that is evicted,
   * in what the item keeps of it. It matches by locator, not by the previous id, so a binding whose id changed since (a
   * restart, a new key) still takes the replacement. Returns the epoch and sequence clients know the item by, or undefined
   * for a duplicate publication, an item the journal does not know and a binding that already is the replacement: none of
   * them changes anything, so nothing is stored or told.
   */
  rebind(publication: JournalPublication, itemKey: string, previous: ResourceBinding, replacement: ResourceBinding): { epoch: string; seq: number } | undefined {
    if (this.duplicate(publication)) return undefined;
    this.advance(publication);
    const item = this.byKey.get(itemKey);
    if (!item) return undefined;
    const resources = item.body ? item.body.resources : item.keptBody?.resources;
    let changed = false;
    resources?.forEach((resource, at) => {
      if (resource.locator !== previous.locator || sameBinding(resource, replacement)) return;
      resources[at] = structuredClone(replacement);
      changed = true;
    });
    if (!changed) return undefined;
    this.touch(itemKey);
    return { epoch: this.meta.epoch, seq: item.seqEnd };
  }

  /**
   * Applies a background outcome in place to every item of that background, evicted ones included; an outcome never
   * regresses. False when nothing changed: a duplicate publication, or items that already have that outcome.
   */
  outcome(publication: JournalPublication, background: BackgroundActivity): boolean {
    if (this.duplicate(publication)) return false;
    this.advance(publication);
    let changed = false;
    for (const item of this.items) {
      const current = item.body ? item.body.item.background : item.background;
      if (current?.id !== background.id) continue;
      const merged = structuredClone(mergeBackgroundActivity(current, background));
      if (canonicalJson(merged) === canonicalJson(current)) continue;
      if (item.body) item.body.item.background = merged;
      else item.background = merged;
      this.touch(item.itemKey);
      changed = true;
    }
    return changed;
  }

  /**
   * Compares the Controller's newest window of native history with the journal and brings the journal to it with the least
   * change: `unchanged` when it already holds the window, `appended` when the window only adds items at the end and they
   * fit `roomBytes`, otherwise one `replaced` epoch that carries the live-only items. Items older than the journal's first
   * shared item are not a change, because older history is not uploaded until it is asked for. A journal that is missing
   * rows is always replaced. The caller has checked that the window and the live-only items fit the room.
   */
  sync(publication: JournalPublication, window: readonly JournalItemInput[], options: { roomBytes: number }): SyncResult {
    if (this.duplicate(publication)) return { outcome: 'unchanged' };
    this.requireDistinct(window);
    const decision = decideWindow(this.windowTail(), window, options);
    if (decision.outcome === 'unchanged') {
      this.advance(publication);
      return { outcome: 'unchanged' };
    }
    if (decision.outcome === 'extend') {
      this.advance(publication);
      const rows: JournalRow[] = [];
      for (const item of window) {
        const key = item.row.itemKey;
        if (decision.append.has(key)) {
          this.insertLast(this.completeItem(this.meta.epoch, item, this.meta.nextSeq));
          rows.push(stampRow(this.meta.epoch, this.meta.nextSeq++, item.row));
        } else if (decision.update.has(key)) {
          const held = this.byKey.get(key) as JournalItem;
          const row = stampRow(this.meta.epoch, this.meta.nextSeq++, item.row);
          this.foldRow(held, row, true);
          if (item.digest !== undefined) { held.state = 'complete'; held.digest = item.digest; }
          rows.push(row);
        }
      }
      return { outcome: 'appended', rows };
    }
    return { outcome: 'replaced', epoch: this.rebuild(publication, window), reason: decision.reason };
  }

  /**
   * How many bytes `sync` would write for `window`: zero when the journal already holds it, and undefined when the window
   * replaces the journal instead. The Relay makes body room for this before it syncs.
   */
  extensionBytes(window: readonly JournalItemInput[]): number | undefined {
    const decision = decideWindow(this.windowTail(), window);
    return decision.outcome === 'unchanged' ? 0 : decision.outcome === 'extend' ? decision.bytes : undefined;
  }

  protected windowTail(): WindowTail {
    return { items: this.items, byKey: this.byKey, incomplete: this.incomplete, residentBytes: () => this.residentBytes() };
  }

  /** Starts the new epoch of a replacement: the items in order with the carried ones, and resets what depended on the old epoch. */
  protected rebuild(publication: JournalPublication, items: readonly JournalItemInput[]): string {
    const epoch = this.newEpoch();
    const next = replacementOrder(this.items, items).map((entry, offset): JournalItem => {
      const seq = offset + 1;
      if (entry.kind === 'carried') {
        return { ...entry.item, seqStart: seq, seqEnd: seq, sourceSeqRanges: [{ startSeq: seq, endSeq: seq }] };
      }
      return this.completeItem(epoch, entry.complete, seq, this.byKey.get(entry.complete.row.itemKey));
    });
    this.advance(publication);
    this.meta.epoch = epoch;
    this.meta.nextSeq = next.length + 1;
    this.meta.minSeq = 1;
    this.items.length = 0;
    this.byKey.clear();
    this.dirty.clear();
    this.sizes.clear();
    this.sizedTotal = 0;
    this.unmeasured.clear();
    this.liveOnlyKeys.clear();
    this.liveOnlySizes.clear();
    this.liveOnlyTotal = 0;
    this.removedKeys.clear();
    this.replaced = true;
    delete this.meta.incomplete;
    for (const item of next) this.insertLast(item);
    return epoch;
  }

  /** Adds older items below the lowest sequence as one batch, oldest first. Items already known are skipped. */
  prepend(publication: JournalPublication, older: readonly JournalItemInput[]): JournalRow[] {
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
      this.touch(item.itemKey);
    }
    this.meta.minSeq = first;
    return rows;
  }

  protected requireDistinct(items: readonly JournalItemInput[]): void {
    const seen = new Set<string>();
    for (const { row } of items) {
      if (seen.has(row.itemKey)) throw new JournalInvalidPublicationError(`Item ${row.itemKey} is repeated.`);
      seen.add(row.itemKey);
    }
  }

  /** An item built from a reread: complete with its digest, or open without one. `previous` is the item of the same key whose alias and background it keeps. */
  protected completeItem(epoch: string, complete: JournalItemInput, seq: number, previous?: JournalItem): JournalItem {
    const item: JournalItem = { ...this.openItem(stampRow(epoch, seq, complete.row), complete.row.liveOnly === true), ...(complete.digest === undefined ? {} : { state: 'complete' as const, digest: complete.digest }) };
    if (previous) {
      carryKnownFields((item.body as JournalBody).item, knownFields(previous));
      if (previous.clientMessageId !== undefined) item.clientMessageId = previous.clientMessageId;
    }
    return item;
  }

  /** A page of the journal; `olderBeyondJournal` says whether the Host still holds history older than the journal. */
  page(request: JournalPageRequest, options: { olderBeyondJournal: boolean }): JournalPageResult {
    return pageJournal({ epoch: this.meta.epoch, items: this.items, nextSeq: this.meta.nextSeq }, request, options);
  }

  /**
   * Evicts the bodies of complete, non-live-only items that carry a digest, outside the retained window: the latest
   * `keepLatestTurns` turns or the latest `keepLatestItems` items, whichever reaches further back. Returns the evicted
   * item keys. The background outcome, time, collapse marks and resources of a body stay on the item.
   */
  evict(keepLatestTurns: number, keepLatestItems = 0): string[] {
    return this.evictKeys(this.items.slice(0, retainedFrom(this.items, keepLatestTurns, keepLatestItems)).filter(evictable));
  }

  /** The `seqStart` where the retained window of `evict` begins; the journal's next sequence when it holds no item. */
  windowStart(keepLatestTurns: number, keepLatestItems = 0): number {
    return this.items[retainedFrom(this.items, keepLatestTurns, keepLatestItems)]?.seqStart ?? this.meta.nextSeq;
  }

  /** Evicts the bodies of the items that `evict` could evict and whose `seqStart` is at least `from` and below `to`. */
  evictRange(from: number, to: number): string[] {
    return this.evictKeys(this.items.filter(item => item.seqStart >= from && item.seqStart < to && evictable(item)));
  }

  protected evictKeys(items: readonly JournalItem[]): string[] {
    const keys: string[] = [];
    for (const item of items) {
      const body = item.body as JournalBody;
      if (body.item.background) item.background = structuredClone(body.item.background);
      else delete item.background;
      item.keptBody = { itemType: body.item.type, timestamp: body.timestamp, collapsed: [...body.collapsed], resources: structuredClone(body.resources) };
      item.body = null;
      this.touch(item.itemKey);
      keys.push(item.itemKey);
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
    if (item.keptBody) {
      const { itemType: _itemType, ...kept } = item.keptBody;
      Object.assign(filled, structuredClone(kept));
    }
    item.body = filled;
    delete item.background;
    delete item.keptBody;
    this.touch(itemKey);
    return 'filled';
  }

  state(): JournalState {
    return { meta: structuredClone(this.meta), items: structuredClone(this.items) };
  }

  /** What changed since the last call, or undefined when nothing did. */
  takeChanges(): JournalChanges | undefined {
    if (!this.metaDirty && this.dirty.size === 0 && this.removedKeys.size === 0 && !this.replaced) return undefined;
    const upsert = [...this.dirty]
      .map(key => this.byKey.get(key))
      .filter((item): item is JournalItem => item !== undefined)
      .map(item => structuredClone(item));
    const changes: JournalChanges = { meta: structuredClone(this.meta), removed: [...this.removedKeys], upsert, replaced: this.replaced, bytes: this.residentBytes() };
    this.dirty.clear();
    this.removedKeys.clear();
    this.metaDirty = false;
    this.replaced = false;
    return changes;
  }

  /** Marks an item for the store and for measuring. */
  protected touch(itemKey: string): void {
    this.dirty.add(itemKey);
    this.unmeasured.add(itemKey);
    if (this.byKey.get(itemKey)?.liveOnly) this.liveOnlyKeys.add(itemKey); else this.liveOnlyKeys.delete(itemKey);
  }

  protected duplicate(publication: JournalPublication): boolean {
    const publisher = this.meta.publisher;
    if (!publisher || publisher.publisherId !== publication.publisherId || publisher.generation !== publication.generation) {
      throw new JournalFencedError(this.meta.sessionKey);
    }
    if (!Number.isSafeInteger(publication.sequence) || publication.sequence < 1) throw new JournalInvalidPublicationError(`sequence ${String(publication.sequence)} is not a positive safe integer.`);
    if (publication.sequence > publisher.watermark + 1) throw new JournalSequenceGapError(publication.sequence, publisher.watermark);
    return publication.sequence <= publisher.watermark;
  }

  protected advance(publication: JournalPublication): void {
    (this.meta.publisher as NonNullable<JournalMeta['publisher']>).watermark = publication.sequence;
    this.metaDirty = true;
  }

  protected require(itemKey: string): JournalItem {
    const item = this.byKey.get(itemKey);
    if (!item) throw new JournalInvalidPublicationError(`Item ${itemKey} is unknown.`);
    return item;
  }

  protected openItem(row: JournalRow, liveOnly: boolean): JournalItem {
    const entry = entryFromRow(canonicalRow(row));
    return {
      itemKey: row.itemKey, providerId: row.providerId, ...(row.turnId === undefined ? {} : { turnId: row.turnId }),
      seqStart: row.seq, seqEnd: row.seq, sourceSeqRanges: entry.sourceSeqRanges,
      state: 'open', liveOnly, body: entryBody(entry),
    };
  }

  protected insertLast(item: JournalItem): void {
    this.items.push(item);
    this.byKey.set(item.itemKey, item);
    this.touch(item.itemKey);
  }
}

function sameBinding(a: ResourceBinding, b: ResourceBinding): boolean {
  return a.locator === b.locator && a.resourceId === b.resourceId && a.status === b.status;
}
