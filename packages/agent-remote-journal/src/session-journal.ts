import { mergeBackgroundActivity, type AgentTimelineItem, type BackgroundActivity, type ProjectedTimelineEntry, type ResourceBinding, type TimelineCursor } from '@orchardworks/agent-remote-protocol';
import { entryFromRow, includeSequence, mergeRowIntoEntry } from '@orchardworks/agent-remote-relay/timeline-projection';

import {
  canonicalRow, carryKnownFields, entryBody, extendSequenceRanges, knownFields, mergeResources, residentEntry, stampRow,
} from './journal-items.js';
import { canonicalContent, canonicalJson } from './item-digest.js';
import { pageJournal, type JournalPageRequest, type JournalPageResult } from './journal-pages.js';
import { evictable, retainedFrom } from './retention.js';
import { replacementOrder } from './replacement.js';
import { utf8ByteLength } from './utf8-size.js';
import {
  JournalBodyMissingError, JournalDuplicateItemError, JournalFencedError, JournalInvalidPublicationError, JournalItemTypeChangedError, JournalSequenceGapError,
  JournalStaleRevisionError, JournalUnknownItemError,
  type JournalItemInput, type JournalChanges, type JournalHead, type JournalPublisher, type JournalIndexEntry, type JournalItem, type JournalMeta, type JournalPublication,
  type JournalBody, type JournalRow, type JournalRowInput, type JournalState, type SyncResult,
} from './types.js';

