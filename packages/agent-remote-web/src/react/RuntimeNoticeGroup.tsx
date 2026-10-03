import { useId, useState, type ReactNode } from 'react';
import type { ProjectedTimelineEntry } from '@orchardworks/agent-remote-protocol';
import type { TimelineRenderEntry } from './timeline-render-model.js';
import { useTimelineAction } from './useTimelineAction.js';

type NoticeRenderEntry = TimelineRenderEntry & {
  readonly entry: ProjectedTimelineEntry & { readonly item: Extract<ProjectedTimelineEntry['item'], { type: 'error' }> };
};

type ConversationRow =
  | { readonly type: 'entry'; readonly key: string; readonly value: TimelineRenderEntry }
  | { readonly type: 'notices'; readonly key: string; readonly entries: NoticeRenderEntry[] };

/** Filtering must not join notices separated by hidden timeline activity. */
export function groupRuntimeNotices(model: readonly TimelineRenderEntry[], timeline: readonly ProjectedTimelineEntry[]): ConversationRow[] {
  const positions = new Map(timeline.map((entry, index) => [entry, index]));
  const rows: ConversationRow[] = [];
  let previousPosition = -2;
  for (const row of model) {
    const position = positions.get(row.entry)!;
    const previous = rows.at(-1);
    if (row.entry.item.type === 'error') {
      const notice = row as NoticeRenderEntry;
      if (previous?.type === 'notices' && position === previousPosition + 1) previous.entries.push(notice);
      else rows.push({ type: 'notices', key: row.key, entries: [notice] });
    } else rows.push({ type: 'entry', key: row.key, value: row });
    previousPosition = position;
  }
  return rows;
}

/** Remember choices by original entries so both append and history prepend preserve them. */
export function useRuntimeNoticeDisclosure(scopeKey: string, searchEntryKey?: string, inspectedEntryKey?: string,
  searchRequestId?: number, inspectedRequestId?: number) {
  const searchRequest = JSON.stringify([searchEntryKey, searchRequestId]);
  const inspectRequest = JSON.stringify([inspectedEntryKey, inspectedRequestId]);
  const [stored, setStored] = useState(() => ({ scopeKey, searchRequest, inspectRequest,
    open: new Set([searchEntryKey, inspectedEntryKey].filter((key): key is string => key !== undefined)) }));
  let current = stored;
  if (stored.scopeKey !== scopeKey || stored.searchRequest !== searchRequest || stored.inspectRequest !== inspectRequest) {
    const open = new Set(stored.scopeKey === scopeKey ? stored.open : []);
    if (searchEntryKey !== undefined && (stored.scopeKey !== scopeKey || stored.searchRequest !== searchRequest)) open.add(searchEntryKey);
    if (inspectedEntryKey !== undefined && (stored.scopeKey !== scopeKey || stored.inspectRequest !== inspectRequest)) open.add(inspectedEntryKey);
    current = { scopeKey, searchRequest, inspectRequest, open };
    // Reveal during rendering: the workbench locates search/Trace targets in a layout effect.
    setStored(current);
  }
  return {
    isExpanded: (entries: readonly TimelineRenderEntry[]) => entries.some(entry => current.open.has(entry.key)),
    toggle: (entries: readonly TimelineRenderEntry[]) => setStored(previous => {
      const open = new Set(previous.scopeKey === scopeKey ? previous.open : []);
      const expanded = entries.some(entry => open.has(entry.key));
      for (const entry of entries) {
        if (expanded) open.delete(entry.key);
        else open.add(entry.key);
      }
      return { scopeKey, searchRequest, inspectRequest, open };
    }),
  };
}

/** Primitive props keep each historical ConversationEntry eligible for memoization. */
export interface RuntimeNoticePresentation {
  readonly noticeExpanded?: boolean;
  readonly noticeCount?: number;
  readonly onToggleNotice?: () => void;
  readonly noticeDetailsId?: string;
  readonly noticeControls?: string;
}

export function RuntimeNoticeGroup({ entries, expanded, toggle, renderEntry }: {
  readonly entries: readonly NoticeRenderEntry[];
  readonly expanded: boolean;
  readonly toggle: () => void;
  readonly renderEntry: (row: TimelineRenderEntry, notice: RuntimeNoticePresentation) => ReactNode;
}) {
  const id = useId();
  const toggleGroup = useTimelineAction(id, toggle);
  const visible = expanded ? entries : entries.slice(0, 1);
  const controls = visible.map((_, index) => `${id}-${index}`).join(' ');
  // Keep original entries as siblings for time, Trace, and scroll-anchor indexing.
  return <>{visible.map((row, index) => renderEntry(row, {
    noticeExpanded: expanded, onToggleNotice: index === 0 ? toggleGroup : undefined, noticeCount: entries.length,
    noticeDetailsId: `${id}-${index}`, noticeControls: controls,
  }))}</>;
}
