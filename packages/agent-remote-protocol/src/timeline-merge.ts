import type { AgentTimelineItem } from './timeline.js';
import type { ProjectedTimelineEntry, TimelineCollapse, TimelineSeqRange } from './timeline.js';
import { mergeBackgroundActivity } from './background-activity.js';

/** What a row adds to the entry it continues: its sequence, its item and its resources. */
export interface TimelineRowContribution {
  seq: number;
  item: AgentTimelineItem;
  resources: ProjectedTimelineEntry['resources'];
}

const clone = <T>(value: T): T => JSON.parse(JSON.stringify(value)) as T;

export function includeSequence(ranges: readonly TimelineSeqRange[], sequence: number): TimelineSeqRange[] {
  const next: TimelineSeqRange[] = ranges.map((range) => ({ ...range }));
  const last = next.at(-1);
  if (last && last.endSeq + 1 === sequence) last.endSeq = sequence;
  else next.push({ startSeq: sequence, endSeq: sequence });
  return next;
}

function includeCollapse(collapsed: TimelineCollapse[], collapse: TimelineCollapse): void {
  if (!collapsed.includes(collapse)) collapsed.push(collapse);
}

export function includeResources(resources: ProjectedTimelineEntry['resources'], additions: ProjectedTimelineEntry['resources']): void {
  for (const addition of additions) {
    if (resources.some(({ locator, resourceId }) => locator === addition.locator && resourceId === addition.resourceId)) continue;
    resources.push(clone(addition));
  }
}

/**
 * Folds one row into the entry it continues. Pages project rows with it, the journal merges live rows with it and the client folds
 * live frames with it, so a row built live equals the row built from a page by construction.
 */
export function mergeRowIntoEntry(entry: ProjectedTimelineEntry, row: TimelineRowContribution): void {
  const previousBackground = entry.item.background;
  entry.seqEnd = row.seq;
  entry.sourceSeqRanges = includeSequence(entry.sourceSeqRanges, row.seq);
  includeResources(entry.resources, row.resources);
  if (row.item.background) entry.item.background = clone(mergeBackgroundActivity(entry.item.background, row.item.background));
  if (row.item.type === 'assistant_message' && entry.item.type === 'assistant_message') {
    entry.item.text += row.item.text;
    includeCollapse(entry.collapsed, 'assistant_merge');
  } else if (row.item.type === 'reasoning' && entry.item.type === 'reasoning') {
    entry.item.text += row.item.text;
    includeCollapse(entry.collapsed, 'reasoning_merge');
  } else if (row.item.type === 'tool_call') {
    entry.item = clone(row.item);
    if (row.item.background) entry.item.background = mergeBackgroundActivity(previousBackground, row.item.background);
    includeCollapse(entry.collapsed, 'tool_lifecycle');
  } else if (row.item.type === 'compaction' && entry.item.type === 'compaction') {
    entry.item = { ...entry.item, ...row.item };
  } else if (row.item.type === 'todo') {
    entry.item = clone(row.item);
    if (row.item.background) entry.item.background = mergeBackgroundActivity(previousBackground, row.item.background);
  }
}
