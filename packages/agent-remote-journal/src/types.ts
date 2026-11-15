import type { AgentTimelineItem, ResourceBinding, TimelineCollapse, TimelineSeqRange } from '@orchardworks/agent-remote-protocol';

/** One row a Controller publishes: a timeline row (`TimelineRowInput` in agent-remote-relay) plus the native identity of the item it belongs to. */
export interface JournalRowInput {
  itemKey: string;
  providerId: string;
  sourceKey: string;
  nativeRevision?: number;
  occurredAt: number;
  turnId?: string;
  item: AgentTimelineItem;
  resources?: ResourceBinding[];
  /** A row that a reread of native history cannot reproduce, such as an interaction record. */
  liveOnly?: boolean;
}

/** A row stamped with the journal's epoch and sequence; what subscribers receive live. */
export interface JournalRow {
  epoch: string;
  seq: number;
  itemKey: string;
  providerId: string;
  sourceKey: string;
  nativeRevision?: number;
  occurredAt: number;
  timestamp: string;
  turnId?: string;
  item: AgentTimelineItem;
  resources: ResourceBinding[];
}

/** The content of an item, which the journal may evict and fill again from the Host. */
export interface JournalBody {
  item: AgentTimelineItem;
  timestamp: string;
  collapsed: TimelineCollapse[];
  resources: ResourceBinding[];
}

/** One item of the session. Everything but the body is the journal's skeleton and is never evicted. */
export interface JournalItem {
  itemKey: string;
  providerId: string;
  turnId?: string;
  seqStart: number;
  seqEnd: number;
  sourceSeqRanges: TimelineSeqRange[];
  state: 'open' | 'complete';
  digest?: string;
  liveOnly: boolean;
  clientMessageId?: string;
  revision: number;
  body: JournalBody | null;
}

/** The publisher allowed to write: one Controller process (`publisherId`) on one uplink connection (`generation`). */
export interface JournalPublisher {
  publisherId: string;
  generation: number;
  /** The last publication applied; publications at or below it are duplicates. */
  watermark: number;
}

/** Identifies one publication: the publisher's connection and its monotonic publication number. */
export interface JournalPublication {
  publisherId: string;
  generation: number;
  sequence: number;
}

export interface JournalMeta {
  sessionKey: string;
  epoch: string;
  /** The sequence the next forward row receives. */
  nextSeq: number;
  /** The lowest sequence in use; older rows are prepended below it. */
  minSeq: number;
  publisher: JournalPublisher | null;
  retiredEpochs: { epoch: string; retiredAt: number }[];
}

export interface JournalState {
  meta: JournalMeta;
  items: JournalItem[];
}

/** What changed since changes were last taken, for a store that writes incrementally. */
export interface JournalChanges {
  meta: JournalMeta;
  upsert: JournalItem[];
  /** True after a replacement: the store drops every item it holds for the session before the upserts. */
  replaced: boolean;
}

export interface JournalIndexEntry {
  itemKey: string;
  seqStart: number;
  seqEnd: number;
  state: 'open' | 'complete';
  digest?: string;
  liveOnly: boolean;
  clientMessageId?: string;
  revision: number;
  /** Whether the journal holds the body; false after eviction. */
  resident: boolean;
}

/** A complete item from native history: one row carrying its whole content, and its digest. */
export interface CompleteItemInput {
  row: JournalRowInput;
  digest: string;
}

export class JournalFencedError extends Error {
  constructor(readonly sessionKey: string) {
    super(`A newer publisher owns the journal of ${sessionKey}.`);
    this.name = 'JournalFencedError';
  }
}

export class JournalStaleRevisionError extends Error {
  constructor(readonly itemKey: string, readonly revision: number) {
    super(`Journal item ${itemKey} moved to revision ${revision}.`);
    this.name = 'JournalStaleRevisionError';
  }
}

export class JournalBodyMissingError extends Error {
  constructor(readonly itemKey: string) {
    super(`Journal item ${itemKey} has no resident body.`);
    this.name = 'JournalBodyMissingError';
  }
}

export class JournalUnknownItemError extends Error {
  constructor(readonly itemKey: string) {
    super(`Journal item ${itemKey} is unknown.`);
    this.name = 'JournalUnknownItemError';
  }
}
