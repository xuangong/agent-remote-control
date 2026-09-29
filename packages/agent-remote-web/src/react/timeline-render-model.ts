import { timelineEntryKey } from '../replica/timeline-entry-key.js';
import type { AgentTimelineItem, ProjectedTimelineEntry } from '@orchardworks/agent-remote-protocol';

export type MessageGroupPosition = 'single' | 'first' | 'middle' | 'last';

export interface TimelineRenderEntry {
  readonly entry: ProjectedTimelineEntry;
  readonly key: string;
  readonly messageGroup?: MessageGroupPosition;
}

export function createTimelineRenderModel(
  epoch: string | null,
  entries: readonly ProjectedTimelineEntry[],
): readonly TimelineRenderEntry[] {
  return entries.map((entry, index) => ({
    entry,
    key: timelineEntryKey(epoch, entry),
    ...(isMessage(entry.item) ? { messageGroup: messageGroupPosition(entries, index) } : {}),
  }));
}

function messageGroupPosition(entries: readonly ProjectedTimelineEntry[], index: number): MessageGroupPosition {
  const item = entries[index]?.item;
  if (!item || !isMessage(item)) return 'single';
  const previous = entries[index - 1]?.item;
  const next = entries[index + 1]?.item;
  const joinsPrevious = isMessage(previous) && previous.type === item.type;
  const joinsNext = isMessage(next) && next.type === item.type;
  if (joinsPrevious && joinsNext) return 'middle';
  if (joinsPrevious) return 'last';
  if (joinsNext) return 'first';
  return 'single';
}

function isMessage(item: AgentTimelineItem | undefined): item is Extract<AgentTimelineItem, { type: 'user_message' | 'assistant_message' }> {
  return item?.type === 'user_message' || item?.type === 'assistant_message';
}
