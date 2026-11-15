import { PROTOCOL_VERSION, type HistoryPage, type TimelineDirection, type TimelineHistoryCursor } from '@orchardworks/agent-remote-protocol';

import { itemEntry } from './journal-items.js';
import type { JournalItem } from './types.js';

export interface JournalPageRequest {
  requestId: string;
  agentId: string;
  direction: TimelineDirection;
  cursor?: TimelineHistoryCursor;
  limit: number;
}

export interface JournalPageView {
  epoch: string;
  items: readonly JournalItem[];
  nextSeq: number;
}

/** A page, or the items whose bodies must be filled from the Host before the page can be served. */
export type JournalPageResult = { kind: 'page'; page: HistoryPage } | { kind: 'missing'; itemKeys: string[] };

type PageFlags = Pick<HistoryPage['payload'], 'reset' | 'staleCursor' | 'gap' | 'error'>;
const SERVED: PageFlags = { reset: false, staleCursor: false, gap: false, error: null };

export function pageJournal(view: JournalPageView, request: JournalPageRequest, options: { olderBeyondJournal: boolean }): JournalPageResult {
  if (!Number.isSafeInteger(request.limit) || request.limit < 1) throw new Error('Timeline page limit must be a positive integer.');
  if (request.direction !== 'tail' && request.cursor === undefined) throw new Error(`${request.direction} Timeline requests require a cursor.`);
  const cursor = request.cursor;
  if (cursor && cursor.epoch !== view.epoch) {
    return page(view, request, [], { reset: true, staleCursor: true, gap: false, error: 'Timeline cursor epoch was replaced.' }, options);
  }
  if (request.direction === 'after' && cursor && cursor.seq > view.nextSeq - 1) {
    return page(view, request, [], { reset: false, staleCursor: false, gap: true, error: 'Timeline cursor is ahead of recoverable history.' }, options);
  }
  const selected = request.direction === 'tail' ? view.items.slice(-request.limit)
    : request.direction === 'before' ? view.items.filter(({ seqStart }) => seqStart < (cursor as TimelineHistoryCursor).seq).slice(-request.limit)
      : view.items.filter(({ seqEnd }) => seqEnd > (cursor as TimelineHistoryCursor).seq)
        .sort((left, right) => left.seqEnd - right.seqEnd || left.seqStart - right.seqStart)
        .slice(0, request.limit)
        .sort((left, right) => left.seqStart - right.seqStart);
  const missing = selected.filter(({ body }) => body === null).map(({ itemKey }) => itemKey);
  if (missing.length > 0) return { kind: 'missing', itemKeys: missing };
  return page(view, request, selected, SERVED, options);
}

function page(view: JournalPageView, request: JournalPageRequest, selected: readonly JournalItem[], flags: PageFlags, options: { olderBeyondJournal: boolean }): JournalPageResult {
  const first = selected[0];
  let endSeq: number | undefined;
  for (const { seqEnd } of selected) if (endSeq === undefined || seqEnd > endSeq) endSeq = seqEnd;
  const servedOlder = options.olderBeyondJournal && flags.error === null;
  return {
    kind: 'page',
    page: {
      protocolVersion: PROTOCOL_VERSION,
      type: 'timeline_page',
      payload: {
        requestId: request.requestId,
        agentId: request.agentId,
        direction: request.direction,
        epoch: view.epoch,
        ...flags,
        window: { minSeq: view.items[0]?.seqStart ?? 0, maxSeq: view.nextSeq - 1, nextSeq: view.nextSeq },
        startCursor: first ? { epoch: view.epoch, seq: first.seqStart } : null,
        endCursor: endSeq === undefined ? null : { epoch: view.epoch, seq: endSeq },
        hasOlder: first
          ? view.items.some(({ seqStart }) => seqStart < first.seqStart) || (servedOlder && first === view.items[0])
          : servedOlder,
        hasNewer: endSeq === undefined ? false : view.items.some(({ seqEnd }) => seqEnd > endSeq),
        entries: selected.map(itemEntry),
      },
    },
  };
}
