import { itemDigest, type JournalItemInput, type JournalRowInput } from '@orchardworks/agent-remote-journal';
import {
  encodeRemoteHostUplinkMessage, JOURNAL_ITEMS_PER_ENTRY_MAX, JOURNAL_PUBLISH_MAX_ENTRIES, REMOTE_HOST_UPLINK_VERSION, type JournalPublishEntry,
} from '@orchardworks/agent-remote-protocol';
import { entryFromRow, mergeRowIntoEntry, rowItemKey, type CanonicalTimelineRow } from '@orchardworks/agent-remote-relay/timeline-projection';

/** What one publication message may carry in bytes: half of the 8 MiB the Relay accepts, so every estimate has room. */
export const MESSAGE_BUDGET_BYTES = 4 * 1024 * 1024;

/** The key prefix of items the Controller makes itself, such as a question it asks. A provider never supplies a key that starts with it. */
const CONTROLLER_ITEM_KEY_PREFIX = 'controller:';

/** One item of the Controller's timeline: its rows in order, and what the provider said about it. */
export interface TimelineItem {
  key: string;
  rows: CanonicalTimelineRow[];
  /** The provider finished it, or its rows came from native history, which is finalized. */
  complete: boolean;
  /** Native history cannot rebuild it, so the journal keeps the only copy. */
  liveOnly: boolean;
}

/** An operation of a publication, before it is numbered. */
export type PublishOp = JournalPublishEntry extends infer Entry ? Entry extends { sequence: number } ? Omit<Entry, 'sequence'> : never : never;

export interface SizedOp { op: PublishOp; bytes: number }
export interface SizedItem { item: JournalItemInput; bytes: number }

/** Whether a row's item is the Controller's own, or the provider said native history cannot rebuild it. */
export const isLiveOnlyRow = (row: CanonicalTimelineRow): boolean =>
  row.identity === undefined || row.identity.liveOnly === true || rowItemKey(row).startsWith(CONTROLLER_ITEM_KEY_PREFIX);

/** Groups rows by item, in the order the items first appear. An item is complete when its last row completes it. A row without identity is a complete, live-only item of its own. */
export function groupItems(rows: readonly CanonicalTimelineRow[]): TimelineItem[] {
  const items = new Map<string, TimelineItem>();
  for (const row of rows) {
    const key = rowItemKey(row);
    let item = items.get(key);
    if (!item) {
      item = { key, rows: [], complete: false, liveOnly: false };
      items.set(key, item);
    }
    item.rows.push(row);
    // The journal's rule: a content row for a complete item reopens it, and a row that completes closes it.
    item.complete = row.identity === undefined || row.identity.completes === true;
    if (isLiveOnlyRow(row)) item.liveOnly = true;
  }
  return [...items.values()];
}

/**
 * The row an item has in a journal: its content with its rows merged the way the journal merges them, and the time,
 * source and turn of its first row. A journal that holds the item as one row, or as the deltas it came from, shows the same item.
 */
export function mergedRow(item: TimelineItem): JournalRowInput {
  const [first, ...rest] = item.rows as [CanonicalTimelineRow, ...CanonicalTimelineRow[]];
  const entry = entryFromRow(first);
  for (const row of rest) mergeRowIntoEntry(entry, row);
  return {
    itemKey: item.key, providerId: first.providerId, sourceKey: first.sourceKey, occurredAt: first.occurredAt,
    ...(first.turnId === undefined ? {} : { turnId: first.turnId }),
    item: entry.item, ...(entry.resources.length === 0 ? {} : { resources: entry.resources }),
    ...(item.liveOnly ? { liveOnly: true } : {}),
  };
}

/** The digest of an item's whole content, as the journal compares it. */
export const digestOf = (item: TimelineItem): Promise<string> => itemDigest(mergedRow(item).item);

/** What a message carries besides its entries, under the longest session key; counted once per message. */
const MESSAGE_ENVELOPE_BYTES = Buffer.byteLength(JSON.stringify({ uplinkVersion: REMOTE_HOST_UPLINK_VERSION, type: 'journal_publish', sessionKey: 'k'.repeat(4609), generation: 1, entries: [] })) - 2;

