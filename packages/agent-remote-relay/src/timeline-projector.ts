import type {
  HistoryPage,
  ProjectedTimelineEntry,
  TimelineCursor,
  TimelineCollapse,
  TimelineDirection,
  TimelineSeqRange,
} from '@agent-remote-controller/agent-remote-protocol';
import { PROTOCOL_VERSION } from '@agent-remote-controller/agent-remote-protocol';

import { TimelineStore, type CanonicalTimelineRow } from './timeline-store.js';

export interface TimelinePageRequest {
  requestId: string;
  agentId: string;
  direction: TimelineDirection;
  cursor?: TimelineCursor;
  limit: number;
}

interface TimelineSequenceWindow {
  startSeq: number;
  endSeq: number;
}

export function projectTimelineRows(rows: readonly CanonicalTimelineRow[]): ProjectedTimelineEntry[] {
  const entries: ProjectedTimelineEntry[] = [];
  for (const row of rows) {
    const match = findProjection(entries, row);
    if (match === undefined) {
      entries.push(entryFromRow(row));
      continue;
    }

    const entry = entries[match] as ProjectedTimelineEntry;
    entry.seqEnd = row.seq;
    entry.sourceSeqRanges = includeSequence(entry.sourceSeqRanges, row.seq);
    includeResources(entry.resources, row.resources);
    if (row.item.type === 'assistant_message' && entry.item.type === 'assistant_message') {
      entry.item.text += row.item.text;
      includeCollapse(entry.collapsed, 'assistant_merge');
    } else if (row.item.type === 'reasoning' && entry.item.type === 'reasoning') {
      entry.item.text += row.item.text;
      includeCollapse(entry.collapsed, 'reasoning_merge');
    } else if (row.item.type === 'tool_call') {
      entry.item = structuredClone(row.item);
      includeCollapse(entry.collapsed, 'tool_lifecycle');
    } else if (row.item.type === 'todo') {
      entry.item = structuredClone(row.item);
    }
  }
  return entries;
}

export function projectTimelinePage(store: TimelineStore, request: TimelinePageRequest): HistoryPage {
  if (!Number.isSafeInteger(request.limit) || request.limit < 1) {
    throw new Error('Timeline page limit must be a positive integer.');
  }
  if (request.direction !== 'tail' && request.cursor === undefined) {
    throw new Error(`${request.direction} Timeline requests require a cursor.`);
  }

  const rows = store.rows();
  if (request.cursor && request.cursor.epoch !== store.epoch) {
    return page(store, request, [], {
      reset: true,
      staleCursor: true,
      gap: false,
      error: 'Timeline cursor epoch was replaced.',
    });
  }
  if (request.direction === 'after' && (request.cursor as TimelineCursor).seq > store.cursor.seq) {
    return page(store, request, [], {
      reset: false,
      staleCursor: false,
      gap: true,
      error: 'Timeline cursor is ahead of recoverable history.',
    });
  }

  let selected: readonly ProjectedTimelineEntry[];
  let sequenceWindow: TimelineSequenceWindow | undefined;
  if (request.direction === 'tail') selected = projectTimelineRows(rows).slice(-request.limit);
  else if (request.direction === 'before') {
    selected = projectTimelineRows(rows)
      .filter(({ seqStart }) => seqStart < (request.cursor as TimelineCursor).seq)
      .slice(-request.limit);
  } else {
    const cursorSeq = (request.cursor as TimelineCursor).seq;
    const rowWindow = rows.filter(({ seq }) => seq > cursorSeq).slice(0, request.limit);
    const firstRow = rowWindow[0];
    const lastRow = rowWindow.at(-1);
    if (firstRow && lastRow) {
      sequenceWindow = { startSeq: firstRow.seq, endSeq: lastRow.seq };
      selected = projectTimelineRows(rows.filter(({ seq }) => seq <= lastRow.seq))
        .filter(({ seqEnd }) => seqEnd > cursorSeq);
    } else {
      selected = [];
    }
  }
  return page(
    store,
    request,
    selected,
    { reset: false, staleCursor: false, gap: false, error: null },
    sequenceWindow,
  );
}