/** The item types whose rows replace the item's content instead of adding to it. */
const CONTENT_REPLACING_TYPES: ReadonlySet<string> = new Set(['tool_call', 'todo']);

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
  /** The index as last built; dropped whenever an item changes. */
  protected indexSnapshot: readonly JournalIndexEntry[] | undefined;

  static create(sessionKey: string, epoch: string = crypto.randomUUID()): SessionJournal {
    const journal = new SessionJournal({ meta: { sessionKey, epoch, nextSeq: 1, minSeq: 1, publisher: null, lastRevision: 0, retiredEpochs: [] }, items: [] });
    journal.metaDirty = true;
    return journal;
  }

  constructor(state: JournalState) {
    this.meta = structuredClone(state.meta);
    this.items = structuredClone(state.items).sort((left, right) => left.seqStart - right.seqStart);
    let newest = this.meta.lastRevision ?? 0;
    for (const { revision } of this.items) if (revision > newest) newest = revision;
    this.meta.lastRevision = newest;
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

  /**
   * What a replacement by `reread` would carry over: the live-only items and the open items it seals, with their count and
   * estimated size. A replacement is admitted by its own size plus this.
   */
  carriedOnReplace(reread: readonly JournalItemInput[]): { count: number; bytes: number } {
    let count = 0, bytes = 0;
    for (const entry of replacementOrder(this.items, reread)) {
      if (entry.kind !== 'carried') continue;
      count += 1;
      bytes += utf8ByteLength(JSON.stringify(entry.item));
    }
    return { count, bytes };
  }

  /**
   * Removes the oldest complete live-only items until at most `keep` live-only items remain, skeleton and body: nothing can
   * rebuild them, so their place in the sequence goes with them. An open item is never removed: the next append would
   * recreate it with only the new text. Returns the keys removed.
   */
  dropOldestLiveOnly(keep: number): string[] {
    const excess = this.liveOnlyCount - Math.max(0, keep);
    const doomed = new Set(this.items.filter(item => item.liveOnly && item.state === 'complete').slice(0, Math.max(0, excess)).map(item => item.itemKey));
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
    this.indexSnapshot = undefined;
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
      if (keptType !== undefined && keptType !== input.item.type) throw new JournalItemTypeChangedError(input.itemKey, keptType, input.item.type);
      if (!CONTENT_REPLACING_TYPES.has(input.item.type)) throw new JournalBodyMissingError(input.itemKey);
      return this.appendToEvicted(publication, existing, row, input.liveOnly === true);
    }
    const existingType = existing?.body?.item.type;
    if (existingType !== undefined && existingType !== input.item.type) {
      throw new JournalItemTypeChangedError(input.itemKey, existingType, input.item.type);
    }
    if (!existing) {
      const opened = this.openItem(structuredClone(row), input.liveOnly === true);
      this.advance(publication);
      this.meta.nextSeq += 1;
      opened.revision = this.nextRevision();
      this.insertLast(opened);
      return row;
    }
    const body = existing.body as JournalBody;
    const entry = residentEntry(existing);
    mergeRowIntoEntry(entry, canonicalRow(structuredClone(row)));
    this.advance(publication);
    this.meta.nextSeq += 1;
    body.item = entry.item;
    existing.seqEnd = row.seq;
    extendSequenceRanges(existing.sourceSeqRanges, row.seq);
    if (input.liveOnly) existing.liveOnly = true;
    existing.state = 'open';
    delete existing.digest;
    existing.revision = this.nextRevision();
    this.touch(existing.itemKey);
    return row;
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
    if (!kept) throw new JournalBodyMissingError(existing.itemKey);
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
    existing.revision = this.nextRevision();
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
    item.revision = this.nextRevision();
    this.touch(itemKey);
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
    item.revision = this.nextRevision();
    this.touch(itemKey);
  }

  /** Records which operation produced a user message, so clients match its echo exactly. */
  alias(publication: JournalPublication, itemKey: string, clientMessageId: string): void {
    if (this.duplicate(publication)) return;
    const item = this.require(itemKey);
    this.advance(publication);
    item.clientMessageId = clientMessageId;
    if (item.body?.item.type === 'user_message') item.body.item.clientMessageId = clientMessageId;
    item.revision = this.nextRevision();
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
   * them changes anything, so nothing is stored or told. An amendment does not move the item's revision.
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
   * Replaces an item's content after a reread found it different, unless the item moved since the index was read. With a
   * digest the item is complete; without one it stays open, as an item the Controller still receives deltas of does.
   */
  correct(publication: JournalPublication, input: JournalRowInput, digest: string | undefined, expectedRevision: number): JournalRow | undefined {
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
    item.liveOnly = input.liveOnly === true;
    item.seqEnd = row.seq;
    item.sourceSeqRanges = includeSequence(item.sourceSeqRanges, row.seq);
    if (digest === undefined) {
      item.state = 'open';
      delete item.digest;
    } else {
      item.state = 'complete';
      item.digest = digest;
    }
    item.revision = this.nextRevision();
    this.touch(item.itemKey);
    return row;
  }

  /**
   * Starts a new epoch from a reread of native history: one sequence per item, oldest first. Live-only items, which a
   * reread cannot reproduce, are carried over in place, and open items the reread lacks are carried sealed.
   */
  replace(publication: JournalPublication, items: readonly JournalItemInput[], now: number): string {
    if (this.duplicate(publication)) return this.meta.epoch;
    this.requireDistinct(items);
    const retired = this.meta.epoch;
    const epoch = this.rebuild(publication, items, true);
    this.meta.retiredEpochs = [
      ...this.meta.retiredEpochs.filter(({ retiredAt }) => now - retiredAt < RETIRED_EPOCH_MS),
      { epoch: retired, retiredAt: now },
    ];
    return epoch;
  }

  /**
   * Compares the Controller's newest window of native history with the journal and brings the journal to it with the least
   * change: `unchanged` when it already holds the window, `appended` when the window only adds items at the end, otherwise
   * one `replaced` epoch that carries the live-only items. The window is trimmed first to the newest items that fit
   * `roomBytes`; items older than the journal's first shared item are not a change, because older history is not
   * uploaded until it is asked for. A journal that is missing rows is always replaced.
   */
  sync(publication: JournalPublication, window: readonly JournalItemInput[], options: { roomBytes: number }): SyncResult {
    if (this.duplicate(publication)) return { outcome: 'unchanged' };
    this.requireDistinct(window);
    const fixed = this.residentBytes() - (this.sizedTotal - this.liveOnlyTotal);
    let budget = options.roomBytes - fixed;
    let start = window.length;
    while (start > 0) {
      const size = utf8ByteLength(JSON.stringify(window[start - 1]));
      if (size > budget) break;
      budget -= size;
      start -= 1;
    }
    const kept = window.slice(start);
    const extension = this.incomplete ? undefined : this.extensionOf(kept);
    if (extension && extension.length === 0) {
      this.advance(publication);
      return { outcome: 'unchanged' };
    }
    if (extension && this.residentBytes() + extension.reduce((sum, item) => sum + utf8ByteLength(JSON.stringify(item)), 0) <= options.roomBytes) {
      this.advance(publication);
      const rows = extension.map(item => {
        const created = this.completeItem(this.meta.epoch, item, this.meta.nextSeq);
        created.revision = this.nextRevision();
        this.insertLast(created);
        return stampRow(this.meta.epoch, this.meta.nextSeq++, item.row);
      });
      return { outcome: 'appended', rows };
    }
    return { outcome: 'replaced', epoch: this.rebuild(publication, kept, false), trimmed: start };
  }

  /**
   * The items of `window` that the journal lacks at its end, when everything else of the window is already in the
   * journal as it is; undefined when the journal must be replaced.
   */
  protected extensionOf(window: readonly JournalItemInput[]): JournalItemInput[] | undefined {
    if (window.length === 0) return this.items.some(item => !item.liveOnly) ? undefined : [];
    const position = new Map(this.items.map((item, at) => [item.itemKey, at] as const));
    const first = window.findIndex(({ row }) => position.has(row.itemKey));
    if (first < 0) return undefined;
    let at = position.get((window[first] as JournalItemInput).row.itemKey) as number;
    if (first > 0 && this.items.slice(0, at).some(item => !item.liveOnly)) return undefined;
    const windowKeys = new Set(window.map(({ row }) => row.itemKey));
    let next = first;
    for (; at < this.items.length; at += 1) {
      const held = this.items[at] as JournalItem;
      const wanted = window[next];
      if (wanted && held.itemKey === wanted.row.itemKey) {
        if (!sameItem(held, wanted)) return undefined;
        next += 1;
      } else if (!held.liveOnly || windowKeys.has(held.itemKey)) {
        return undefined;
      }
    }
    const extension = window.slice(next);
    return extension.some(({ row }) => position.has(row.itemKey)) ? undefined : extension;
  }

  /** Starts the new epoch of a replacement: the items in order with the carried ones, and resets what depended on the old epoch. */
  protected rebuild(publication: JournalPublication, items: readonly JournalItemInput[], sealOpen: boolean): string {
    const epoch = crypto.randomUUID();
    const resealed = new Set<JournalItem>();
    const next = replacementOrder(this.items, items, sealOpen).map((entry, offset): JournalItem => {
      const seq = offset + 1;
      if (entry.kind === 'carried') {
        const carried = { ...entry.item, seqStart: seq, seqEnd: seq, sourceSeqRanges: [{ startSeq: seq, endSeq: seq }] };
        if (entry.item !== this.byKey.get(entry.item.itemKey)) resealed.add(carried);
        return carried;
      }
      const item = this.completeItem(epoch, entry.complete, seq, this.byKey.get(entry.complete.row.itemKey));
      resealed.add(item);
      return item;
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
    this.indexSnapshot = undefined;
    this.liveOnlyKeys.clear();
    this.liveOnlySizes.clear();
    this.liveOnlyTotal = 0;
    this.removedKeys.clear();
    this.replaced = true;
    delete this.meta.incomplete;
    for (const item of next) {
      if (resealed.has(item)) item.revision = this.nextRevision();
      this.insertLast(item);
    }
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
      item.revision = this.nextRevision();
      this.byKey.set(item.itemKey, item);
      this.touch(item.itemKey);
    }
    this.meta.minSeq = first;
    this.indexSnapshot = undefined;
    return rows;
  }

  protected requireDistinct(items: readonly JournalItemInput[]): void {
    const seen = new Set<string>();
    for (const { row } of items) {
      if (seen.has(row.itemKey)) throw new JournalDuplicateItemError(row.itemKey);
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

  /** The entries of every item in order. The array is a snapshot that stays valid until an item changes: do not modify it. */
  index(): readonly JournalIndexEntry[] {
    this.indexSnapshot ??= this.items.map(item => ({
      itemKey: item.itemKey, seqStart: item.seqStart, seqEnd: item.seqEnd, state: item.state,
      ...(item.digest === undefined ? {} : { digest: item.digest }), liveOnly: item.liveOnly,
      ...(item.clientMessageId === undefined ? {} : { clientMessageId: item.clientMessageId }),
      revision: item.revision, resident: item.body !== null,
    }));
    return this.indexSnapshot;
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
    this.indexSnapshot = undefined;
    if (this.byKey.get(itemKey)?.liveOnly) this.liveOnlyKeys.add(itemKey); else this.liveOnlyKeys.delete(itemKey);
  }

  protected duplicate(publication: JournalPublication): boolean {
    const publisher = this.meta.publisher;
    if (!publisher || publisher.publisherId !== publication.publisherId || publisher.generation !== publication.generation) {
      throw new JournalFencedError(this.meta.sessionKey);
    }
    if (!Number.isSafeInteger(publication.sequence) || publication.sequence < 1) throw new JournalInvalidPublicationError(publication.sequence);
    if (publication.sequence > publisher.watermark + 1) throw new JournalSequenceGapError(publication.sequence, publisher.watermark);
    return publication.sequence <= publisher.watermark;
  }

  protected nextRevision(): number {
    this.meta.lastRevision += 1;
    return this.meta.lastRevision;
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
      state: 'open', liveOnly, revision: 0, body: entryBody(entry),
    };
  }

  protected insertLast(item: JournalItem): void {
    this.items.push(item);
    this.byKey.set(item.itemKey, item);
    this.touch(item.itemKey);
  }
}

/** Whether the journal's item is the window's item: the same key and live-only mark, and the same digest when complete or the same resident content when open. */
function sameItem(held: JournalItem, wanted: JournalItemInput): boolean {
  if (held.liveOnly !== (wanted.row.liveOnly === true)) return false;
  if (wanted.digest !== undefined) return held.state === 'complete' && held.digest === wanted.digest;
  return held.state === 'open' && held.body !== null && canonicalContent(held.body.item) === canonicalContent(wanted.row.item);
}

function sameBinding(a: ResourceBinding, b: ResourceBinding): boolean {
  return a.locator === b.locator && a.resourceId === b.resourceId && a.status === b.status;
}
