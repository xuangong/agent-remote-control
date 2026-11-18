/** Small pure helpers over timeline entries that the other replica folds share. */
import type {
  AgentStreamMessage,
  ProjectedTimelineEntry,
} from '@orchardworks/agent-remote-protocol';

import type {
  TimelineStreamMessage,
} from './types.js';

export function clone<T>(value: T): T {
  return structuredClone(value);
}

export function unique(values: readonly string[]): string[] {
  return [...new Set(values)];
}

export function sortEntries(entries: ProjectedTimelineEntry[]): ProjectedTimelineEntry[] {
  return entries.sort((left, right) => left.seqStart - right.seqStart || left.seqEnd - right.seqEnd);
}

export function rangesOverlap(
  left: ProjectedTimelineEntry['sourceSeqRanges'],
  right: ProjectedTimelineEntry['sourceSeqRanges'],
): boolean {
  return left.some((a) => right.some((b) => a.startSeq <= b.endSeq && b.startSeq <= a.endSeq));
}

export function mergeRanges(ranges: ProjectedTimelineEntry['sourceSeqRanges']): ProjectedTimelineEntry['sourceSeqRanges'] {
  const sorted = ranges.map(clone).sort((left, right) => left.startSeq - right.startSeq);
  const merged: ProjectedTimelineEntry['sourceSeqRanges'] = [];
  for (const range of sorted) {
    const previous = merged.at(-1);
    if (previous && range.startSeq <= previous.endSeq + 1) previous.endSeq = Math.max(previous.endSeq, range.endSeq);
    else merged.push(range);
  }
  return merged;
}

export function mergeResources(
  existing: ProjectedTimelineEntry['resources'],
  incoming: ProjectedTimelineEntry['resources'],
): ProjectedTimelineEntry['resources'] {
  const resources = new Map(existing.map((resource) => [resource.resourceId, clone(resource)]));
  for (const resource of incoming) resources.set(resource.resourceId, clone(resource));
  return [...resources.values()];
}

export function isTimelineMessage(message: AgentStreamMessage): message is TimelineStreamMessage {
  return message.payload.event.type === 'timeline';
}

export function sameContext(left: ProjectedTimelineEntry, right: ProjectedTimelineEntry): boolean {
  return left.providerId === right.providerId && left.turnId === right.turnId && left.item.background?.id === right.item.background?.id;
}