function page(
  store: TimelineStore,
  request: TimelinePageRequest,
  entries: readonly ProjectedTimelineEntry[],
  flags: Pick<HistoryPage['payload'], 'reset' | 'staleCursor' | 'gap' | 'error'>,
  sequenceWindow?: TimelineSequenceWindow,
): HistoryPage {
  const allRows = store.rows();
  const first = entries[0];
  const last = entries.at(-1);
  const startSeq = sequenceWindow?.startSeq ?? first?.seqStart;
  const endSeq = sequenceWindow?.endSeq ?? last?.seqEnd;
  return {
    protocolVersion: PROTOCOL_VERSION,
    type: 'timeline_page',
    payload: {
      requestId: request.requestId,
      agentId: request.agentId,
      direction: request.direction,
      epoch: store.epoch,
      ...flags,
      window: {
        minSeq: allRows[0]?.seq ?? 0,
        maxSeq: allRows.at(-1)?.seq ?? 0,
        nextSeq: (allRows.at(-1)?.seq ?? 0) + 1,
      },
      startCursor: startSeq === undefined ? null : { epoch: store.epoch, seq: startSeq },
      endCursor: endSeq === undefined ? null : { epoch: store.epoch, seq: endSeq },
      hasOlder: startSeq === undefined ? false : allRows.some(({ seq }) => seq < startSeq),
      hasNewer: endSeq === undefined ? false : allRows.some(({ seq }) => seq > endSeq),
      entries: [...structuredClone(entries)],
    },
  };
}

function entryFromRow(row: CanonicalTimelineRow): ProjectedTimelineEntry {
  return {
    providerId: row.providerId,
    item: structuredClone(row.item),
    ...(row.turnId === undefined ? {} : { turnId: row.turnId }),
    timestamp: row.timestamp,
    seqStart: row.seq,
    seqEnd: row.seq,
    sourceSeqRanges: [{ startSeq: row.seq, endSeq: row.seq }],
    collapsed: [],
    resources: structuredClone(row.resources),
  };
}

function findProjection(entries: readonly ProjectedTimelineEntry[], row: CanonicalTimelineRow): number | undefined {
  if (row.item.type === 'assistant_message') {
    const index = entries.length - 1;
    const previous = entries[index];
    if (
      previous?.item.type === 'assistant_message'
      && sameContext(previous, row)
      && previous.item.messageId === row.item.messageId
    ) return index;
    return undefined;
  }
  if (row.item.type === 'reasoning') {
    const index = entries.length - 1;
    const previous = entries[index];
    return previous?.item.type === 'reasoning' && sameContext(previous, row) ? index : undefined;
  }
  if (row.item.type === 'tool_call') {
    const callId = row.item.callId;
    const index = entries.findIndex((entry) => entry.providerId === row.providerId
      && entry.item.type === 'tool_call'
      && entry.item.callId === callId);
    return index === -1 ? undefined : index;
  }
  if (row.item.type === 'todo') {
    for (let index = entries.length - 1; index >= 0; index -= 1) {
      const entry = entries[index];
      if (entry?.item.type === 'todo' && sameContext(entry, row)) return index;
    }
  }
  return undefined;
}

function sameContext(entry: ProjectedTimelineEntry, row: CanonicalTimelineRow): boolean {
  return entry.providerId === row.providerId && entry.turnId === row.turnId;
}

function includeSequence(ranges: readonly TimelineSeqRange[], sequence: number): TimelineSeqRange[] {
  const next: TimelineSeqRange[] = ranges.map((range) => ({ ...range }));
  const last = next.at(-1);
  if (last && last.endSeq + 1 === sequence) last.endSeq = sequence;
  else next.push({ startSeq: sequence, endSeq: sequence });
  return next;
}

function includeCollapse(collapsed: TimelineCollapse[], collapse: TimelineCollapse): void {
  if (!collapsed.includes(collapse)) collapsed.push(collapse);
}

function includeResources(
  resources: ProjectedTimelineEntry['resources'],
  additions: CanonicalTimelineRow['resources'],
): void {
  for (const addition of additions) {
    if (resources.some(({ locator, resourceId }) => locator === addition.locator && resourceId === addition.resourceId)) {
      continue;
    }
    resources.push(structuredClone(addition));
  }
}
