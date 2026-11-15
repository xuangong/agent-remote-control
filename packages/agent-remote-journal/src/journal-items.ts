import type { ProjectedTimelineEntry, ResourceBinding } from '@orchardworks/agent-remote-protocol';
import { includeResources, type CanonicalTimelineRow } from '@orchardworks/agent-remote-relay/timeline-projection';

import { JournalBodyMissingError, type JournalBody, type JournalItem, type JournalRow, type JournalRowInput } from './types.js';

export function rowTimestamp(occurredAt: number): string {
  return new Date(occurredAt).toISOString();
}

export function stampRow(epoch: string, seq: number, input: JournalRowInput): JournalRow {
  return {
    epoch, seq, itemKey: input.itemKey, providerId: input.providerId, sourceKey: input.sourceKey,
    ...(input.nativeRevision === undefined ? {} : { nativeRevision: input.nativeRevision }),
    occurredAt: input.occurredAt, timestamp: rowTimestamp(input.occurredAt),
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

export function entryBody(entry: ProjectedTimelineEntry): JournalBody {
  return { item: entry.item, timestamp: entry.timestamp, collapsed: entry.collapsed, resources: entry.resources };
}

/** The body of a complete item read again from native history, for a fill. */
export function bodyFromRow(input: JournalRowInput): JournalBody {
  return {
    item: structuredClone(input.item), timestamp: rowTimestamp(input.occurredAt),
    collapsed: [], resources: structuredClone(input.resources ?? []),
  };
}

export function mergeResources(current: readonly ResourceBinding[], additions: readonly ResourceBinding[]): ResourceBinding[] {
  const merged = structuredClone([...current]);
  includeResources(merged, [...additions]);
  return merged;
}
