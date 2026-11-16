import type { AgentTimelineItem, BackgroundActivity, ProjectedTimelineEntry, TimelineSeqRange } from '@orchardworks/agent-remote-protocol';
import { mergeBackgroundActivity } from '@orchardworks/agent-remote-protocol';
import type { CanonicalTimelineRow } from '@orchardworks/agent-remote-relay/timeline-projection';

import { JournalBodyMissingError, JournalInvalidRowError, type JournalBody, type JournalItem, type JournalRow, type JournalRowInput } from './types.js';

export function rowTimestamp(itemKey: string, occurredAt: number): string {
  const time = new Date(occurredAt);
  if (Number.isNaN(time.getTime())) throw new JournalInvalidRowError(itemKey, 'occurredAt is not a time that can be stamped');
  return time.toISOString();
}

export function stampRow(epoch: string, seq: number, input: JournalRowInput): JournalRow {
  return {
    epoch, seq, itemKey: input.itemKey, providerId: input.providerId, sourceKey: input.sourceKey,
    ...(input.nativeRevision === undefined ? {} : { nativeRevision: input.nativeRevision }),
    occurredAt: input.occurredAt, timestamp: rowTimestamp(input.itemKey, input.occurredAt),
    ...(input.turnId === undefined ? {} : { turnId: input.turnId }),
    item: structuredClone(input.item), resources: structuredClone(input.resources ?? []),
  };
}

export function canonicalRow(row: JournalRow): CanonicalTimelineRow {
  return {
    epoch: row.epoch, seq: row.seq, providerId: row.providerId, sourceKey: row.sourceKey,
    ...(row.nativeRevision === undefined ? {} : { nativeRevision: row.nativeRevision }),
    occurredAt: row.occurredAt, timestamp: row.timestamp,
    ...(row.turnId === undefined ? {} : { turnId: row.turnId }),
    item: row.item, resources: row.resources,
  };
}

/** The projected entry of a resident item, as pages show it and live rows merge into it. */
export function itemEntry(item: JournalItem): ProjectedTimelineEntry {
  if (item.body === null) throw new JournalBodyMissingError(item.itemKey);
  return {
    providerId: item.providerId, item: structuredClone(item.body.item),
    ...(item.turnId === undefined ? {} : { turnId: item.turnId }),
    timestamp: item.body.timestamp, seqStart: item.seqStart, seqEnd: item.seqEnd,
    sourceSeqRanges: structuredClone(item.sourceSeqRanges), collapsed: [...item.body.collapsed],
    resources: structuredClone(item.body.resources),
  };
}

/**
 * A resident item's entry that shares its body's content, collapse marks and resources, so that a live row merges
 * into the body in place. Its sequence ranges are empty: the caller extends the item's own.
 */
export function residentEntry(item: JournalItem): ProjectedTimelineEntry {
  if (item.body === null) throw new JournalBodyMissingError(item.itemKey);
  return {
    providerId: item.providerId, item: item.body.item,
    ...(item.turnId === undefined ? {} : { turnId: item.turnId }),
    timestamp: item.body.timestamp, seqStart: item.seqStart, seqEnd: item.seqEnd,
    sourceSeqRanges: [], collapsed: item.body.collapsed, resources: item.body.resources,
  };
}

/** Extends the ranges of sequences an item came from with one more sequence, in place. */
export function extendSequenceRanges(ranges: TimelineSeqRange[], sequence: number): void {
  const last = ranges.at(-1);
  if (last && last.endSeq + 1 === sequence) last.endSeq = sequence;
  else ranges.push({ startSeq: sequence, endSeq: sequence });
}

/** What the journal knows about an item that content read again from a Controller or the Host lacks. */
export interface KnownFields {
  clientMessageId?: string;
  background?: BackgroundActivity;
}

/** The alias and background outcome of an item, from its body while resident and from its skeleton while evicted. */
export function knownFields(item: JournalItem): KnownFields {
  const background = item.body ? item.body.item.background : item.background;
  return {
    ...(item.clientMessageId === undefined ? {} : { clientMessageId: item.clientMessageId }),
    ...(background ? { background } : {}),
  };
}

/** Writes what is known about an item into new content of it: the alias into a user message, a background merged so that a finished outcome never regresses. */
export function carryKnownFields(content: AgentTimelineItem, known: KnownFields): void {
  if (known.background) content.background = structuredClone(content.background ? mergeBackgroundActivity(known.background, content.background) : known.background);
  if (known.clientMessageId !== undefined && content.type === 'user_message') content.clientMessageId = known.clientMessageId;
}

export function entryBody(entry: ProjectedTimelineEntry): JournalBody {
  return { item: entry.item, timestamp: entry.timestamp, collapsed: entry.collapsed, resources: entry.resources };
}

/** The body of a complete item read again from native history, for a fill. */
export function bodyFromRow(input: JournalRowInput): JournalBody {
  return {
    item: structuredClone(input.item), timestamp: rowTimestamp(input.itemKey, input.occurredAt),
    collapsed: [], resources: structuredClone(input.resources ?? []),
  };
}