/** The longest session key the wire accepts, so an entry measured here encodes under any real key. */
const PROBE = { uplinkVersion: REMOTE_HOST_UPLINK_VERSION, type: 'journal_publish', sessionKey: 'k'.repeat(4609), generation: 1 } as const;

/**
 * The bytes an entry takes on the wire, or undefined when the wire refuses it: a field over its limit, a row that is
 * not a valid timeline row, or a message over the Relay's size bound. One refused row would make the whole message
 * unencodable, so every row is measured before it joins a publication.
 */
export function entryBytes(op: PublishOp): number | undefined {
  const encoded = encodeRemoteHostUplinkMessage({ ...PROBE, entries: [{ sequence: 1, ...op } as JournalPublishEntry] });
  // The entry's own bytes and its separator: the envelope is counted once per message, not once per entry.
  return encoded.status === 'ok' ? Buffer.byteLength(encoded.json) - MESSAGE_ENVELOPE_BYTES + 1 : undefined;
}

/** The items the wire accepts, each with its digest (none for an item still open) and size, and the keys of those it refuses. */
export async function sizedItems(items: readonly TimelineItem[], digest: (item: TimelineItem) => Promise<string>): Promise<{ accepted: SizedItem[]; refused: string[] }> {
  const accepted: SizedItem[] = [];
  const refused: string[] = [];
  for (const item of items) {
    const input: JournalItemInput = { row: mergedRow(item), ...(item.complete ? { digest: await digest(item) } : {}) };
    const bytes = entryBytes({ op: 'prepend', items: [input] });
    if (bytes === undefined) refused.push(item.key);
    else accepted.push({ item: input, bytes });
  }
  return { accepted, refused };
}

/** Consecutive blocks of items, in their order, each within the budget of one message (at least one item each). */
export function blocksOf(items: readonly SizedItem[]): JournalItemInput[][] {
  const blocks: JournalItemInput[][] = [];
  let current: JournalItemInput[] = [];
  let bytes = 0;
  for (const sized of items) {
    if (current.length > 0 && (current.length >= JOURNAL_ITEMS_PER_ENTRY_MAX || MESSAGE_ENVELOPE_BYTES + bytes + sized.bytes > MESSAGE_BUDGET_BYTES)) {
      blocks.push(current);
      current = [];
      bytes = 0;
    }
    current.push(sized.item);
    bytes += sized.bytes;
  }
  if (current.length > 0) blocks.push(current);
  return blocks;
}

/** The newest items that fit one message, oldest first, taken from the end; at least one when there is any the wire accepts. */
export async function newestItems(items: readonly TimelineItem[], digest: (item: TimelineItem) => Promise<string>): Promise<{ block: JournalItemInput[]; refused: string[] }> {
  const block: JournalItemInput[] = [];
  const refused: string[] = [];
  let bytes = 0;
  for (let at = items.length - 1; at >= 0; at -= 1) {
    const { accepted, refused: bad } = await sizedItems([items[at] as TimelineItem], digest);
    refused.push(...bad);
    const sized = accepted[0];
    if (!sized) continue;
    if (block.length > 0 && (block.length >= JOURNAL_ITEMS_PER_ENTRY_MAX || MESSAGE_ENVELOPE_BYTES + bytes + sized.bytes > MESSAGE_BUDGET_BYTES)) break;
    block.unshift(sized.item);
    bytes += sized.bytes;
  }
  return { block, refused };
}

/** Publications, in order, each within the entry count and the byte budget of one message. */
export function chunkOps(ops: readonly SizedOp[]): Array<{ ops: PublishOp[]; bytes: number }> {
  const chunks: Array<{ ops: PublishOp[]; bytes: number }> = [];
  let current: { ops: PublishOp[]; bytes: number } = { ops: [], bytes: 0 };
  for (const sized of ops) {
    if (current.ops.length > 0 && (current.ops.length >= JOURNAL_PUBLISH_MAX_ENTRIES || MESSAGE_ENVELOPE_BYTES + current.bytes + sized.bytes > MESSAGE_BUDGET_BYTES)) {
      chunks.push(current);
      current = { ops: [], bytes: 0 };
    }
    current.ops.push(sized.op);
    current.bytes += sized.bytes;
  }
  if (current.ops.length > 0) chunks.push(current);
  return chunks;
}
